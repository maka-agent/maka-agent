import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CreateSessionInput } from '@maka/core';
import { importLegacySessionMetadataTree } from '../session-metadata-transfer.js';
import { createLegacyFileSessionStore as createSessionStore } from '../session-store.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('legacy session metadata transfer', () => {
  test('imports every legacy line-1 header without reading transcript payloads as metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-'));
    const legacy = createSessionStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const first = await legacy.create(makeInput({ name: 'First', labels: ['alpha'] }));
      const second = await legacy.create(makeInput({ name: 'Second', labels: ['beta'] }));
      await legacy.appendMessage(first.id, {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'This transcript row is not session metadata.',
      });
      await legacy.updateHeader(second.id, {
        status: 'blocked',
        blockedReason: 'permission_required',
        hasUnread: true,
      });

      const report = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.deepEqual(report, {
        filesScanned: 2,
        headersRead: 2,
        headersImported: 2,
        headersExisting: 0,
        sourcesAlreadyImported: 0,
        sourcesTombstoned: 0,
      });
      assert.deepEqual((await sqlite.list()).map((record) => record.header.name).sort(), [
        'First',
        'Second',
      ]);
      assert.deepEqual(
        (await sqlite.read(first.id)).header,
        await legacy.readHeaderSnapshot(first.id),
      );
      assert.deepEqual(
        (await sqlite.read(second.id)).header,
        await legacy.readHeaderSnapshot(second.id),
      );

      await legacy.appendMessage(second.id, {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 11,
        text: 'Appending transcript bytes must not invalidate the imported header.',
        modelId: 'fake-model',
      });
      await sqlite.update(first.id, { name: 'SQLite is canonical now' });
      const repeated = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.deepEqual(repeated, {
        filesScanned: 2,
        headersRead: 2,
        headersImported: 0,
        headersExisting: 0,
        sourcesAlreadyImported: 2,
        sourcesTombstoned: 0,
      });
      assert.equal((await sqlite.read(first.id)).header.name, 'SQLite is canonical now');
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('decodes legacy compatibility defaults through the FileSessionStore codec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-legacy-'));
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    const sessionId = 'legacy-session';
    const path = join(root, 'sessions', sessionId, 'session.jsonl');
    try {
      const legacy = {
        id: sessionId,
        workspaceRoot: root,
        cwd: '/workspace',
        createdAt: 1,
        lastUsedAt: 2,
        name: 'New Session',
        isFlagged: false,
        labels: [],
        isArchived: false,
        pendingCwdReminder: {
          from: '/workspace/old',
          to: '/workspace',
        },
        hasUnread: false,
        backend: 'pi',
        llmConnectionSlug: 'legacy',
        connectionLocked: false,
        schemaVersion: 1,
      };
      await mkdir(join(root, 'sessions', sessionId), { recursive: true });
      await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');

      await importLegacySessionMetadataTree({ workspaceRoot: root, destination: sqlite });
      const header = (await sqlite.read(sessionId)).header;
      assert.equal(header.backend, 'pi-agent');
      assert.equal(header.model, 'default');
      assert.equal(header.permissionMode, 'ask');
      assert.equal(header.collaborationMode, 'agent');
      assert.equal(header.orchestrationMode, 'default');
      assert.equal(header.status, 'active');
      assert.equal(header.titleIsManual, false);
      assert.equal(header.name, 'New Chat');
      assert.equal(Object.hasOwn(header, 'pendingCwdReminder'), false);
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects one malformed header before importing any session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-invalid-'));
    const legacy = createSessionStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const valid = await legacy.create(makeInput({ name: 'Valid' }));
      const invalid = await legacy.create(makeInput({ name: 'Invalid' }));
      const invalidPath = join(root, 'sessions', invalid.id, 'session.jsonl');
      const lines = (await readFile(invalidPath, 'utf8')).split('\n');
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), labels: 'not-an-array' });
      await writeFile(invalidPath, lines.join('\n'), 'utf8');

      await assert.rejects(
        () => importLegacySessionMetadataTree({ workspaceRoot: root, destination: sqlite }),
        /Invalid legacy session header/,
      );
      await assert.rejects(() => sqlite.read(valid.id), /not found/);
      assert.deepEqual(await sqlite.list(), []);
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps canonical metadata readable when its optional transcript is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-missing-transcript-'));
    const legacy = createSessionStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const created = await legacy.create(makeInput({ name: 'Canonical metadata' }));
      await importLegacySessionMetadataTree({ workspaceRoot: root, destination: sqlite });
      await rm(join(root, 'sessions', created.id, 'session.jsonl'));

      const report = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });

      assert.deepEqual(report, {
        filesScanned: 1,
        headersRead: 0,
        headersImported: 0,
        headersExisting: 0,
        sourcesAlreadyImported: 0,
        sourcesTombstoned: 0,
      });
      assert.equal((await sqlite.read(created.id)).header.name, 'Canonical metadata');
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
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
