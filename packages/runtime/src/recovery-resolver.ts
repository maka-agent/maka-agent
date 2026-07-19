import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type ToolBoundaryProtocol,
} from '@maka/core/runtime-event';

export type ToolRecoveryDecisionStatus =
  | 'completed'
  | 'definitely_not_dispatched'
  | 'indeterminate'
  | 'corruption';

export type ToolRecoveryDecisionReason =
  | 'matching_response'
  | 'dispatch_without_response'
  | 'new_protocol_before_dispatch'
  | 'legacy_dispatch_unknown'
  | 'orphan_dispatch'
  | 'orphan_response'
  | 'duplicate_dispatch'
  | 'duplicate_response'
  | 'identity_conflict'
  | 'protocol_marker_invalid';

export interface ToolRecoveryDecision {
  toolCallId: string;
  toolName?: string;
  operationId?: string;
  status: ToolRecoveryDecisionStatus;
  reason: ToolRecoveryDecisionReason;
  callRuntimeEventId?: string;
  dispatchRuntimeEventId?: string;
  responseRuntimeEventId?: string;
  responseIsError?: boolean;
}

export interface RuntimeRecoveryResolution {
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  decisions: ToolRecoveryDecision[];
  issues: Array<{
    code: 'protocol_marker_invalid';
    eventId: string;
  }>;
  hasCorruption: boolean;
  requiresReconciliation: boolean;
}

export function resolveRuntimeRecovery(
  events: readonly RuntimeEvent[],
): RuntimeRecoveryResolution {
  const firstProtocol = events[0]?.actions?.runtimeProtocol;
  const toolBoundaryProtocol = firstProtocol?.toolBoundary === TOOL_BOUNDARY_PROTOCOL_V1
    ? TOOL_BOUNDARY_PROTOCOL_V1
    : undefined;
  const issues: RuntimeRecoveryResolution['issues'] = [];
  if (firstProtocol !== undefined && toolBoundaryProtocol === undefined && events[0]) {
    issues.push({
      code: 'protocol_marker_invalid' as const,
      eventId: events[0].id,
    });
  }
  issues.push(...events.slice(1)
    .filter((event) => event.actions?.runtimeProtocol !== undefined)
    .map((event) => ({ code: 'protocol_marker_invalid' as const, eventId: event.id })));
  const decisions: ToolRecoveryDecision[] = [];
  const decisionsByToolCallId = new Map<string, ToolRecoveryDecision>();
  for (const event of events) {
    if (event.partial || event.content?.kind !== 'function_call') continue;
    const decision: ToolRecoveryDecision = {
      toolCallId: event.content.id,
      toolName: event.content.name,
      status: toolBoundaryProtocol
        ? 'definitely_not_dispatched'
        : 'indeterminate',
      reason: toolBoundaryProtocol
        ? 'new_protocol_before_dispatch'
        : 'legacy_dispatch_unknown',
      callRuntimeEventId: event.id,
    };
    decisions.push(decision);
    decisionsByToolCallId.set(decision.toolCallId, decision);
  }
  for (const event of events) {
    if (event.partial) continue;
    const dispatch = event.actions?.toolDispatch;
    if (!dispatch) continue;
    const decision = decisionsByToolCallId.get(dispatch.providerToolCallId);
    if (!decision) {
      decisions.push({
        toolCallId: dispatch.providerToolCallId,
        toolName: dispatch.toolName,
        operationId: dispatch.operationId,
        status: 'corruption',
        reason: 'orphan_dispatch',
        dispatchRuntimeEventId: event.id,
      });
      continue;
    }
    if (decision.dispatchRuntimeEventId !== undefined) {
      decision.status = 'corruption';
      decision.reason = 'duplicate_dispatch';
      continue;
    }
    decision.operationId = dispatch.operationId;
    decision.dispatchRuntimeEventId = event.id;
    if (
      decision.toolName !== dispatch.toolName
      || event.refs?.operationId !== dispatch.operationId
      || event.refs?.toolCallId !== dispatch.providerToolCallId
    ) {
      decision.status = 'corruption';
      decision.reason = 'identity_conflict';
      continue;
    }
    decision.status = 'indeterminate';
    decision.reason = 'dispatch_without_response';
  }
  for (const event of events) {
    if (event.partial || event.content?.kind !== 'function_response') continue;
    const decision = decisionsByToolCallId.get(event.content.id);
    if (!decision) {
      decisions.push({
        toolCallId: event.content.id,
        toolName: event.content.name,
        status: 'corruption',
        reason: 'orphan_response',
        responseRuntimeEventId: event.id,
        responseIsError: event.content.isError === true,
      });
      continue;
    }
    if (decision.responseRuntimeEventId !== undefined) {
      decision.status = 'corruption';
      decision.reason = 'duplicate_response';
      continue;
    }
    decision.responseRuntimeEventId = event.id;
    decision.responseIsError = event.content.isError === true;
    if (decision.status === 'corruption') continue;
    if (
      decision.toolName !== event.content.name
      || (decision.operationId !== undefined
        && event.refs?.operationId !== decision.operationId)
      || (event.refs?.toolCallId !== undefined
        && event.refs.toolCallId !== decision.toolCallId)
    ) {
      decision.status = 'corruption';
      decision.reason = 'identity_conflict';
      continue;
    }
    decision.status = 'completed';
    decision.reason = 'matching_response';
  }
  return {
    ...(toolBoundaryProtocol ? { toolBoundaryProtocol } : {}),
    decisions,
    issues,
    hasCorruption: issues.length > 0
      || decisions.some((decision) => decision.status === 'corruption'),
    requiresReconciliation: decisions.some((decision) => decision.status === 'indeterminate'),
  };
}
