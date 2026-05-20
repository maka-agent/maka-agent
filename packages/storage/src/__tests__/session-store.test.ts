import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
