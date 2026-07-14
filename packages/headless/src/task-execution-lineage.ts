import {
  EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
  validateExecutionEvidenceRef,
  type ExecutionEvidenceRef,
} from '@maka/core/execution-evidence';
import type { RuntimeEvent } from '@maka/core/runtime-event';

export interface TaskAttemptExecutionEvidenceInput {
  taskRunId: string;
  attemptId: string;
  sessionId: string;
  agentRunId: string;
  invocationId?: string;
  turnId?: string;
  /** Immutable Runtime Events read from the persisted AgentRun stream in append order. */
  runtimeEvents: readonly RuntimeEvent[];
}

/**
 * Build a Task-to-Runtime lineage reference without copying Runtime facts.
 *
 * The input is the physical immutable append stream, so its zero-based indexes
 * are stable cursor sequences. Some immutable lifecycle rows may still carry
 * `partial: true`; callers must exclude mutable partial snapshot files by
 * reading the RuntimeEventStore immutable stream.
 */
export function taskAttemptExecutionEvidence(
  input: TaskAttemptExecutionEvidenceInput,
): ExecutionEvidenceRef {
  const durableEvents = input.runtimeEvents;
  for (const event of durableEvents) assertRuntimeIdentity(event, input);

  const first = durableEvents[0];
  const last = durableEvents.at(-1);
  const ref: ExecutionEvidenceRef = {
    schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
    execution: {
      sessionId: input.sessionId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      agentRunId: input.agentRunId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
    task: {
      taskRunId: input.taskRunId,
      attemptId: input.attemptId,
    },
    ...(first && last
      ? {
          runtimeCoverage: {
            lowWater: {
              ledger: 'runtime_event',
              streamId: input.agentRunId,
              sequence: 0,
              eventId: first.id,
            },
            highWater: {
              ledger: 'runtime_event',
              streamId: input.agentRunId,
              sequence: durableEvents.length - 1,
              eventId: last.id,
            },
            eventCount: durableEvents.length,
          },
        }
      : {}),
  };

  const validation = validateExecutionEvidenceRef(ref);
  if (!validation.ok) {
    throw new Error(
      `invalid task execution lineage: ${validation.errors
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return validation.value;
}

function assertRuntimeIdentity(
  event: RuntimeEvent,
  input: TaskAttemptExecutionEvidenceInput,
): void {
  if (event.sessionId !== input.sessionId) {
    throw new Error(`RuntimeEvent ${event.id} sessionId does not match lineage sessionId`);
  }
  if (event.runId !== input.agentRunId) {
    throw new Error(`RuntimeEvent ${event.id} runId does not match lineage agentRunId`);
  }
  if (input.invocationId && event.invocationId !== input.invocationId) {
    throw new Error(`RuntimeEvent ${event.id} invocationId does not match lineage invocationId`);
  }
  if (input.turnId && event.turnId !== input.turnId) {
    throw new Error(`RuntimeEvent ${event.id} turnId does not match lineage turnId`);
  }
}
