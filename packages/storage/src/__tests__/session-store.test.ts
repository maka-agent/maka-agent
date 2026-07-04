import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import type { CreateSessionInput, SessionHeader, StoredMessage } from '@maka/core';
import { createSessionStore } from '../session-store.js';

describe('FileSessionStore CRUD', () => {
  test('archive sets isArchived and archivedAt; unarchive clears them', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Archived me' }));

      await store.archive(header.id);
      const archived = await store.readHeader(header.id);
      assert.equal(archived.isArchived, true);
      assert.equal(archived.status, 'archived');
      assert.equal(typeof archived.archivedAt, 'number');

      await store.unarchive(header.id);
      const restored = await store.readHeader(header.id);
      assert.equal(restored.isArchived, false);
      assert.equal(restored.status, 'active');
      assert.equal(restored.archivedAt, undefined);
    });
  });

  test('new sessions default to active status and include it in summaries', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Status' }));

      assert.equal(header.status, 'active');
      assert.equal(typeof header.statusUpdatedAt, 'number');
      const [summary] = await store.list();
      assert.equal(summary?.status, 'active');
      assert.equal(summary?.statusUpdatedAt, header.statusUpdatedAt);
      assert.equal(summary?.model, 'fake-model');
      assert.equal(summary?.cwd, '/tmp/cwd');
    });
  });

  test('persists session branch lineage in header and summaries', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({
        name: 'Branch',
        parentSessionId: 'parent-session',
        branchOfTurnId: 'turn-parent',
      }));

      assert.equal(header.parentSessionId, 'parent-session');
      assert.equal(header.branchOfTurnId, 'turn-parent');
      const [summary] = await store.list();
      assert.equal(summary?.parentSessionId, 'parent-session');
      assert.equal(summary?.branchOfTurnId, 'turn-parent');
    });
  });

  test('setFlagged toggles the flag without touching other fields', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Pin me' }));

      await store.setFlagged(header.id, true);
      const pinned = await store.readHeader(header.id);
      assert.equal(pinned.isFlagged, true);
      assert.equal(pinned.name, 'Pin me');

      await store.setFlagged(header.id, false);
      const unpinned = await store.readHeader(header.id);
      assert.equal(unpinned.isFlagged, false);
    });
  });

  test('markSessionReadThrough clears unread only through the current last message', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Unread' }));
      await store.updateHeader(header.id, { hasUnread: true, lastMessageAt: 250 });

      const unchanged = await store.markSessionReadThrough(header.id, 200);
      assert.equal(unchanged.lastMessageAt, 250);
      assert.equal(unchanged.hasUnread, true);
      assert.equal((await store.readHeader(header.id)).hasUnread, true);

      const cleared = await store.markSessionReadThrough(header.id, 250);
      assert.equal(cleared.lastMessageAt, 250);
      assert.equal(cleared.hasUnread, false);
      assert.equal((await store.readHeader(header.id)).hasUnread, false);
    });
  });

  test('markSessionReadThrough uses visible message timestamps when header lastMessageAt is stale', async () => {
    for (const headerLastMessageAt of [100, undefined]) {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'Stale unread' }));
        await store.appendMessage(header.id, assistantMessageAt(250));
        await store.updateHeader(header.id, { hasUnread: true, lastMessageAt: headerLastMessageAt });

        const unchanged = await store.markSessionReadThrough(header.id, 200);
        assert.equal(unchanged.hasUnread, true);
        assert.equal((await store.list())[0]?.lastMessageAt, 250);
        assert.equal((await store.readHeader(header.id)).hasUnread, true);

        const cleared = await store.markSessionReadThrough(header.id, 250);
        assert.equal(cleared.hasUnread, false);
        assert.equal((await store.readHeader(header.id)).hasUnread, false);
      });
    }
  });

  test('rename trims whitespace, rejects empty strings, and caps absurd lengths', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Old' }));

      await store.rename(header.id, '  Brand new name  ');
      const renamed = await store.readHeader(header.id);
      assert.equal(renamed.name, 'Brand new name');

      await assert.rejects(store.rename(header.id, '   '), /name cannot be empty/);

      const overly = 'a'.repeat(200);
      await store.rename(header.id, overly);
      const bounded = await store.readHeader(header.id);
      assert.equal(bounded.name.length, 80);
    });
  });

  test('remove deletes the session directory entirely', async () => {
    await withStore(async (store, workspaceRoot) => {
      const header = await store.create(makeInput({ name: 'Goodbye' }));
      const sessionDir = join(workspaceRoot, 'sessions', header.id);

      // sanity: file exists before remove
      const before = await readFile(join(sessionDir, 'session.jsonl'), 'utf8');
      assert.match(before, /Goodbye/);

      await store.remove(header.id);

      await assert.rejects(readFile(join(sessionDir, 'session.jsonl'), 'utf8'));
      const remaining = await store.list();
      assert.equal(remaining.find((s) => s.id === header.id), undefined);
    });
  });

  test('rejects traversal-style session ids before touching the filesystem', async () => {
    await withStore(async (store, workspaceRoot) => {
      const victim = join(workspaceRoot, 'outside-victim');
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, 'keep.txt'), 'keep', 'utf8');

      await assert.rejects(store.readMessages('../outside-victim'), /Invalid session id/);
      await assert.rejects(store.remove('../outside-victim'), /Invalid session id/);

      assert.equal(await readFile(join(victim, 'keep.txt'), 'utf8'), 'keep');
    });
  });

  test('rejects malformed session headers instead of returning partial records', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'malformed-header';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({
          ...makeRawHeader({ id: sessionId, workspaceRoot, name: 'Broken labels' }),
          labels: 'not-an-array',
        }) + '\n',
        'utf8',
      );

      await assert.rejects(
        () => store.readHeader(sessionId),
        /Invalid session header for session malformed-header: malformed fields/,
      );
      assert.deepEqual(await store.list(), []);
    });
  });

  test('rejects malformed session headers on write paths without overwriting bytes', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'malformed-write';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      const sessionPath = join(sessionDir, 'session.jsonl');
      const invalid = JSON.stringify({
        ...makeRawHeader({ id: sessionId, workspaceRoot, name: 'Broken timestamp' }),
        lastUsedAt: 'soon',
      }) + '\n';
      await mkdir(sessionDir, { recursive: true });
      await writeFile(sessionPath, invalid, 'utf8');

      await assert.rejects(
        () => store.setFlagged(sessionId, true),
        /Invalid session header for session malformed-write: malformed fields/,
      );
      assert.equal(await readFile(sessionPath, 'utf8'), invalid);
    });
  });

  test('rejects session headers whose id does not match the directory', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'header-id-mismatch';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify(makeRawHeader({ id: 'other-session', workspaceRoot })) + '\n',
        'utf8',
      );

      await assert.rejects(
        () => store.readMessages(sessionId),
        /Invalid session header for session header-id-mismatch: malformed fields/,
      );
      assert.deepEqual(await store.list(), []);
    });
  });

  test('migrates legacy headers without permissionMode to ask', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'legacy-session';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({
          id: sessionId,
          workspaceRoot,
          cwd: '/tmp/cwd',
          createdAt: 1,
          lastUsedAt: 1,
          name: 'Legacy',
          isFlagged: false,
          labels: [],
          isArchived: false,
          hasUnread: false,
          backend: 'claude',
          llmConnectionSlug: 'legacy',
          connectionLocked: false,
          model: 'legacy-model',
          schemaVersion: 1,
        }) + '\n',
        'utf8',
      );

      const header = await store.readHeader(sessionId);
      assert.equal(header.backend, 'ai-sdk');
      assert.equal(header.permissionMode, 'ask');
      assert.equal(header.status, 'active');
      const [summary] = await store.list();
      assert.equal(summary?.permissionMode, 'ask');
      assert.equal(summary?.status, 'active');
    });
  });

  test('migrates legacy headers without model to default and exposes model in summaries', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'legacy-no-model';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({
          id: sessionId,
          workspaceRoot,
          cwd: '/tmp/cwd',
          createdAt: 1,
          lastUsedAt: 1,
          name: 'Legacy no model',
          isFlagged: false,
          labels: [],
          isArchived: false,
          hasUnread: false,
          backend: 'ai-sdk',
          llmConnectionSlug: 'anthropic',
          connectionLocked: false,
          permissionMode: 'ask',
          schemaVersion: 1,
        }) + '\n',
        'utf8',
      );

      const header = await store.readHeader(sessionId);
      assert.equal(header.model, 'default');
      const [summary] = await store.list();
      assert.equal(summary?.model, 'default');
    });
  });

  test('migrates archived legacy headers to archived status', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'legacy-archived';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({
          id: sessionId,
          workspaceRoot,
          cwd: '/tmp/cwd',
          createdAt: 1,
          lastUsedAt: 2,
          name: 'Legacy archived',
          isFlagged: false,
          labels: [],
          isArchived: true,
          archivedAt: 3,
          hasUnread: false,
          backend: 'fake',
          llmConnectionSlug: 'fake',
          connectionLocked: false,
          model: 'fake-model',
          permissionMode: 'ask',
          schemaVersion: 1,
        }) + '\n',
        'utf8',
      );

      const header = await store.readHeader(sessionId);
      assert.equal(header.status, 'archived');
      assert.equal(header.statusUpdatedAt, 3);
    });
  });

  test('recovers readable messages around a corrupt JSONL message line', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'corrupt-middle-line';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({ id: sessionId, workspaceRoot, name: 'Corrupt middle' })),
          JSON.stringify({ type: 'user', id: 'u1', turnId: 't1', ts: 2, text: 'hello' }),
          '{"type":"assistant","id":"broken"',
          JSON.stringify({ type: 'assistant', id: 'a1', turnId: 't1', ts: 4, text: 'recovered answer', modelId: 'fake' }),
          '',
        ].join('\n'),
        'utf8',
      );

      const messages = await store.readMessages(sessionId);
      assert.equal(messages.length, 3);
      assert.equal(messages[0]?.type, 'user');
      const note = messages[1];
      assert.equal(note?.type, 'system_note');
      if (note?.type !== 'system_note') throw new Error('corruption note missing');
      assert.equal(note.kind, 'error');
      assert.equal((note.data as { code?: unknown }).code, 'jsonl_parse_error');
      assert.equal((note.data as { lineNumber?: unknown }).lineNumber, 3);
      assert.equal(typeof (note.data as { message?: unknown }).message, 'string');
      assert.ok(((note.data as { message?: string }).message ?? '').length > 0);
      assert.equal(messages[2]?.type, 'assistant');

      const [summary] = await store.list();
      assert.equal(summary?.id, sessionId);
      assert.equal(summary?.lastMessagePreview, 'recovered answer');
    });
  });

  test('silently drops a truncated tail JSONL message line', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'truncated-tail-line';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({ id: sessionId, workspaceRoot, name: 'Truncated tail' })),
          JSON.stringify({ type: 'user', id: 'u1', turnId: 't1', ts: 2, text: 'survives' }),
          '{"type":"assistant","id":"partial"',
        ].join('\n'),
        'utf8',
      );

      const messages = await store.readMessages(sessionId);
      assert.deepEqual(messages.map((message) => message.type), ['user']);

      const [summary] = await store.list();
      assert.equal(summary?.id, sessionId);
      assert.equal(summary?.lastMessagePreview, 'survives');
    });
  });

  test('reports a corrupt tail JSONL message line when it was newline-terminated', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'corrupt-terminated-tail-line';
      const sessionDir = join(workspaceRoot, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({ id: sessionId, workspaceRoot, name: 'Corrupt terminated tail' })),
          JSON.stringify({ type: 'user', id: 'u1', turnId: 't1', ts: 2, text: 'survives' }),
          '{"type":"assistant","id":"durably-broken"',
          '',
        ].join('\n'),
        'utf8',
      );

      const messages = await store.readMessages(sessionId);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.type, 'user');
      const note = messages[1];
      assert.equal(note?.type, 'system_note');
      if (note?.type !== 'system_note') throw new Error('corruption note missing');
      assert.equal(note.kind, 'error');
      assert.equal((note.data as { code?: unknown }).code, 'jsonl_parse_error');
      assert.equal((note.data as { lineNumber?: unknown }).lineNumber, 3);
    });
  });

  test('derives lastMessagePreview from visible user and assistant messages', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Preview' }));

      await store.appendMessages(header.id, [
        { type: 'system_note', id: 'sys-1', ts: 1, kind: 'mode_change', data: { from: 'ask', to: 'execute' } },
        { type: 'tool_call', id: 'tool-1', turnId: 't1', ts: 2, toolName: 'Read', args: { file: 'secret.ts' } },
        { type: 'assistant', id: 'a1', turnId: 't1', ts: 3, text: 'Here is the latest answer.\nIt spans lines.', modelId: 'fake' },
      ]);

      const [summary] = await store.list();
      assert.equal(summary?.lastMessagePreview, 'Here is the latest answer. It spans lines.');
    });
  });

  test('lastMessagePreview skips internal-only tails, preserves emoji, and falls back for attachments', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Emoji' }));
      const longText = `hello ${'🙂'.repeat(120)} tail`;

      await store.appendMessages(header.id, [
        {
          type: 'user',
          id: 'u1',
          turnId: 't1',
          ts: 1,
          text: longText,
        },
        { type: 'system_note', id: 'sys-1', turnId: 't1', ts: 2, kind: 'session_resume' },
      ]);

      const [summary] = await store.list();
      assert.equal(summary?.lastMessagePreview?.endsWith('…'), true);
      assert.equal(summary?.lastMessagePreview?.includes('�'), false);
      assert.equal(summary?.lastMessagePreview?.startsWith('hello 🙂'), true);
    });

    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Attachment' }));

      await store.appendMessage(header.id, {
        type: 'user',
        id: 'u1',
        turnId: 't1',
        ts: 1,
        text: '   ',
        attachments: [{
          kind: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          bytes: 10,
          ref: { kind: 'session_file', sessionId: header.id, relativePath: 'shot.png' },
        }],
      });

      const [summary] = await store.list();
      assert.equal(summary?.lastMessagePreview, '附件');
    });
  });

  test('summary lastMessageAt derives from visible messages when header timestamp is missing or stale', async () => {
    await withStore(async (store, workspaceRoot) => {
      const missingId = 'missing-last-message-at';
      await mkdir(join(workspaceRoot, 'sessions', missingId), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'sessions', missingId, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({ id: missingId, workspaceRoot, name: 'Missing timestamp' })),
          JSON.stringify({ type: 'user', id: 'u1', turnId: 't1', ts: 20, text: 'new visible user text' }),
          JSON.stringify({ type: 'system_note', id: 'sys-1', ts: 30, kind: 'session_resume' }),
          '',
        ].join('\n'),
        'utf8',
      );

      const staleId = 'stale-last-message-at';
      await mkdir(join(workspaceRoot, 'sessions', staleId), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'sessions', staleId, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({
            id: staleId,
            workspaceRoot,
            name: 'Stale timestamp',
            lastMessageAt: 5,
          })),
          JSON.stringify({ type: 'assistant', id: 'a1', turnId: 't1', ts: 40, text: 'new visible assistant text', modelId: 'fake' }),
          '',
        ].join('\n'),
        'utf8',
      );

      const summaries = await store.list();
      const missing = summaries.find((summary) => summary.id === missingId);
      const stale = summaries.find((summary) => summary.id === staleId);

      assert.equal(missing?.lastMessageAt, 20);
      assert.equal(missing?.lastMessagePreview, 'new visible user text');
      assert.equal(stale?.lastMessageAt, 40);
      assert.equal(stale?.lastMessagePreview, 'new visible assistant text');
      assert.deepEqual(summaries.slice(0, 2).map((summary) => summary.id), [staleId, missingId]);
    });
  });

  test('list derives previews for sessions outside the first three without full detail reads', async () => {
    await withStore(async (store, workspaceRoot) => {
      for (let index = 0; index < 5; index += 1) {
        const sessionId = `preview-tail-${index}`;
        await mkdir(join(workspaceRoot, 'sessions', sessionId), { recursive: true });
        await writeFile(
          join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
          [
            JSON.stringify(makeRawHeader({
              id: sessionId,
              workspaceRoot,
              name: `Preview tail ${index}`,
              lastMessageAt: 100 - index,
            })),
            JSON.stringify({ type: 'assistant', id: `a-${index}`, turnId: `t-${index}`, ts: 100 - index, text: `tail preview ${index}`, modelId: 'fake' }),
            '',
          ].join('\n'),
          'utf8',
        );
      }

      const summaries = await store.list();

      assert.equal(summaries.length, 5);
      assert.deepEqual(summaries.map((summary) => summary.lastMessagePreview), [
        'tail preview 0',
        'tail preview 1',
        'tail preview 2',
        'tail preview 3',
        'tail preview 4',
      ]);
    });
  });

  test('list accepts unusually large but valid session headers', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'large-valid-header';
      await mkdir(join(workspaceRoot, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({
            id: sessionId,
            workspaceRoot,
            name: 'Large header',
            labels: Array.from({ length: 700 }, (_, index) => `label-${index}`),
            lastMessageAt: 10,
          })),
          JSON.stringify({ type: 'assistant', id: 'a1', turnId: 't1', ts: 10, text: 'large header survives', modelId: 'fake' }),
          '',
        ].join('\n'),
        'utf8',
      );

      const [summary] = await store.list();

      assert.equal(summary?.id, sessionId);
      assert.equal(summary?.lastMessagePreview, 'large header survives');
    });
  });

  test('summary lastMessageAt does not move backwards when copying older visible messages', async () => {
    await withStore(async (store, workspaceRoot) => {
      const sessionId = 'newer-header-with-old-copy';
      await mkdir(join(workspaceRoot, 'sessions', sessionId), { recursive: true });
      await writeFile(
        join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
        [
          JSON.stringify(makeRawHeader({
            id: sessionId,
            workspaceRoot,
            name: 'Newer header',
            lastMessageAt: 100,
          })),
          JSON.stringify({ type: 'assistant', id: 'a1', turnId: 't1', ts: 40, text: 'old copied text', modelId: 'fake' }),
          '',
        ].join('\n'),
        'utf8',
      );

      const [summary] = await store.list();

      assert.equal(summary?.id, sessionId);
      assert.equal(summary?.lastMessageAt, 100);
      assert.equal(summary?.lastMessagePreview, 'old copied text');
    });
  });

  test('listTurns derives latest persisted turn states and lineage', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Turns' }));

      await store.appendMessages(header.id, [
        { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: 'hello' },
        { type: 'turn_state', id: 'state-1', turnId: 't1', ts: 2, status: 'running', partialOutputRetained: false },
        { type: 'assistant', id: 'a1', turnId: 't1', ts: 3, text: 'partial', modelId: 'fake' },
        {
          type: 'turn_state',
          id: 'state-2',
          turnId: 't1',
          ts: 4,
          status: 'aborted',
          retriedFromTurnId: 't0',
          abortedAt: 4,
          partialOutputRetained: false,
        },
      ]);

      assert.deepEqual(await store.listTurns(header.id), [
        {
          turnId: 't1',
          status: 'aborted',
          retriedFromTurnId: 't0',
          abortedAt: 4,
          partialOutputRetained: true,
        },
      ]);
    });
  });

  test('listTurns projects legacy message-only turns as completed', async () => {
    await withStore(async (store) => {
      const header = await store.create(makeInput({ name: 'Legacy turn' }));
      await store.appendMessages(header.id, [
        { type: 'user', id: 'u1', turnId: 'legacy', ts: 1, text: 'hello' },
        { type: 'assistant', id: 'a1', turnId: 'legacy', ts: 2, text: 'world', modelId: 'fake' },
      ]);

      const turns = await store.listTurns(header.id);
      assert.equal(turns[0]?.turnId, 'legacy');
      assert.equal(turns[0]?.status, 'completed');
      assert.equal(turns[0]?.partialOutputRetained, true);
    });
  });

  // PR-UI-IPC-2 (@kenji msg 0474c3fe + @xuan msg 88d96a87):
  // session-name normalize contract is enforced at the store
  // boundary by `normalizeUserSessionName`. These integration
  // tests verify that the create + rename + (derived) branch
  // paths all converge on the same chokepoint — locking @xuan's
  // merge-gate criterion "all write entry points use same helper".
  describe('normalizeUserSessionName store-boundary integration (PR-UI-IPC-2)', () => {
    test('create with control chars in name → store persists sanitized name', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'multi\nline\tname' }));
        const persisted = await store.readHeader(header.id);
        assert.equal(persisted.name, 'multi line name');
      });
    });

    test('create with bidi RLO spoof → spoof char replaced before persistence', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'safe‮evil' }));
        const persisted = await store.readHeader(header.id);
        assert.ok(!persisted.name.includes('‮'), 'RLO must be stripped at store boundary');
        assert.equal(persisted.name, 'safe evil');
      });
    });

    test('create with zero-width injection ("ad\\u200Bmin") → ZWSP removed', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'ad​min' }));
        const persisted = await store.readHeader(header.id);
        assert.equal(persisted.name, 'admin');
      });
    });

    test('create with undefined name → uses canonical "New Chat" default', async () => {
      await withStore(async (store) => {
        const input = makeInput();
        delete (input as Partial<CreateSessionInput>).name;
        const header = await store.create(input);
        const persisted = await store.readHeader(header.id);
        assert.equal(persisted.name, 'New Chat');
      });
    });

    test('create with explicit empty string name → REJECT (no silent default fallback)', async () => {
      // Per @xuan caller-semantics lock: empty-after-sanitize on
      // an EXPLICIT input must reject, not silently use the
      // default. Default is reserved for the truly omitted
      // (undefined) case.
      await withStore(async (store) => {
        await assert.rejects(store.create(makeInput({ name: '' })), /cannot be empty/);
        await assert.rejects(store.create(makeInput({ name: '   ' })), /cannot be empty/);
        await assert.rejects(store.create(makeInput({ name: '\n\n' })), /cannot be empty/);
      });
    });

    test('rename with control chars → sanitized at store boundary (replaces v1 inline trim/cap)', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'Old' }));
        await store.rename(header.id, 'new\x00name\x1b[31mwith\x7fcontrols');
        const persisted = await store.readHeader(header.id);
        assert.ok(!persisted.name.includes('\x00'));
        assert.ok(!persisted.name.includes('\x1b'));
        assert.ok(!persisted.name.includes('\x7f'));
        // Each control replaced with single space, then collapsed:
        assert.equal(persisted.name, 'new name [31mwith controls');
      });
    });

    test('rename with non-string runtime type rejects (TS signature is not enough at IPC boundary)', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'Valid' }));
        // Intentionally cast around the TS signature to simulate an
        // IPC payload that didn't honor the type contract.
        await assert.rejects(store.rename(header.id, null as unknown as string), /must be a string/);
        await assert.rejects(store.rename(header.id, 42 as unknown as string), /must be a string/);
      });
    });

    test('rename with 100-char input → capped to 80 code points', async () => {
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: 'Old' }));
        await store.rename(header.id, 'a'.repeat(100));
        const persisted = await store.readHeader(header.id);
        assert.equal(Array.from(persisted.name).length, 80);
      });
    });

    test('create with emoji at the cap boundary → surrogate pair never cut in half', async () => {
      // 79 ASCII + 1 emoji = 80 code points, 81 UTF-16 code units.
      // Naive `.slice(0, 80)` would cut the emoji's high-surrogate
      // and leave an invalid lone low-surrogate. The helper uses
      // code-point iteration to prevent this.
      await withStore(async (store) => {
        const header = await store.create(makeInput({ name: `${'a'.repeat(79)}🦊` }));
        const persisted = await store.readHeader(header.id);
        assert.ok(persisted.name.endsWith('🦊'), 'emoji must be intact at cap boundary');
      });
    });

    test('branch derived name with control-char parent → sanitized', async () => {
      // Simulates the runtime branch path: derived name is
      // `${parent} · 分支`. If parent.name has somehow accumulated
      // dirty bytes (legacy session, manual file edit), the
      // derived name passed to `store.create` still goes through
      // the same normalize gate.
      await withStore(async (store) => {
        const dirtyParent = 'parent\nwith\ttabs';
        // Simulate runtime's `name: input.name ?? '${header.name} · 分支'`
        const derived = `${dirtyParent} · 分支`;
        const branchHeader = await store.create(makeInput({ name: derived }));
        const persisted = await store.readHeader(branchHeader.id);
        assert.ok(!persisted.name.includes('\n'), 'newline in derived must be sanitized');
        assert.ok(!persisted.name.includes('\t'), 'tab in derived must be sanitized');
        assert.equal(persisted.name, 'parent with tabs · 分支');
      });
    });
  });
});

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}

function makeRawHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'raw-session',
    workspaceRoot: '/tmp/workspace',
    cwd: '/tmp/cwd',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Raw session',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask',
    schemaVersion: 1,
    ...overrides,
  };
}

function assistantMessageAt(ts: number): StoredMessage {
  return {
    type: 'assistant',
    id: `assistant-${ts}`,
    turnId: `turn-${ts}`,
    ts,
    text: 'ok',
    modelId: 'fake-model',
  };
}

async function withStore(
  fn: (store: ReturnType<typeof createSessionStore>, workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-session-store-'));
  const store = createSessionStore(workspaceRoot);
  try {
    await fn(store, workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

// Silence unused-import warnings (kept for type clarity).
type _Header = SessionHeader;
