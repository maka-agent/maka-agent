import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import {
  SQLITE_RUNTIME_SCHEMA_VERSION,
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreFailpoint,
} from '../sqlite-runtime-store.js';

describe('SqliteRuntimeStore', () => {
  it('applies versioned migrations and reopens the same database without rewriting schema', async () => {
    await withStore(async (store, dbPath) => {
      assert.equal(store.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
      assert.equal(store.journalMode(), 'wal');
      assert.equal(store.foreignKeysEnabled(), true);
      store.close();

      const reopened = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(reopened.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
        assert.deepEqual(await reopened.readRuntimeEvents('session-1', 'run-1'), []);
      } finally {
        reopened.close();
      }
    });
  });

  it('commits function_call, prepared journal fact, and operation projection atomically in T1', async () => {
    await withStore(async (store) => {
      const call = functionCallEvent();

      const result = await store.commitToolPrepared({
        operationId: 'operation-1',
        journalEventId: 'journal-prepared-1',
        runtimeEvent: call,
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
        committedAt: 10,
      });

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 1);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [call]);
      assert.equal(await store.runtimeHighWater('invocation-1'), 1);
      assert.deepEqual(await store.readToolOperation('operation-1'), {
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
        currentState: 'prepared',
        callEventId: 'call-event-1',
        version: 1,
      });
      assert.deepEqual((await store.readToolJournal('operation-1')).map((event) => event.state), [
        'prepared',
      ]);
      assert.deepEqual(
        (await store.listUnsettledToolOperations()).map((operation) => operation.operationId),
        ['operation-1'],
      );
    });
  });

  it('rolls back every T1 row when failure occurs after the RuntimeEvent insert', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      setFailpoint('after_runtime_event_insert');

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-t1-failure',
          journalEventId: 'journal-t1-failure',
          runtimeEvent: functionCallEvent({ id: 'call-t1-failure' }),
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: 'sha256:t1-failure',
          recoveryMode: 'replay_safe',
          committedAt: 11,
        }),
        /sqlite runtime failpoint: after_runtime_event_insert/,
      );

      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), []);
      assert.equal(await store.readToolOperation('operation-t1-failure'), undefined);
      assert.deepEqual(await store.readToolJournal('operation-t1-failure'), []);
      assert.equal(await store.runtimeHighWater('invocation-1'), 0);
    });
  });

  it('commits function_response, outcome journal fact, and projection atomically in T2', async () => {
    await withStore(async (store) => {
      await commitPrepared(store);
      const outcome = functionResponseEvent();

      const result = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-outcome-1',
        runtimeEvent: outcome,
        committedAt: 20,
      });

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 2);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [
        functionCallEvent(),
        outcome,
      ]);
      assert.equal(await store.runtimeHighWater('invocation-1'), 2);
      assert.deepEqual(await store.readToolOperation('operation-1'), {
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
        currentState: 'outcome_committed',
        callEventId: 'call-event-1',
        resultEventId: 'response-event-1',
        version: 2,
      });
      assert.deepEqual((await store.readToolJournal('operation-1')).map((event) => event.state), [
        'prepared',
        'outcome_committed',
      ]);
      assert.deepEqual(await store.listUnsettledToolOperations(), []);
    });
  });

  it('rolls back T2 without hiding the previously committed prepared boundary', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      await commitPrepared(store);
      setFailpoint('after_runtime_event_insert');

      await assert.rejects(
        store.commitToolOutcome({
          operationId: 'operation-1',
          journalEventId: 'journal-outcome-failure',
          runtimeEvent: functionResponseEvent({ id: 'response-t2-failure' }),
          committedAt: 21,
        }),
        /sqlite runtime failpoint: after_runtime_event_insert/,
      );

      assert.deepEqual((await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id), [
        'call-event-1',
      ]);
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      assert.deepEqual((await store.readToolJournal('operation-1')).map((event) => event.state), [
        'prepared',
      ]);
      assert.equal(await store.runtimeHighWater('invocation-1'), 1);
    });
  });

  it('deduplicates exact T1/T2 retries and rejects operation identity drift', async () => {
    await withStore(async (store) => {
      const firstPrepared = await commitPrepared(store);
      const duplicatePrepared = await commitPrepared(store);
      assert.equal(firstPrepared.created, true);
      assert.equal(duplicatePrepared.created, false);

      const firstOutcome = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-outcome-1',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });
      const duplicateOutcome = await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-outcome-1',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });
      assert.equal(firstOutcome.created, true);
      assert.equal(duplicateOutcome.created, false);
      assert.equal((await store.readToolJournal('operation-1')).length, 2);
      assert.equal((await store.readRuntimeEvents('session-1', 'run-1')).length, 2);

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'journal-prepared-drift',
          runtimeEvent: functionCallEvent(),
          providerToolCallId: 'provider-call-1',
          toolName: 'Read',
          canonicalArgsHash: 'sha256:different-args',
          recoveryMode: 'replay_safe',
          committedAt: 30,
        }),
        /operation identity conflict/,
      );
    });
  });

  it('coalesces stream chunks outside the immutable high-water ledger', async () => {
    await withStore(async (store) => {
      for (const [index, text] of ['hel', 'lo', '!'].entries()) {
        await store.appendRuntimeEvent('session-1', 'run-1', functionCallEvent({
          id: `partial-${index}`,
          ts: index + 1,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text },
          refs: { providerEventId: 'message-1' },
        }));
      }

      const visible = await store.readRuntimeEvents('session-1', 'run-1');
      assert.equal(visible.length, 1);
      assert.deepEqual(visible[0]?.content, { kind: 'text', text: 'hello!' });
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
      assert.equal(await store.runtimeHighWater('invocation-1'), 0);
    });
  });

  it('replaces text and tool partial snapshots when their durable final arrives', async () => {
    await withStore(async (store) => {
      await store.appendRuntimeEvent('session-1', 'run-1', functionCallEvent({
        id: 'text-partial',
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'working' },
        refs: { providerEventId: 'message-1' },
      }));
      await store.appendRuntimeEvent('session-1', 'run-1', functionCallEvent({
        id: 'tool-partial',
        partial: true,
        role: 'tool',
        author: 'tool',
        content: undefined,
        refs: { toolCallId: 'provider-call-1' },
      }));
      await store.appendRuntimeEvent('session-1', 'run-1', functionCallEvent({
        id: 'text-final',
        ts: 2,
        partial: false,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'done' },
        refs: { providerEventId: 'message-1' },
      }));
      await store.appendRuntimeEvent('session-1', 'run-1', functionResponseEvent({
        refs: { toolCallId: 'provider-call-1' },
      }));

      assert.deepEqual(
        (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['text-final', 'response-event-1'],
      );
      assert.equal(await store.runtimeHighWater('invocation-1'), 2);
    });
  });
});

type Store = ReturnType<typeof createSqliteRuntimeStore>;

async function withStore(
  run: (
    store: Store,
    dbPath: string,
    setFailpoint: (point: SqliteRuntimeStoreFailpoint | undefined) => void,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-runtime-'));
  const dbPath = join(root, 'runtime.sqlite');
  let failpoint: SqliteRuntimeStoreFailpoint | undefined;
  const store = createSqliteRuntimeStore(dbPath, {
    failpoint: (point) => {
      if (failpoint === point) throw new Error(`sqlite runtime failpoint: ${point}`);
    },
  });
  try {
    await run(store, dbPath, (point) => { failpoint = point; });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function functionCallEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'call-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Read',
      args: { path: '/workspace/repo/README.md' },
    },
    ...overrides,
  };
}

function functionResponseEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'response-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Read',
      result: 'contents',
    },
    ...overrides,
  };
}

function commitPrepared(store: Store) {
  return store.commitToolPrepared({
    operationId: 'operation-1',
    journalEventId: 'journal-prepared-1',
    runtimeEvent: functionCallEvent(),
    providerToolCallId: 'provider-call-1',
    toolName: 'Read',
    canonicalArgsHash: 'sha256:args-1',
    recoveryMode: 'replay_safe',
    committedAt: 10,
  });
}
