import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import { createRuntimeEventStore } from '../agent-run-store.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import {
  exportRuntimeEventsToJsonl,
  importLegacyRuntimeEventJsonlTree,
  importRuntimeEventsFromJsonl,
  openRuntimeEventPersistence,
} from '../runtime-event-transfer.js';

describe('runtime event JSONL compatibility transfer', () => {
  it('imports a legacy runtime tree idempotently into the SQLite canonical store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-runtime-import-'));
    const legacy = createRuntimeEventStore(root);
    const sqlite = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      await legacy.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-1'));
      await legacy.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-2', { ts: 2 }));
      await legacy.appendRuntimeEvent('session-1', 'run-2', runtimeEvent('event-3', {
        invocationId: 'run-2',
        runId: 'run-2',
        turnId: 'turn-2',
        ts: 3,
      }));

      const first = await importLegacyRuntimeEventJsonlTree({ workspaceRoot: root, destination: sqlite });
      const second = await importLegacyRuntimeEventJsonlTree({ workspaceRoot: root, destination: sqlite });

      assert.deepEqual(first, { filesScanned: 2, eventsRead: 3, eventsImported: 3, eventsExisting: 0 });
      assert.deepEqual(second, { filesScanned: 2, eventsRead: 3, eventsImported: 0, eventsExisting: 3 });
      assert.deepEqual(
        (await sqlite.readSessionRuntimeEvents('session-1')).map((event) => event.id),
        ['event-1', 'event-2', 'event-3'],
      );
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-trips explicit JSONL export without creating a second live writer', async () => {
    const sqlite = createSqliteRuntimeStore(':memory:');
    try {
      const events = [runtimeEvent('event-1'), runtimeEvent('event-2', { ts: 2 })];
      for (const event of events) await sqlite.appendRuntimeEvent('session-1', 'run-1', event);

      const jsonl = await exportRuntimeEventsToJsonl(sqlite, 'session-1', 'run-1');
      const destination = createSqliteRuntimeStore(':memory:');
      try {
        const report = await importRuntimeEventsFromJsonl({
          jsonl,
          sessionId: 'session-1',
          runId: 'run-1',
          destination,
        });
        assert.deepEqual(report, { eventsRead: 2, eventsImported: 2, eventsExisting: 0 });
        assert.deepEqual(await destination.readRuntimeEvents('session-1', 'run-1'), events);
      } finally {
        destination.close();
      }
    } finally {
      sqlite.close();
    }
  });

  it('rejects malformed rows and cross-run identity drift', async () => {
    const sqlite = createSqliteRuntimeStore(':memory:');
    try {
      await assert.rejects(
        importRuntimeEventsFromJsonl({
          jsonl: '{not-json}\n',
          sessionId: 'session-1',
          runId: 'run-1',
          destination: sqlite,
        }),
        /Invalid RuntimeEvent JSONL line 1/,
      );
      await assert.rejects(
        importRuntimeEventsFromJsonl({
          jsonl: `${JSON.stringify(runtimeEvent('event-1', { runId: 'other-run' }))}\n`,
          sessionId: 'session-1',
          runId: 'run-1',
          destination: sqlite,
        }),
        /identity mismatch/i,
      );
    } finally {
      sqlite.close();
    }
  });

  it('selects exactly one canonical writer and imports before returning SQLite mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-runtime-persistence-'));
    const legacy = createRuntimeEventStore(root);
    try {
      await legacy.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-1'));

      const opened = await openRuntimeEventPersistence({
        workspaceRoot: root,
        sqliteCanonical: true,
      });
      try {
        assert.equal(opened.kind, 'sqlite');
        assert.ok(opened.runtimeCommitStore);
        assert.strictEqual(opened.runtimeEventStore, opened.runtimeCommitStore);
        assert.equal(opened.importReport?.eventsImported, 1);
        assert.deepEqual(
          (await opened.runtimeEventStore.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['event-1'],
        );
      } finally {
        opened.close();
      }

      const legacyOnly = await openRuntimeEventPersistence({
        workspaceRoot: join(root, 'legacy-only'),
        sqliteCanonical: false,
      });
      assert.equal(legacyOnly.kind, 'jsonl');
      assert.equal(legacyOnly.runtimeCommitStore, undefined);
      legacyOnly.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    invocationId: 'run-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: id },
    ...overrides,
  };
}
