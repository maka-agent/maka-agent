import {
  EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
  validateExecutionEvidenceRef,
  type ExecutionEvidenceRef,
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

    const positions = toolFactPositions(item, input);
    if (!positions) continue;
    const low = input.runtimeEvents[positions.low]!;
    const high = input.runtimeEvents[positions.high]!;
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
      runtimeCoverage: {
        lowWater: {
          ledger: 'runtime_event',
          streamId: input.agentRunId,
          sequence: positions.low,
          eventId: low.id,
        },
        highWater: {
          ledger: 'runtime_event',
          streamId: input.agentRunId,
          sequence: positions.high,
          eventId: high.id,
        },
        eventCount: positions.high - positions.low + 1,
      },
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

function toolFactPositions(
  item: HeavyTaskCompactEvidenceEnvelope,
  input: TaskEvidenceRuntimeProvenanceInput,
): { low: number; high: number } | undefined {
  const matching: Array<{ index: number; event: RuntimeEvent }> = [];
  for (let index = 0; index < input.runtimeEvents.length; index += 1) {
    const event = input.runtimeEvents[index]!;
    if (
      event.sessionId === input.sessionId
      && event.invocationId === input.invocationId
      && event.runId === input.agentRunId
      && event.turnId === input.turnId
      && event.refs?.toolCallId === item.source.toolCallId
    ) {
      matching.push({ index, event });
    }
  }
  const result = matching.find(({ event }) => event.content?.kind === 'function_response');
  if (!result || !toolNameMatches(item, result.event)) return undefined;

  const call = matching.find(({ event }) => event.content?.kind === 'function_call');
  if (call && !toolNameMatches(item, call.event)) return undefined;
  return {
    low: call && call.index <= result.index ? call.index : result.index,
    high: result.index,
  };
}

function toolNameMatches(item: HeavyTaskCompactEvidenceEnvelope, event: RuntimeEvent): boolean {
  const expected = item.source.toolName;
  const content = event.content;
  if (!expected || (content?.kind !== 'function_call' && content?.kind !== 'function_response')) return true;
  return content.name.length === 0 || content.name === expected;
}
