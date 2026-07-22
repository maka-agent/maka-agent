import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type ToolBoundaryProtocol,
} from '@maka/core/runtime-event';
import type { ToolRecoveryContractRegistry } from './tool-recovery-contract.js';
import {
  parseToolRecoveryFact,
  type ToolRecoveryDecisionFact,
  type ToolReconcileResultFact,
} from './tool-recovery-facts.js';

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
  | 'reconcile_applied'
  | 'reconcile_not_applied'
  | 'reconcile_conflict'
  | 'reconcile_still_running'
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
  /**
   * Whether recovery may take the decision's next action without human confirmation.
   * This covers read-only observation, a contract-authorized retry/reattach, or a
   * synthesized response. Completed operations are true because no recovery action
   * remains; definitely-not-dispatched operations are true because execution is safe.
   */
  automaticActionAllowed: boolean;
  evidenceEventIds: string[];
}

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
    | {
        code: 'recovery_fact_corruption';
        eventId: string;
        reason:
          | 'invalid_payload'
          | 'orphan_operation'
          | 'duplicate_decision'
          | 'duplicate_reconcile_result'
          | 'fact_after_decision'
          | 'invalid_evidence';
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
  const recoveryFacts: Array<
    | { kind: 'recovery_decision'; eventId: string; fact: ToolRecoveryDecisionFact }
    | { kind: 'reconcile_result'; eventId: string; fact: ToolReconcileResultFact }
  > = [];
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
    const parsed = parseToolRecoveryFact(fact);
    if (parsed.status === 'recovery_decision') {
      recoveryFacts.push({ kind: parsed.status, eventId: event.id, fact: parsed.fact });
      continue;
    }
    if (parsed.status === 'reconcile_result') {
      recoveryFacts.push({ kind: parsed.status, eventId: event.id, fact: parsed.fact });
      continue;
    }
    if (parsed.status === 'prepared_file_mutation') {
      // Phase 3B preparation evidence is associated with its operation below;
      // recognizing it here keeps the ledger readable and prevents an unknown-
      // fact park while older operations continue to use Phase 3A decisions.
      continue;
    }
    if (parsed.status === 'invalid') {
      issues.push({
        code: 'recovery_fact_corruption',
        eventId: event.id,
        reason: 'invalid_payload',
      });
      continue;
    }
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
  const appliedRecoveryDecisions = new Set<string>();
  const appliedReconcileResults = new Set<string>();
  const canonicalEventPositions = new Map(
    canonicalEvents.map((event, index) => [event.id, index] as const),
  );
  for (const recoveryFact of recoveryFacts) {
    const { eventId } = recoveryFact;
    const decision = decisionsByOperationId.get(recoveryFact.fact.operationId);
    if (!decision) {
      issues.push({ code: 'recovery_fact_corruption', eventId, reason: 'orphan_operation' });
      continue;
    }
    if (recoveryFact.kind === 'reconcile_result') {
      const { fact } = recoveryFact;
      if (appliedRecoveryDecisions.has(fact.operationId)) {
        markRecoveryFactCorruption(decision, eventId);
        issues.push({ code: 'recovery_fact_corruption', eventId, reason: 'fact_after_decision' });
        continue;
      }
      if (appliedReconcileResults.has(fact.operationId)) {
        markRecoveryFactCorruption(decision, eventId);
        issues.push({
          code: 'recovery_fact_corruption',
          eventId,
          reason: 'duplicate_reconcile_result',
        });
        continue;
      }
      appliedReconcileResults.add(fact.operationId);
      decision.disposition = fact.nextAction === 'park' ? 'parked' : 'reconcile_required';
      decision.reasonCode = reconcileReasonCode(fact.result);
      decision.automaticActionAllowed = fact.nextAction !== 'park';
      decision.evidenceEventIds.push(eventId);
      continue;
    }
    const { fact } = recoveryFact;
    if (appliedRecoveryDecisions.has(fact.operationId)) {
      decision.disposition = 'corruption';
      decision.reasonCode = 'duplicate_operation_id';
      decision.automaticActionAllowed = false;
      decision.evidenceEventIds.push(eventId);
      issues.push({ code: 'recovery_fact_corruption', eventId, reason: 'duplicate_decision' });
      continue;
    }
    const decisionPosition = canonicalEventPositions.get(eventId);
    const uniqueEvidenceIds = new Set(fact.evidenceEventIds);
    if (
      decisionPosition === undefined ||
      uniqueEvidenceIds.size !== fact.evidenceEventIds.length ||
      fact.evidenceEventIds.some((evidenceEventId) => {
        const evidencePosition = canonicalEventPositions.get(evidenceEventId);
        return evidencePosition === undefined || evidencePosition >= decisionPosition;
      })
    ) {
      decision.disposition = 'corruption';
      decision.reasonCode = 'identity_conflict';
      decision.automaticActionAllowed = false;
      decision.evidenceEventIds.push(eventId);
      issues.push({ code: 'recovery_fact_corruption', eventId, reason: 'invalid_evidence' });
      continue;
    }
    appliedRecoveryDecisions.add(fact.operationId);
    decision.disposition = fact.disposition;
    decision.reasonCode = fact.reasonCode;
    decision.recoveryContractId = fact.recoveryContractId;
    decision.automaticActionAllowed =
      fact.disposition !== 'parked' && fact.disposition !== 'corruption';
    decision.evidenceEventIds = [...fact.evidenceEventIds, eventId];
  }
  return {
    ...(toolBoundaryProtocol ? { toolBoundaryProtocol } : {}),
    decisions,
    issues,
    hasCorruption:
      issues.some(
        (issue) =>
          issue.code === 'protocol_marker_invalid' || issue.code === 'recovery_fact_corruption',
      ) || decisions.some((decision) => decision.disposition === 'corruption'),
    hasUnsupportedFacts: issues.some((issue) => issue.code === 'runtime_fact_unsupported'),
    requiresReconciliation: decisions.some(
      (decision) => decision.disposition === 'reconcile_required',
    ),
  };
}

function reconcileReasonCode(result: ToolReconcileResultFact['result']): RecoveryReasonCode {
  switch (result) {
    case 'applied':
      return 'reconcile_applied';
    case 'not_applied':
      return 'reconcile_not_applied';
    case 'conflict':
      return 'reconcile_conflict';
    case 'still_running':
      return 'reconcile_still_running';
  }
}

function markRecoveryFactCorruption(decision: RecoveryDecision, eventId: string): void {
  decision.disposition = 'corruption';
  decision.reasonCode = 'identity_conflict';
  decision.automaticActionAllowed = false;
  decision.evidenceEventIds.push(eventId);
}
