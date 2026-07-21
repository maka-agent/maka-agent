import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeEvent, RuntimeEventStore } from '@maka/core';
import { RUNTIME_FACT_WRITE_CAPABILITY_V1 } from '@maka/core';
import { commitToolRecoveryDecisionFact } from '../tool-recovery-fact-writer.js';

describe('tool recovery canonical fact writer', () => {
  it('rejects a store without the runtime fact capability before append', async () => {
    const appended: RuntimeEvent[] = [];
    const store = fakeStore(appended);

    await assert.rejects(
      commitToolRecoveryDecisionFact(writerInput(store)),
      /runtime fact writer capability/i,
    );
    assert.deepEqual(appended, []);
  });

  it('durably appends an invisible versioned recovery decision fact', async () => {
    const appended: RuntimeEvent[] = [];
    const store = fakeStore(appended, RUNTIME_FACT_WRITE_CAPABILITY_V1);

    const committed = await commitToolRecoveryDecisionFact(writerInput(store));

    assert.equal(committed.id, 'recovery-event-1');
    assert.deepEqual(appended, [committed]);
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
  capability?: typeof RUNTIME_FACT_WRITE_CAPABILITY_V1,
): RuntimeEventStore {
  return {
    ...(capability ? { runtimeFactWriteCapability: capability } : {}),
    appendRuntimeEvent: async (_sessionId, _runId, event) => {
      appended.push(event);
    },
    ensureTerminalRuntimeEventDurable: async () => {},
    readRuntimeEvents: async () => [],
    readSessionRuntimeEvents: async () => [],
  };
}
