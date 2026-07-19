import {
  EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
  validateExecutionEvidenceRef,
  type ExecutionEvidenceRef,
} from '@maka/core/execution-evidence';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  HeavyTaskSelfCheckEvidenceLinkedEvent,
  HeavyTaskSelfCheckRecordedEvent,
  HeavyTaskWorkspaceObservationRecordedEvent,
} from './task-contracts.js';
import type { TaskEventLedgerEntry } from './task-run-store.js';
import { runtimeToolFactCoverage } from './task-evidence-provenance.js';

export interface SelfCheckEvidenceBindingInput {
  taskRunId: string;
  attemptId: string;
  sessionId: string;
  invocationId: string;
  agentRunId: string;
  turnId: string;
  runtimeEvents: readonly RuntimeEvent[];
  selfCheckRecord: TaskEventLedgerEntry & { event: HeavyTaskSelfCheckRecordedEvent };
  workspaceObservation: HeavyTaskWorkspaceObservationRecordedEvent;
}

export type SelfCheckEvidenceBindingResult =
  | {
      ok: true;
      link: Omit<HeavyTaskSelfCheckEvidenceLinkedEvent, 'id' | 'ts'>;
    }
  | { ok: false; reason: string };

/**
 * Bind a durable Self-check assertion to canonical executor facts, the exact
 * Task Event row that recorded it, and a post-invocation workspace manifest.
 */
export function bindSelfCheckEvidence(
  input: SelfCheckEvidenceBindingInput,
): SelfCheckEvidenceBindingResult {
  const selfCheck = input.selfCheckRecord.event.selfCheck;
  const observation = input.workspaceObservation.observation;
  if (
    selfCheck.taskRunId !== input.taskRunId ||
    input.selfCheckRecord.event.taskRunId !== input.taskRunId
  ) {
    return { ok: false, reason: 'Self-check does not belong to the TaskRun' };
  }
  if (selfCheck.attemptId !== input.attemptId) {
    return { ok: false, reason: 'Self-check does not belong to the attempt' };
  }
  if (
    (selfCheck.source.sessionId && selfCheck.source.sessionId !== input.sessionId) ||
    (selfCheck.source.agentRunId && selfCheck.source.agentRunId !== input.agentRunId) ||
    (selfCheck.source.turnId && selfCheck.source.turnId !== input.turnId)
  ) {
    return { ok: false, reason: 'Self-check source does not match the Runtime invocation' };
  }
  if (
    observation.taskRunId !== input.taskRunId ||
    input.workspaceObservation.taskRunId !== input.taskRunId ||
    observation.status !== 'ok' ||
    !observation.revision
  ) {
    return { ok: false, reason: 'A successful workspace manifest revision is required' };
  }

  const runtimeCoverage = runtimeToolFactCoverage({
    sessionId: input.sessionId,
    invocationId: input.invocationId,
    agentRunId: input.agentRunId,
    turnId: input.turnId,
    runtimeEvents: input.runtimeEvents,
    toolCallId: selfCheck.source.toolCallId,
    toolName: 'self_check_submit',
    requireCall: true,
  });
  if (!runtimeCoverage) {
    return { ok: false, reason: 'Matching Self-check function call and response are required' };
  }

  const provenance: ExecutionEvidenceRef = {
    schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
    execution: {
      sessionId: input.sessionId,
      invocationId: input.invocationId,
      agentRunId: input.agentRunId,
      turnId: input.turnId,
    },
    task: { taskRunId: input.taskRunId, attemptId: input.attemptId },
    runtimeCoverage,
    taskCoverage: {
      highWater: input.selfCheckRecord.cursor,
      eventCount: input.selfCheckRecord.cursor.sequence + 1,
    },
    workspace: observation.revision,
  };
  const validation = validateExecutionEvidenceRef(provenance);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    };
  }
  return {
    ok: true,
    link: {
      type: 'heavy_task_self_check_evidence_linked',
      taskRunId: input.taskRunId,
      selfCheckId: selfCheck.selfCheckId,
      attemptId: input.attemptId,
      workspaceObservationId: observation.observationId,
      provenance: validation.value,
    },
  };
}
