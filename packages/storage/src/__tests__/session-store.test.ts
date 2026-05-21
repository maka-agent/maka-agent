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
      assert.equal(typeof archived.archivedAt, 'number');

      await store.unarchive(header.id);
      const restored = await store.readHeader(header.id);
      assert.equal(restored.isArchived, false);
      assert.equal(restored.archivedAt, undefined);
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
      const [summary] = await store.list();
      assert.equal(summary?.permissionMode, 'ask');
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
