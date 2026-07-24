import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeEvent, RuntimeEventStore } from '@maka/core';
import { RUNTIME_FACT_WRITE_CAPABILITY_V1 } from '@maka/core';
import {
  commitToolReconcileResultFact,
  commitToolRecoveryDecisionFact,
  type ToolRecoveryFactCommitInput,
} from '../tool-recovery-fact-writer.js';

describe('tool recovery canonical fact writer', () => {
  it('rejects a store without the runtime fact capability before append', async () => {
    const appended: RuntimeEvent[] = [];
    const committed: ToolRecoveryFactCommitInput[] = [];
    const store = fakeStore(appended, committed);

    await assert.rejects(
      commitToolRecoveryDecisionFact(writerInput(store)),
      /runtime fact writer capability/i,
    );
    assert.deepEqual(appended, []);
    assert.deepEqual(committed, []);
  });

  it('atomically commits an invisible versioned recovery decision fact and its projection', async () => {
    const appended: RuntimeEvent[] = [];
    const factCommits: ToolRecoveryFactCommitInput[] = [];
    const store = fakeStore(appended, factCommits, RUNTIME_FACT_WRITE_CAPABILITY_V1);

    const committed = await commitToolRecoveryDecisionFact(writerInput(store));

    assert.equal(committed.id, 'recovery-event-1');
    assert.deepEqual(appended, []);
    assert.deepEqual(factCommits, [
      {
        operationId: 'operation-1',
        journalEventId: 'recovery-event-1_journal',
        state: 'recovery_decided',
        runtimeEvent: committed,
        committedAt: 10,
      },
    ]);
    assert.deepEqual(committed.actions?.runtimeFact, {
      kind: 'maka.tool.recovery_decision',
      version: 1,
      legacyProjection: 'invisible',
      payload: {
        protocol: 'tool_recovery_v1',
        operationId: 'operation-1',
        disposition: 'parked',
        reasonCode: 'manual_recovery_required',
        evidenceEventIds: ['call-1', 'dispatch-1'],
      },
    });
    assert.deepEqual(committed.refs, { operationId: 'operation-1' });
  });

  it('atomically commits a canonical reconcile result fact', async () => {
    const factCommits: ToolRecoveryFactCommitInput[] = [];
    const store = fakeStore([], factCommits, RUNTIME_FACT_WRITE_CAPABILITY_V1);

    const committed = await commitToolReconcileResultFact({
      runtimeEventStore: store,
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      eventId: 'reconcile-event-1',
      ts: 11,
      fact: {
        protocol: 'tool_reconcile_v1',
        operationId: 'operation-1',
        result: 'not_applied',
        observationDigest: 'sha256:observation-1',
        observedAt: '2026-07-21T00:00:00.000Z',
        nextAction: 'retry_allowed',
      },
    });

    assert.equal(committed.actions?.runtimeFact?.kind, 'maka.tool.reconcile_result');
    assert.equal(factCommits[0]?.state, 'reconcile_recorded');
    assert.equal(factCommits[0]?.runtimeEvent, committed);
  });
});

function writerInput(store: RuntimeEventStore) {
  return {
    runtimeEventStore: store,
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    eventId: 'recovery-event-1',
    ts: 10,
    fact: {
      protocol: 'tool_recovery_v1' as const,
      operationId: 'operation-1',
      disposition: 'parked' as const,
      reasonCode: 'manual_recovery_required' as const,
      evidenceEventIds: ['call-1', 'dispatch-1'],
    },
  };
}

function fakeStore(
  appended: RuntimeEvent[],
  factCommits: ToolRecoveryFactCommitInput[],
  capability?: typeof RUNTIME_FACT_WRITE_CAPABILITY_V1,
): RuntimeEventStore & {
  commitToolRecoveryFact(input: ToolRecoveryFactCommitInput): Promise<unknown>;
} {
  return {
    ...(capability ? { runtimeFactWriteCapability: capability } : {}),
    appendRuntimeEvent: async (_sessionId, _runId, event) => {
      appended.push(event);
    },
    commitToolRecoveryFact: async (input) => {
      factCommits.push(input);
      return { created: true, runtimeEventSeq: 1 };
    },
    ensureTerminalRuntimeEventDurable: async () => {},
    readRuntimeEvents: async () => [],
    readSessionRuntimeEvents: async () => [],
  };
}
