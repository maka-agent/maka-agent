import { ARTIFACT_OPERATION_SPECS } from './artifact.js';
import { requireExactRecord, requireId, requireRecord, requireString } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { HOST_STATUS_OPERATION_SPECS } from './host-status.js';
import { INTERACTION_OPERATION_SPECS } from './interaction.js';
import { MESSAGE_OPERATION_SPECS } from './message.js';
import { MEMORY_OPERATION_SPECS } from './memory.js';
import {
  composeOperationSpecMaps,
  type HostOperationError,
  type HostOperationErrorCode,
  type OperationSpec,
} from './operation-spec.js';
import { SESSION_CONTINUITY_OPERATION_SPECS } from './session-continuity.js';
import { TURN_OPERATION_SPECS } from './turn.js';
import { RUNTIME_POLICY_OPERATION_SPECS } from './runtime-policy.js';
import { SKILL_CATALOG_OPERATION_SPECS } from './skill-catalog.js';
import { TASK_LEDGER_OPERATION_SPECS } from './task-ledger.js';
import { USAGE_PRICING_OPERATION_SPECS } from './usage-pricing.js';

export {
  TURN_MESSAGE_CONTENT_MAX_BYTES,
  TURN_MESSAGE_TEXT_MAX_BYTES,
} from './turn.js';
export {
  decodeMemoryMutateInput,
  decodeMemoryMutateResult,
  decodeMemoryQueryInput,
  decodeMemoryQueryResult,
  encodeMemoryMutateResult,
  encodeMemoryQueryResult,
  MEMORY_ENTRY_CONTENT_MAX_BYTES,
  MEMORY_TITLE_MAX_BYTES,
} from './memory.js';

export type {
  MemoryBlockedReason,
  MemoryEntryStatus,
  MemoryExpectedRevision,
  MemoryMutateInput,
  MemoryMutateResult,
  MemoryMutation,
  MemoryMutationRejectedReason,
  MemoryQueryInput,
  MemoryQueryResult,
  MemoryRevision,
  MemorySafeModeReason,
  MemoryScope,
} from './memory.js';
export type {
  ArtifactBinaryPreview,
  ArtifactDeleteInput,
  ArtifactDeleteResult,
  ArtifactProjection,
  ArtifactQueryInput,
  ArtifactQueryResult,
  ArtifactRevision,
  ArtifactTextPreview,
} from './artifact.js';
export type {
  InFlightMessageSnapshot,
  MessagePlacement,
  MessageQueueEntrySnapshot,
  QueueRetractInput,
  QueueRetractResult,
  QueuedMessageSnapshot,
  RetractedMessageSnapshot,
  SessionMessageQueueProjection,
  SteeringMessageSnapshot,
  TurnInterruptInput,
  TurnInterruptResult,
  TurnMessageSubmitInput,
  TurnMessageSubmitResult,
} from './message.js';
export type {
  HostLifecycleState,
  HostStatusInput,
  HostStatusResult,
} from './host-status.js';
export type {
  AdmissionClass,
  HostOperationError,
  HostOperationErrorCode,
  OperationMode,
  OperationSpec,
  RetryPolicy,
} from './operation-spec.js';
export type {
  TurnQueryInput,
  TurnRunStatus,
  TurnSnapshot,
  TurnStartInput,
  TurnStopInput,
} from './turn.js';
export type {
  ConnectionCatalogCursor,
  ConnectionCatalogCreateInput,
  ConnectionCatalogHeaderItem,
  ConnectionCatalogPageItem,
  ConnectionCatalogQueryInput,
  ConnectionCatalogQueryResult,
  ConnectionCatalogRemoveInput,
  ConnectionCatalogSetDefaultTargetInput,
  ConnectionCatalogUpdateInput,
  CreateCatalogConnectionResult,
  CredentialVaultQueryInput,
  CredentialVaultQueryResult,
  CredentialVaultDeleteInput,
  CredentialVaultSetInput,
  DeleteCredentialResult,
  RemoveCatalogConnectionResult,
  RuntimePolicyMutateResult,
  RuntimePolicyMutateInput,
  RuntimePolicyQueryInput,
  RuntimePolicyQueryResult,
  SetCredentialResult,
  SetDefaultConnectionTargetResult,
  UpdateCatalogConnectionResult,
} from './runtime-policy.js';
export type {
  SkillCatalogDiagnostic,
  SkillCatalogEntry,
  SkillCatalogItem,
  SkillCatalogManagedUpdateStatus,
  SkillCatalogMutateInput,
  SkillCatalogMutateResult,
  SkillCatalogMutation,
  SkillCatalogMutationRejectedReason,
  SkillCatalogPreviewRejectedReason,
  SkillCatalogPreviewUpdateInput,
  SkillCatalogPreviewUpdateResult,
  SkillCatalogQueryInput,
  SkillCatalogQueryResult,
  SkillCatalogRefreshInput,
  SkillCatalogRefreshResult,
  SkillCatalogRevision,
  SkillCatalogRevisionConflict,
  SkillCatalogSourceEntry,
  SkillCatalogValidationStatus,
  SkillCatalogView,
  SkillContentSha256,
  SkillRuntimeStatus,
  SkillSourceType,
} from './skill-catalog.js';
export type {
  TaskLedgerQueryInput,
  TaskLedgerQueryResult,
  TaskLedgerRevision,
  TaskLedgerTask,
} from './task-ledger.js';
export type {
  PricingMutateInput,
  PricingMutateResult,
  PricingMutation,
  PricingQueryInput,
  PricingQueryResult,
  UsageQueryInput,
  UsageQueryResult,
  UsageLogProjection,
} from './usage-pricing.js';
export {
  ARTIFACT_CURSOR_MAX_BYTES,
  ARTIFACT_MIME_TYPE_MAX_BYTES,
  ARTIFACT_NAME_MAX_BYTES,
  ARTIFACT_PAGE_MAX_ITEMS,
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_SUMMARY_MAX_BYTES,
  decodeArtifactDeleteInput,
  decodeArtifactDeleteResult,
  decodeArtifactQueryInput,
  decodeArtifactQueryResult,
  encodeArtifactDeleteResult,
  encodeArtifactQueryResult,
} from './artifact.js';
export {
  decodeTaskLedgerQueryInput,
  decodeTaskLedgerQueryResult,
  encodeTaskLedgerQueryResult,
  TASK_LEDGER_CURSOR_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_ITEMS,
} from './task-ledger.js';
export {
  SKILL_CATALOG_PAGE_MAX_BYTES,
  SKILL_CATALOG_PAGE_MAX_ITEMS,
  SKILL_CATALOG_PREVIEW_CONTENT_MAX_BYTES,
  SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES,
} from './skill-catalog.js';
export {
  CONNECTION_CATALOG_PAGE_MAX_BYTES,
  CONNECTION_CATALOG_PAGE_MAX_ITEMS,
  CREDENTIAL_SECRET_MAX_BYTES,
  RUNTIME_POLICY_SNAPSHOT_MAX_BYTES,
} from './runtime-policy.js';
export {
  decodePricingMutateInput,
  decodePricingMutateResult,
  decodePricingQueryInput,
  decodePricingQueryResult,
  decodeUsageQueryInput,
  decodeUsageQueryResult,
  encodePricingQueryResult,
  encodeUsageQueryResult,
  PRICING_CURSOR_MAX_BYTES,
  PRICING_PAGE_MAX_BYTES,
  PRICING_PAGE_MAX_ITEMS,
  USAGE_PAGE_MAX_BYTES,
  USAGE_PAGE_MAX_ITEMS,
  USAGE_PROJECTION_TEXT_MAX_BYTES,
} from './usage-pricing.js';

const HOST_AND_TURN_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_STATUS_OPERATION_SPECS,
  TURN_OPERATION_SPECS,
);

const HOST_TURN_AND_MESSAGE_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_AND_TURN_OPERATION_SPECS,
  MESSAGE_OPERATION_SPECS,
);

const HOST_TURN_MESSAGE_AND_INTERACTION_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_TURN_AND_MESSAGE_OPERATION_SPECS,
  INTERACTION_OPERATION_SPECS,
);

const HOST_TURN_MESSAGE_INTERACTION_AND_CONTINUITY_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_TURN_MESSAGE_AND_INTERACTION_OPERATION_SPECS,
  SESSION_CONTINUITY_OPERATION_SPECS,
);

const HOST_AND_DOMAIN_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_TURN_MESSAGE_INTERACTION_AND_CONTINUITY_OPERATION_SPECS,
  RUNTIME_POLICY_OPERATION_SPECS,
);

const HOST_AND_SKILL_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_AND_DOMAIN_OPERATION_SPECS,
  SKILL_CATALOG_OPERATION_SPECS,
);

const HOST_SKILL_AND_TASK_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_AND_SKILL_OPERATION_SPECS,
  TASK_LEDGER_OPERATION_SPECS,
);

const HOST_TASK_AND_ARTIFACT_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_SKILL_AND_TASK_OPERATION_SPECS,
  ARTIFACT_OPERATION_SPECS,
);

const HOST_ARTIFACT_AND_MEMORY_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_TASK_AND_ARTIFACT_OPERATION_SPECS,
  MEMORY_OPERATION_SPECS,
);

export const HOST_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_ARTIFACT_AND_MEMORY_OPERATION_SPECS,
  USAGE_PRICING_OPERATION_SPECS,
);

export type OperationSpecMap = typeof HOST_OPERATION_SPECS;
export type OperationKey = keyof OperationSpecMap;

type InferInput<Spec> =
  Spec extends OperationSpec<infer Input, unknown, HostOperationErrorCode> ? Input : never;
type InferOutput<Spec> =
  Spec extends OperationSpec<unknown, infer Output, HostOperationErrorCode> ? Output : never;
type InferErrorCode<Spec> =
  Spec extends OperationSpec<unknown, unknown, infer ErrorCode> ? ErrorCode : never;

export type OperationInput<K extends OperationKey> = InferInput<OperationSpecMap[K]>;
export type OperationOutput<K extends OperationKey> = InferOutput<OperationSpecMap[K]>;
export type OperationError<K extends OperationKey> = HostOperationError<
  InferErrorCode<OperationSpecMap[K]>
>;

export type RequestFrameFor<K extends OperationKey> = {
  requestId: string;
  operation: K;
  input: OperationInput<K>;
};

export type ResponseFrameFor<K extends OperationKey> =
  | { requestId: string; operation: K; ok: true; result: OperationOutput<K> }
  | { requestId: string; operation: K; ok: false; error: OperationError<K> };

export type OperationOutcome<K extends OperationKey> =
  | { ok: true; result: OperationOutput<K> }
  | { ok: false; error: OperationError<K> };

export type RequestFrame = {
  [K in OperationKey]: RequestFrameFor<K>;
}[OperationKey];
export type ResponseFrame = {
  [K in OperationKey]: ResponseFrameFor<K>;
}[OperationKey];

export function decodeRequestFrame(value: unknown): RequestFrame {
  const frame = requireExactRecord(value, 'operation request', ['requestId', 'operation', 'input']);
  const requestId = requireId(frame.requestId, 'requestId');
  const operation = requireOperationKey(frame.operation);
  const spec = HOST_OPERATION_SPECS[operation];
  const input = spec.decodeInput(frame.input);
  return { requestId, operation, input } as RequestFrame;
}

export function decodeResponseFrame(value: unknown): ResponseFrame {
  const record = requireRecord(value, 'operation response');
  if (record.ok === true) {
    const frame = requireExactRecord(record, 'operation response', [
      'requestId',
      'operation',
      'ok',
      'result',
    ]);
    const requestId = requireId(frame.requestId, 'requestId');
    const operation = requireOperationKey(frame.operation);
    const result = HOST_OPERATION_SPECS[operation].decodeOutput(frame.result);
    return { requestId, operation, ok: true, result } as ResponseFrame;
  }
  if (record.ok === false) {
    const frame = requireExactRecord(record, 'operation response', [
      'requestId',
      'operation',
      'ok',
      'error',
    ]);
    const requestId = requireId(frame.requestId, 'requestId');
    const operation = requireOperationKey(frame.operation);
    const error = decodeOperationError(frame.error, HOST_OPERATION_SPECS[operation].errors);
    return { requestId, operation, ok: false, error } as ResponseFrame;
  }
  throw invalidProtocolFrame('Invalid operation response outcome');
}

export function isOperationKey(value: unknown): value is OperationKey {
  return typeof value === 'string' && Object.hasOwn(HOST_OPERATION_SPECS, value);
}

function decodeOperationError<C extends HostOperationErrorCode>(
  value: unknown,
  allowedCodes: readonly C[],
): HostOperationError<C> {
  const record = requireExactRecord(value, 'operation error', ['code', 'message']);
  if (typeof record.code !== 'string' || !allowedCodes.includes(record.code as C)) {
    throw invalidProtocolFrame('Operation returned an undeclared error code');
  }
  return {
    code: record.code as C,
    message: requireString(record.message, 'operation error message', 1024),
  };
}

function requireOperationKey(value: unknown): OperationKey {
  if (!isOperationKey(value)) throw invalidProtocolFrame('Unknown operation key');
  return value;
}
