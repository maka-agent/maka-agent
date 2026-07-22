import {
  RUNTIME_FACT_WRITE_CAPABILITY_V1,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';
import {
  TOOL_RECOVERY_DECISION_FACT_KIND,
  TOOL_RECOVERY_FACT_VERSION,
  TOOL_RECONCILE_RESULT_FACT_KIND,
  parseToolRecoveryFact,
  type ToolRecoveryDecisionFact,
  type ToolReconcileResultFact,
} from './tool-recovery-facts.js';

export interface ToolRecoveryFactCommitInput {
  operationId: string;
  journalEventId: string;
  state: 'reconcile_recorded' | 'recovery_decided';
  runtimeEvent: RuntimeEvent;
  committedAt: number;
}

export interface ToolRecoveryFactCommitStore extends RuntimeEventStore {
  commitToolRecoveryFact(input: ToolRecoveryFactCommitInput): Promise<unknown>;
}

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
  const event = createToolRecoveryDecisionFactEvent(input);
  await commitToolRecoveryFact({
    ...input,
    operationId: input.fact.operationId,
    state: 'recovery_decided',
    event,
  });
  return event;
}

export function createToolRecoveryDecisionFactEvent(
  input: Omit<CommitToolRecoveryDecisionFactInput, 'runtimeEventStore'>,
): RuntimeEvent {
  return createToolRecoveryFactEvent({
    ...input,
    kind: TOOL_RECOVERY_DECISION_FACT_KIND,
    expectedParseStatus: 'recovery_decision',
  });
}

export interface CommitToolReconcileResultFactInput {
  runtimeEventStore: RuntimeEventStore;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  eventId: string;
  ts: number;
  fact: ToolReconcileResultFact;
}

export async function commitToolReconcileResultFact(
  input: CommitToolReconcileResultFactInput,
): Promise<RuntimeEvent> {
  const event = createToolReconcileResultFactEvent(input);
  await commitToolRecoveryFact({
    ...input,
    operationId: input.fact.operationId,
    state: 'reconcile_recorded',
    event,
  });
  return event;
}

export function createToolReconcileResultFactEvent(
  input: Omit<CommitToolReconcileResultFactInput, 'runtimeEventStore'>,
): RuntimeEvent {
  return createToolRecoveryFactEvent({
    ...input,
    kind: TOOL_RECONCILE_RESULT_FACT_KIND,
    expectedParseStatus: 'reconcile_result',
  });
}

async function commitToolRecoveryFact(input: {
  runtimeEventStore: RuntimeEventStore;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  operationId: string;
  state: ToolRecoveryFactCommitInput['state'];
  event: RuntimeEvent;
}): Promise<void> {
  if (input.runtimeEventStore.runtimeFactWriteCapability !== RUNTIME_FACT_WRITE_CAPABILITY_V1) {
    throw new Error('Runtime fact writer capability is unavailable for tool recovery facts');
  }
  if (!isToolRecoveryFactCommitStore(input.runtimeEventStore)) {
    throw new Error('Atomic tool recovery fact projection capability is unavailable');
  }
  await input.runtimeEventStore.commitToolRecoveryFact({
    operationId: input.operationId,
    journalEventId: `${input.event.id}_journal`,
    state: input.state,
    runtimeEvent: input.event,
    committedAt: input.event.ts,
  });
}

function createToolRecoveryFactEvent(input: {
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  eventId: string;
  ts: number;
  fact: ToolRecoveryDecisionFact | ToolReconcileResultFact;
  kind: typeof TOOL_RECOVERY_DECISION_FACT_KIND | typeof TOOL_RECONCILE_RESULT_FACT_KIND;
  expectedParseStatus: 'recovery_decision' | 'reconcile_result';
}): RuntimeEvent {
  const runtimeFact = {
    kind: input.kind,
    version: TOOL_RECOVERY_FACT_VERSION,
    legacyProjection: 'invisible' as const,
    payload: input.fact,
  };
  if (parseToolRecoveryFact(runtimeFact).status !== input.expectedParseStatus) {
    throw new Error('Invalid canonical tool recovery fact');
  }
  return {
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
}

function isToolRecoveryFactCommitStore(
  store: RuntimeEventStore,
): store is ToolRecoveryFactCommitStore {
  return (
    'commitToolRecoveryFact' in store &&
    typeof (store as { commitToolRecoveryFact?: unknown }).commitToolRecoveryFact === 'function'
  );
}
