import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
      assert.equal(SQLITE_RUNTIME_SCHEMA_VERSION, 5);
      assert.equal(store.schemaVersion(), SQLITE_RUNTIME_SCHEMA_VERSION);
      assert.equal(store.runtimeFactWriteCapability, 'runtime_fact_envelope_v1');
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

  it('round-trips an unknown versioned runtime fact through the capability-gated schema', async () => {
    await withStore(async (store) => {
      const fact: RuntimeEvent = {
        id: 'future-runtime-fact',
        invocationId: 'invocation-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ts: 1,
        partial: false,
        role: 'system',
        author: 'system',
        actions: {
          runtimeFact: {
            kind: 'maka.test.future_fact',
            version: 7,
            legacyProjection: 'invisible',
            payload: { checkpointId: 'checkpoint-1' },
          },
        },
      };

      await store.appendRuntimeEvent('session-1', 'run-1', fact);

      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [fact]);
    });
  });

  it('upgrades a populated schema 4 database to the runtime-fact reader gate without data loss', async () => {
    await withStore(async (store, dbPath) => {
      const event = functionCallEvent();
      await store.appendRuntimeEvent('session-1', 'run-1', event);
      store.close();

      const legacy = new DatabaseSync(dbPath);
      legacy.exec('DROP TABLE runtime_capabilities');
      legacy.exec('PRAGMA user_version = 4');
      legacy.close();

      const upgraded = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(upgraded.schemaVersion(), 5);
        assert.equal(upgraded.runtimeFactWriteCapability, 'runtime_fact_envelope_v1');
        assert.deepEqual(await upgraded.readRuntimeEvents('session-1', 'run-1'), [event]);
      } finally {
        upgraded.close();
      }
    });
  });

  it('fails closed when schema 5 lacks its runtime-fact capability declaration', async () => {
    await withStore(async (store, dbPath) => {
      store.close();
      const corrupted = new DatabaseSync(dbPath);
      corrupted.exec("DELETE FROM runtime_capabilities WHERE capability = 'runtime_fact_envelope'");
      corrupted.close();

      let unexpectedlyOpened: ReturnType<typeof createSqliteRuntimeStore> | undefined;
      try {
        assert.throws(() => {
          unexpectedlyOpened = createSqliteRuntimeStore(dbPath);
        }, /runtime fact envelope capability declaration/i);
      } finally {
        unexpectedlyOpened?.close();
      }
    });
  });

  it('commits function_call, dispatch fact, and operation projection atomically in T1', async () => {
    await withStore(async (store) => {
      const call = functionCallEvent();
      const dispatch = toolDispatchEvent();

      const input = {
        operationId: 'operation-1',
        journalEventId: 'journal-prepared-1',
        runtimeEvent: call,
        dispatchRuntimeEvent: dispatch,
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
        committedAt: 10,
      } as const;
      const result = await store.commitToolPrepared(input);

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 2);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [call, dispatch]);
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
        dispatchEventId: 'dispatch-event-1',
        version: 1,
      });
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.equal((await store.readToolJournal('operation-1'))[0]?.runtimeEventId, dispatch.id);
      assert.deepEqual(
        (await store.listUnsettledToolOperations()).map((operation) => operation.operationId),
        ['operation-1'],
      );
    });
  });

  it('commits prepared mutation facts inside the same T1 transaction before dispatch', async () => {
    await withStore(async (store) => {
      const call = functionCallEvent();
      const preparedMutation: RuntimeEvent = {
        id: 'prepared-file-mutation-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ts: 9,
        partial: false,
        role: 'system',
        author: 'system',
        actions: {
          runtimeFact: {
            kind: 'maka.file.prepared_mutation',
            version: 1,
            legacyProjection: 'invisible',
            payload: { operationId: 'operation-1' },
          },
        },
        refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
      };
      const dispatch = toolDispatchEvent();
      const input = {
        operationId: 'operation-1',
        journalEventId: 'journal-prepared-1',
        runtimeEvent: call,
        preparationRuntimeEvents: [preparedMutation],
        dispatchRuntimeEvent: dispatch,
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe' as const,
        committedAt: 10,
      };

      const result = await store.commitToolPrepared(input);

      assert.equal(result.runtimeEventSeq, 3);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [
        call,
        preparedMutation,
        dispatch,
      ]);
    });
  });

  it('claims an exact function_call that was committed while permission was pending', async () => {
    await withStore(async (store) => {
      const call = functionCallEvent();
      await store.appendRuntimeEvent('session-1', 'run-1', call);

      const result = await commitPrepared(store);

      assert.equal(result.created, true);
      assert.equal(result.runtimeEventSeq, 2);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [
        call,
        toolDispatchEvent(),
      ]);
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
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
          dispatchRuntimeEvent: toolDispatchEvent({
            id: 'dispatch-t1-failure',
            refs: { operationId: 'operation-t1-failure', toolCallId: 'provider-call-1' },
            actions: {
              toolDispatch: {
                protocol: 't1_after_preflight_v1',
                operationId: 'operation-t1-failure',
                providerToolCallId: 'provider-call-1',
                toolName: 'Read',
                canonicalArgsHash: 'sha256:t1-failure',
                recoveryMode: 'replay_safe',
              },
            },
          }),
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
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 0);
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
      assert.equal(result.runtimeEventSeq, 3);
      assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), [
        functionCallEvent(),
        toolDispatchEvent(),
        outcome,
      ]);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 3);
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
        dispatchEventId: 'dispatch-event-1',
        resultEventId: 'response-event-1',
        version: 2,
      });
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared', 'outcome_committed'],
      );
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

      assert.deepEqual(
        (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 2);
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
      assert.equal((await store.readRuntimeEvents('session-1', 'run-1')).length, 3);

      await assert.rejects(
        store.commitToolPrepared({
          operationId: 'operation-1',
          journalEventId: 'journal-prepared-drift',
          runtimeEvent: functionCallEvent(),
          dispatchRuntimeEvent: toolDispatchEvent({
            actions: {
              toolDispatch: {
                protocol: 't1_after_preflight_v1',
                operationId: 'operation-1',
                providerToolCallId: 'provider-call-1',
                toolName: 'Read',
                canonicalArgsHash: 'sha256:different-args',
                recoveryMode: 'replay_safe',
              },
            },
          }),
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

  it('rebuilds disposable tool projections from RuntimeEvent facts', async () => {
    await withStore(async (store) => {
      await commitPrepared(store);
      await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-outcome-1',
        runtimeEvent: functionResponseEvent(),
        committedAt: 20,
      });

      const result = await store.rebuildToolProjectionsFromRuntimeEvents();

      assert.deepEqual(result, { operations: 1, journalEvents: 2 });
      assert.equal(
        (await store.readToolOperation('operation-1'))?.dispatchEventId,
        'dispatch-event-1',
      );
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => ({
          state: event.state,
          runtimeEventId: event.runtimeEventId,
        })),
        [
          { state: 'prepared', runtimeEventId: 'dispatch-event-1' },
          { state: 'outcome_committed', runtimeEventId: 'response-event-1' },
        ],
      );
    });
  });

  it('atomically projects canonical recovery facts and rebuilds the same journal', async () => {
    await withStore(async (store) => {
      await commitPrepared(store);
      const reconcile = toolRecoveryFactEvent({
        id: 'reconcile-event-1',
        ts: 20,
        kind: 'maka.tool.reconcile_result',
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          result: 'applied',
          observationDigest: 'sha256:observation-1',
          observedAt: '2026-07-21T00:00:00.000Z',
          nextAction: 'synthesize_response',
        },
      });
      const decision = toolRecoveryFactEvent({
        id: 'recovery-decision-event-1',
        ts: 21,
        kind: 'maka.tool.recovery_decision',
        payload: {
          protocol: 'tool_recovery_v1',
          operationId: 'operation-1',
          disposition: 'reconcile_required',
          reasonCode: 'reconcile_applied',
          evidenceEventIds: ['call-event-1', 'dispatch-event-1', 'reconcile-event-1'],
        },
      });

      await store.commitToolRecoveryFact({
        operationId: 'operation-1',
        journalEventId: 'journal-reconcile-1',
        state: 'reconcile_recorded',
        runtimeEvent: reconcile,
        committedAt: 20,
      });
      const outcome = functionResponseEvent({ id: 'recovered-response-event-1', ts: 21 });
      await store.commitToolOutcome({
        operationId: 'operation-1',
        journalEventId: 'journal-recovered-outcome-1',
        runtimeEvent: outcome,
        committedAt: 21,
      });
      await store.commitToolRecoveryFact({
        operationId: 'operation-1',
        journalEventId: 'journal-recovery-decision-1',
        state: 'recovery_decided',
        runtimeEvent: decision,
        committedAt: 22,
      });

      const beforeRebuild = await store.readToolJournal('operation-1');
      assert.deepEqual(
        beforeRebuild.map(({ state, runtimeEventId, metadata }) => ({
          state,
          runtimeEventId,
          metadata,
        })),
        [
          { state: 'prepared', runtimeEventId: 'dispatch-event-1', metadata: undefined },
          {
            state: 'reconcile_recorded',
            runtimeEventId: 'reconcile-event-1',
            metadata: reconcile.actions?.runtimeFact,
          },
          {
            state: 'outcome_committed',
            runtimeEventId: 'recovered-response-event-1',
            metadata: undefined,
          },
          {
            state: 'recovery_decided',
            runtimeEventId: 'recovery-decision-event-1',
            metadata: decision.actions?.runtimeFact,
          },
        ],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.version, 4);

      const result = await store.rebuildToolProjectionsFromRuntimeEvents();

      assert.deepEqual(result, { operations: 1, journalEvents: 4 });
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map(
          ({ journalEventId: _, ...record }) => record,
        ),
        beforeRebuild.map(({ journalEventId: _, ...record }) => record),
      );
      assert.equal((await store.readToolOperation('operation-1'))?.version, 4);
    });
  });

  it('rolls back the entire recovery bundle when interrupted after its synthesized outcome', async () => {
    await withStore(async (store, _dbPath, setFailpoint) => {
      await commitPrepared(store);
      const reconcile = toolRecoveryFactEvent({
        id: 'reconcile-bundle-event-1',
        ts: 20,
        kind: 'maka.tool.reconcile_result',
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          result: 'applied',
          observationDigest: 'sha256:observation-1',
          observedAt: '2026-07-21T00:00:00.000Z',
          nextAction: 'synthesize_response',
        },
      });
      const outcome = functionResponseEvent({ id: 'recovered-bundle-response-1', ts: 21 });
      const decision = toolRecoveryFactEvent({
        id: 'recovery-bundle-decision-1',
        ts: 22,
        kind: 'maka.tool.recovery_decision',
        payload: {
          protocol: 'tool_recovery_v1',
          operationId: 'operation-1',
          disposition: 'completed',
          reasonCode: 'reconcile_applied',
          evidenceEventIds: [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-bundle-event-1',
            'recovered-bundle-response-1',
          ],
        },
      });
      setFailpoint('after_recovery_outcome');

      await assert.rejects(
        store.commitToolRecoveryBundle({
          operationId: 'operation-1',
          reconcile: {
            journalEventId: 'journal-reconcile-bundle-1',
            runtimeEvent: reconcile,
            committedAt: 20,
          },
          outcome: {
            journalEventId: 'journal-outcome-bundle-1',
            runtimeEvent: outcome,
            committedAt: 21,
          },
          decision: {
            journalEventId: 'journal-decision-bundle-1',
            runtimeEvent: decision,
            committedAt: 22,
          },
        }),
        /sqlite runtime failpoint: after_recovery_outcome/,
      );

      assert.deepEqual(
        (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['call-event-1', 'dispatch-event-1'],
      );
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared'],
      );
      assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
    });
  });

  it('coalesces stream chunks outside the immutable high-water ledger', async () => {
    await withStore(async (store) => {
      for (const [index, text] of ['hel', 'lo', '!'].entries()) {
        await store.appendRuntimeEvent(
          'session-1',
          'run-1',
          functionCallEvent({
            id: `partial-${index}`,
            ts: index + 1,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text },
            refs: { providerEventId: 'message-1' },
          }),
        );
      }

      const visible = await store.readRuntimeEvents('session-1', 'run-1');
      assert.equal(visible.length, 1);
      assert.deepEqual(visible[0]?.content, { kind: 'text', text: 'hello!' });
      assert.deepEqual(await store.readImmutableRuntimeEvents('session-1', 'run-1'), []);
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 0);
    });
  });

  it('replaces text and tool partial snapshots when their durable final arrives', async () => {
    await withStore(async (store) => {
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'text-partial',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'working' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'tool-partial',
          partial: true,
          role: 'tool',
          author: 'tool',
          content: undefined,
          refs: { toolCallId: 'provider-call-1' },
        }),
      );
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionCallEvent({
          id: 'text-final',
          ts: 2,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'done' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await store.appendRuntimeEvent(
        'session-1',
        'run-1',
        functionResponseEvent({
          refs: { toolCallId: 'provider-call-1' },
        }),
      );

      assert.deepEqual(
        (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['text-final', 'response-event-1'],
      );
      assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 2);
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
    await run(store, dbPath, (point) => {
      failpoint = point;
    });
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
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  };
}

function toolDispatchEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'dispatch-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 10,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: 'sha256:args-1',
        recoveryMode: 'replay_safe',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  };
}

function toolRecoveryFactEvent(input: {
  id: string;
  ts: number;
  kind: 'maka.tool.reconcile_result' | 'maka.tool.recovery_decision';
  payload: Record<string, unknown>;
}): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: input.ts,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      runtimeFact: {
        kind: input.kind,
        version: 1,
        legacyProjection: 'invisible',
        payload: input.payload,
      },
    },
    refs: { operationId: 'operation-1' },
  };
}

function commitPrepared(store: Store) {
  return store.commitToolPrepared({
    operationId: 'operation-1',
    journalEventId: 'journal-prepared-1',
    runtimeEvent: functionCallEvent(),
    dispatchRuntimeEvent: toolDispatchEvent(),
    providerToolCallId: 'provider-call-1',
    toolName: 'Read',
    canonicalArgsHash: 'sha256:args-1',
    recoveryMode: 'replay_safe',
    committedAt: 10,
  });
}
