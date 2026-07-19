import {
  EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
  validateExecutionEvidenceRef,
  type ExecutionEvidenceRef,
  type ExecutionLogCoverage,
} from '@maka/core/execution-evidence';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { HeavyTaskCompactEvidenceEnvelope } from './task-contracts.js';

export interface TaskEvidenceRuntimeProvenanceInput {
  taskRunId: string;
  attemptId: string;
  sessionId: string;
  invocationId: string;
  agentRunId: string;
  turnId: string;
  runtimeEvents: readonly RuntimeEvent[];
  evidence: readonly HeavyTaskCompactEvidenceEnvelope[];
}

export interface TaskEvidenceRuntimeProvenanceLink {
  evidenceId: string;
  attemptId: string;
  provenance: ExecutionEvidenceRef;
}

/**
 * Resolve compact Task evidence to the immutable Runtime call/result range.
 *
 * The compact envelope keeps bounded display data. The returned reference
 * points back to the canonical function_call/function_response facts without
 * copying either Runtime payload into the Task Event ledger.
 */
export function taskEvidenceRuntimeProvenanceLinks(
  input: TaskEvidenceRuntimeProvenanceInput,
): TaskEvidenceRuntimeProvenanceLink[] {
  const links: TaskEvidenceRuntimeProvenanceLink[] = [];
  for (const item of input.evidence) {
    if (item.provenance || !evidenceBelongsToInvocation(item, input)) continue;

    const runtimeCoverage = runtimeToolFactCoverage({
      sessionId: input.sessionId,
      invocationId: input.invocationId,
      agentRunId: input.agentRunId,
      turnId: input.turnId,
      runtimeEvents: input.runtimeEvents,
      toolCallId: item.source.toolCallId,
      toolName: item.source.toolName,
    });
    if (!runtimeCoverage) continue;
    const provenance: ExecutionEvidenceRef = {
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      execution: {
        sessionId: input.sessionId,
        invocationId: input.invocationId,
        agentRunId: input.agentRunId,
        turnId: input.turnId,
      },
      task: {
        taskRunId: input.taskRunId,
        attemptId: item.attemptId ?? input.attemptId,
      },
      runtimeCoverage,
    };
    const validation = validateExecutionEvidenceRef(provenance);
    if (!validation.ok) {
      throw new Error(
        `invalid task evidence provenance: ${validation.errors
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    links.push({
      evidenceId: item.evidenceId,
      attemptId: item.attemptId ?? input.attemptId,
      provenance: validation.value,
    });
  }
  return links;
}

function evidenceBelongsToInvocation(
  item: HeavyTaskCompactEvidenceEnvelope,
  input: TaskEvidenceRuntimeProvenanceInput,
): boolean {
  if (item.taskRunId !== input.taskRunId) return false;
  if (item.attemptId && item.attemptId !== input.attemptId) return false;
  if (item.source.sessionId && item.source.sessionId !== input.sessionId) return false;
  if (item.source.agentRunId && item.source.agentRunId !== input.agentRunId) return false;
  if (item.source.turnId && item.source.turnId !== input.turnId) return false;
  return true;
}

export function runtimeToolFactCoverage(input: {
  sessionId: string;
  invocationId: string;
  agentRunId: string;
  turnId: string;
  runtimeEvents: readonly RuntimeEvent[];
  toolCallId: string;
  toolName?: string;
  requireCall?: boolean;
}): ExecutionLogCoverage | undefined {
  const matching: Array<{ index: number; event: RuntimeEvent }> = [];
  for (let index = 0; index < input.runtimeEvents.length; index += 1) {
    const event = input.runtimeEvents[index]!;
    if (
      event.sessionId === input.sessionId &&
      event.invocationId === input.invocationId &&
      event.runId === input.agentRunId &&
      event.turnId === input.turnId &&
      event.refs?.toolCallId === input.toolCallId
    ) {
      matching.push({ index, event });
    }
  }
  const results = matching.filter(({ event }) => event.content?.kind === 'function_response');
  if (results.length !== 1) return undefined;
  const result = results[0]!;
  if (!toolNameMatches(input.toolName, result.event)) return undefined;

  const calls = matching.filter(({ event }) => event.content?.kind === 'function_call');
  if (calls.length > 1) return undefined;
  const call = calls[0];
  if (call && (call.index > result.index || !toolNameMatches(input.toolName, call.event)))
    return undefined;
  if (!call && input.requireCall) return undefined;
  const low = call ?? result;
  return {
    lowWater: {
      ledger: 'runtime_event',
      streamId: input.agentRunId,
      sequence: low.index,
      eventId: low.event.id,
    },
    highWater: {
      ledger: 'runtime_event',
      streamId: input.agentRunId,
      sequence: result.index,
      eventId: result.event.id,
    },
    eventCount: result.index - low.index + 1,
  };
}

function toolNameMatches(expected: string | undefined, event: RuntimeEvent): boolean {
  const content = event.content;
  if (!expected || (content?.kind !== 'function_call' && content?.kind !== 'function_response'))
    return true;
  return content.name.length === 0 || content.name === expected;
}
