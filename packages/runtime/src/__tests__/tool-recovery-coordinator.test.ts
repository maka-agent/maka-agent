import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RUNTIME_FACT_WRITE_CAPABILITY_V1,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';
import { createSqliteRuntimeStore } from '@maka/storage';
import { ToolRecoveryContractRegistry } from '../tool-recovery-contract.js';
import { resolveRuntimeRecovery } from '../recovery-resolver.js';
import {
  reconcileUnsettledToolOperation,
  type ReconcileUnsettledToolOperationInput,
} from '../tool-recovery-coordinator.js';
import type { ToolRecoveryFactCommitInput } from '../tool-recovery-fact-writer.js';

describe('tool recovery coordinator', () => {
  it('settles an interrupted Write in the canonical SQLite ledger end to end', async () => {
    const store = createSqliteRuntimeStore(':memory:');
    try {
      await store.appendRuntimeEvent('session-1', 'run-1', initialEvent());
      await store.commitToolPrepared({
        operationId: 'operation-1',
        journalEventId: 'journal-prepared-1',
        runtimeEvent: functionCallEvent(),
        dispatchRuntimeEvent: dispatchEvent(),
        providerToolCallId: 'call-1',
        toolName: 'Write',
        canonicalArgsHash: 'sha256:original-args',
        recoveryMode: 'reconcile',
        committedAt: 3,
      });
      const result = await reconcileUnsettledToolOperation(
        coordinatorInput(
          [],
          [],
          new ToolRecoveryContractRegistry([
            {
              toolName: 'Write',
              contract: {
                id: 'maka.tool.write.reconcile',
                version: 1,
                mode: 'reconcile_then_decide',
                observe: async () => ({ content: 'expected' }),
                decide: () => ({
                  result: 'applied',
                  reasonCode: 'write_postcondition_matches',
                  nextAction: 'synthesize_response',
                  synthesizedResult: { ok: true, path: 'notes.txt', recovered: true },
                }),
              },
            },
          ]),
          store,
        ),
      );

      assert.equal(result.status, 'reconciled');
      const events = await store.readRuntimeEvents('session-1', 'run-1');
      const resolution = resolveRuntimeRecovery(events);
      assert.equal(resolution.decisions[0]?.disposition, 'completed');
      assert.deepEqual(
        (await store.readToolJournal('operation-1')).map((event) => event.state),
        ['prepared', 'reconcile_recorded', 'outcome_committed', 'recovery_decided'],
      );
      assert.deepEqual(await store.rebuildToolProjectionsFromRuntimeEvents(), {
        operations: 1,
        journalEvents: 4,
      });
    } finally {
      store.close();
    }
  });

  it('observes, decides, and atomically commits reconcile plus decision facts', async () => {
    const commits: ToolRecoveryFactCommitInput[] = [];
    const outcomes: RuntimeEvent[] = [];
    const result = await reconcileUnsettledToolOperation(
      coordinatorInput(
        commits,
        outcomes,
        new ToolRecoveryContractRegistry([
          {
            toolName: 'Write',
            contract: {
              id: 'maka.tool.write.reconcile',
              version: 1,
              mode: 'reconcile_then_decide',
              observe: async () => ({ content: 'secret current contents' }),
              decide: () => ({
                result: 'applied',
                reasonCode: 'write_postcondition_matches',
                nextAction: 'synthesize_response',
                synthesizedResult: { ok: true, path: 'notes.txt', recovered: true },
              }),
            },
          },
        ]),
      ),
    );

    assert.equal(result.status, 'reconciled');
    assert.equal(commits.length, 2);
    assert.equal(commits[0]?.runtimeEvent.actions?.runtimeFact?.kind, 'maka.tool.reconcile_result');
    assert.equal(
      commits[1]?.runtimeEvent.actions?.runtimeFact?.kind,
      'maka.tool.recovery_decision',
    );
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.content?.kind, 'function_response');
    assert.deepEqual(outcomes[0]?.actions?.stateDelta, { toolOutcomeOrigin: 'runtime_recovery' });
    assert.equal(
      (
        commits[1]?.runtimeEvent.actions?.runtimeFact?.payload as
          | { disposition?: string }
          | undefined
      )?.disposition,
      'completed',
    );
    const reconcilePayload = commits[0]?.runtimeEvent.actions?.runtimeFact?.payload as {
      observationDigest?: string;
    };
    assert.match(reconcilePayload.observationDigest ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(commits), /secret current contents/);
    const resolution = resolveRuntimeRecovery([
      initialEvent(),
      functionCallEvent(),
      dispatchEvent(),
      commits[0]!.runtimeEvent,
      outcomes[0]!,
      commits[1]!.runtimeEvent,
    ]);
    assert.deepEqual(resolution.issues, []);
    assert.equal(resolution.decisions[0]?.disposition, 'completed');
    assert.equal(resolution.decisions[0]?.responseRuntimeEventId, 'outcome-event-1');
  });

  it('produces a stable diagnostic and writes no facts when observation fails', async () => {
    const commits: ToolRecoveryFactCommitInput[] = [];
    const outcomes: RuntimeEvent[] = [];
    const result = await reconcileUnsettledToolOperation(
      coordinatorInput(
        commits,
        outcomes,
        new ToolRecoveryContractRegistry([
          {
            toolName: 'Write',
            contract: {
              id: 'maka.tool.write.reconcile',
              version: 1,
              mode: 'reconcile_then_decide',
              observe: async () => {
                throw new Error('EACCES: host-specific detail');
              },
              decide: () => ({ result: 'unknown', reasonCode: 'unknown', nextAction: 'park' }),
            },
          },
        ]),
      ),
    );

    assert.deepEqual(result, {
      status: 'blocked',
      diagnostic: {
        code: 'tool_recovery_observation_failed',
        message: 'tool recovery observation could not be completed',
        toolCallId: 'call-1',
        toolName: 'Write',
        detail: { operationId: 'operation-1' },
      },
    });
    assert.deepEqual(commits, []);
    assert.deepEqual(outcomes, []);
  });
});

function coordinatorInput(
  commits: ToolRecoveryFactCommitInput[],
  outcomes: RuntimeEvent[],
  contracts: ToolRecoveryContractRegistry,
  runtimeEventStore = fakeStore(commits, outcomes),
): ReconcileUnsettledToolOperationInput {
  return {
    contracts,
    runtimeEventStore,
    operation: {
      operationId: 'operation-1',
      toolCallId: 'call-1',
      toolName: 'Write',
      args: { path: 'notes.txt', content: 'expected' },
      recoveryMode: 'reconcile',
      evidenceEventIds: ['call-event-1', 'dispatch-event-1'],
    },
    runtimeIdentity: {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
    },
    newId: (() => {
      let index = 0;
      return () => ['reconcile-event-1', 'outcome-event-1', 'decision-event-1'][index++]!;
    })(),
    now: (() => {
      let value = 10;
      return () => value++;
    })(),
  };
}

function initialEvent(): RuntimeEvent {
  return {
    id: 'initial-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'write it' },
    actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
  };
}

function functionCallEvent(): RuntimeEvent {
  return {
    id: 'call-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'call-1',
      name: 'Write',
      args: { path: 'notes.txt', content: 'expected' },
    },
  };
}

function dispatchEvent(): RuntimeEvent {
  return {
    id: 'dispatch-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 3,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'call-1',
        toolName: 'Write',
        canonicalArgsHash: 'sha256:original-args',
        recoveryMode: 'reconcile',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'call-1' },
  };
}

function fakeStore(
  commits: ToolRecoveryFactCommitInput[],
  outcomes: RuntimeEvent[],
): RuntimeEventStore & {
  commitToolRecoveryBundle(input: {
    operationId: string;
    reconcile: Omit<ToolRecoveryFactCommitInput, 'operationId' | 'state'>;
    outcome?: {
      journalEventId: string;
      runtimeEvent: RuntimeEvent;
      committedAt: number;
    };
    decision: Omit<ToolRecoveryFactCommitInput, 'operationId' | 'state'>;
  }): Promise<unknown>;
} {
  return {
    runtimeFactWriteCapability: RUNTIME_FACT_WRITE_CAPABILITY_V1,
    appendRuntimeEvent: async () => {},
    ensureTerminalRuntimeEventDurable: async () => {},
    readRuntimeEvents: async () => [],
    readSessionRuntimeEvents: async () => [],
    commitToolRecoveryBundle: async (input) => {
      commits.push({
        operationId: input.operationId,
        state: 'reconcile_recorded',
        ...input.reconcile,
      });
      if (input.outcome) outcomes.push(input.outcome.runtimeEvent);
      commits.push({
        operationId: input.operationId,
        state: 'recovery_decided',
        ...input.decision,
      });
    },
  };
}
