import type { RuntimeFactEnvelope } from '@maka/core';
import type { RecoveryDisposition, RecoveryReasonCode } from './recovery-resolver.js';

export const TOOL_RECOVERY_DECISION_FACT_KIND = 'maka.tool.recovery_decision' as const;
export const TOOL_RECONCILE_RESULT_FACT_KIND = 'maka.tool.reconcile_result' as const;
export const PREPARED_FILE_MUTATION_FACT_KIND = 'maka.file.prepared_mutation' as const;
export const TOOL_RECOVERY_FACT_VERSION = 1 as const;

const RECOVERY_DISPOSITIONS = new Set<RecoveryDisposition>([
  'completed',
  'definitely_not_dispatched',
  'reconcile_required',
  'parked',
  'corruption',
]);
const RECOVERY_REASON_CODES = new Set<RecoveryReasonCode>([
  'matching_response',
  'recovery_contract_available',
  'recovery_contract_unavailable',
  'recovery_contract_mismatch',
  'manual_recovery_required',
  'reconcile_applied',
  'reconcile_not_applied',
  'reconcile_conflict',
  'reconcile_still_running',
  'new_protocol_before_dispatch',
  'legacy_dispatch_unknown',
  'orphan_dispatch',
  'orphan_response',
  'duplicate_call',
  'duplicate_dispatch',
  'duplicate_response',
  'duplicate_operation_id',
  'identity_conflict',
]);

export interface ToolRecoveryDecisionFact {
  protocol: 'tool_recovery_v1';
  operationId: string;
  disposition: RecoveryDisposition;
  reasonCode: RecoveryReasonCode;
  evidenceEventIds: string[];
  recoveryContractId?: string;
}

export interface ToolReconcileResultFact {
  protocol: 'tool_reconcile_v1';
  operationId: string;
  result: 'applied' | 'not_applied' | 'conflict' | 'still_running';
  observationDigest: string;
  observedAt: string;
  nextAction: 'synthesize_response' | 'retry_allowed' | 'reattach' | 'park';
}

export interface PreparedFileBlobRef {
  kind: 'file';
  sha256: string;
  /** Optional content-addressed carrier object; not required for local file transactions. */
  blobOid?: string;
  byteLength: number;
  mode: number;
}

export type PreparedFileBeforeState = { kind: 'missing' } | PreparedFileBlobRef;

export interface PreparedFileMutationFact {
  protocol: 'prepared_file_mutation_v1';
  operationId: string;
  workspaceRoot: string;
  canonicalPath: string;
  relativePath: string;
  before: PreparedFileBeforeState;
  expectedAfter: PreparedFileBlobRef;
  transform: {
    id: string;
    version: number;
    argsHash: string;
  };
  carrier?: {
    kind: 'git_object_v1';
    repositoryCommonDir: string;
    retentionRef: string;
  };
}

export type ParsedToolRecoveryFact =
  | { status: 'unsupported' }
  | { status: 'invalid' }
  | { status: 'recovery_decision'; fact: ToolRecoveryDecisionFact }
  | { status: 'reconcile_result'; fact: ToolReconcileResultFact }
  | { status: 'prepared_file_mutation'; fact: PreparedFileMutationFact };

export function parseToolRecoveryFact(envelope: RuntimeFactEnvelope): ParsedToolRecoveryFact {
  if (
    envelope.kind !== TOOL_RECOVERY_DECISION_FACT_KIND &&
    envelope.kind !== TOOL_RECONCILE_RESULT_FACT_KIND &&
    envelope.kind !== PREPARED_FILE_MUTATION_FACT_KIND
  ) {
    return { status: 'unsupported' };
  }
  if (envelope.version !== TOOL_RECOVERY_FACT_VERSION) return { status: 'unsupported' };
  if (envelope.kind === TOOL_RECOVERY_DECISION_FACT_KIND) {
    return parseRecoveryDecision(envelope.payload);
  }
  if (envelope.kind === PREPARED_FILE_MUTATION_FACT_KIND) {
    return parsePreparedFileMutation(envelope.payload);
  }
  return parseReconcileResult(envelope.payload);
}

export function parsePreparedFileMutationFact(
  payload: unknown,
): PreparedFileMutationFact | undefined {
  const parsed = parsePreparedFileMutation(payload);
  return parsed.status === 'prepared_file_mutation' ? parsed.fact : undefined;
}

function parsePreparedFileMutation(payload: unknown): ParsedToolRecoveryFact {
  if (
    !hasExactKeys(
      payload,
      [
        'protocol',
        'operationId',
        'workspaceRoot',
        'canonicalPath',
        'relativePath',
        'before',
        'expectedAfter',
        'transform',
      ],
      ['carrier'],
    )
  ) {
    return { status: 'invalid' };
  }
  if (
    payload.protocol !== 'prepared_file_mutation_v1' ||
    !isNonEmptyString(payload.operationId) ||
    !isNonEmptyString(payload.workspaceRoot) ||
    !isNonEmptyString(payload.canonicalPath) ||
    !isNonEmptyString(payload.relativePath) ||
    !isPreparedBeforeState(payload.before) ||
    !isPreparedBlobRef(payload.expectedAfter) ||
    !isPreparedTransform(payload.transform) ||
    (payload.carrier !== undefined && !isPreparedCarrier(payload.carrier))
  ) {
    return { status: 'invalid' };
  }
  return {
    status: 'prepared_file_mutation',
    fact: payload as unknown as PreparedFileMutationFact,
  };
}

function isPreparedBeforeState(value: unknown): value is PreparedFileBeforeState {
  return (hasExactKeys(value, ['kind']) && value.kind === 'missing') || isPreparedBlobRef(value);
}

function isPreparedBlobRef(value: unknown): value is PreparedFileBlobRef {
  return (
    hasExactKeys(value, ['kind', 'sha256', 'byteLength', 'mode'], ['blobOid']) &&
    value.kind === 'file' &&
    isSha256(value.sha256) &&
    (value.blobOid === undefined || isGitOid(value.blobOid)) &&
    Number.isSafeInteger(value.byteLength) &&
    Number(value.byteLength) >= 0 &&
    Number.isSafeInteger(value.mode) &&
    Number(value.mode) > 0
  );
}

function isPreparedTransform(value: unknown): boolean {
  return (
    hasExactKeys(value, ['id', 'version', 'argsHash']) &&
    isNonEmptyString(value.id) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 1 &&
    isSha256(value.argsHash)
  );
}

function isPreparedCarrier(value: unknown): boolean {
  return (
    hasExactKeys(value, ['kind', 'repositoryCommonDir', 'retentionRef']) &&
    value.kind === 'git_object_v1' &&
    isNonEmptyString(value.repositoryCommonDir) &&
    isNonEmptyString(value.retentionRef) &&
    value.retentionRef.startsWith('refs/maka/checkpoints/')
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isGitOid(value: unknown): value is string {
  return typeof value === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseRecoveryDecision(payload: unknown): ParsedToolRecoveryFact {
  if (
    !hasExactKeys(
      payload,
      ['protocol', 'operationId', 'disposition', 'reasonCode', 'evidenceEventIds'],
      ['recoveryContractId'],
    )
  ) {
    return { status: 'invalid' };
  }
  if (
    payload.protocol !== 'tool_recovery_v1' ||
    typeof payload.operationId !== 'string' ||
    payload.operationId.length === 0 ||
    typeof payload.disposition !== 'string' ||
    !RECOVERY_DISPOSITIONS.has(payload.disposition as RecoveryDisposition) ||
    typeof payload.reasonCode !== 'string' ||
    !RECOVERY_REASON_CODES.has(payload.reasonCode as RecoveryReasonCode) ||
    !isNonEmptyStringArray(payload.evidenceEventIds) ||
    (payload.recoveryContractId !== undefined && typeof payload.recoveryContractId !== 'string')
  ) {
    return { status: 'invalid' };
  }
  return { status: 'recovery_decision', fact: payload as unknown as ToolRecoveryDecisionFact };
}

function parseReconcileResult(payload: unknown): ParsedToolRecoveryFact {
  if (
    !hasExactKeys(payload, [
      'protocol',
      'operationId',
      'result',
      'observationDigest',
      'observedAt',
      'nextAction',
    ])
  ) {
    return { status: 'invalid' };
  }
  if (
    payload.protocol !== 'tool_reconcile_v1' ||
    typeof payload.operationId !== 'string' ||
    payload.operationId.length === 0 ||
    !['applied', 'not_applied', 'conflict', 'still_running'].includes(String(payload.result)) ||
    typeof payload.observationDigest !== 'string' ||
    payload.observationDigest.length === 0 ||
    typeof payload.observedAt !== 'string' ||
    payload.observedAt.length === 0 ||
    !['synthesize_response', 'retry_allowed', 'reattach', 'park'].includes(
      String(payload.nextAction),
    ) ||
    !isSafeReconcileTransition(String(payload.result), String(payload.nextAction))
  ) {
    return { status: 'invalid' };
  }
  return { status: 'reconcile_result', fact: payload as unknown as ToolReconcileResultFact };
}

function isSafeReconcileTransition(result: string, nextAction: string): boolean {
  return (
    nextAction === 'park' ||
    (result === 'applied' && nextAction === 'synthesize_response') ||
    (result === 'not_applied' && nextAction === 'retry_allowed') ||
    (result === 'still_running' && nextAction === 'reattach')
  );
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}
