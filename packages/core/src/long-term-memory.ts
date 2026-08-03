/**
 * Atomic long-term-memory contracts.
 *
 * This module contains no storage, model, prompt, or UI dependencies. The
 * existing MEMORY.md bundle remains a separate legacy product surface while
 * the automatic memory lifecycle is introduced incrementally.
 */

export const MEMORY_ITEM_KINDS = [
  'preference',
  'identity',
  'context',
  'knowledge',
  'failure',
  'note',
] as const;
export type MemoryItemKind = (typeof MEMORY_ITEM_KINDS)[number];

export const MEMORY_STATEMENT_TYPES = ['fact', 'plan', 'prediction'] as const;
export type MemoryStatementType = (typeof MEMORY_STATEMENT_TYPES)[number];

export const MEMORY_TEMPORAL_TYPES = ['undated', 'point', 'interval', 'open_ended'] as const;
export type MemoryTemporalType = (typeof MEMORY_TEMPORAL_TYPES)[number];

export const MEMORY_SCOPE_TYPES = ['global', 'workspace'] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export const MEMORY_LIFECYCLE_STATES = ['active', 'archived'] as const;
export type MemoryLifecycleState = (typeof MEMORY_LIFECYCLE_STATES)[number];

export const MEMORY_ITEM_ORIGINS = ['agent_extracted', 'user_requested'] as const;
export type MemoryItemOrigin = (typeof MEMORY_ITEM_ORIGINS)[number];

export const MEMORY_KEY_TYPES = ['exact', 'entity', 'concept', 'alias', 'code'] as const;
export type MemoryKeyType = (typeof MEMORY_KEY_TYPES)[number];

export const MEMORY_KEY_ORIGINS = ['deterministic', 'llm', 'user'] as const;
export type MemoryKeyOrigin = (typeof MEMORY_KEY_ORIGINS)[number];

export const MEMORY_MUTATION_TYPES = ['create', 'update', 'archive', 'restore'] as const;
export type MemoryMutationType = (typeof MEMORY_MUTATION_TYPES)[number];
export type MemoryWriteOperationType = MemoryMutationType | 'batch';

export const MEMORY_EXTRACTION_MODES = ['sweep', 'targeted'] as const;
export type MemoryExtractionMode = (typeof MEMORY_EXTRACTION_MODES)[number];

export const MEMORY_EXTRACTION_TRIGGER_KINDS = [
  'context_threshold',
  'compaction',
  'user_requested',
  'agent_requested',
] as const;
export type MemoryExtractionTriggerKind = (typeof MEMORY_EXTRACTION_TRIGGER_KINDS)[number];

export const MEMORY_EXTRACTION_OPERATION_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
] as const;
export type MemoryExtractionOperationState = (typeof MEMORY_EXTRACTION_OPERATION_STATES)[number];

export const MEMORY_EXTRACTION_ATTEMPT_STATES = [
  'running',
  'succeeded',
  'failed',
  'abandoned',
] as const;
export type MemoryExtractionAttemptState = (typeof MEMORY_EXTRACTION_ATTEMPT_STATES)[number];

export const MEMORY_EXTRACTION_SNAPSHOT_KINDS = [
  'provider_prefix',
  'runtime_delta',
  'reconstructed_full',
] as const;
export type MemoryExtractionSnapshotKind = (typeof MEMORY_EXTRACTION_SNAPSHOT_KINDS)[number];

export const MEMORY_EXTRACTION_FAILURE_STAGES = [
  'admission',
  'provider',
  'search',
  'read',
  'submit',
  'commit',
  'recovery',
  'cleanup',
] as const;
export type MemoryExtractionFailureStage = (typeof MEMORY_EXTRACTION_FAILURE_STAGES)[number];

export const MEMORY_EXTRACTION_CLEANUP_STATES = ['pending', 'running', 'completed'] as const;
export type MemoryExtractionCleanupState = (typeof MEMORY_EXTRACTION_CLEANUP_STATES)[number];

export const MEMORY_EXTRACTION_RESULT_TYPES = [
  'proposed',
  'empty',
  'unresolved',
  'not_storable',
] as const;
export type MemoryExtractionResultType = (typeof MEMORY_EXTRACTION_RESULT_TYPES)[number];

/** Store and scheduler hard cap for one atomic multi-Run Sweep. */
export const MEMORY_EXTRACTION_MAX_RANGES = 32;

export const LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS = 2_000;
export type MemorySha256Digest = `sha256:${string}`;

const LONG_TERM_MEMORY_CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'g',
);
const LONG_TERM_MEMORY_ZERO_WIDTH_CHARS = new RegExp(
  `[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d)}${String.fromCharCode(0xfeff)}]`,
  'g',
);
const LONG_TERM_MEMORY_SURROGATE_CHARS = /\p{Cs}/u;

export interface MemoryItem {
  readonly itemId: string;
  readonly version: number;
  readonly content: string;
  readonly kind: MemoryItemKind;
  readonly statementType: MemoryStatementType;
  readonly temporalType: MemoryTemporalType;
  readonly scopeType: MemoryScopeType;
  readonly scopeKey: string | null;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly observedAt: number;
  readonly lifecycleState: MemoryLifecycleState;
  /** How the current content was produced, not how this stable Item was first created. */
  readonly origin: MemoryItemOrigin;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryItemKeyInput {
  readonly key: string;
  readonly keyType: MemoryKeyType;
  readonly keyOrigin: MemoryKeyOrigin;
}

export interface MemoryItemKey extends MemoryItemKeyInput {
  readonly normalizedKey: string;
}

/** Durable provenance for the current Item content. */
export interface MemoryItemSource {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly eventId: string;
}

/** Complete current-fact state admitted by trusted Runtime code. */
export interface MemoryItemWrite {
  readonly content: string;
  readonly kind: MemoryItemKind;
  readonly statementType: MemoryStatementType;
  readonly temporalType: MemoryTemporalType;
  readonly scopeType: MemoryScopeType;
  readonly scopeKey?: string | null;
  readonly eventStartedAt?: number | null;
  readonly eventEndedAt?: number | null;
  /** Derived by Runtime from the supporting source Events. */
  readonly observedAt: number;
  readonly origin: MemoryItemOrigin;
  readonly keys: readonly MemoryItemKeyInput[];
  readonly sources: readonly MemoryItemSource[];
}

export interface CreateMemoryItemMutation {
  readonly type: 'create';
  readonly item: MemoryItemWrite;
}

export interface UpdateMemoryItemMutation {
  readonly type: 'update';
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly item: MemoryItemWrite;
}

export interface ArchiveMemoryItemMutation {
  readonly type: 'archive';
  readonly itemId: string;
  readonly expectedVersion: number;
}

export interface RestoreMemoryItemMutation {
  readonly type: 'restore';
  readonly itemId: string;
  readonly expectedVersion: number;
}

export type MemoryItemMutation =
  | CreateMemoryItemMutation
  | UpdateMemoryItemMutation
  | ArchiveMemoryItemMutation
  | RestoreMemoryItemMutation;

export interface ApplyMemoryMutationsRequest {
  readonly operationId: string;
  /** The Store applies the complete list atomically under one idempotency receipt. */
  readonly mutations: readonly MemoryItemMutation[];
}

export type MemoryMutationOutcome = 'created' | 'updated' | 'archived' | 'restored' | 'noop';

export interface MemoryMutationResult {
  readonly mutationIndex: number;
  readonly mutationType: MemoryMutationType;
  readonly itemId: string;
  readonly version: number;
  readonly lifecycleState: MemoryLifecycleState;
  readonly outcome: MemoryMutationOutcome;
}

export interface MemoryWriteOperationResult {
  readonly operationId: string;
  readonly operationType: MemoryWriteOperationType;
  readonly replayed: boolean;
  readonly committedAt: number;
  readonly results: readonly MemoryMutationResult[];
}

export interface MemoryItemRecord {
  readonly item: MemoryItem;
  readonly keys: readonly MemoryItemKey[];
  readonly sources: readonly MemoryItemSource[];
}

export interface SearchMemoryItemsByKeyRequest {
  /** Match any distinct term and rank Items by the number of matched terms. */
  readonly terms: readonly string[];
  readonly match: 'exact' | 'prefix';
  /** Omit to search global Items only; provide to include global plus this workspace. */
  readonly workspaceKey?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

/** A frozen sweep range. Event sequence values are comparable only within its Run. */
export interface MemoryExtractionOperationRange {
  readonly operationId: string;
  readonly rangeOrdinal: number;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly fromEventSeqExclusive: number;
  readonly fromEventId: string | null;
  readonly fromPrefixDigest: MemorySha256Digest | null;
  readonly toEventSeqInclusive: number;
  readonly toEventId: string;
  readonly toPrefixDigest: MemorySha256Digest;
}

export type MemoryExtractionOperationRangeInput = Omit<
  MemoryExtractionOperationRange,
  'operationId'
>;

/** Persistent task authority for one frozen memory-extraction input. */
export interface MemoryExtractionOperation {
  readonly operationId: string;
  readonly sessionId: string;
  readonly mode: MemoryExtractionMode;
  readonly triggerKind: MemoryExtractionTriggerKind;
  readonly internalSessionId: string;
  readonly sessionCreateFingerprint: MemorySha256Digest;
  readonly requestHash: MemorySha256Digest;
  readonly requestJson: string;
  readonly triggerEpoch: string | null;
  readonly state: MemoryExtractionOperationState;
  readonly attemptCount: number;
  readonly activeAttemptId: string | null;
  readonly leaseExpiresAt: number | null;
  readonly nextAttemptAt: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorStage: MemoryExtractionFailureStage | null;
  readonly lastErrorAt: number | null;
  readonly lastFailedAttemptId: string | null;
  readonly startedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly resultType: MemoryExtractionResultType | null;
  /** Raw lowercase SHA-256 hex, matching memory_write_operations.request_hash. */
  readonly commitHash: string | null;
  readonly receipt: MemoryExtractionCommitReceipt | null;
  readonly diagnosticRetentionUntil: number | null;
  readonly cleanupState: MemoryExtractionCleanupState | null;
  readonly cleanupClaimId: string | null;
  readonly cleanupLeaseExpiresAt: number | null;
  readonly cleanupAttemptCount: number;
  readonly cleanupErrorCode: string | null;
  readonly cleanedAt: number | null;
  readonly ranges: readonly MemoryExtractionOperationRange[];
}

export interface CreateMemoryExtractionOperationRequest {
  readonly operationId: string;
  readonly sessionId: string;
  readonly mode: MemoryExtractionMode;
  readonly triggerKind: MemoryExtractionTriggerKind;
  readonly internalSessionId: string;
  readonly sessionCreateFingerprint: MemorySha256Digest;
  /** Semantic task hash; cache-only capture hints must not be its sole input. */
  readonly requestHash: MemorySha256Digest;
  /** Versioned boundary/search manifest. It must not contain prompts or proposal text. */
  readonly requestJson: string;
  readonly triggerEpoch?: string | null;
  /** Required for sweep and forbidden for targeted operations. */
  readonly ranges?: readonly MemoryExtractionOperationRangeInput[];
  /** Atomic admission ceiling for unfinished Targeted Operations in this Session. */
  readonly maxUnfinishedTargetedPerSession?: number;
}

export interface CreateMemoryExtractionOperationResult {
  readonly operation: MemoryExtractionOperation;
  readonly replayed: boolean;
}

/** Numeric-only durable diagnostics. Raw provider output and errors are intentionally excluded. */
export interface MemoryExtractionAttemptMetrics {
  readonly version: 1;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly latencyMs?: number;
  readonly searchCount?: number;
  readonly readCount?: number;
}

export interface MemoryExtractionAttempt {
  readonly attemptId: string;
  readonly operationId: string;
  readonly attemptOrdinal: number;
  readonly state: MemoryExtractionAttemptState;
  readonly turnId: string;
  readonly runId: string;
  readonly snapshotKind: MemoryExtractionSnapshotKind;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly failureCode: string | null;
  readonly failureStage: MemoryExtractionFailureStage | null;
  readonly metrics: MemoryExtractionAttemptMetrics | null;
}

export interface ClaimMemoryExtractionOperationRequest {
  readonly operationId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly snapshotKind: MemoryExtractionSnapshotKind;
  readonly leaseExpiresAt: number;
  /** Optional durable retry ceiling enforced atomically before a new Attempt is created. */
  readonly maxAttempts?: number;
  /** Required with maxAttempts so exhaustion can enter retained terminal failure. */
  readonly diagnosticRetentionUntil?: number;
}

export interface ClaimMemoryExtractionOperationResult {
  readonly operation: MemoryExtractionOperation;
  readonly attempt: MemoryExtractionAttempt;
  readonly replayed: boolean;
}

export interface ListRecoverableMemoryExtractionsRequest {
  /**
   * Eligibility is evaluated against the Store clock; callers cannot supply `now`.
   * The Store applies a bounded default and rejects values above its hard cap.
   */
  readonly limit?: number;
}

export interface ListUnassignedMemoryExtractionSweepDebtsRequest {
  readonly limit?: number;
}

/** A durable Sweep boundary that was requested but has no active Operation. */
export type MemoryExtractionSweepDebt = MemoryExtractionCursor & {
  readonly activeSweepOperationId: null;
};

export interface CreateMemoryExtractionSweepFollowupRequest {
  readonly operation: CreateMemoryExtractionOperationRequest;
  /** CAS guard captured by the reconciler before it builds the follow-up request. */
  readonly expectedCursorVersion: number;
}

export interface RenewMemoryExtractionAttemptLeaseRequest {
  readonly operationId: string;
  readonly attemptId: string;
  /** Trusted Child AgentRun identity bound when the Attempt was claimed. */
  readonly runId: string;
  readonly leaseExpiresAt: number;
}

export interface FailMemoryExtractionAttemptRequest {
  readonly operationId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly failureCode: string;
  readonly failureStage: MemoryExtractionFailureStage;
  readonly metrics?: MemoryExtractionAttemptMetrics | null;
  /** When set, the Operation returns to pending; otherwise this is its final failure. */
  readonly nextAttemptAt?: number | null;
  /** Required for a final failure and ignored for a retryable failure. */
  readonly diagnosticRetentionUntil?: number | null;
}

export interface MemoryExtractionCursor {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly committedEventSeq: number;
  readonly committedEventId: string | null;
  readonly committedPrefixDigest: MemorySha256Digest | null;
  readonly requestedEventSeq: number;
  readonly requestedEventId: string | null;
  readonly requestedPrefixDigest: MemorySha256Digest | null;
  readonly activeSweepOperationId: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Raise, but never lower, a running sweep's requested high-water boundary. */
export interface RaiseMemoryExtractionRequestedBoundaryRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly activeSweepOperationId: string;
  readonly requestedEventSeq: number;
  readonly requestedEventId: string;
  readonly requestedPrefixDigest: MemorySha256Digest;
}

export interface SearchMemoryExtractionCandidatesRequest {
  readonly content: string;
  readonly kind: MemoryItemKind;
  readonly statementType: MemoryStatementType;
  readonly temporalType: MemoryTemporalType;
  readonly scopeType: MemoryScopeType;
  readonly scopeKey?: string | null;
  readonly eventStartedAt?: number | null;
  readonly eventEndedAt?: number | null;
  readonly keys: readonly string[];
  readonly sourceEventIds?: readonly string[];
  /** Hard-capped by the Store at 20. */
  readonly limit?: number;
}

export interface MemoryExtractionCandidate {
  readonly record: MemoryItemRecord;
  readonly contentHashMatch: boolean;
  readonly sourceOverlapCount: number;
  readonly exactKeyMatchCount: number;
  readonly kindMatch: boolean;
  readonly statementTypeMatch: boolean;
  readonly temporalMatch: boolean;
}

export interface SearchMemoryExtractionCandidatesResult {
  readonly candidates: readonly MemoryExtractionCandidate[];
  readonly truncated: boolean;
}

export interface CommitMemoryExtractionRequest {
  readonly operationId: string;
  readonly attemptId: string;
  /** Trusted Child AgentRun identity bound when the Attempt was claimed. */
  readonly runId: string;
  readonly resultType: MemoryExtractionResultType;
  readonly selectionSaturated: boolean;
  readonly evidenceDigest: MemorySha256Digest;
  readonly mutations: readonly MemoryItemMutation[];
  readonly diagnosticRetentionUntil: number;
}

export interface MemoryExtractionCommitReceipt {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly attemptId: string;
  readonly resultType: MemoryExtractionResultType;
  readonly selectionSaturated: boolean;
  readonly evidenceDigest: MemorySha256Digest;
  readonly mutationDigest: MemorySha256Digest;
  readonly writeOperationId: string;
  readonly committedAt: number;
  readonly mutationResults: readonly MemoryMutationResult[];
  /** Frozen post-commit snapshots; replay never re-reads later Cursor state. */
  readonly cursors: readonly MemoryExtractionCursor[];
}

export interface CommitMemoryExtractionResult {
  readonly operation: MemoryExtractionOperation;
  readonly attempt: MemoryExtractionAttempt;
  readonly writeOperation: MemoryWriteOperationResult;
  readonly cursors: readonly MemoryExtractionCursor[];
  readonly receipt: MemoryExtractionCommitReceipt;
  readonly resultType: MemoryExtractionResultType;
  readonly replayed: boolean;
}

export interface ClaimMemoryExtractionCleanupRequest {
  readonly operationId: string;
  readonly claimId: string;
  readonly leaseExpiresAt: number;
}

export interface FinishMemoryExtractionCleanupRequest {
  readonly operationId: string;
  readonly claimId: string;
  /** Omit on success; a stable code returns the cleanup task to pending. */
  readonly errorCode?: string;
}

export interface CancelMemoryExtractionsForSessionsRequest {
  readonly sessionIds: readonly string[];
  readonly diagnosticRetentionUntil: number;
}

export interface MemoryItemStore {
  applyMutations(request: ApplyMemoryMutationsRequest): Promise<MemoryWriteOperationResult>;
  readItem(itemId: string): Promise<MemoryItemRecord | undefined>;
  searchByKeys(request: SearchMemoryItemsByKeyRequest): Promise<readonly MemoryItemRecord[]>;
  readOperation(operationId: string): Promise<MemoryWriteOperationResult | undefined>;
  createMemoryExtractionOperation(
    request: CreateMemoryExtractionOperationRequest,
  ): Promise<CreateMemoryExtractionOperationResult>;
  claimMemoryExtractionOperation(
    request: ClaimMemoryExtractionOperationRequest,
  ): Promise<ClaimMemoryExtractionOperationResult | undefined>;
  listRecoverableMemoryExtractions(
    request?: ListRecoverableMemoryExtractionsRequest,
  ): Promise<readonly MemoryExtractionOperation[]>;
  /** Terminal Operations whose diagnostic retention elapsed and whose cleanup is claimable. */
  listRecoverableMemoryExtractionCleanups(
    request?: ListRecoverableMemoryExtractionsRequest,
  ): Promise<readonly MemoryExtractionOperation[]>;
  hasUnfinishedMemoryExtractions(): Promise<boolean>;
  listUnassignedMemoryExtractionSweepDebts(
    request?: ListUnassignedMemoryExtractionSweepDebtsRequest,
  ): Promise<readonly MemoryExtractionSweepDebt[]>;
  createMemoryExtractionSweepFollowup(
    request: CreateMemoryExtractionSweepFollowupRequest,
  ): Promise<CreateMemoryExtractionOperationResult | undefined>;
  renewMemoryExtractionAttemptLease(
    request: RenewMemoryExtractionAttemptLeaseRequest,
  ): Promise<MemoryExtractionOperation>;
  failMemoryExtractionAttempt(
    request: FailMemoryExtractionAttemptRequest,
  ): Promise<MemoryExtractionOperation>;
  readMemoryExtractionOperation(
    operationId: string,
  ): Promise<MemoryExtractionOperation | undefined>;
  readMemoryExtractionAttempt(attemptId: string): Promise<MemoryExtractionAttempt | undefined>;
  readMemoryExtractionCursor(
    sessionId: string,
    runId: string,
  ): Promise<MemoryExtractionCursor | undefined>;
  raiseMemoryExtractionRequestedBoundary(
    request: RaiseMemoryExtractionRequestedBoundaryRequest,
  ): Promise<MemoryExtractionCursor>;
  searchMemoryExtractionCandidates(
    request: SearchMemoryExtractionCandidatesRequest,
  ): Promise<SearchMemoryExtractionCandidatesResult>;
  commitMemoryExtraction(
    request: CommitMemoryExtractionRequest,
  ): Promise<CommitMemoryExtractionResult>;
  claimMemoryExtractionCleanup(
    request: ClaimMemoryExtractionCleanupRequest,
  ): Promise<MemoryExtractionOperation | undefined>;
  finishMemoryExtractionCleanup(
    request: FinishMemoryExtractionCleanupRequest,
  ): Promise<MemoryExtractionOperation>;
  cancelMemoryExtractionsForSessions(
    request: CancelMemoryExtractionsForSessionsRequest,
  ): Promise<readonly string[]>;
}

export type MemoryItemStoreConflictReason =
  | 'operation_reused'
  | 'version_conflict'
  | 'duplicate_active'
  | 'duplicate_within_batch'
  | 'item_not_found'
  | 'invalid_lifecycle_transition'
  | 'extraction_operation_not_found'
  | 'extraction_operation_not_claimable'
  | 'extraction_queue_full'
  | 'extraction_attempt_not_active'
  | 'extraction_cursor_conflict'
  | 'extraction_cleanup_conflict';

export class MemoryItemStoreConflictError extends Error {
  readonly name = 'MemoryItemStoreConflictError';

  constructor(
    readonly reason: MemoryItemStoreConflictReason,
    message: string,
    readonly itemId?: string,
    readonly conflictingItemId?: string,
  ) {
    super(message);
  }
}

export function normalizeLongTermMemoryContent(
  input: unknown,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string } {
  if (typeof input !== 'string') {
    return { ok: false, message: 'Long-term Memory Item content must be a string' };
  }
  if (LONG_TERM_MEMORY_SURROGATE_CHARS.test(input)) {
    return {
      ok: false,
      message: 'Long-term Memory Item content cannot contain unpaired surrogate code points',
    };
  }
  const value = input
    .normalize('NFC')
    .replace(LONG_TERM_MEMORY_CONTROL_CHARS, ' ')
    .replace(LONG_TERM_MEMORY_ZERO_WIDTH_CHARS, '')
    .trim();
  if (value === '') {
    return { ok: false, message: 'Long-term Memory Item content cannot be empty' };
  }
  if (Array.from(value).length > LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS) {
    return {
      ok: false,
      message: `Long-term Memory Item content must be ${LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS} code points or fewer`,
    };
  }
  return { ok: true, value };
}

/** Validate the stored event bounds without deriving a relative status. */
export function validateMemoryTemporalBounds(
  item: Pick<MemoryItem, 'temporalType' | 'eventStartedAt' | 'eventEndedAt'>,
): void {
  if (!isMemoryTemporalType(item.temporalType)) {
    throw new Error('Memory Item has invalid temporalType');
  }
  if (item.temporalType === 'undated') {
    if (item.eventStartedAt !== null || item.eventEndedAt !== null) {
      throw new Error('Undated Memory Item cannot carry event bounds');
    }
    return;
  }
  const start = item.eventStartedAt;
  if (!isTimestamp(start)) throw new Error('Dated Memory Item has invalid eventStartedAt');
  const end = item.eventEndedAt;
  if (item.temporalType === 'interval' && (!isTimestamp(end) || end <= start)) {
    throw new Error('Interval Memory Item requires an end after its start');
  }
  if (item.temporalType === 'point' && end !== null && (!isTimestamp(end) || end <= start)) {
    throw new Error('Point Memory Item end must be later than its start');
  }
  if (item.temporalType === 'open_ended' && end !== null) {
    throw new Error('Open-ended Memory Item cannot carry eventEndedAt');
  }
}

export function isMemoryItemKind(value: unknown): value is MemoryItemKind {
  return memberOf(MEMORY_ITEM_KINDS, value);
}

export function isMemoryStatementType(value: unknown): value is MemoryStatementType {
  return memberOf(MEMORY_STATEMENT_TYPES, value);
}

export function isMemoryTemporalType(value: unknown): value is MemoryTemporalType {
  return memberOf(MEMORY_TEMPORAL_TYPES, value);
}

export function isMemoryScopeType(value: unknown): value is MemoryScopeType {
  return memberOf(MEMORY_SCOPE_TYPES, value);
}

export function isMemoryLifecycleState(value: unknown): value is MemoryLifecycleState {
  return memberOf(MEMORY_LIFECYCLE_STATES, value);
}

export function isMemoryItemOrigin(value: unknown): value is MemoryItemOrigin {
  return memberOf(MEMORY_ITEM_ORIGINS, value);
}

export function isMemoryKeyType(value: unknown): value is MemoryKeyType {
  return memberOf(MEMORY_KEY_TYPES, value);
}

export function isMemoryKeyOrigin(value: unknown): value is MemoryKeyOrigin {
  return memberOf(MEMORY_KEY_ORIGINS, value);
}

export function isMemoryExtractionMode(value: unknown): value is MemoryExtractionMode {
  return memberOf(MEMORY_EXTRACTION_MODES, value);
}

export function isMemoryExtractionTriggerKind(
  value: unknown,
): value is MemoryExtractionTriggerKind {
  return memberOf(MEMORY_EXTRACTION_TRIGGER_KINDS, value);
}

export function isMemoryExtractionOperationState(
  value: unknown,
): value is MemoryExtractionOperationState {
  return memberOf(MEMORY_EXTRACTION_OPERATION_STATES, value);
}

export function isMemoryExtractionAttemptState(
  value: unknown,
): value is MemoryExtractionAttemptState {
  return memberOf(MEMORY_EXTRACTION_ATTEMPT_STATES, value);
}

export function isMemoryExtractionSnapshotKind(
  value: unknown,
): value is MemoryExtractionSnapshotKind {
  return memberOf(MEMORY_EXTRACTION_SNAPSHOT_KINDS, value);
}

export function isMemoryExtractionFailureStage(
  value: unknown,
): value is MemoryExtractionFailureStage {
  return memberOf(MEMORY_EXTRACTION_FAILURE_STAGES, value);
}

export function isMemoryExtractionCleanupState(
  value: unknown,
): value is MemoryExtractionCleanupState {
  return memberOf(MEMORY_EXTRACTION_CLEANUP_STATES, value);
}

export function isMemoryExtractionResultType(value: unknown): value is MemoryExtractionResultType {
  return memberOf(MEMORY_EXTRACTION_RESULT_TYPES, value);
}

function memberOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
