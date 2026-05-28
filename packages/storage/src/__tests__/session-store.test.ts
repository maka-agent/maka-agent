import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import type { CreateSessionInput, SessionHeader } from '@maka/core';
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
