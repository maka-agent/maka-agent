import {
  RUNTIME_FACT_WRITE_CAPABILITY_V1,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';
import {
  TOOL_RECOVERY_DECISION_FACT_KIND,
  TOOL_RECOVERY_FACT_VERSION,
  parseToolRecoveryFact,
  type ToolRecoveryDecisionFact,
} from './tool-recovery-facts.js';

export interface CommitToolRecoveryDecisionFactInput {
  runtimeEventStore: RuntimeEventStore;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  eventId: string;
  ts: number;
  fact: ToolRecoveryDecisionFact;
}

export async function commitToolRecoveryDecisionFact(
  input: CommitToolRecoveryDecisionFactInput,
): Promise<RuntimeEvent> {
  if (input.runtimeEventStore.runtimeFactWriteCapability !== RUNTIME_FACT_WRITE_CAPABILITY_V1) {
    throw new Error('Runtime fact writer capability is unavailable for tool recovery decisions');
  }
  const runtimeFact = {
    kind: TOOL_RECOVERY_DECISION_FACT_KIND,
    version: TOOL_RECOVERY_FACT_VERSION,
    legacyProjection: 'invisible' as const,
    payload: input.fact,
  };
  if (parseToolRecoveryFact(runtimeFact).status !== 'recovery_decision') {
    throw new Error('Invalid canonical tool recovery decision fact');
  }
  const event: RuntimeEvent = {
    id: input.eventId,
    sessionId: input.sessionId,
    invocationId: input.invocationId,
    runId: input.runId,
    turnId: input.turnId,
    ts: input.ts,
    partial: false,
    role: 'system',
    author: 'system',
    actions: { runtimeFact },
    refs: { operationId: input.fact.operationId },
  };
  await input.runtimeEventStore.appendRuntimeEvent(input.sessionId, input.runId, event, {
    durable: true,
  });
  return event;
}
