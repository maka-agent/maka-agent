import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CreateSessionInput } from '@maka/core';
import { importLegacySessionMetadataTree } from '../session-metadata-transfer.js';
import {
  createLegacyFileSessionStore as createLegacyStore,
  createSessionStore,
  SQLITE_SESSION_METADATA_DATABASE_NAME,
} from '../session-store.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('legacy session metadata transfer', () => {
  test('imports every legacy line-1 header without reading transcript payloads as metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-'));
    const legacy = createLegacyStore(root);
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

  test('skips a malformed header without tombstoning it while importing valid sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-invalid-'));
    const legacy = createLegacyStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const valid = await legacy.create(makeInput({ name: 'Valid' }));
      const invalid = await legacy.create(makeInput({ name: 'Invalid' }));
      const invalidPath = join(root, 'sessions', invalid.id, 'session.jsonl');
      const lines = (await readFile(invalidPath, 'utf8')).split('\n');
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), labels: 'not-an-array' });
      await writeFile(invalidPath, lines.join('\n'), 'utf8');

      const report = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.equal(report.filesScanned, 2);
      assert.equal(report.headersImported, 1);
      // The valid session was imported.
      assert.equal((await sqlite.read(valid.id)).header.name, 'Valid');
      // The malformed session was skipped, not imported and not tombstoned.
      assert.equal(await sqlite.has(invalid.id), false);
      assert.equal(await sqlite.isTombstoned(invalid.id), false);
      // Re-importing should skip the malformed session again (not tombstoned).
      const repeated = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.equal(repeated.filesScanned, 2);
      assert.equal(repeated.headersImported, 0);
      // Repairing the header should allow it to be imported on the next run.
      const repairedLines = (await readFile(invalidPath, 'utf8')).split('\n');
      const repairedHeader = JSON.parse(repairedLines[0]!);
      repairedHeader.labels = ['repaired'];
      repairedLines[0] = JSON.stringify(repairedHeader);
      await writeFile(invalidPath, repairedLines.join('\n'), 'utf8');
      const repaired = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.equal(repaired.headersImported, 1);
      assert.equal((await sqlite.read(invalid.id)).header.name, 'Invalid');
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not tombstone a session when a non-ENOENT filesystem error occurs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-fs-error-'));
    const legacy = createLegacyStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const valid = await legacy.create(makeInput({ name: 'Valid' }));
      const unreadable = await legacy.create(makeInput({ name: 'Unreadable' }));
      const unreadablePath = join(root, 'sessions', unreadable.id, 'session.jsonl');
      // Replace the session file with a directory to provoke a non-ENOENT
      // filesystem error (EISDIR) when readFirstJsonlRecord tries to open it.
      await rm(unreadablePath);
      await mkdir(unreadablePath);

      await assert.rejects(
        importLegacySessionMetadataTree({ workspaceRoot: root, destination: sqlite }),
        (error: NodeJS.ErrnoException) => error.code === 'EISDIR',
      );
      // The session must NOT be tombstoned — a filesystem error is not corrupt data.
      assert.equal(await sqlite.isTombstoned(unreadable.id), false);
      assert.equal(await sqlite.has(unreadable.id), false);
      // The valid session was not imported because the scan aborted.
      assert.equal(await sqlite.has(valid.id), false);
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('skips a malformed header without tombstoning when a later scan step fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-rollback-'));
    const legacy = createLegacyStore(root);
    const sqlite = createSqliteSessionMetadataStore(join(root, 'state.sqlite'));
    try {
      const valid = await legacy.create(makeInput({ name: 'Valid' }));
      const invalid = await legacy.create(makeInput({ name: 'Invalid' }));
      // Corrupt the invalid session's header.
      const invalidPath = join(root, 'sessions', invalid.id, 'session.jsonl');
      const lines = (await readFile(invalidPath, 'utf8')).split('\n');
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), labels: 'not-an-array' });
      await writeFile(invalidPath, lines.join('\n'), 'utf8');
      // Create an orphan transcript-marker directory with no SQLite metadata.
      // The scan will skip the malformed header, but the transcript marker
      // check fails before the import, so no writes should occur.
      const orphanId = 'orphan-transcript-session';
      const orphanDir = join(root, 'sessions', orphanId);
      await mkdir(orphanDir, { recursive: true });
      const orphanPath = join(orphanDir, 'session.jsonl');
      await writeFile(
        orphanPath,
        `${JSON.stringify({ type: 'session_transcript', sessionId: orphanId, schemaVersion: 1 })}\n`,
        'utf8',
      );

      await assert.rejects(
        importLegacySessionMetadataTree({ workspaceRoot: root, destination: sqlite }),
        /transcript marker has no SQLite metadata/,
      );
      // The malformed session must NOT be tombstoned (skipped, not quarantined).
      assert.equal(await sqlite.isTombstoned(invalid.id), false);
      // The valid session was not imported either (scan aborted).
      assert.equal(await sqlite.has(valid.id), false);
      // Re-running with the orphan removed should import the valid session
      // and skip (not tombstone) the malformed one.
      await rm(orphanDir, { recursive: true, force: true });
      const report = await importLegacySessionMetadataTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      assert.equal(report.headersImported, 1);
      assert.equal(await sqlite.read(valid.id).then((r) => r.header.name), 'Valid');
      assert.equal(await sqlite.isTombstoned(invalid.id), false);
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps canonical metadata readable when its optional transcript is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transfer-missing-transcript-'));
    const legacy = createLegacyStore(root);
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

describe('malformed legacy headers at the public SessionStore boundary', () => {
  // Helper: create a workspace root with one valid legacy session and one
  // corrupt legacy session whose session.jsonl is replaced by `corruptContent`.
  async function setupWorkspaceWithCorruptSession(
    corruptContent: string | ((sessionId: string, headerLine: string) => string),
  ): Promise<{
    root: string;
    validId: string;
    corruptId: string;
    corruptPath: string;
    validHeaderLine: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-boundary-'));
    const legacy = createLegacyStore(root);
    const valid = await legacy.create(makeInput({ name: 'Valid' }));
    const corrupt = await legacy.create(makeInput({ name: 'Corrupt' }));
    await legacy.close?.();
    const corruptPath = join(root, 'sessions', corrupt.id, 'session.jsonl');
    const lines = (await readFile(corruptPath, 'utf8')).split('\n');
    const validHeaderLine = (
      await readFile(join(root, 'sessions', valid.id, 'session.jsonl'), 'utf8')
    ).split('\n')[0]!;
    const newContent =
      typeof corruptContent === 'function' ? corruptContent(corrupt.id, lines[0]!) : corruptContent;
    await writeFile(corruptPath, newContent, 'utf8');
    return { root, validId: valid.id, corruptId: corrupt.id, corruptPath, validHeaderLine };
  }

  // Helper: repair a corrupt session file by writing a valid header line
  // derived from the valid session's header, with the id swapped to the
  // corrupt session's id.
  async function repairSession(
    path: string,
    validHeaderLine: string,
    targetId: string,
  ): Promise<void> {
    const header = JSON.parse(validHeaderLine) as Record<string, unknown>;
    header.id = targetId;
    await writeFile(path, `${JSON.stringify(header)}\n`, 'utf8');
  }

  // Helper: open the metadata store used by createSessionStore to check
  // tombstone and has state.
  function openMetadata(root: string) {
    return createSqliteSessionMetadataStore(join(root, SQLITE_SESSION_METADATA_DATABASE_NAME));
  }

  test('empty session.jsonl: store.list() resolves, valid session visible, corrupt absent, no tombstone', async () => {
    const { root, validId, corruptId, corruptPath, validHeaderLine } =
      await setupWorkspaceWithCorruptSession('');
    try {
      const store = createSessionStore(root);
      const sessions = await store.list();
      assert.equal(sessions.length, 1, 'only the valid session should be listed');
      assert.equal(sessions[0]!.id, validId);
      // The corrupt session is absent.
      await assert.rejects(store.readHeader(corruptId), /Session metadata not found/);
      // No tombstone was written.
      const meta = openMetadata(root);
      assert.equal(await meta.isTombstoned(corruptId), false);
      assert.equal(await meta.has(corruptId), false);
      meta.close();
      await store.close?.();

      // Repair: write a valid header, reopen, and verify the session is imported.
      await repairSession(corruptPath, validHeaderLine, corruptId);
      const store2 = createSessionStore(root);
      const sessions2 = await store2.list();
      assert.equal(sessions2.length, 2, 'both sessions should be listed after repair');
      assert.equal(
        sessions2.some((s) => s.id === corruptId),
        true,
        'repaired session should appear in list',
      );
      await store2.close?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('truncated JSON without a newline: catalog remains usable, session skipped without tombstone', async () => {
    const { root, validId, corruptId, corruptPath, validHeaderLine } =
      await setupWorkspaceWithCorruptSession('{ "id": "truncated"');
    try {
      const store = createSessionStore(root);
      const sessions = await store.list();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.id, validId);
      await assert.rejects(store.readHeader(corruptId), /Session metadata not found/);
      const meta = openMetadata(root);
      assert.equal(await meta.isTombstoned(corruptId), false);
      assert.equal(await meta.has(corruptId), false);
      meta.close();
      await store.close?.();

      // Repair and verify import.
      await repairSession(corruptPath, validHeaderLine, corruptId);
      const store2 = createSessionStore(root);
      const sessions2 = await store2.list();
      assert.equal(sessions2.length, 2);
      assert.equal(
        sessions2.some((s) => s.id === corruptId),
        true,
      );
      await store2.close?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('first record over 1 MiB limit: catalog usable, session skipped without tombstone', async () => {
    // Build a >1 MiB first line that has no newline.
    const oversized = '{ "' + 'x'.repeat(1024 * 1024 + 100) + '": 1 }';
    const { root, validId, corruptId, corruptPath, validHeaderLine } =
      await setupWorkspaceWithCorruptSession(oversized);
    try {
      const store = createSessionStore(root);
      const sessions = await store.list();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.id, validId);
      await assert.rejects(store.readHeader(corruptId), /Session metadata not found/);
      const meta = openMetadata(root);
      assert.equal(await meta.isTombstoned(corruptId), false);
      assert.equal(await meta.has(corruptId), false);
      meta.close();
      await store.close?.();

      // Repair and verify import.
      await repairSession(corruptPath, validHeaderLine, corruptId);
      const store2 = createSessionStore(root);
      const sessions2 = await store2.list();
      assert.equal(sessions2.length, 2);
      assert.equal(
        sessions2.some((s) => s.id === corruptId),
        true,
      );
      await store2.close?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('turn_state first record: valid sessions remain available through createSessionStore()', async () => {
    // Simulate the original bug: a turn_state record where the header should be.
    const turnStateFirst = (_sessionId: string, _original: string) =>
      JSON.stringify({
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: 1,
        status: 'running',
        partialOutputRetained: false,
      }) + '\n';
    const { root, validId, corruptId, corruptPath, validHeaderLine } =
      await setupWorkspaceWithCorruptSession(turnStateFirst);
    try {
      const store = createSessionStore(root);
      const sessions = await store.list();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.id, validId);
      await assert.rejects(store.readHeader(corruptId), /Session metadata not found/);
      const meta = openMetadata(root);
      assert.equal(await meta.isTombstoned(corruptId), false);
      assert.equal(await meta.has(corruptId), false);
      meta.close();
      await store.close?.();

      // Repair and verify import.
      await repairSession(corruptPath, validHeaderLine, corruptId);
      const store2 = createSessionStore(root);
      const sessions2 = await store2.list();
      assert.equal(sessions2.length, 2);
      assert.equal(
        sessions2.some((s) => s.id === corruptId),
        true,
      );
      await store2.close?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('EISDIR filesystem failure: store.list() rejects with EISDIR, no metadata or tombstone written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-boundary-eisdir-'));
    const legacy = createLegacyStore(root);
    try {
      const valid = await legacy.create(makeInput({ name: 'Valid' }));
      const unreadable = await legacy.create(makeInput({ name: 'Unreadable' }));
      await legacy.close?.();
      const unreadablePath = join(root, 'sessions', unreadable.id, 'session.jsonl');
      // Replace the session file with a directory to provoke EISDIR.
      await rm(unreadablePath);
      await mkdir(unreadablePath);

      const store = createSessionStore(root);
      await assert.rejects(store.list(), (error: NodeJS.ErrnoException) => error.code === 'EISDIR');
      // No metadata or tombstone was written for either session.
      const meta = openMetadata(root);
      assert.equal(await meta.has(valid.id), false);
      assert.equal(await meta.has(unreadable.id), false);
      assert.equal(await meta.isTombstoned(unreadable.id), false);
      meta.close();
      await store.close?.();
    } finally {
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
