import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type ToolBoundaryProtocol,
} from '@maka/core/runtime-event';
import type { ToolRecoveryContractRegistry } from './tool-recovery-contract.js';

export type RecoveryDisposition =
  | 'completed'
  | 'definitely_not_dispatched'
  | 'reconcile_required'
  | 'parked'
  | 'corruption';

export type RecoveryReasonCode =
  | 'matching_response'
  | 'recovery_contract_available'
  | 'recovery_contract_unavailable'
  | 'recovery_contract_mismatch'
  | 'manual_recovery_required'
  | 'new_protocol_before_dispatch'
  | 'legacy_dispatch_unknown'
  | 'orphan_dispatch'
  | 'orphan_response'
  | 'duplicate_call'
  | 'duplicate_dispatch'
  | 'duplicate_response'
  | 'duplicate_operation_id'
  | 'identity_conflict';

export interface RecoveryDecision {
  toolCallId: string;
  toolName?: string;
  operationId?: string;
  disposition: RecoveryDisposition;
  reasonCode: RecoveryReasonCode;
  callRuntimeEventId?: string;
  dispatchRuntimeEventId?: string;
  responseRuntimeEventId?: string;
  responseIsError?: boolean;
  recoveryContractId?: string;
  /** Whether recovery may take its next action without human confirmation. */
  automaticActionAllowed: boolean;
  evidenceEventIds: string[];
}

/** @deprecated Use RecoveryDisposition. */
export type ToolRecoveryDecisionStatus = RecoveryDisposition;
/** @deprecated Use RecoveryReasonCode. */
export type ToolRecoveryDecisionReason = RecoveryReasonCode;
/** @deprecated Use RecoveryDecision. */
export type ToolRecoveryDecision = RecoveryDecision;

export interface ResolveRuntimeRecoveryOptions {
  contracts?: ToolRecoveryContractRegistry;
}

export interface RuntimeRecoveryResolution {
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  decisions: RecoveryDecision[];
  issues: Array<
    | {
        code: 'protocol_marker_invalid';
        eventId: string;
      }
    | {
        code: 'runtime_fact_unsupported';
        eventId: string;
        kind: string;
        version: number;
      }
  >;
  hasCorruption: boolean;
  hasUnsupportedFacts: boolean;
  requiresReconciliation: boolean;
}

export function resolveRuntimeRecovery(
  events: readonly RuntimeEvent[],
  options: ResolveRuntimeRecoveryOptions = {},
): RuntimeRecoveryResolution {
  const canonicalEvents = events.filter((event) => !event.partial);
  const firstCanonicalEvent = canonicalEvents[0];
  const firstProtocol = firstCanonicalEvent?.actions?.runtimeProtocol;
  const toolBoundaryProtocol =
    firstProtocol?.toolBoundary === TOOL_BOUNDARY_PROTOCOL_V1
      ? TOOL_BOUNDARY_PROTOCOL_V1
      : undefined;
  const issues: RuntimeRecoveryResolution['issues'] = [];
  if (firstProtocol !== undefined && toolBoundaryProtocol === undefined && firstCanonicalEvent) {
    issues.push({
      code: 'protocol_marker_invalid' as const,
      eventId: firstCanonicalEvent.id,
    });
  }
  issues.push(
    ...canonicalEvents
      .slice(1)
      .filter((event) => event.actions?.runtimeProtocol !== undefined)
      .map((event) => ({ code: 'protocol_marker_invalid' as const, eventId: event.id })),
  );
  for (const event of canonicalEvents) {
    const fact = event.actions?.runtimeFact;
    if (!fact) continue;
    // PR 0 introduces the compatibility envelope but intentionally registers
    // no recovery handlers. Every fact therefore remains a fail-closed gate.
    issues.push({
      code: 'runtime_fact_unsupported',
      eventId: event.id,
      kind: fact.kind,
      version: fact.version,
    });
  }
  const decisions: RecoveryDecision[] = [];
  const decisionsByToolCallId = new Map<string, RecoveryDecision>();
  for (const event of events) {
    if (event.partial || event.content?.kind !== 'function_call') continue;
    const existing = decisionsByToolCallId.get(event.content.id);
    if (existing) {
      existing.evidenceEventIds.push(event.id);
      existing.disposition = 'corruption';
      existing.reasonCode = 'duplicate_call';
      existing.automaticActionAllowed = false;
      continue;
    }
    const decision: RecoveryDecision = {
      toolCallId: event.content.id,
      toolName: event.content.name,
      ...(event.refs?.operationId ? { operationId: event.refs.operationId } : {}),
      disposition: toolBoundaryProtocol ? 'definitely_not_dispatched' : 'parked',
      reasonCode: toolBoundaryProtocol ? 'new_protocol_before_dispatch' : 'legacy_dispatch_unknown',
      callRuntimeEventId: event.id,
      automaticActionAllowed: toolBoundaryProtocol !== undefined,
      evidenceEventIds: [event.id],
    };
    if (event.refs?.toolCallId !== undefined && event.refs.toolCallId !== event.content.id) {
      decision.disposition = 'corruption';
      decision.reasonCode = 'identity_conflict';
      decision.automaticActionAllowed = false;
    }
    decisions.push(decision);
    decisionsByToolCallId.set(decision.toolCallId, decision);
  }
  const decisionsByOperationId = new Map<string, RecoveryDecision>();
  for (const decision of decisions) {
    if (!decision.operationId) continue;
    const existing = decisionsByOperationId.get(decision.operationId);
    if (existing && existing !== decision) {
      existing.disposition = 'corruption';
      existing.reasonCode = 'duplicate_operation_id';
      existing.automaticActionAllowed = false;
      decision.disposition = 'corruption';
      decision.reasonCode = 'duplicate_operation_id';
      decision.automaticActionAllowed = false;
      continue;
    }
    decisionsByOperationId.set(decision.operationId, decision);
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
        disposition: 'corruption',
        reasonCode: 'orphan_dispatch',
        dispatchRuntimeEventId: event.id,
        automaticActionAllowed: false,
        evidenceEventIds: [event.id],
      });
      continue;
    }
    if (decision.dispatchRuntimeEventId !== undefined) {
      decision.evidenceEventIds.push(event.id);
      decision.disposition = 'corruption';
      decision.reasonCode = 'duplicate_dispatch';
      decision.automaticActionAllowed = false;
      continue;
    }
    const operationOwner = decisionsByOperationId.get(dispatch.operationId);
    if (operationOwner && operationOwner !== decision) {
      operationOwner.disposition = 'corruption';
      operationOwner.reasonCode = 'duplicate_operation_id';
      operationOwner.automaticActionAllowed = false;
      decision.operationId = dispatch.operationId;
      decision.dispatchRuntimeEventId = event.id;
      decision.evidenceEventIds.push(event.id);
      decision.disposition = 'corruption';
      decision.reasonCode = 'duplicate_operation_id';
      decision.automaticActionAllowed = false;
      continue;
    }
    // Reserve the dispatch identity before classification so any later fact
    // that reuses it is also deterministically classified as corruption.
    decisionsByOperationId.set(dispatch.operationId, decision);
    decision.dispatchRuntimeEventId = event.id;
    decision.evidenceEventIds.push(event.id);
    decision.operationId ??= dispatch.operationId;
    if (
      decision.toolName !== dispatch.toolName ||
      (decision.operationId !== undefined && decision.operationId !== dispatch.operationId) ||
      event.refs?.operationId !== dispatch.operationId ||
      event.refs?.toolCallId !== dispatch.providerToolCallId
    ) {
      decision.disposition = 'corruption';
      decision.reasonCode = 'identity_conflict';
      decision.automaticActionAllowed = false;
      continue;
    }
    const contractResolution = options.contracts?.resolve(
      dispatch.toolName,
      dispatch.recoveryMode,
    ) ?? { status: 'missing' as const };
    if (contractResolution.status === 'missing') {
      decision.disposition = 'parked';
      decision.reasonCode = 'recovery_contract_unavailable';
      decision.automaticActionAllowed = false;
    } else if (contractResolution.status === 'incompatible') {
      decision.disposition = 'parked';
      decision.reasonCode = 'recovery_contract_mismatch';
      decision.recoveryContractId = `${contractResolution.contract.id}@${contractResolution.contract.version}`;
      decision.automaticActionAllowed = false;
    } else {
      decision.recoveryContractId = `${contractResolution.contract.id}@${contractResolution.contract.version}`;
      if (contractResolution.contract.mode === 'manual_only') {
        decision.disposition = 'parked';
        decision.reasonCode = 'manual_recovery_required';
        decision.automaticActionAllowed = false;
      } else {
        decision.disposition = 'reconcile_required';
        decision.reasonCode = 'recovery_contract_available';
        decision.automaticActionAllowed = true;
      }
    }
  }
  for (const event of events) {
    if (event.partial || event.content?.kind !== 'function_response') continue;
    const decision = decisionsByToolCallId.get(event.content.id);
    if (!decision) {
      decisions.push({
        toolCallId: event.content.id,
        toolName: event.content.name,
        disposition: 'corruption',
        reasonCode: 'orphan_response',
        responseRuntimeEventId: event.id,
        responseIsError: event.content.isError === true,
        automaticActionAllowed: false,
        evidenceEventIds: [event.id],
      });
      continue;
    }
    if (decision.responseRuntimeEventId !== undefined) {
      decision.evidenceEventIds.push(event.id);
      decision.disposition = 'corruption';
      decision.reasonCode = 'duplicate_response';
      decision.automaticActionAllowed = false;
      continue;
    }
    decision.responseRuntimeEventId = event.id;
    decision.responseIsError = event.content.isError === true;
    decision.evidenceEventIds.push(event.id);
    if (decision.disposition === 'corruption') continue;
    if (
      decision.toolName !== event.content.name ||
      (decision.operationId !== undefined && event.refs?.operationId !== decision.operationId) ||
      (event.refs?.toolCallId !== undefined && event.refs.toolCallId !== decision.toolCallId)
    ) {
      decision.disposition = 'corruption';
      decision.reasonCode = 'identity_conflict';
      decision.automaticActionAllowed = false;
      continue;
    }
    decision.disposition = 'completed';
    decision.reasonCode = 'matching_response';
    decision.automaticActionAllowed = true;
  }
  return {
    ...(toolBoundaryProtocol ? { toolBoundaryProtocol } : {}),
    decisions,
    issues,
    hasCorruption:
      issues.some((issue) => issue.code === 'protocol_marker_invalid') ||
      decisions.some((decision) => decision.disposition === 'corruption'),
    hasUnsupportedFacts: issues.some((issue) => issue.code === 'runtime_fact_unsupported'),
    requiresReconciliation: decisions.some(
      (decision) => decision.disposition === 'reconcile_required',
    ),
  };
}
