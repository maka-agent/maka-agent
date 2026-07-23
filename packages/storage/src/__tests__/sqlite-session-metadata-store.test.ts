import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import {
  createSqliteSessionMetadataStore,
  SessionMetadataConflictError,
  type SqliteSessionMetadataStoreFailpoint,
} from '../sqlite-session-metadata-store.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

describe('SqliteSessionMetadataStore', () => {
  test('round-trips every SessionHeader field and reopens the same schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-metadata-'));
    const path = join(root, 'state.sqlite');
    try {
      const store = createSqliteSessionMetadataStore(path, { now: () => 100 });
      const header = fullHeader();
      assert.equal(store.schemaVersion(), 1);
      assert.equal(store.journalMode(), 'wal');
      assert.deepEqual(await store.create(header), {
        header,
        metadataVersion: 1,
        committedAt: 100,
      });
      store.close();

      const reopened = createSqliteSessionMetadataStore(path, { now: () => 200 });
      try {
        assert.equal(reopened.schemaVersion(), 1);
        assert.deepEqual(await reopened.read(header.id), {
          header,
          metadataVersion: 1,
          committedAt: 100,
        });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('coexists with the RuntimeEvent schema in one workspace database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-runtime-database-'));
    const path = join(root, 'runtime.sqlite');
    const runtime = createSqliteRuntimeStore(path);
    const metadata = createSqliteSessionMetadataStore(path);
    try {
      assert.equal(runtime.schemaVersion(), 4);
      assert.equal(metadata.schemaVersion(), 1);
      await metadata.create(fullHeader());
      await runtime.appendRuntimeEvent('session-1', 'run-1', {
        id: 'event-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ts: 1,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
      });
      assert.equal((await metadata.read('session-1')).header.name, 'Session');
      assert.equal((await runtime.readRuntimeEvents('session-1', 'run-1')).length, 1);
    } finally {
      metadata.close();
      runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('filters indexed flags, archive state, and normalized labels in recency order', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.create(
        fullHeader({
          id: 'older',
          name: 'Older',
          lastUsedAt: 10,
          lastMessageAt: 20,
          labels: ['alpha', 'shared'],
          isFlagged: true,
        }),
      );
      await store.create(
        fullHeader({
          id: 'newer',
          name: 'Newer',
          lastUsedAt: 30,
          lastMessageAt: 40,
          labels: ['shared'],
          isFlagged: true,
        }),
      );
      await store.create(
        fullHeader({
          id: 'archived',
          name: 'Archived',
          isArchived: true,
          archivedAt: 50,
          status: 'archived',
          blockedReason: undefined,
          lastMessageAt: 50,
          labels: ['shared'],
        }),
      );

      assert.deepEqual(
        (await store.list({ isArchived: false })).map((record) => record.header.id),
        ['newer', 'older'],
      );
      assert.deepEqual(
        (await store.list({ isArchived: false, isFlagged: true, labelSlug: 'shared' })).map(
          (record) => record.header.id,
        ),
        ['newer', 'older'],
      );
      assert.deepEqual(
        (await store.list({ labelSlug: 'alpha' })).map((record) => record.header.id),
        ['older'],
      );
    } finally {
      store.close();
    }
  });

  test('updates metadata and labels with a compare-and-set version', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNow(10) });
    try {
      await store.create(fullHeader());
      const updated = await store.update(
        'session-1',
        {
          name: 'Renamed',
          labels: ['replacement'],
          hasUnread: false,
          pendingCwdReminder: undefined,
        },
        { expectedVersion: 1 },
      );
      assert.equal(updated.metadataVersion, 2);
      assert.equal(updated.header.name, 'Renamed');
      assert.deepEqual(updated.header.labels, ['replacement']);
      assert.equal(updated.header.pendingCwdReminder, undefined);
      assert.deepEqual(
        (await store.list({ labelSlug: 'replacement' })).map((record) => record.header.id),
        ['session-1'],
      );
      assert.deepEqual(await store.list({ labelSlug: 'alpha' }), []);

      await assert.rejects(
        () => store.update('session-1', { name: 'Stale' }, { expectedVersion: 1 }),
        SessionMetadataConflictError,
      );
      assert.equal((await store.read('session-1')).header.name, 'Renamed');
    } finally {
      store.close();
    }
  });

  test('rolls back row and label changes at every injected transaction failure', async () => {
    for (const failpoint of [
      'after_session_row_write',
      'after_session_labels_write',
    ] satisfies SqliteSessionMetadataStoreFailpoint[]) {
      let armed = true;
      const store = createSqliteSessionMetadataStore(':memory:', {
        failpoint: (point) => {
          if (armed && point === failpoint) throw new Error(`failpoint: ${point}`);
        },
      });
      try {
        await assert.rejects(() => store.create(fullHeader()), /failpoint/);
        await assert.rejects(() => store.read('session-1'), /not found/);

        armed = false;
        await store.create(fullHeader());
        armed = true;
        await assert.rejects(
          () => store.update('session-1', { name: 'Not committed', labels: ['lost'] }),
          /failpoint/,
        );
        const current = await store.read('session-1');
        assert.equal(current.metadataVersion, 1);
        assert.equal(current.header.name, 'Session');
        assert.deepEqual(current.header.labels, ['alpha', 'beta']);
        assert.deepEqual(await store.list({ labelSlug: 'lost' }), []);
      } finally {
        store.close();
      }
    }
  });

  test('imports source-marked metadata idempotently and rejects identity drift', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const entry = {
      header: fullHeader(),
      source: { path: '/workspace/sessions/session-1/session.jsonl', fingerprint: '1:1' },
    };
    try {
      assert.deepEqual(await store.importEntries([entry]), {
        created: [true],
        sourcesAlreadyImported: 0,
      });
      assert.deepEqual(await store.importEntries([entry]), {
        created: [],
        sourcesAlreadyImported: 1,
      });
      await assert.rejects(
        () =>
          store.importEntries([
            {
              ...entry,
              header: fullHeader({ name: 'Changed outside SQLite' }),
              source: { ...entry.source, fingerprint: '2:2' },
            },
          ]),
        SessionMetadataConflictError,
      );
      assert.equal((await store.read('session-1')).header.name, 'Session');
    } finally {
      store.close();
    }
  });

  test('rolls back the whole import batch when a later source marker fails', async () => {
    let markers = 0;
    const store = createSqliteSessionMetadataStore(':memory:', {
      failpoint: (point) => {
        if (point === 'after_session_import_marker_write' && ++markers === 2) {
          throw new Error('second marker failed');
        }
      },
    });
    try {
      await assert.rejects(
        () =>
          store.importEntries([
            {
              header: fullHeader({ id: 'session-1' }),
              source: { path: '/session-1.jsonl', fingerprint: '1:1' },
            },
            {
              header: fullHeader({ id: 'session-2' }),
              source: { path: '/session-2.jsonl', fingerprint: '2:2' },
            },
          ]),
        /second marker failed/,
      );
      assert.deepEqual(await store.list(), []);
    } finally {
      store.close();
    }
  });

  test('deletes metadata and its label projection atomically', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.create(fullHeader());
      assert.equal(await store.remove('session-1'), true);
      assert.equal(await store.remove('session-1'), false);
      assert.deepEqual(await store.list({ labelSlug: 'alpha' }), []);
    } finally {
      store.close();
    }
  });
});

function fullHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace/repo',
    pendingCwdReminder: { from: '/workspace/old', to: '/workspace/repo' },
    createdAt: 1,
    lastUsedAt: 2,
    lastMessageAt: 3,
    name: 'Session',
    titleIsManual: true,
    isFlagged: false,
    labels: ['alpha', 'beta'],
    isArchived: false,
    status: 'blocked',
    blockedReason: 'permission_required',
    statusUpdatedAt: 4,
    parentSessionId: 'parent-session',
    branchOfTurnId: 'branch-turn',
    revisionRootSessionId: 'root-session',
    revisionParentSessionId: 'previous-session',
    revisionOfTurnId: 'revised-turn',
    revisionIndex: 2,
    revisionState: 'committed',
    lastReadMessageId: 'message-1',
    hasUnread: true,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai',
    connectionLocked: true,
    model: 'gpt-5',
    thinkingLevel: 'high',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'swarm',
    schemaVersion: 1,
    ...overrides,
  };
}

function nextNow(start: number): () => number {
  let current = start;
  return () => current++;
}
