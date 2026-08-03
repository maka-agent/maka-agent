import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  MEMORY_EXTRACTION_MAX_RANGES,
  MemoryItemStoreConflictError,
  isMemoryExtractionAttemptState,
  isMemoryExtractionCleanupState,
  isMemoryExtractionFailureStage,
  isMemoryExtractionMode,
  isMemoryExtractionOperationState,
  isMemoryExtractionResultType,
  isMemoryExtractionSnapshotKind,
  isMemoryExtractionTriggerKind,
  isMemoryItemKind,
  isMemoryItemOrigin,
  isMemoryKeyOrigin,
  isMemoryKeyType,
  isMemoryLifecycleState,
  isMemoryScopeType,
  isMemoryStatementType,
  isMemoryTemporalType,
  normalizeLongTermMemoryContent,
  validateMemoryTemporalBounds,
  type ApplyMemoryMutationsRequest,
  type ClaimMemoryExtractionCleanupRequest,
  type CancelMemoryExtractionsForSessionsRequest,
  type ClaimMemoryExtractionOperationRequest,
  type ClaimMemoryExtractionOperationResult,
  type CommitMemoryExtractionRequest,
  type CommitMemoryExtractionResult,
  type CreateMemoryExtractionOperationRequest,
  type CreateMemoryExtractionOperationResult,
  type CreateMemoryExtractionSweepFollowupRequest,
  type FailMemoryExtractionAttemptRequest,
  type FinishMemoryExtractionCleanupRequest,
  type ListRecoverableMemoryExtractionsRequest,
  type ListUnassignedMemoryExtractionSweepDebtsRequest,
  type MemoryItem,
  type MemoryItemKey,
  type MemoryItemKeyInput,
  type MemoryItemMutation,
  type MemoryItemRecord,
  type MemoryItemSource,
  type MemoryItemStore,
  type MemoryItemWrite,
  type MemoryMutationResult,
  type MemorySha256Digest,
  type MemoryExtractionAttempt,
  type MemoryExtractionAttemptMetrics,
  type MemoryExtractionCandidate,
  type MemoryExtractionCommitReceipt,
  type MemoryExtractionCursor,
  type MemoryExtractionOperation,
  type MemoryExtractionOperationRange,
  type MemoryExtractionOperationRangeInput,
  type MemoryExtractionSweepDebt,
  type MemoryWriteOperationResult,
  type RaiseMemoryExtractionRequestedBoundaryRequest,
  type RenewMemoryExtractionAttemptLeaseRequest,
  type SearchMemoryExtractionCandidatesRequest,
  type SearchMemoryExtractionCandidatesResult,
  type SearchMemoryItemsByKeyRequest,
} from '@maka/core/long-term-memory';
import {
  assertSupportedSqliteLongTermMemorySchemaVersion,
  configureSqliteLongTermMemoryDatabase,
  migrateSqliteLongTermMemoryDatabase,
  readSqliteLongTermMemorySchemaVersion,
  type SqliteLongTermMemoryMigrationFailpoint,
} from './sqlite-long-term-memory-schema.js';

const MAX_MUTATIONS_PER_OPERATION = 32;
const MAX_KEYS_PER_ITEM = 32;
const MAX_SOURCES_PER_ITEM = 256;
const MAX_SEARCH_TERMS = 32;
const MAX_SEARCH_RESULTS = 100;
const MAX_EXTRACTION_CANDIDATES = 20;
const MAX_EXTRACTION_CANDIDATE_KEYS = 32;
const MAX_EXTRACTION_CANDIDATE_SOURCES = 256;
const DEFAULT_RECOVERABLE_EXTRACTION_LIMIT = 20;
const MAX_RECOVERABLE_EXTRACTION_LIMIT = 100;
const MAX_IDENTIFIER_CODE_POINTS = 512;
const MAX_KEY_CODE_POINTS = 256;
const MAX_OPERATION_RESULT_JSON_CODE_UNITS = 128 * 1_024;
const MAX_EXTRACTION_REQUEST_JSON_CODE_UNITS = 128 * 1_024;
const MAX_EXTRACTION_METRICS_JSON_CODE_UNITS = 8 * 1_024;

const require = createRequire(import.meta.url);

export type SqliteMemoryItemStoreFailpoint =
  | 'after_item_write'
  | 'after_keys_write'
  | 'after_sources_write'
  | 'after_cursor_write'
  | 'after_extraction_state_write'
  | 'before_operation_write'
  | 'after_commit';

export interface SqliteMemoryItemStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly failpoint?: (point: SqliteMemoryItemStoreFailpoint) => void;
  readonly migrationFailpoint?: (point: SqliteLongTermMemoryMigrationFailpoint) => void;
}

interface NormalizedMemoryWrite {
  readonly content: string;
  readonly kind: MemoryItem['kind'];
  readonly statementType: MemoryItem['statementType'];
  readonly temporalType: MemoryItem['temporalType'];
  readonly scopeType: MemoryItem['scopeType'];
  readonly scopeKey: string | null;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly observedAt: number;
  readonly origin: MemoryItem['origin'];
  readonly contentHash: string;
  readonly keys: readonly MemoryItemKey[];
  readonly sources: readonly MemoryItemSource[];
}

type NormalizedMutation =
  | { readonly type: 'create'; readonly item: NormalizedMemoryWrite }
  | {
      readonly type: 'update';
      readonly itemId: string;
      readonly expectedVersion: number;
      readonly item: NormalizedMemoryWrite;
    }
  | { readonly type: 'archive'; readonly itemId: string; readonly expectedVersion: number }
  | { readonly type: 'restore'; readonly itemId: string; readonly expectedVersion: number };

interface MemoryItemRow {
  item_id: unknown;
  version: unknown;
  content: unknown;
  kind: unknown;
  statement_type: unknown;
  temporal_type: unknown;
  scope_type: unknown;
  scope_key: unknown;
  event_started_at: unknown;
  event_ended_at: unknown;
  observed_at: unknown;
  lifecycle_state: unknown;
  origin: unknown;
  content_hash: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface MemoryKeyRow {
  key_text: unknown;
  normalized_key: unknown;
  key_type: unknown;
  key_origin: unknown;
}

interface MemorySourceRow {
  session_id: unknown;
  run_id: unknown;
  turn_id: unknown;
  event_id: unknown;
}

interface MemoryOperationRow {
  operation_id: unknown;
  operation_type: unknown;
  request_hash: unknown;
  result_json: unknown;
  committed_at: unknown;
}

interface MemoryExtractionOperationRow {
  operation_id: unknown;
  session_id: unknown;
  mode: unknown;
  trigger_kind: unknown;
  internal_session_id: unknown;
  session_create_fingerprint: unknown;
  request_hash: unknown;
  request_json: unknown;
  trigger_epoch: unknown;
  state: unknown;
  attempt_count: unknown;
  active_attempt_id: unknown;
  lease_expires_at: unknown;
  next_attempt_at: unknown;
  last_error_code: unknown;
  last_error_stage: unknown;
  last_error_at: unknown;
  last_failed_attempt_id: unknown;
  started_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
  result_type: unknown;
  commit_hash: unknown;
  result_json: unknown;
  diagnostic_retention_until: unknown;
  cleanup_state: unknown;
  cleanup_claim_id: unknown;
  cleanup_lease_expires_at: unknown;
  cleanup_attempt_count: unknown;
  cleanup_error_code: unknown;
  cleaned_at: unknown;
}

interface MemoryExtractionAttemptRow {
  attempt_id: unknown;
  operation_id: unknown;
  attempt_ordinal: unknown;
  state: unknown;
  turn_id: unknown;
  run_id: unknown;
  snapshot_kind: unknown;
  started_at: unknown;
  completed_at: unknown;
  failure_code: unknown;
  failure_stage: unknown;
  metrics_json: unknown;
}

interface MemoryExtractionOperationRangeRow {
  operation_id: unknown;
  range_ordinal: unknown;
  session_id: unknown;
  invocation_id: unknown;
  run_id: unknown;
  turn_id: unknown;
  from_event_seq_exclusive: unknown;
  from_event_id: unknown;
  from_prefix_digest: unknown;
  to_event_seq_inclusive: unknown;
  to_event_id: unknown;
  to_prefix_digest: unknown;
}

interface MemoryExtractionCursorRow {
  session_id: unknown;
  invocation_id: unknown;
  run_id: unknown;
  turn_id: unknown;
  committed_event_seq: unknown;
  committed_event_id: unknown;
  committed_prefix_digest: unknown;
  requested_event_seq: unknown;
  requested_event_id: unknown;
  requested_prefix_digest: unknown;
  active_sweep_operation_id: unknown;
  followup_eligible: unknown;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface MemoryExtractionCandidateRow {
  item_id: unknown;
  content_hash_match: unknown;
  source_overlap_count: unknown;
  exact_key_match_count: unknown;
  kind_match: unknown;
  statement_type_match: unknown;
  temporal_match: unknown;
}

interface NormalizedCreateMemoryExtractionOperation {
  readonly operationId: string;
  readonly sessionId: string;
  readonly mode: 'sweep' | 'targeted';
  readonly triggerKind: 'context_threshold' | 'compaction' | 'user_requested' | 'agent_requested';
  readonly internalSessionId: string;
  readonly sessionCreateFingerprint: string;
  readonly requestHash: string;
  readonly requestJson: string;
  readonly triggerEpoch: string | null;
  readonly ranges: readonly MemoryExtractionOperationRangeInput[];
  readonly maxUnfinishedTargetedPerSession: number | null;
}

interface NormalizedExtractionCandidateQuery {
  readonly contentHash: string;
  readonly kind: MemoryItem['kind'];
  readonly statementType: MemoryItem['statementType'];
  readonly temporalType: MemoryItem['temporalType'];
  readonly scopeType: MemoryItem['scopeType'];
  readonly scopeKey: string | null;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly keys: readonly string[];
  readonly sourceEventIds: readonly string[];
  readonly limit: number;
}

interface SqliteMemoryKeySearchQuery {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

/** Low-level implementation; production callers must use the StorageRoot authority facade. */
export class SqliteMemoryItemStore implements MemoryItemStore {
  readonly #database: DatabaseSync;
  readonly #options: SqliteMemoryItemStoreOptions;
  #closed = false;

  constructor(path: string, options: SqliteMemoryItemStoreOptions = {}) {
    if (path.trim() === '') throw new Error('Long-term memory SQLite path cannot be empty');
    this.#options = options;
    if (path !== ':memory:') preparePrivateDatabaseFiles(path);
    const Database = loadDatabaseSync();
    this.#database = new Database(path);
    try {
      assertSupportedSqliteLongTermMemorySchemaVersion(this.#database);
      configureSqliteLongTermMemoryDatabase(this.#database);
      migrateSqliteLongTermMemoryDatabase(this.#database, {
        failpoint: options.migrationFailpoint,
      });
      if (path !== ':memory:') secureExistingDatabaseFiles(path);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  schemaVersion(): number {
    this.#assertOpen();
    return readSqliteLongTermMemorySchemaVersion(this.#database);
  }

  journalMode(): string {
    this.#assertOpen();
    const row = this.#database.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
  }

  foreignKeysEnabled(): boolean {
    this.#assertOpen();
    const row = this.#database.prepare('PRAGMA foreign_keys').get() as
      | { foreign_keys?: unknown }
      | undefined;
    return row?.foreign_keys === 1;
  }

  async applyMutations(request: ApplyMemoryMutationsRequest): Promise<MemoryWriteOperationResult> {
    this.#assertOpen();
    const committedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const mutations = normalizeMutations(request.mutations);
    const requestHash = hashCanonical(mutations);
    const operationType = mutations.length === 1 ? mutations[0]!.type : 'batch';

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (this.#readExtractionOperationRow(operationId)) {
        throw new MemoryItemStoreConflictError(
          'operation_reused',
          `Memory operation ${operationId} is reserved by a Memory Extraction Operation`,
        );
      }
      const existing = this.#readOperationRow(operationId);
      if (existing) {
        if (requiredHash(existing.request_hash, 'request_hash') !== requestHash) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory operation ${operationId} was already used for a different request`,
          );
        }
        this.#database.exec('COMMIT');
        return { ...decodeOperation(existing), replayed: true };
      }

      validateObservedAtForCommit(mutations, committedAt);

      const results = this.#applyNormalizedMutations(mutations, committedAt);

      this.#options.failpoint?.('before_operation_write');
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, operationType, requestHash, JSON.stringify(results), committedAt);
      this.#database.exec('COMMIT');
      this.#options.failpoint?.('after_commit');
      return { operationId, operationType, replayed: false, committedAt, results };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async readItem(itemId: string): Promise<MemoryItemRecord | undefined> {
    this.#assertOpen();
    return this.#readSnapshot(() => this.#readItemRecord(normalizeIdentifier(itemId, 'itemId')));
  }

  async searchByKeys(request: SearchMemoryItemsByKeyRequest): Promise<readonly MemoryItemRecord[]> {
    this.#assertOpen();
    if (request.match !== 'exact' && request.match !== 'prefix') {
      throw new Error('Memory key match must be exact or prefix');
    }
    if (!Array.isArray(request.terms) || request.terms.length === 0) {
      throw new Error('Memory key search requires at least one term');
    }
    if (request.terms.length > MAX_SEARCH_TERMS) {
      throw new Error(`Memory key search accepts at most ${MAX_SEARCH_TERMS} terms`);
    }
    if (request.includeArchived !== undefined && typeof request.includeArchived !== 'boolean') {
      throw new Error('Memory key includeArchived must be a boolean');
    }
    const terms = [...new Set(request.terms.map(normalizeSearchTerm))].sort(compareText);
    const workspaceKey =
      request.workspaceKey === undefined
        ? undefined
        : normalizeIdentifier(request.workspaceKey, 'workspaceKey');
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw new Error(`Memory key search limit must be between 1 and ${MAX_SEARCH_RESULTS}`);
    }

    const query = buildSqliteMemoryKeySearchQuery({
      terms,
      match: request.match,
      workspaceKey,
      includeArchived: request.includeArchived ?? false,
      limit,
    });
    return this.#readSnapshot(() => {
      const rows = this.#database.prepare(query.sql).all(...query.parameters) as Array<{
        item_id?: unknown;
      }>;

      return rows.map((row) => {
        if (typeof row.item_id !== 'string') throw new Error('Invalid Memory Item search result');
        const record = this.#readItemRecord(row.item_id);
        if (!record) throw new Error(`Memory Item ${row.item_id} disappeared during read`);
        return record;
      });
    });
  }

  async readOperation(operationId: string): Promise<MemoryWriteOperationResult | undefined> {
    this.#assertOpen();
    const row = this.#readOperationRow(normalizeIdentifier(operationId, 'operationId'));
    return row ? decodeOperation(row) : undefined;
  }

  async createMemoryExtractionOperation(
    request: CreateMemoryExtractionOperationRequest,
  ): Promise<CreateMemoryExtractionOperationResult> {
    this.#assertOpen();
    const createdAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const normalized = normalizeCreateMemoryExtractionOperation(request);

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (this.#readOperationRow(normalized.operationId)) {
        throw new MemoryItemStoreConflictError(
          'operation_reused',
          `Memory operation ${normalized.operationId} is already a write receipt`,
        );
      }
      const existing = this.#readExtractionOperationRow(normalized.operationId);
      if (existing) {
        if (!extractionOperationDefinitionMatches(existing, normalized)) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory Extraction Operation ${normalized.operationId} was already used for a different request`,
          );
        }
        const operation = this.#decodeExtractionOperation(existing);
        this.#database.exec('COMMIT');
        return { operation, replayed: true };
      }

      const equivalent = this.#readExtractionOperationRowByRequestHash(
        normalized.sessionId,
        normalized.requestHash,
      );
      if (equivalent) {
        const operation = this.#decodeExtractionOperation(equivalent);
        this.#database.exec('COMMIT');
        return { operation, replayed: true };
      }

      if (normalized.maxUnfinishedTargetedPerSession !== null) {
        const row = this.#database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_extraction_operations
             WHERE session_id = ? AND mode = 'targeted' AND state IN ('pending', 'running')`,
          )
          .get(normalized.sessionId) as { count?: unknown } | undefined;
        const count = requiredNonNegativeInteger(row?.count, 'count');
        if (count >= normalized.maxUnfinishedTargetedPerSession) {
          throw new MemoryItemStoreConflictError(
            'extraction_queue_full',
            `Memory Extraction Targeted queue is full for Session ${normalized.sessionId}`,
          );
        }
      }

      this.#insertExtractionOperation(normalized, createdAt);

      const operation = this.#requireExtractionOperation(normalized.operationId);
      this.#database.exec('COMMIT');
      return { operation, replayed: false };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async listRecoverableMemoryExtractions(
    request: ListRecoverableMemoryExtractionsRequest = {},
  ): Promise<readonly MemoryExtractionOperation[]> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const limit = normalizeRecoverableExtractionLimit(request);
    return this.#readSnapshot(() => {
      const rows = this.#database
        .prepare(
          `SELECT * FROM memory_extraction_operations
           WHERE (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           ORDER BY
             CASE mode WHEN 'targeted' THEN 0 ELSE 1 END ASC,
             created_at ASC,
             operation_id ASC
           LIMIT ?`,
        )
        .all(now, now, limit) as unknown as MemoryExtractionOperationRow[];
      return rows.map((row) => this.#decodeExtractionOperation(row));
    });
  }

  async listRecoverableMemoryExtractionCleanups(
    request: ListRecoverableMemoryExtractionsRequest = {},
  ): Promise<readonly MemoryExtractionOperation[]> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const limit = normalizeRecoverableExtractionLimit(request);
    return this.#readSnapshot(() => {
      const rows = this.#database
        .prepare(
          `SELECT * FROM memory_extraction_operations
           WHERE state IN ('succeeded', 'failed')
             AND diagnostic_retention_until <= ?
             AND (cleanup_state = 'pending'
               OR (cleanup_state = 'running' AND cleanup_lease_expires_at <= ?))
           ORDER BY diagnostic_retention_until ASC, operation_id ASC
           LIMIT ?`,
        )
        .all(now, now, limit) as unknown as MemoryExtractionOperationRow[];
      return rows.map((row) => this.#decodeExtractionOperation(row));
    });
  }

  async hasUnfinishedMemoryExtractions(): Promise<boolean> {
    this.#assertOpen();
    return this.#readSnapshot(() =>
      Boolean(
        this.#database
          .prepare(
            `SELECT 1
             FROM memory_extraction_operations
             WHERE state IN ('pending', 'running')
             LIMIT 1`,
          )
          .get(),
      ),
    );
  }

  async listUnassignedMemoryExtractionSweepDebts(
    request: ListUnassignedMemoryExtractionSweepDebtsRequest = {},
  ): Promise<readonly MemoryExtractionSweepDebt[]> {
    this.#assertOpen();
    const limit = normalizeSweepDebtLimit(request);
    return this.#readSnapshot(() => {
      const rows = this.#database
        .prepare(
          `SELECT * FROM memory_extraction_cursors
           WHERE active_sweep_operation_id IS NULL
             AND requested_event_seq > committed_event_seq
             AND followup_eligible = 1
           ORDER BY updated_at ASC, session_id ASC, run_id ASC
           LIMIT ?`,
        )
        .all(limit) as unknown as MemoryExtractionCursorRow[];
      return rows.map((row) => {
        const cursor = decodeExtractionCursor(row);
        if (cursor.activeSweepOperationId !== null)
          throw invalidColumn('active_sweep_operation_id');
        return cursor as MemoryExtractionSweepDebt;
      });
    });
  }

  async createMemoryExtractionSweepFollowup(
    request: CreateMemoryExtractionSweepFollowupRequest,
  ): Promise<CreateMemoryExtractionOperationResult | undefined> {
    this.#assertOpen();
    if (!Number.isSafeInteger(request.expectedCursorVersion) || request.expectedCursorVersion < 1) {
      throw new Error('Memory Extraction follow-up expectedCursorVersion must be positive');
    }
    const createdAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const normalized = normalizeCreateMemoryExtractionOperation(request.operation);
    if (normalized.mode !== 'sweep' || normalized.ranges.length !== 1) {
      throw new Error('Memory Extraction follow-up requires exactly one Sweep Range');
    }
    const range = normalized.ranges[0]!;

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#readExtractionOperationRow(normalized.operationId);
      if (existing) {
        if (!extractionOperationDefinitionMatches(existing, normalized)) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory Extraction Operation ${normalized.operationId} was already used for a different request`,
          );
        }
        const operation = this.#decodeExtractionOperation(existing);
        this.#database.exec('COMMIT');
        return { operation, replayed: true };
      }

      const cursorRow = this.#readExtractionCursorRow(range.sessionId, range.runId);
      if (!cursorRow)
        throw extractionCursorConflict(range.sessionId, range.runId, 'does not exist');
      const cursor = decodeExtractionCursor(cursorRow);
      if (
        cursor.version !== request.expectedCursorVersion ||
        cursor.activeSweepOperationId !== null ||
        cursor.requestedEventSeq <= cursor.committedEventSeq ||
        requiredBooleanInteger(cursorRow.followup_eligible, 'followup_eligible') !== true
      ) {
        this.#database.exec('COMMIT');
        return undefined;
      }
      if (
        cursor.invocationId !== range.invocationId ||
        cursor.turnId !== range.turnId ||
        !cursorMatchesFrozenStart(cursor, range) ||
        cursor.requestedEventSeq !== range.toEventSeqInclusive ||
        cursor.requestedEventId !== range.toEventId ||
        cursor.requestedPrefixDigest !== range.toPrefixDigest
      ) {
        throw extractionCursorConflict(range.sessionId, range.runId, 'follow-up debt changed');
      }

      this.#insertExtractionOperation(normalized, createdAt);
      const operation = this.#requireExtractionOperation(normalized.operationId);
      this.#database.exec('COMMIT');
      return { operation, replayed: false };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async claimMemoryExtractionOperation(
    request: ClaimMemoryExtractionOperationRequest,
  ): Promise<ClaimMemoryExtractionOperationResult | undefined> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const attemptId = normalizeIdentifier(request.attemptId, 'attemptId');
    const turnId = normalizeIdentifier(request.turnId, 'attempt turnId');
    const runId = normalizeIdentifier(request.runId, 'attempt runId');
    if (!isMemoryExtractionSnapshotKind(request.snapshotKind)) {
      throw new Error('Invalid Memory Extraction snapshot kind');
    }
    const leaseExpiresAt = normalizeTimestamp(request.leaseExpiresAt, 'leaseExpiresAt');
    if (leaseExpiresAt <= now) throw new Error('Memory Extraction lease must expire in the future');
    const maxAttempts =
      request.maxAttempts === undefined
        ? null
        : normalizePositiveInteger(request.maxAttempts, 'maxAttempts');
    const exhaustionRetentionUntil =
      request.diagnosticRetentionUntil === undefined
        ? null
        : normalizeTimestamp(request.diagnosticRetentionUntil, 'diagnosticRetentionUntil');
    if ((maxAttempts === null) !== (exhaustionRetentionUntil === null)) {
      throw new Error('Memory Extraction retry ceiling requires diagnostic retention');
    }
    if (exhaustionRetentionUntil !== null && exhaustionRetentionUntil < now) {
      throw new Error('diagnosticRetentionUntil cannot be earlier than claim time');
    }

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existingAttemptRow = this.#readExtractionAttemptRow(attemptId);
      if (existingAttemptRow) {
        const existingAttempt = decodeExtractionAttempt(existingAttemptRow);
        const operation = this.#requireExtractionOperation(operationId);
        if (
          existingAttempt.operationId !== operationId ||
          existingAttempt.turnId !== turnId ||
          existingAttempt.runId !== runId ||
          existingAttempt.snapshotKind !== request.snapshotKind
        ) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory Extraction Attempt ${attemptId} was already used for a different claim`,
          );
        }
        if (
          existingAttempt.state !== 'running' ||
          operation.state !== 'running' ||
          operation.activeAttemptId !== attemptId
        ) {
          this.#database.exec('COMMIT');
          return undefined;
        }
        this.#database.exec('COMMIT');
        return { operation, attempt: existingAttempt, replayed: true };
      }

      const operationRow = this.#readExtractionOperationRow(operationId);
      if (!operationRow) throw extractionOperationNotFound(operationId);
      const operation = this.#decodeExtractionOperation(operationRow);
      if (operation.state === 'succeeded' || operation.state === 'failed') {
        this.#database.exec('COMMIT');
        return undefined;
      }
      if (
        operation.state === 'pending' &&
        operation.nextAttemptAt !== null &&
        operation.nextAttemptAt > now
      ) {
        this.#database.exec('COMMIT');
        return undefined;
      }
      if (
        operation.state === 'running' &&
        operation.leaseExpiresAt !== null &&
        operation.leaseExpiresAt > now
      ) {
        this.#database.exec('COMMIT');
        return undefined;
      }

      if (maxAttempts !== null && operation.attemptCount >= maxAttempts) {
        if (operation.state === 'running') {
          const staleAttemptId = operation.activeAttemptId;
          if (!staleAttemptId) throw invalidColumn('active_attempt_id');
          this.#database
            .prepare(
              `UPDATE memory_extraction_attempts
               SET state = 'abandoned', completed_at = ?,
                   failure_code = 'attempt_limit_exhausted', failure_stage = 'recovery'
               WHERE attempt_id = ? AND operation_id = ? AND state = 'running'`,
            )
            .run(now, staleAttemptId, operationId);
        }
        this.#database
          .prepare(
            `UPDATE memory_extraction_operations
             SET state = 'failed', active_attempt_id = NULL, lease_expires_at = NULL,
                 next_attempt_at = NULL, last_error_code = 'attempt_limit_exhausted',
                 last_error_stage = 'recovery', last_error_at = ?,
                 last_failed_attempt_id = COALESCE(active_attempt_id, last_failed_attempt_id),
                 updated_at = MAX(updated_at, ?), completed_at = ?, result_type = NULL,
                 diagnostic_retention_until = ?, cleanup_state = 'pending',
                 cleanup_claim_id = NULL, cleanup_lease_expires_at = NULL,
                 cleanup_error_code = NULL, cleaned_at = NULL
             WHERE operation_id = ? AND state IN ('pending', 'running')`,
          )
          .run(now, now, now, exhaustionRetentionUntil, operationId);
        this.#database
          .prepare(
            `UPDATE memory_extraction_cursors
             SET active_sweep_operation_id = NULL, followup_eligible = 0,
                 version = version + 1,
                 updated_at = MAX(updated_at, ?)
             WHERE active_sweep_operation_id = ?`,
          )
          .run(now, operationId);
        this.#database.exec('COMMIT');
        return undefined;
      }

      if (operation.state === 'running') {
        const staleAttemptId = operation.activeAttemptId;
        if (!staleAttemptId) throw invalidColumn('active_attempt_id');
        const stale = this.#database
          .prepare(
            `UPDATE memory_extraction_attempts
             SET state = 'abandoned', completed_at = ?,
                 failure_code = 'lease_expired', failure_stage = 'recovery'
             WHERE attempt_id = ? AND operation_id = ? AND state = 'running'`,
          )
          .run(now, staleAttemptId, operationId);
        if (Number(stale.changes) !== 1) {
          throw new MemoryItemStoreConflictError(
            'extraction_attempt_not_active',
            `Memory Extraction Attempt ${staleAttemptId} is no longer active`,
          );
        }
      }

      const ordinal = operation.attemptCount + 1;
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_attempts(
             attempt_id, operation_id, attempt_ordinal, state, turn_id, run_id,
             snapshot_kind, started_at, completed_at, failure_code, failure_stage, metrics_json
           ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(attemptId, operationId, ordinal, turnId, runId, request.snapshotKind, now);
      const updated = this.#database
        .prepare(
          `UPDATE memory_extraction_operations
           SET state = 'running', attempt_count = ?, active_attempt_id = ?,
               lease_expires_at = ?, next_attempt_at = NULL,
               last_error_code = CASE WHEN state = 'running' THEN 'lease_expired' ELSE last_error_code END,
               last_error_stage = CASE WHEN state = 'running' THEN 'recovery' ELSE last_error_stage END,
               last_error_at = CASE WHEN state = 'running' THEN ? ELSE last_error_at END,
               last_failed_attempt_id = CASE WHEN state = 'running' THEN active_attempt_id ELSE last_failed_attempt_id END,
               started_at = COALESCE(started_at, ?), updated_at = MAX(updated_at, ?)
           WHERE operation_id = ? AND state IN ('pending', 'running')`,
        )
        .run(ordinal, attemptId, leaseExpiresAt, now, now, now, operationId);
      if (Number(updated.changes) !== 1) {
        throw new MemoryItemStoreConflictError(
          'extraction_operation_not_claimable',
          `Memory Extraction Operation ${operationId} is not claimable`,
        );
      }

      const claimedOperation = this.#requireExtractionOperation(operationId);
      const attempt = this.#requireExtractionAttempt(attemptId);
      this.#database.exec('COMMIT');
      return { operation: claimedOperation, attempt, replayed: false };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async renewMemoryExtractionAttemptLease(
    request: RenewMemoryExtractionAttemptLeaseRequest,
  ): Promise<MemoryExtractionOperation> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const attemptId = normalizeIdentifier(request.attemptId, 'attemptId');
    const runId = normalizeIdentifier(request.runId, 'attempt runId');
    const leaseExpiresAt = normalizeTimestamp(request.leaseExpiresAt, 'leaseExpiresAt');
    if (leaseExpiresAt <= now) throw new Error('Memory Extraction lease must expire in the future');

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#requireActiveExtractionAttempt(operationId, attemptId, runId);
      const operation = this.#requireExtractionOperation(operationId);
      if (operation.leaseExpiresAt === null || operation.leaseExpiresAt <= now) {
        throw extractionAttemptNotActive(attemptId);
      }
      if (leaseExpiresAt < operation.leaseExpiresAt) {
        throw new Error('Memory Extraction lease renewal cannot shorten the active lease');
      }
      if (leaseExpiresAt === operation.leaseExpiresAt) {
        this.#database.exec('COMMIT');
        return operation;
      }

      const updated = this.#database
        .prepare(
          `UPDATE memory_extraction_operations
           SET lease_expires_at = ?, updated_at = MAX(updated_at, ?)
           WHERE operation_id = ? AND state = 'running' AND active_attempt_id = ?
             AND lease_expires_at = ? AND lease_expires_at > ?`,
        )
        .run(leaseExpiresAt, now, operationId, attemptId, operation.leaseExpiresAt, now);
      if (Number(updated.changes) !== 1) throw extractionAttemptNotActive(attemptId);
      const renewed = this.#requireExtractionOperation(operationId);
      this.#database.exec('COMMIT');
      return renewed;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async failMemoryExtractionAttempt(
    request: FailMemoryExtractionAttemptRequest,
  ): Promise<MemoryExtractionOperation> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const attemptId = normalizeIdentifier(request.attemptId, 'attemptId');
    const runId = normalizeIdentifier(request.runId, 'attempt runId');
    const failureCode = normalizeStableErrorCode(request.failureCode, 'failureCode');
    if (!isMemoryExtractionFailureStage(request.failureStage)) {
      throw new Error('Invalid Memory Extraction failure stage');
    }
    const metricsJson = encodeExtractionMetrics(request.metrics ?? null);
    const nextAttemptAt = normalizeOptionalTimestamp(request.nextAttemptAt, 'nextAttemptAt');
    const diagnosticRetentionUntil = normalizeOptionalTimestamp(
      request.diagnosticRetentionUntil,
      'diagnosticRetentionUntil',
    );
    if (nextAttemptAt !== null && nextAttemptAt < now) {
      throw new Error('nextAttemptAt cannot be earlier than failure time');
    }
    if (
      nextAttemptAt === null &&
      (diagnosticRetentionUntil === null || diagnosticRetentionUntil < now)
    ) {
      throw new Error(
        'Final Memory Extraction failure requires a future diagnostic retention boundary',
      );
    }

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#requireActiveExtractionAttempt(operationId, attemptId, runId);
      const attemptUpdate = this.#database
        .prepare(
          `UPDATE memory_extraction_attempts
           SET state = 'failed', completed_at = ?, failure_code = ?, failure_stage = ?, metrics_json = ?
           WHERE attempt_id = ? AND operation_id = ? AND run_id = ? AND state = 'running'`,
        )
        .run(now, failureCode, request.failureStage, metricsJson, attemptId, operationId, runId);
      if (Number(attemptUpdate.changes) !== 1) throw extractionAttemptNotActive(attemptId);

      const operationUpdate =
        nextAttemptAt === null
          ? this.#database
              .prepare(
                `UPDATE memory_extraction_operations
               SET state = 'failed', active_attempt_id = NULL, lease_expires_at = NULL,
                   next_attempt_at = NULL, last_error_code = ?, last_error_stage = ?,
                   last_error_at = ?, last_failed_attempt_id = ?, updated_at = MAX(updated_at, ?),
                   completed_at = ?, result_type = NULL, diagnostic_retention_until = ?,
                   cleanup_state = 'pending', cleanup_claim_id = NULL,
                   cleanup_lease_expires_at = NULL, cleanup_error_code = NULL, cleaned_at = NULL
               WHERE operation_id = ? AND state = 'running' AND active_attempt_id = ?`,
              )
              .run(
                failureCode,
                request.failureStage,
                now,
                attemptId,
                now,
                now,
                diagnosticRetentionUntil,
                operationId,
                attemptId,
              )
          : this.#database
              .prepare(
                `UPDATE memory_extraction_operations
               SET state = 'pending', active_attempt_id = NULL, lease_expires_at = NULL,
                   next_attempt_at = ?, last_error_code = ?, last_error_stage = ?,
                   last_error_at = ?, last_failed_attempt_id = ?, updated_at = MAX(updated_at, ?)
               WHERE operation_id = ? AND state = 'running' AND active_attempt_id = ?`,
              )
              .run(
                nextAttemptAt,
                failureCode,
                request.failureStage,
                now,
                attemptId,
                now,
                operationId,
                attemptId,
              );
      if (Number(operationUpdate.changes) !== 1) throw extractionAttemptNotActive(attemptId);
      if (nextAttemptAt === null) {
        this.#database
          .prepare(
            `UPDATE memory_extraction_cursors
             SET active_sweep_operation_id = NULL, followup_eligible = 0,
                 version = version + 1,
                 updated_at = MAX(updated_at, ?)
             WHERE active_sweep_operation_id = ?`,
          )
          .run(now, operationId);
      }
      const operation = this.#requireExtractionOperation(operationId);
      this.#database.exec('COMMIT');
      return operation;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async readMemoryExtractionOperation(
    operationId: string,
  ): Promise<MemoryExtractionOperation | undefined> {
    this.#assertOpen();
    const normalized = normalizeIdentifier(operationId, 'operationId');
    return this.#readSnapshot(() => {
      const row = this.#readExtractionOperationRow(normalized);
      return row ? this.#decodeExtractionOperation(row) : undefined;
    });
  }

  async readMemoryExtractionAttempt(
    attemptId: string,
  ): Promise<MemoryExtractionAttempt | undefined> {
    this.#assertOpen();
    const normalized = normalizeIdentifier(attemptId, 'attemptId');
    const row = this.#readExtractionAttemptRow(normalized);
    return row ? decodeExtractionAttempt(row) : undefined;
  }

  async readMemoryExtractionCursor(
    sessionId: string,
    runId: string,
  ): Promise<MemoryExtractionCursor | undefined> {
    this.#assertOpen();
    const row = this.#readExtractionCursorRow(
      normalizeIdentifier(sessionId, 'sessionId'),
      normalizeIdentifier(runId, 'runId'),
    );
    return row ? decodeExtractionCursor(row) : undefined;
  }

  async raiseMemoryExtractionRequestedBoundary(
    request: RaiseMemoryExtractionRequestedBoundaryRequest,
  ): Promise<MemoryExtractionCursor> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const sessionId = normalizeIdentifier(request.sessionId, 'sessionId');
    const runId = normalizeIdentifier(request.runId, 'runId');
    const operationId = normalizeIdentifier(
      request.activeSweepOperationId,
      'activeSweepOperationId',
    );
    const requestedEventSeq = normalizePositiveInteger(
      request.requestedEventSeq,
      'requestedEventSeq',
    );
    const requestedEventId = normalizeIdentifier(request.requestedEventId, 'requestedEventId');
    const requestedPrefixDigest = normalizeSha256Digest(
      request.requestedPrefixDigest,
      'requestedPrefixDigest',
    );

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const operation = this.#requireExtractionOperation(operationId);
      if (operation.mode !== 'sweep' || !['pending', 'running'].includes(operation.state)) {
        throw new MemoryItemStoreConflictError(
          'extraction_cursor_conflict',
          `Memory Extraction Operation ${operationId} cannot own an active Sweep Cursor`,
        );
      }
      const row = this.#readExtractionCursorRow(sessionId, runId);
      if (!row) throw extractionCursorConflict(sessionId, runId, 'does not exist');
      const cursor = decodeExtractionCursor(row);
      if (cursor.activeSweepOperationId !== operationId) {
        throw extractionCursorConflict(sessionId, runId, 'is owned by another Sweep Operation');
      }
      if (requestedEventSeq < cursor.requestedEventSeq) {
        throw extractionCursorConflict(
          sessionId,
          runId,
          'requested boundary cannot move backwards',
        );
      }
      if (requestedEventSeq === cursor.requestedEventSeq) {
        if (
          cursor.requestedEventId !== requestedEventId ||
          cursor.requestedPrefixDigest !== requestedPrefixDigest
        ) {
          throw extractionCursorConflict(sessionId, runId, 'requested boundary identity changed');
        }
        this.#database.exec('COMMIT');
        return cursor;
      }
      this.#database
        .prepare(
          `UPDATE memory_extraction_cursors
           SET requested_event_seq = ?, requested_event_id = ?, requested_prefix_digest = ?,
               version = version + 1, updated_at = MAX(updated_at, ?)
           WHERE session_id = ? AND run_id = ? AND active_sweep_operation_id = ?`,
        )
        .run(
          requestedEventSeq,
          requestedEventId,
          requestedPrefixDigest,
          now,
          sessionId,
          runId,
          operationId,
        );
      const updated = this.#readExtractionCursorRow(sessionId, runId);
      if (!updated) throw invalidColumn('memory_extraction_cursors');
      this.#database.exec('COMMIT');
      return decodeExtractionCursor(updated);
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async searchMemoryExtractionCandidates(
    request: SearchMemoryExtractionCandidatesRequest,
  ): Promise<SearchMemoryExtractionCandidatesResult> {
    this.#assertOpen();
    const query = normalizeExtractionCandidateQuery(request);
    return this.#readSnapshot(() => {
      const built = buildExtractionCandidateQuery(query);
      const rows = this.#database
        .prepare(built.sql)
        .all(...built.parameters) as unknown as MemoryExtractionCandidateRow[];
      const truncated = rows.length > query.limit;
      const candidates = rows.slice(0, query.limit).map((row): MemoryExtractionCandidate => {
        const itemId = requiredIdentifierString(row.item_id, 'item_id');
        return {
          record: this.#requireItemRecord(itemId),
          contentHashMatch: requiredBooleanInteger(row.content_hash_match, 'content_hash_match'),
          sourceOverlapCount: requiredNonNegativeInteger(
            row.source_overlap_count,
            'source_overlap_count',
          ),
          exactKeyMatchCount: requiredNonNegativeInteger(
            row.exact_key_match_count,
            'exact_key_match_count',
          ),
          kindMatch: requiredBooleanInteger(row.kind_match, 'kind_match'),
          statementTypeMatch: requiredBooleanInteger(
            row.statement_type_match,
            'statement_type_match',
          ),
          temporalMatch: requiredBooleanInteger(row.temporal_match, 'temporal_match'),
        };
      });
      return { candidates, truncated };
    });
  }

  async commitMemoryExtraction(
    request: CommitMemoryExtractionRequest,
  ): Promise<CommitMemoryExtractionResult> {
    this.#assertOpen();
    const committedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const attemptId = normalizeIdentifier(request.attemptId, 'attemptId');
    const runId = normalizeIdentifier(request.runId, 'attempt runId');
    if (!isMemoryExtractionResultType(request.resultType)) {
      throw new Error('Invalid Memory Extraction result type');
    }
    if (typeof request.selectionSaturated !== 'boolean') {
      throw new Error('Memory Extraction selectionSaturated must be a boolean');
    }
    const evidenceDigest = normalizeSha256Digest(request.evidenceDigest, 'evidenceDigest');
    const diagnosticRetentionUntil = normalizeTimestamp(
      request.diagnosticRetentionUntil,
      'diagnosticRetentionUntil',
    );
    const mutations = normalizeMutations(request.mutations, true);
    validateObservedAtForCommit(mutations, committedAt);

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const operationRow = this.#readExtractionOperationRow(operationId);
      if (!operationRow) throw extractionOperationNotFound(operationId);
      const operation = this.#decodeExtractionOperation(operationRow);
      const ranges = operation.ranges;
      validateExtractionCommitShape(operation, request.resultType, mutations);
      const mutationDigest = `sha256:${hashCanonical(mutations)}` as MemorySha256Digest;
      const commitHash = hashCanonical({
        version: 1,
        operationId,
        operationRequestHash: operation.requestHash,
        attemptId,
        runId,
        resultType: request.resultType,
        selectionSaturated: request.selectionSaturated,
        evidenceDigest,
        mutationDigest,
        mutations,
        ranges,
      });

      const existingReceipt = this.#readOperationRow(operationId);
      if (existingReceipt) {
        if (requiredHash(existingReceipt.request_hash, 'request_hash') !== commitHash) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory Extraction Operation ${operationId} was already committed with a different result`,
          );
        }
        const successfulAttempt = this.#readExtractionAttemptRow(attemptId);
        if (!successfulAttempt) throw extractionAttemptNotActive(attemptId);
        const attempt = decodeExtractionAttempt(successfulAttempt);
        if (
          operation.state !== 'succeeded' ||
          operation.resultType !== request.resultType ||
          attempt.operationId !== operationId ||
          attempt.runId !== runId ||
          attempt.state !== 'succeeded'
        ) {
          throw new Error(`Invalid committed Memory Extraction Operation ${operationId}`);
        }
        if (operation.commitHash !== commitHash || operation.receipt === null) {
          throw new Error(`Invalid committed Memory Extraction receipt ${operationId}`);
        }
        const writeOperation = { ...decodeOperation(existingReceipt), replayed: true };
        const receipt = operation.receipt;
        const cursors = receipt.cursors;
        this.#database.exec('COMMIT');
        return {
          operation,
          attempt,
          writeOperation,
          cursors,
          receipt,
          resultType: request.resultType,
          replayed: true,
        };
      }

      if (diagnosticRetentionUntil < committedAt) {
        throw new Error('diagnosticRetentionUntil cannot be earlier than commit time');
      }
      this.#requireActiveExtractionAttempt(operationId, attemptId, runId);
      if (operation.state !== 'running' || operation.activeAttemptId !== attemptId) {
        throw extractionAttemptNotActive(attemptId);
      }
      for (const range of ranges) this.#validateCursorAtFrozenRange(operationId, range);

      const results = this.#applyNormalizedMutations(mutations, committedAt);
      for (const range of ranges) this.#advanceExtractionCursor(operationId, range, committedAt);
      this.#options.failpoint?.('after_cursor_write');

      const cursors = ranges.map((range) =>
        this.#requireExtractionCursor(range.sessionId, range.runId),
      );
      const receipt: MemoryExtractionCommitReceipt = {
        schemaVersion: 1,
        operationId,
        attemptId,
        resultType: request.resultType,
        selectionSaturated: request.selectionSaturated,
        evidenceDigest,
        mutationDigest,
        writeOperationId: operationId,
        committedAt,
        mutationResults: results,
        cursors,
      };
      const resultJson = JSON.stringify(receipt);

      const operationType = mutations.length === 1 ? mutations[0]!.type : 'batch';
      this.#options.failpoint?.('before_operation_write');
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, operationType, commitHash, JSON.stringify(results), committedAt);

      const attemptUpdate = this.#database
        .prepare(
          `UPDATE memory_extraction_attempts
           SET state = 'succeeded', completed_at = ?, failure_code = NULL, failure_stage = NULL
           WHERE attempt_id = ? AND operation_id = ? AND run_id = ? AND state = 'running'`,
        )
        .run(committedAt, attemptId, operationId, runId);
      if (Number(attemptUpdate.changes) !== 1) throw extractionAttemptNotActive(attemptId);
      const operationUpdate = this.#database
        .prepare(
          `UPDATE memory_extraction_operations
           SET state = 'succeeded', active_attempt_id = NULL, lease_expires_at = NULL,
               next_attempt_at = NULL, last_error_code = NULL, last_error_stage = NULL,
               last_error_at = NULL, last_failed_attempt_id = NULL,
               updated_at = MAX(updated_at, ?), completed_at = ?, result_type = ?,
               commit_hash = ?, result_json = ?,
               diagnostic_retention_until = ?, cleanup_state = 'pending',
               cleanup_claim_id = NULL, cleanup_lease_expires_at = NULL,
               cleanup_error_code = NULL, cleaned_at = NULL
           WHERE operation_id = ? AND state = 'running' AND active_attempt_id = ?`,
        )
        .run(
          committedAt,
          committedAt,
          request.resultType,
          commitHash,
          resultJson,
          diagnosticRetentionUntil,
          operationId,
          attemptId,
        );
      if (Number(operationUpdate.changes) !== 1) throw extractionAttemptNotActive(attemptId);
      this.#options.failpoint?.('after_extraction_state_write');

      const committedOperation = this.#requireExtractionOperation(operationId);
      const attempt = this.#requireExtractionAttempt(attemptId);
      const writeOperation: MemoryWriteOperationResult = {
        operationId,
        operationType,
        replayed: false,
        committedAt,
        results,
      };
      this.#database.exec('COMMIT');
      this.#options.failpoint?.('after_commit');
      return {
        operation: committedOperation,
        attempt,
        writeOperation,
        cursors,
        receipt,
        resultType: request.resultType,
        replayed: false,
      };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async claimMemoryExtractionCleanup(
    request: ClaimMemoryExtractionCleanupRequest,
  ): Promise<MemoryExtractionOperation | undefined> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const claimId = normalizeIdentifier(request.claimId, 'cleanup claimId');
    const leaseExpiresAt = normalizeTimestamp(request.leaseExpiresAt, 'cleanup leaseExpiresAt');
    if (leaseExpiresAt <= now) throw new Error('Cleanup lease must expire in the future');

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#requireExtractionOperation(operationId);
      const update = this.#database
        .prepare(
          `UPDATE memory_extraction_operations
           SET cleanup_state = 'running', cleanup_claim_id = ?, cleanup_lease_expires_at = ?,
               cleanup_attempt_count = cleanup_attempt_count + 1,
               cleanup_error_code = NULL, updated_at = MAX(updated_at, ?)
           WHERE operation_id = ? AND state IN ('succeeded', 'failed')
             AND active_attempt_id IS NULL AND diagnostic_retention_until <= ?
             AND (cleanup_state = 'pending'
               OR (cleanup_state = 'running' AND cleanup_lease_expires_at <= ?))`,
        )
        .run(claimId, leaseExpiresAt, now, operationId, now, now);
      if (Number(update.changes) !== 1) {
        this.#database.exec('COMMIT');
        return undefined;
      }
      const claimed = this.#requireExtractionOperation(operationId);
      this.#database.exec('COMMIT');
      return claimed;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async finishMemoryExtractionCleanup(
    request: FinishMemoryExtractionCleanupRequest,
  ): Promise<MemoryExtractionOperation> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const claimId = normalizeIdentifier(request.claimId, 'cleanup claimId');
    const errorCode =
      request.errorCode === undefined
        ? undefined
        : normalizeStableErrorCode(request.errorCode, 'cleanup errorCode');

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const update =
        errorCode === undefined
          ? this.#database
              .prepare(
                `UPDATE memory_extraction_operations
               SET cleanup_state = 'completed', cleanup_claim_id = NULL,
                   cleanup_lease_expires_at = NULL, cleanup_error_code = NULL,
                   cleaned_at = ?, updated_at = MAX(updated_at, ?)
               WHERE operation_id = ? AND cleanup_state = 'running' AND cleanup_claim_id = ?`,
              )
              .run(now, now, operationId, claimId)
          : this.#database
              .prepare(
                `UPDATE memory_extraction_operations
               SET cleanup_state = 'pending', cleanup_claim_id = NULL,
                   cleanup_lease_expires_at = NULL, cleanup_error_code = ?,
                   updated_at = MAX(updated_at, ?)
               WHERE operation_id = ? AND cleanup_state = 'running' AND cleanup_claim_id = ?`,
              )
              .run(errorCode, now, operationId, claimId);
      if (Number(update.changes) !== 1) {
        throw new MemoryItemStoreConflictError(
          'extraction_cleanup_conflict',
          `Memory Extraction cleanup claim ${claimId} is no longer active`,
        );
      }
      const operation = this.#requireExtractionOperation(operationId);
      this.#database.exec('COMMIT');
      return operation;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async cancelMemoryExtractionsForSessions(
    request: CancelMemoryExtractionsForSessionsRequest,
  ): Promise<readonly string[]> {
    this.#assertOpen();
    const now = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    if (!Array.isArray(request.sessionIds) || request.sessionIds.length === 0) return [];
    const sessionIds = [
      ...new Set(request.sessionIds.map((id) => normalizeIdentifier(id, 'sessionId'))),
    ];
    const retention = normalizeTimestamp(
      request.diagnosticRetentionUntil,
      'diagnosticRetentionUntil',
    );
    if (retention < now)
      throw new Error('diagnosticRetentionUntil cannot be earlier than cancel time');
    const placeholders = sessionIds.map(() => '?').join(', ');

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.#database
        .prepare(
          `SELECT operation_id FROM memory_extraction_operations
           WHERE session_id IN (${placeholders}) AND state IN ('pending', 'running')
           ORDER BY operation_id ASC`,
        )
        .all(...sessionIds) as Array<{ operation_id?: unknown }>;
      const operationIds = rows.map((row) =>
        requiredIdentifierString(row.operation_id, 'operation_id'),
      );
      this.#database
        .prepare(
          `UPDATE memory_extraction_cursors
           SET active_sweep_operation_id = NULL, followup_eligible = 0,
               version = version + 1, updated_at = MAX(updated_at, ?)
           WHERE session_id IN (${placeholders})
             AND (active_sweep_operation_id IS NOT NULL OR followup_eligible != 0)`,
        )
        .run(now, ...sessionIds);
      if (operationIds.length === 0) {
        this.#database.exec('COMMIT');
        return [];
      }
      const operationPlaceholders = operationIds.map(() => '?').join(', ');
      this.#database
        .prepare(
          `UPDATE memory_extraction_attempts
           SET state = 'abandoned', completed_at = ?, failure_code = 'source_evidence_deleted',
               failure_stage = 'admission'
           WHERE operation_id IN (${operationPlaceholders}) AND state = 'running'`,
        )
        .run(now, ...operationIds);
      this.#database
        .prepare(
          `UPDATE memory_extraction_operations
           SET state = 'failed', active_attempt_id = NULL, lease_expires_at = NULL,
               next_attempt_at = NULL, last_error_code = 'source_evidence_deleted',
               last_error_stage = 'admission', last_error_at = ?,
               last_failed_attempt_id = COALESCE(active_attempt_id, last_failed_attempt_id),
               started_at = COALESCE(started_at, ?), updated_at = MAX(updated_at, ?),
               completed_at = ?, result_type = NULL, diagnostic_retention_until = ?,
               cleanup_state = 'pending', cleanup_claim_id = NULL,
               cleanup_lease_expires_at = NULL, cleanup_error_code = NULL, cleaned_at = NULL
           WHERE operation_id IN (${operationPlaceholders}) AND state IN ('pending', 'running')`,
        )
        .run(now, now, now, now, retention, ...operationIds);
      this.#database.exec('COMMIT');
      return operationIds;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #applyNormalizedMutations(
    mutations: readonly NormalizedMutation[],
    committedAt: number,
  ): readonly MemoryMutationResult[] {
    const results: MemoryMutationResult[] = [];
    const transientItemIds = new Set<string>();
    for (let index = 0; index < mutations.length; index += 1) {
      const result = this.#applyMutation(mutations[index]!, index, committedAt, transientItemIds);
      results.push(result);
      if (result.outcome !== 'noop') transientItemIds.add(result.itemId);
    }
    return results;
  }

  #applyMutation(
    mutation: NormalizedMutation,
    mutationIndex: number,
    committedAt: number,
    transientItemIds: ReadonlySet<string>,
  ): MemoryMutationResult {
    switch (mutation.type) {
      case 'create':
        return this.#createItem(mutation.item, mutationIndex, committedAt, transientItemIds);
      case 'update':
        return this.#updateItem(mutation, mutationIndex, committedAt, transientItemIds);
      case 'archive':
        return this.#changeLifecycle(
          mutation,
          mutationIndex,
          committedAt,
          'archived',
          transientItemIds,
        );
      case 'restore':
        return this.#changeLifecycle(
          mutation,
          mutationIndex,
          committedAt,
          'active',
          transientItemIds,
        );
    }
  }

  #createItem(
    write: NormalizedMemoryWrite,
    mutationIndex: number,
    committedAt: number,
    transientItemIds: ReadonlySet<string>,
  ): MemoryMutationResult {
    const duplicate = this.#findActiveFactDuplicate(write);
    if (duplicate) {
      this.#throwDuplicateConflict(duplicate, transientItemIds, undefined, 'Creating this Item');
    }

    const itemId = normalizeIdentifier(
      (this.#options.idFactory ?? randomUUID)(),
      'generated itemId',
    );
    this.#database
      .prepare(
        `INSERT INTO memory_items(
           item_id, version, content, kind, statement_type, temporal_type,
           scope_type, scope_key, event_started_at, event_ended_at, observed_at,
           lifecycle_state, origin, content_hash, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        write.content,
        write.kind,
        write.statementType,
        write.temporalType,
        write.scopeType,
        write.scopeKey,
        write.eventStartedAt,
        write.eventEndedAt,
        write.observedAt,
        write.origin,
        write.contentHash,
        committedAt,
        committedAt,
      );
    this.#options.failpoint?.('after_item_write');
    this.#replaceKeys(itemId, write.keys);
    this.#options.failpoint?.('after_keys_write');
    this.#replaceSources(itemId, write.sources);
    this.#options.failpoint?.('after_sources_write');
    return mutationResult(mutationIndex, 'create', this.#requireItemRecord(itemId).item, 'created');
  }

  #updateItem(
    mutation: Extract<NormalizedMutation, { type: 'update' }>,
    mutationIndex: number,
    committedAt: number,
    transientItemIds: ReadonlySet<string>,
  ): MemoryMutationResult {
    const current = this.#requireVersion(mutation.itemId, mutation.expectedVersion);
    const currentRecord = this.#requireItemRecord(mutation.itemId);
    if (recordMatchesWrite(currentRecord, mutation.item)) {
      return mutationResult(mutationIndex, 'update', current, 'noop');
    }
    const duplicate = this.#findActiveFactDuplicate(mutation.item, mutation.itemId);
    if (duplicate) {
      this.#throwDuplicateConflict(
        duplicate,
        transientItemIds,
        mutation.itemId,
        `Updating Memory Item ${mutation.itemId}`,
      );
    }

    const updatedAt = Math.max(committedAt, current.updatedAt);
    const result = this.#database
      .prepare(
        `UPDATE memory_items
         SET version = version + 1,
             content = ?, kind = ?, statement_type = ?, temporal_type = ?,
             scope_type = ?, scope_key = ?, event_started_at = ?, event_ended_at = ?,
             observed_at = ?, origin = ?, content_hash = ?, updated_at = ?
         WHERE item_id = ? AND version = ?`,
      )
      .run(
        mutation.item.content,
        mutation.item.kind,
        mutation.item.statementType,
        mutation.item.temporalType,
        mutation.item.scopeType,
        mutation.item.scopeKey,
        mutation.item.eventStartedAt,
        mutation.item.eventEndedAt,
        mutation.item.observedAt,
        mutation.item.origin,
        mutation.item.contentHash,
        updatedAt,
        mutation.itemId,
        mutation.expectedVersion,
      );
    assertChanged(result.changes, mutation.itemId);
    this.#options.failpoint?.('after_item_write');
    this.#replaceKeys(mutation.itemId, mutation.item.keys);
    this.#options.failpoint?.('after_keys_write');
    this.#replaceSources(mutation.itemId, mutation.item.sources);
    this.#options.failpoint?.('after_sources_write');
    return mutationResult(
      mutationIndex,
      'update',
      this.#requireItemRecord(mutation.itemId).item,
      'updated',
    );
  }

  #changeLifecycle(
    mutation: Extract<NormalizedMutation, { type: 'archive' | 'restore' }>,
    mutationIndex: number,
    committedAt: number,
    target: MemoryItem['lifecycleState'],
    transientItemIds: ReadonlySet<string>,
  ): MemoryMutationResult {
    const current = this.#requireVersion(mutation.itemId, mutation.expectedVersion);
    const expected = target === 'archived' ? 'active' : 'archived';
    if (current.lifecycleState !== expected) {
      throw new MemoryItemStoreConflictError(
        'invalid_lifecycle_transition',
        `Memory Item ${mutation.itemId} is ${current.lifecycleState}, expected ${expected}`,
        mutation.itemId,
      );
    }
    if (target === 'active') {
      const duplicate = this.#findActiveFactDuplicate(
        writeFromRecord(this.#requireItemRecord(mutation.itemId)),
        mutation.itemId,
      );
      if (duplicate) {
        this.#throwDuplicateConflict(
          duplicate,
          transientItemIds,
          mutation.itemId,
          `Restoring Memory Item ${mutation.itemId}`,
        );
      }
    }

    const updatedAt = Math.max(committedAt, current.updatedAt);
    const result = this.#database
      .prepare(
        `UPDATE memory_items
         SET version = version + 1, lifecycle_state = ?, updated_at = ?
         WHERE item_id = ? AND version = ? AND lifecycle_state = ?`,
      )
      .run(target, updatedAt, mutation.itemId, mutation.expectedVersion, expected);
    assertChanged(result.changes, mutation.itemId);
    this.#options.failpoint?.('after_item_write');
    return mutationResult(
      mutationIndex,
      mutation.type,
      this.#requireItemRecord(mutation.itemId).item,
      target === 'active' ? 'restored' : 'archived',
    );
  }

  #requireVersion(itemId: string, expectedVersion: number): MemoryItem {
    const record = this.#readItemRecord(itemId);
    if (!record) {
      throw new MemoryItemStoreConflictError(
        'item_not_found',
        `Memory Item ${itemId} does not exist`,
        itemId,
      );
    }
    if (record.item.version !== expectedVersion) {
      throw new MemoryItemStoreConflictError(
        'version_conflict',
        `Memory Item ${itemId} is version ${record.item.version}, expected ${expectedVersion}`,
        itemId,
      );
    }
    return record.item;
  }

  /**
   * Enforce one active row per exact normalized fact identity.
   * Evidence and retrieval-key merging remain caller policy: this guard only
   * reports the conflicting Item so a trusted extraction layer can CAS-update it.
   */
  #findActiveFactDuplicate(
    write: NormalizedMemoryWrite,
    excludedItemId?: string,
  ): MemoryItem | undefined {
    const scopeClause = write.scopeType === 'global' ? 'scope_key IS NULL' : 'scope_key = ?';
    const parameters: string[] = [write.scopeType];
    if (write.scopeType === 'workspace') parameters.push(write.scopeKey!);
    parameters.push(write.contentHash);
    const rows = this.#database
      .prepare(
        `SELECT item_id FROM memory_items
         WHERE lifecycle_state = 'active'
           AND scope_type = ?
           AND ${scopeClause}
           AND content_hash = ?
         ORDER BY item_id ASC`,
      )
      .all(...parameters) as Array<{ item_id?: unknown }>;
    for (const row of rows) {
      const itemId = requiredIdentifierString(row.item_id, 'item_id');
      const record = this.#readItemRecord(itemId);
      if (!record) throw new Error(`Memory Item ${itemId} disappeared during duplicate check`);
      if (itemId !== excludedItemId && factIdentityMatchesWrite(record.item, write)) {
        return record.item;
      }
    }
    return undefined;
  }

  #throwDuplicateConflict(
    duplicate: MemoryItem,
    transientItemIds: ReadonlySet<string>,
    itemId: string | undefined,
    action: string,
  ): never {
    if (transientItemIds.has(duplicate.itemId)) {
      throw new MemoryItemStoreConflictError(
        'duplicate_within_batch',
        `${action} would duplicate a fact changed earlier in the same batch; split or normalize the batch before retrying`,
        itemId,
      );
    }
    throw new MemoryItemStoreConflictError(
      'duplicate_active',
      `${action} would duplicate active Item ${duplicate.itemId}; merge current keys and sources with the new evidence before updating it`,
      itemId,
      duplicate.itemId,
    );
  }

  #replaceKeys(itemId: string, keys: readonly MemoryItemKey[]): void {
    this.#database.prepare('DELETE FROM memory_item_keys WHERE item_id = ?').run(itemId);
    const insert = this.#database.prepare(
      `INSERT INTO memory_item_keys(item_id, key_text, normalized_key, key_type, key_origin)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const key of keys) {
      insert.run(itemId, key.key, key.normalizedKey, key.keyType, key.keyOrigin);
    }
  }

  #replaceSources(itemId: string, sources: readonly MemoryItemSource[]): void {
    this.#database.prepare('DELETE FROM memory_item_sources WHERE item_id = ?').run(itemId);
    const insert = this.#database.prepare(
      `INSERT INTO memory_item_sources(item_id, session_id, run_id, turn_id, event_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const source of sources) {
      insert.run(itemId, source.sessionId, source.runId, source.turnId, source.eventId);
    }
  }

  #readItemRecord(itemId: string): MemoryItemRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM memory_items WHERE item_id = ?')
      .get(itemId) as MemoryItemRow | undefined;
    if (!row) return undefined;
    const keys = this.#database
      .prepare(
        `SELECT key_text, normalized_key, key_type, key_origin
         FROM memory_item_keys WHERE item_id = ? ORDER BY normalized_key ASC
         LIMIT ${MAX_KEYS_PER_ITEM + 1}`,
      )
      .all(itemId) as unknown as MemoryKeyRow[];
    const sources = this.#database
      .prepare(
        `SELECT session_id, run_id, turn_id, event_id
         FROM memory_item_sources WHERE item_id = ? ORDER BY event_id ASC
         LIMIT ${MAX_SOURCES_PER_ITEM + 1}`,
      )
      .all(itemId) as unknown as MemorySourceRow[];
    assertChildCardinality('keys', keys.length, MAX_KEYS_PER_ITEM);
    assertChildCardinality('sources', sources.length, MAX_SOURCES_PER_ITEM);
    return {
      item: decodeItem(row),
      keys: keys.map(decodeKey),
      sources: sources.map(decodeSource),
    };
  }

  #requireItemRecord(itemId: string): MemoryItemRecord {
    const record = this.#readItemRecord(itemId);
    if (!record) throw new Error(`Memory Item ${itemId} disappeared during transaction`);
    return record;
  }

  #readOperationRow(operationId: string): MemoryOperationRow | undefined {
    return this.#database
      .prepare(
        `SELECT operation_id, operation_type, request_hash, result_json, committed_at
         FROM memory_write_operations WHERE operation_id = ?`,
      )
      .get(operationId) as MemoryOperationRow | undefined;
  }

  #readExtractionOperationRow(operationId: string): MemoryExtractionOperationRow | undefined {
    return this.#database
      .prepare('SELECT * FROM memory_extraction_operations WHERE operation_id = ?')
      .get(operationId) as MemoryExtractionOperationRow | undefined;
  }

  #readExtractionOperationRowByRequestHash(
    sessionId: string,
    requestHash: string,
  ): MemoryExtractionOperationRow | undefined {
    return this.#database
      .prepare(
        `SELECT * FROM memory_extraction_operations
         WHERE session_id = ? AND request_hash = ?`,
      )
      .get(sessionId, requestHash) as MemoryExtractionOperationRow | undefined;
  }

  #readExtractionAttemptRow(attemptId: string): MemoryExtractionAttemptRow | undefined {
    return this.#database
      .prepare('SELECT * FROM memory_extraction_attempts WHERE attempt_id = ?')
      .get(attemptId) as MemoryExtractionAttemptRow | undefined;
  }

  #readExtractionCursorRow(
    sessionId: string,
    runId: string,
  ): MemoryExtractionCursorRow | undefined {
    return this.#database
      .prepare(
        `SELECT * FROM memory_extraction_cursors
         WHERE session_id = ? AND run_id = ?`,
      )
      .get(sessionId, runId) as MemoryExtractionCursorRow | undefined;
  }

  #readExtractionRanges(operationId: string): readonly MemoryExtractionOperationRange[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM memory_extraction_operation_ranges
         WHERE operation_id = ? ORDER BY range_ordinal ASC`,
      )
      .all(operationId) as unknown as MemoryExtractionOperationRangeRow[];
    const ranges = rows.map(decodeExtractionRange);
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges[index]!.rangeOrdinal !== index) {
        throw new Error(`Memory Extraction Operation ${operationId} has non-contiguous Ranges`);
      }
    }
    return ranges;
  }

  #decodeExtractionOperation(row: MemoryExtractionOperationRow): MemoryExtractionOperation {
    const operation = decodeExtractionOperation(
      row,
      this.#readExtractionRanges(requiredIdentifierString(row.operation_id, 'operation_id')),
    );
    if (operation.mode === 'sweep' && operation.ranges.length === 0) {
      throw new Error(`Sweep Memory Extraction Operation ${operation.operationId} has no Ranges`);
    }
    if (operation.mode === 'targeted' && operation.ranges.length !== 0) {
      throw new Error(`Targeted Memory Extraction Operation ${operation.operationId} has Ranges`);
    }
    return operation;
  }

  #requireExtractionOperation(operationId: string): MemoryExtractionOperation {
    const row = this.#readExtractionOperationRow(operationId);
    if (!row) throw extractionOperationNotFound(operationId);
    return this.#decodeExtractionOperation(row);
  }

  #requireExtractionAttempt(attemptId: string): MemoryExtractionAttempt {
    const row = this.#readExtractionAttemptRow(attemptId);
    if (!row) throw extractionAttemptNotActive(attemptId);
    return decodeExtractionAttempt(row);
  }

  #requireExtractionCursor(sessionId: string, runId: string): MemoryExtractionCursor {
    const row = this.#readExtractionCursorRow(sessionId, runId);
    if (!row) throw extractionCursorConflict(sessionId, runId, 'does not exist');
    return decodeExtractionCursor(row);
  }

  #requireActiveExtractionAttempt(
    operationId: string,
    attemptId: string,
    runId: string,
  ): MemoryExtractionAttempt {
    const operation = this.#requireExtractionOperation(operationId);
    const attempt = this.#requireExtractionAttempt(attemptId);
    if (
      operation.state !== 'running' ||
      operation.activeAttemptId !== attemptId ||
      attempt.operationId !== operationId ||
      attempt.runId !== runId ||
      attempt.state !== 'running'
    ) {
      throw extractionAttemptNotActive(attemptId);
    }
    return attempt;
  }

  #insertExtractionOperation(
    normalized: NormalizedCreateMemoryExtractionOperation,
    createdAt: number,
  ): void {
    const reusedInternalSession = this.#database
      .prepare(
        `SELECT operation_id FROM memory_extraction_operations
         WHERE internal_session_id = ?`,
      )
      .get(normalized.internalSessionId) as { operation_id?: unknown } | undefined;
    if (reusedInternalSession) {
      throw new MemoryItemStoreConflictError(
        'operation_reused',
        `Internal Session ${normalized.internalSessionId} is already bound to another Memory Extraction Operation`,
      );
    }

    this.#database
      .prepare(
        `INSERT INTO memory_extraction_operations(
           operation_id, session_id, mode, trigger_kind, internal_session_id,
           session_create_fingerprint, request_hash, request_json, trigger_epoch,
           state, attempt_count, active_attempt_id, lease_expires_at, next_attempt_at,
           last_error_code, last_error_stage, last_error_at, last_failed_attempt_id,
           started_at, created_at, updated_at, completed_at, result_type,
           diagnostic_retention_until, cleanup_state, cleanup_claim_id,
           cleanup_lease_expires_at, cleanup_attempt_count, cleanup_error_code, cleaned_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?,
           'pending', 0, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL,
           NULL, ?, ?, NULL, NULL,
           NULL, NULL, NULL, NULL, 0, NULL, NULL
         )`,
      )
      .run(
        normalized.operationId,
        normalized.sessionId,
        normalized.mode,
        normalized.triggerKind,
        normalized.internalSessionId,
        normalized.sessionCreateFingerprint,
        normalized.requestHash,
        normalized.requestJson,
        normalized.triggerEpoch,
        createdAt,
        createdAt,
      );

    const insertRange = this.#database.prepare(
      `INSERT INTO memory_extraction_operation_ranges(
         operation_id, range_ordinal, session_id, invocation_id, run_id, turn_id,
         from_event_seq_exclusive, from_event_id, from_prefix_digest,
         to_event_seq_inclusive, to_event_id, to_prefix_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const range of normalized.ranges) {
      insertRange.run(
        normalized.operationId,
        range.rangeOrdinal,
        range.sessionId,
        range.invocationId,
        range.runId,
        range.turnId,
        range.fromEventSeqExclusive,
        range.fromEventId,
        range.fromPrefixDigest,
        range.toEventSeqInclusive,
        range.toEventId,
        range.toPrefixDigest,
      );
      this.#attachSweepCursor(normalized.operationId, range, createdAt);
    }
  }

  #attachSweepCursor(
    operationId: string,
    range: MemoryExtractionOperationRangeInput,
    now: number,
  ): void {
    const existingRow = this.#readExtractionCursorRow(range.sessionId, range.runId);
    if (!existingRow) {
      if (
        range.fromEventSeqExclusive !== 0 ||
        range.fromEventId !== null ||
        range.fromPrefixDigest !== null
      ) {
        throw extractionCursorConflict(
          range.sessionId,
          range.runId,
          'cannot start a non-zero Range without an existing Cursor',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO memory_extraction_cursors(
             session_id, invocation_id, run_id, turn_id,
             committed_event_seq, committed_event_id, committed_prefix_digest,
             requested_event_seq, requested_event_id, requested_prefix_digest,
             active_sweep_operation_id, followup_eligible, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .run(
          range.sessionId,
          range.invocationId,
          range.runId,
          range.turnId,
          range.toEventSeqInclusive,
          range.toEventId,
          range.toPrefixDigest,
          operationId,
          now,
          now,
        );
      return;
    }

    const cursor = decodeExtractionCursor(existingRow);
    if (cursor.invocationId !== range.invocationId || cursor.turnId !== range.turnId) {
      throw extractionCursorConflict(range.sessionId, range.runId, 'Run identity changed');
    }
    if (!cursorMatchesFrozenStart(cursor, range)) {
      throw extractionCursorConflict(range.sessionId, range.runId, 'committed boundary changed');
    }
    if (cursor.activeSweepOperationId !== null && cursor.activeSweepOperationId !== operationId) {
      throw extractionCursorConflict(range.sessionId, range.runId, 'already has an active Sweep');
    }

    let requestedEventSeq = cursor.requestedEventSeq;
    let requestedEventId = cursor.requestedEventId;
    let requestedPrefixDigest = cursor.requestedPrefixDigest;
    if (range.toEventSeqInclusive > cursor.requestedEventSeq) {
      requestedEventSeq = range.toEventSeqInclusive;
      requestedEventId = range.toEventId;
      requestedPrefixDigest = range.toPrefixDigest;
    } else if (
      range.toEventSeqInclusive === cursor.requestedEventSeq &&
      (cursor.requestedEventId !== range.toEventId ||
        cursor.requestedPrefixDigest !== range.toPrefixDigest)
    ) {
      throw extractionCursorConflict(
        range.sessionId,
        range.runId,
        'requested boundary identity changed',
      );
    }
    this.#database
      .prepare(
        `UPDATE memory_extraction_cursors
         SET requested_event_seq = ?, requested_event_id = ?, requested_prefix_digest = ?,
             active_sweep_operation_id = ?, followup_eligible = 0, version = version + 1,
             updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND run_id = ?
           AND (active_sweep_operation_id IS NULL OR active_sweep_operation_id = ?)`,
      )
      .run(
        requestedEventSeq,
        requestedEventId,
        requestedPrefixDigest,
        operationId,
        now,
        range.sessionId,
        range.runId,
        operationId,
      );
  }

  #validateCursorAtFrozenRange(operationId: string, range: MemoryExtractionOperationRange): void {
    const cursor = this.#requireExtractionCursor(range.sessionId, range.runId);
    if (cursor.activeSweepOperationId !== operationId) {
      throw extractionCursorConflict(range.sessionId, range.runId, 'active Sweep changed');
    }
    if (!cursorMatchesFrozenStart(cursor, range)) {
      throw extractionCursorConflict(range.sessionId, range.runId, 'committed boundary changed');
    }
    if (cursor.requestedEventSeq < range.toEventSeqInclusive) {
      throw extractionCursorConflict(
        range.sessionId,
        range.runId,
        'requested boundary is behind the frozen Range',
      );
    }
    if (
      cursor.requestedEventSeq === range.toEventSeqInclusive &&
      (cursor.requestedEventId !== range.toEventId ||
        cursor.requestedPrefixDigest !== range.toPrefixDigest)
    ) {
      throw extractionCursorConflict(
        range.sessionId,
        range.runId,
        'requested boundary identity changed',
      );
    }
  }

  #advanceExtractionCursor(
    operationId: string,
    range: MemoryExtractionOperationRange,
    committedAt: number,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE memory_extraction_cursors
         SET committed_event_seq = ?, committed_event_id = ?, committed_prefix_digest = ?,
             active_sweep_operation_id = NULL,
             followup_eligible = CASE WHEN requested_event_seq > ? THEN 1 ELSE 0 END,
             version = version + 1,
             updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND run_id = ?
           AND invocation_id = ? AND turn_id = ?
           AND committed_event_seq = ?
           AND committed_event_id IS ? AND committed_prefix_digest IS ?
           AND requested_event_seq >= ?
           AND active_sweep_operation_id = ?`,
      )
      .run(
        range.toEventSeqInclusive,
        range.toEventId,
        range.toPrefixDigest,
        range.toEventSeqInclusive,
        committedAt,
        range.sessionId,
        range.runId,
        range.invocationId,
        range.turnId,
        range.fromEventSeqExclusive,
        range.fromEventId,
        range.fromPrefixDigest,
        range.toEventSeqInclusive,
        operationId,
      );
    if (Number(result.changes) !== 1) {
      throw extractionCursorConflict(range.sessionId, range.runId, 'changed during commit');
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('SQLite Memory Item Store is closed');
  }

  #readSnapshot<T>(operation: () => T): T {
    this.#database.exec('BEGIN');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

export function buildSqliteMemoryKeySearchQuery(input: {
  readonly terms: readonly string[];
  readonly match: 'exact' | 'prefix';
  readonly workspaceKey?: string;
  readonly includeArchived: boolean;
  readonly limit: number;
}): SqliteMemoryKeySearchQuery {
  const parameters: Array<string | number> = [];
  let matchingKeysSql: string;
  if (input.match === 'exact') {
    matchingKeysSql = `
      SELECT item_id, normalized_key AS matched_term
      FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
      WHERE normalized_key IN (${placeholders(input.terms.length)})`;
    parameters.push(...input.terms);
  } else {
    matchingKeysSql = input.terms
      .map((term, index) => {
        const upperBound = prefixUpperBound(term);
        parameters.push(term);
        if (upperBound) {
          parameters.push(upperBound);
          return `
            SELECT item_id, ${index} AS matched_term
            FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
            WHERE normalized_key >= ? AND normalized_key < ?`;
        }
        return `
          SELECT item_id, ${index} AS matched_term
          FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
          WHERE normalized_key >= ?`;
      })
      .join('\nUNION ALL\n');
  }
  const scopeClause = input.workspaceKey
    ? `(i.scope_type = 'global' OR (i.scope_type = 'workspace' AND i.scope_key = ?))`
    : `i.scope_type = 'global'`;
  if (input.workspaceKey) parameters.push(input.workspaceKey);
  parameters.push(input.limit);
  return {
    sql: `
      WITH matching_keys AS MATERIALIZED (
        ${matchingKeysSql}
      )
      SELECT i.item_id
      FROM matching_keys m
      JOIN memory_items i ON i.item_id = m.item_id
      WHERE ${scopeClause}
        AND ${input.includeArchived ? '1 = 1' : `i.lifecycle_state = 'active'`}
      GROUP BY i.item_id
      ORDER BY COUNT(DISTINCT m.matched_term) DESC, i.updated_at DESC, i.item_id ASC
      LIMIT ?`,
    parameters,
  };
}

function normalizeCreateMemoryExtractionOperation(
  request: CreateMemoryExtractionOperationRequest,
): NormalizedCreateMemoryExtractionOperation {
  if (!request || typeof request !== 'object') {
    throw new Error('Memory Extraction Operation request must be an object');
  }
  if (!isMemoryExtractionMode(request.mode)) throw new Error('Invalid Memory Extraction mode');
  if (!isMemoryExtractionTriggerKind(request.triggerKind)) {
    throw new Error('Invalid Memory Extraction trigger kind');
  }
  const operationId = normalizeIdentifier(request.operationId, 'operationId');
  const sessionId = normalizeIdentifier(request.sessionId, 'sessionId');
  const internalSessionId = normalizeIdentifier(request.internalSessionId, 'internalSessionId');
  const sessionCreateFingerprint = normalizeSha256Digest(
    request.sessionCreateFingerprint,
    'sessionCreateFingerprint',
  );
  const requestHash = normalizeSha256Digest(request.requestHash, 'requestHash');
  const requestJson = normalizeJsonObject(
    request.requestJson,
    'Memory Extraction requestJson',
    MAX_EXTRACTION_REQUEST_JSON_CODE_UNITS,
  );
  const triggerEpoch =
    request.triggerEpoch === undefined || request.triggerEpoch === null
      ? null
      : normalizeIdentifier(request.triggerEpoch, 'triggerEpoch');
  const maxUnfinishedTargetedPerSession =
    request.maxUnfinishedTargetedPerSession === undefined
      ? null
      : normalizePositiveInteger(
          request.maxUnfinishedTargetedPerSession,
          'maxUnfinishedTargetedPerSession',
        );
  if (request.mode === 'sweep' && maxUnfinishedTargetedPerSession !== null) {
    throw new Error('Sweep Memory Extraction cannot set a Targeted queue ceiling');
  }
  const sourceRanges = request.ranges ?? [];
  if (!Array.isArray(sourceRanges) || sourceRanges.length > MEMORY_EXTRACTION_MAX_RANGES) {
    throw new Error(`Memory Extraction accepts at most ${MEMORY_EXTRACTION_MAX_RANGES} Ranges`);
  }
  if (request.mode === 'sweep' && sourceRanges.length === 0) {
    throw new Error('Sweep Memory Extraction Operation requires at least one Range');
  }
  if (request.mode === 'targeted' && sourceRanges.length !== 0) {
    throw new Error('Targeted Memory Extraction Operation cannot carry Sweep Ranges');
  }
  if (request.mode === 'targeted' && request.triggerKind !== 'user_requested') {
    throw new Error('Targeted Memory Extraction Operation must be user_requested');
  }
  if (request.mode === 'sweep' && request.triggerKind === 'user_requested') {
    throw new Error('Sweep Memory Extraction Operation cannot be user_requested');
  }

  const ranges = sourceRanges
    .map((range) => normalizeExtractionRangeInput(range, sessionId))
    .sort((left, right) => left.rangeOrdinal - right.rangeOrdinal);
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges[index]!.rangeOrdinal !== index) {
      throw new Error('Memory Extraction Range ordinals must be contiguous from zero');
    }
    if (index > 0 && ranges[index - 1]!.runId === ranges[index]!.runId) {
      throw new Error(`Memory Extraction Run ${ranges[index]!.runId} appears more than once`);
    }
  }
  if (new Set(ranges.map((range) => range.runId)).size !== ranges.length) {
    throw new Error('Memory Extraction Operation cannot contain duplicate Run Ranges');
  }
  return {
    operationId,
    sessionId,
    mode: request.mode,
    triggerKind: request.triggerKind,
    internalSessionId,
    sessionCreateFingerprint,
    requestHash,
    requestJson,
    triggerEpoch,
    ranges,
    maxUnfinishedTargetedPerSession,
  };
}

function normalizeRecoverableExtractionLimit(
  request: ListRecoverableMemoryExtractionsRequest,
): number {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Recoverable Memory Extraction request must be an object');
  }
  if (Object.keys(request).some((key) => key !== 'limit')) {
    throw new Error('Recoverable Memory Extraction request only accepts limit');
  }
  const limit = request.limit ?? DEFAULT_RECOVERABLE_EXTRACTION_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECOVERABLE_EXTRACTION_LIMIT) {
    throw new Error(
      `Recoverable Memory Extraction limit must be between 1 and ${MAX_RECOVERABLE_EXTRACTION_LIMIT}`,
    );
  }
  return limit;
}

function normalizeSweepDebtLimit(request: ListUnassignedMemoryExtractionSweepDebtsRequest): number {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Memory Extraction Sweep debt request must be an object');
  }
  if (Object.keys(request).some((key) => key !== 'limit')) {
    throw new Error('Memory Extraction Sweep debt request only accepts limit');
  }
  const limit = request.limit ?? DEFAULT_RECOVERABLE_EXTRACTION_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECOVERABLE_EXTRACTION_LIMIT) {
    throw new Error(
      `Memory Extraction Sweep debt limit must be between 1 and ${MAX_RECOVERABLE_EXTRACTION_LIMIT}`,
    );
  }
  return limit;
}

function normalizeExtractionRangeInput(
  range: MemoryExtractionOperationRangeInput,
  operationSessionId: string,
): MemoryExtractionOperationRangeInput {
  if (!range || typeof range !== 'object') throw new Error('Invalid Memory Extraction Range');
  const rangeOrdinal = normalizeNonNegativeInteger(range.rangeOrdinal, 'rangeOrdinal');
  const sessionId = normalizeIdentifier(range.sessionId, 'Range sessionId');
  if (sessionId !== operationSessionId) {
    throw new Error('Memory Extraction Range must belong to its Operation Session');
  }
  const invocationId = normalizeIdentifier(range.invocationId, 'Range invocationId');
  const runId = normalizeIdentifier(range.runId, 'Range runId');
  const turnId = normalizeIdentifier(range.turnId, 'Range turnId');
  const fromEventSeqExclusive = normalizeNonNegativeInteger(
    range.fromEventSeqExclusive,
    'fromEventSeqExclusive',
  );
  const fromEventId =
    range.fromEventId === null ? null : normalizeIdentifier(range.fromEventId, 'fromEventId');
  const fromPrefixDigest =
    range.fromPrefixDigest === null
      ? null
      : normalizeSha256Digest(range.fromPrefixDigest, 'fromPrefixDigest');
  if (
    (fromEventSeqExclusive === 0 && (fromEventId !== null || fromPrefixDigest !== null)) ||
    (fromEventSeqExclusive > 0 && (fromEventId === null || fromPrefixDigest === null))
  ) {
    throw new Error('Memory Extraction Range start boundary is inconsistent');
  }
  const toEventSeqInclusive = normalizePositiveInteger(
    range.toEventSeqInclusive,
    'toEventSeqInclusive',
  );
  if (toEventSeqInclusive <= fromEventSeqExclusive) {
    throw new Error('Memory Extraction Range end must be after its start');
  }
  return {
    rangeOrdinal,
    sessionId,
    invocationId,
    runId,
    turnId,
    fromEventSeqExclusive,
    fromEventId,
    fromPrefixDigest,
    toEventSeqInclusive,
    toEventId: normalizeIdentifier(range.toEventId, 'toEventId'),
    toPrefixDigest: normalizeSha256Digest(range.toPrefixDigest, 'toPrefixDigest'),
  };
}

function extractionOperationDefinitionMatches(
  row: MemoryExtractionOperationRow,
  input: NormalizedCreateMemoryExtractionOperation,
): boolean {
  return (
    row.operation_id === input.operationId &&
    row.session_id === input.sessionId &&
    row.mode === input.mode &&
    row.trigger_kind === input.triggerKind &&
    row.internal_session_id === input.internalSessionId &&
    row.session_create_fingerprint === input.sessionCreateFingerprint &&
    row.request_hash === input.requestHash &&
    row.request_json === input.requestJson &&
    row.trigger_epoch === input.triggerEpoch
  );
}

function decodeExtractionOperation(
  row: MemoryExtractionOperationRow,
  ranges: readonly MemoryExtractionOperationRange[],
): MemoryExtractionOperation {
  const operationId = requiredIdentifierString(row.operation_id, 'operation_id');
  const sessionId = requiredIdentifierString(row.session_id, 'session_id');
  const mode = requiredString(row.mode, 'mode');
  const triggerKind = requiredString(row.trigger_kind, 'trigger_kind');
  const state = requiredString(row.state, 'state');
  const lastErrorStage = nullableString(row.last_error_stage, 'last_error_stage');
  const cleanupState = nullableString(row.cleanup_state, 'cleanup_state');
  const resultType = nullableString(row.result_type, 'result_type');
  if (!isMemoryExtractionMode(mode)) throw invalidColumn('mode');
  if (!isMemoryExtractionTriggerKind(triggerKind)) throw invalidColumn('trigger_kind');
  if (!isMemoryExtractionOperationState(state)) throw invalidColumn('state');
  if (lastErrorStage !== null && !isMemoryExtractionFailureStage(lastErrorStage)) {
    throw invalidColumn('last_error_stage');
  }
  if (cleanupState !== null && !isMemoryExtractionCleanupState(cleanupState)) {
    throw invalidColumn('cleanup_state');
  }
  if (resultType !== null && !isMemoryExtractionResultType(resultType)) {
    throw invalidColumn('result_type');
  }
  const requestJson = requiredString(row.request_json, 'request_json');
  normalizeJsonObject(
    requestJson,
    'Memory Extraction request_json',
    MAX_EXTRACTION_REQUEST_JSON_CODE_UNITS,
  );
  for (const range of ranges) {
    if (range.operationId !== operationId || range.sessionId !== sessionId) {
      throw invalidColumn('memory_extraction_operation_ranges');
    }
  }
  const operation: MemoryExtractionOperation = {
    operationId,
    sessionId,
    mode,
    triggerKind,
    internalSessionId: requiredIdentifierString(row.internal_session_id, 'internal_session_id'),
    sessionCreateFingerprint: requiredSha256Digest(
      row.session_create_fingerprint,
      'session_create_fingerprint',
    ),
    requestHash: requiredSha256Digest(row.request_hash, 'request_hash'),
    requestJson,
    triggerEpoch: nullableIdentifierString(row.trigger_epoch, 'trigger_epoch'),
    state,
    attemptCount: requiredNonNegativeInteger(row.attempt_count, 'attempt_count'),
    activeAttemptId: nullableIdentifierString(row.active_attempt_id, 'active_attempt_id'),
    leaseExpiresAt: nullableNonNegativeInteger(row.lease_expires_at, 'lease_expires_at'),
    nextAttemptAt: nullableNonNegativeInteger(row.next_attempt_at, 'next_attempt_at'),
    lastErrorCode: nullableStableErrorCode(row.last_error_code, 'last_error_code'),
    lastErrorStage,
    lastErrorAt: nullableNonNegativeInteger(row.last_error_at, 'last_error_at'),
    lastFailedAttemptId: nullableIdentifierString(
      row.last_failed_attempt_id,
      'last_failed_attempt_id',
    ),
    startedAt: nullableNonNegativeInteger(row.started_at, 'started_at'),
    createdAt: requiredNonNegativeInteger(row.created_at, 'created_at'),
    updatedAt: requiredNonNegativeInteger(row.updated_at, 'updated_at'),
    completedAt: nullableNonNegativeInteger(row.completed_at, 'completed_at'),
    resultType,
    commitHash: nullableHash(row.commit_hash, 'commit_hash'),
    receipt: decodeExtractionCommitReceipt(row.result_json),
    diagnosticRetentionUntil: nullableNonNegativeInteger(
      row.diagnostic_retention_until,
      'diagnostic_retention_until',
    ),
    cleanupState,
    cleanupClaimId: nullableIdentifierString(row.cleanup_claim_id, 'cleanup_claim_id'),
    cleanupLeaseExpiresAt: nullableNonNegativeInteger(
      row.cleanup_lease_expires_at,
      'cleanup_lease_expires_at',
    ),
    cleanupAttemptCount: requiredNonNegativeInteger(
      row.cleanup_attempt_count,
      'cleanup_attempt_count',
    ),
    cleanupErrorCode: nullableStableErrorCode(row.cleanup_error_code, 'cleanup_error_code'),
    cleanedAt: nullableNonNegativeInteger(row.cleaned_at, 'cleaned_at'),
    ranges,
  };
  validateDecodedExtractionOperation(operation);
  return operation;
}

function validateDecodedExtractionOperation(operation: MemoryExtractionOperation): void {
  if (operation.createdAt > operation.updatedAt) throw invalidColumn('updated_at');
  if (
    operation.state === 'running' &&
    (operation.activeAttemptId === null || operation.leaseExpiresAt === null)
  ) {
    throw invalidColumn('active_attempt_id');
  }
  if (
    operation.state !== 'running' &&
    (operation.activeAttemptId !== null || operation.leaseExpiresAt !== null)
  ) {
    throw invalidColumn('active_attempt_id');
  }
  const terminal = operation.state === 'succeeded' || operation.state === 'failed';
  if (
    terminal !==
    (operation.completedAt !== null &&
      operation.diagnosticRetentionUntil !== null &&
      operation.cleanupState !== null)
  ) {
    throw invalidColumn('completed_at');
  }
  if (
    (operation.state === 'succeeded' &&
      (operation.resultType === null ||
        operation.commitHash === null ||
        operation.receipt === null)) ||
    (operation.state !== 'succeeded' &&
      (operation.resultType !== null ||
        operation.commitHash !== null ||
        operation.receipt !== null))
  ) {
    throw invalidColumn('result_type');
  }
  if (
    operation.receipt !== null &&
    (operation.receipt.operationId !== operation.operationId ||
      operation.receipt.writeOperationId !== operation.operationId ||
      operation.receipt.resultType !== operation.resultType ||
      operation.receipt.committedAt !== operation.completedAt)
  ) {
    throw invalidColumn('result_json');
  }
}

function decodeExtractionRange(
  row: MemoryExtractionOperationRangeRow,
): MemoryExtractionOperationRange {
  const fromEventSeqExclusive = requiredNonNegativeInteger(
    row.from_event_seq_exclusive,
    'from_event_seq_exclusive',
  );
  const fromEventId = nullableIdentifierString(row.from_event_id, 'from_event_id');
  const fromPrefixDigest = nullableSha256Digest(row.from_prefix_digest, 'from_prefix_digest');
  const toEventSeqInclusive = requiredPositiveInteger(
    row.to_event_seq_inclusive,
    'to_event_seq_inclusive',
  );
  if (
    toEventSeqInclusive <= fromEventSeqExclusive ||
    (fromEventSeqExclusive === 0 && (fromEventId !== null || fromPrefixDigest !== null)) ||
    (fromEventSeqExclusive > 0 && (fromEventId === null || fromPrefixDigest === null))
  ) {
    throw invalidColumn('memory_extraction_operation_ranges');
  }
  return {
    operationId: requiredIdentifierString(row.operation_id, 'operation_id'),
    rangeOrdinal: requiredNonNegativeInteger(row.range_ordinal, 'range_ordinal'),
    sessionId: requiredIdentifierString(row.session_id, 'session_id'),
    invocationId: requiredIdentifierString(row.invocation_id, 'invocation_id'),
    runId: requiredIdentifierString(row.run_id, 'run_id'),
    turnId: requiredIdentifierString(row.turn_id, 'turn_id'),
    fromEventSeqExclusive,
    fromEventId,
    fromPrefixDigest,
    toEventSeqInclusive,
    toEventId: requiredIdentifierString(row.to_event_id, 'to_event_id'),
    toPrefixDigest: requiredSha256Digest(row.to_prefix_digest, 'to_prefix_digest'),
  };
}

function decodeExtractionAttempt(row: MemoryExtractionAttemptRow): MemoryExtractionAttempt {
  const state = requiredString(row.state, 'state');
  const snapshotKind = requiredString(row.snapshot_kind, 'snapshot_kind');
  const failureStage = nullableString(row.failure_stage, 'failure_stage');
  if (!isMemoryExtractionAttemptState(state)) throw invalidColumn('state');
  if (!isMemoryExtractionSnapshotKind(snapshotKind)) throw invalidColumn('snapshot_kind');
  if (failureStage !== null && !isMemoryExtractionFailureStage(failureStage)) {
    throw invalidColumn('failure_stage');
  }
  const metrics = decodeExtractionMetrics(row.metrics_json);
  const attempt: MemoryExtractionAttempt = {
    attemptId: requiredIdentifierString(row.attempt_id, 'attempt_id'),
    operationId: requiredIdentifierString(row.operation_id, 'operation_id'),
    attemptOrdinal: requiredPositiveInteger(row.attempt_ordinal, 'attempt_ordinal'),
    state,
    turnId: requiredIdentifierString(row.turn_id, 'turn_id'),
    runId: requiredIdentifierString(row.run_id, 'run_id'),
    snapshotKind,
    startedAt: requiredNonNegativeInteger(row.started_at, 'started_at'),
    completedAt: nullableNonNegativeInteger(row.completed_at, 'completed_at'),
    failureCode: nullableStableErrorCode(row.failure_code, 'failure_code'),
    failureStage,
    metrics,
  };
  if (
    (state === 'running' &&
      (attempt.completedAt !== null ||
        attempt.failureCode !== null ||
        attempt.failureStage !== null)) ||
    (state === 'succeeded' &&
      (attempt.completedAt === null ||
        attempt.failureCode !== null ||
        attempt.failureStage !== null)) ||
    ((state === 'failed' || state === 'abandoned') &&
      (attempt.completedAt === null ||
        attempt.failureCode === null ||
        attempt.failureStage === null))
  ) {
    throw invalidColumn('memory_extraction_attempts');
  }
  return attempt;
}

function decodeExtractionCursor(row: MemoryExtractionCursorRow): MemoryExtractionCursor {
  const committedEventSeq = requiredNonNegativeInteger(
    row.committed_event_seq,
    'committed_event_seq',
  );
  const committedEventId = nullableIdentifierString(row.committed_event_id, 'committed_event_id');
  const committedPrefixDigest = nullableSha256Digest(
    row.committed_prefix_digest,
    'committed_prefix_digest',
  );
  const requestedEventSeq = requiredNonNegativeInteger(
    row.requested_event_seq,
    'requested_event_seq',
  );
  const requestedEventId = nullableIdentifierString(row.requested_event_id, 'requested_event_id');
  const requestedPrefixDigest = nullableSha256Digest(
    row.requested_prefix_digest,
    'requested_prefix_digest',
  );
  if (
    committedEventSeq > requestedEventSeq ||
    (committedEventSeq === 0 && (committedEventId !== null || committedPrefixDigest !== null)) ||
    (committedEventSeq > 0 && (committedEventId === null || committedPrefixDigest === null)) ||
    (requestedEventSeq === 0 && (requestedEventId !== null || requestedPrefixDigest !== null)) ||
    (requestedEventSeq > 0 && (requestedEventId === null || requestedPrefixDigest === null))
  ) {
    throw invalidColumn('memory_extraction_cursors');
  }
  const createdAt = requiredNonNegativeInteger(row.created_at, 'created_at');
  const updatedAt = requiredNonNegativeInteger(row.updated_at, 'updated_at');
  if (createdAt > updatedAt) throw invalidColumn('updated_at');
  return {
    sessionId: requiredIdentifierString(row.session_id, 'session_id'),
    invocationId: requiredIdentifierString(row.invocation_id, 'invocation_id'),
    runId: requiredIdentifierString(row.run_id, 'run_id'),
    turnId: requiredIdentifierString(row.turn_id, 'turn_id'),
    committedEventSeq,
    committedEventId,
    committedPrefixDigest,
    requestedEventSeq,
    requestedEventId,
    requestedPrefixDigest,
    activeSweepOperationId: nullableIdentifierString(
      row.active_sweep_operation_id,
      'active_sweep_operation_id',
    ),
    version: requiredPositiveInteger(row.version, 'version'),
    createdAt,
    updatedAt,
  };
}

function cursorMatchesFrozenStart(
  cursor: MemoryExtractionCursor,
  range: MemoryExtractionOperationRangeInput | MemoryExtractionOperationRange,
): boolean {
  return (
    cursor.committedEventSeq === range.fromEventSeqExclusive &&
    cursor.committedEventId === range.fromEventId &&
    cursor.committedPrefixDigest === range.fromPrefixDigest
  );
}

function normalizeExtractionCandidateQuery(
  request: SearchMemoryExtractionCandidatesRequest,
): NormalizedExtractionCandidateQuery {
  if (!request || typeof request !== 'object') {
    throw new Error('Memory Extraction candidate query must be an object');
  }
  const content = normalizeLongTermMemoryContent(request.content);
  if (!content.ok) throw new Error(content.message);
  if (!isMemoryItemKind(request.kind)) throw new Error('Invalid Memory Item kind');
  if (!isMemoryStatementType(request.statementType))
    throw new Error('Invalid Memory statement type');
  if (!isMemoryTemporalType(request.temporalType)) throw new Error('Invalid Memory temporal type');
  if (!isMemoryScopeType(request.scopeType)) throw new Error('Invalid Memory scope type');
  const scopeKey = normalizeScopeKey(request.scopeType, request.scopeKey);
  const eventStartedAt = normalizeOptionalTimestamp(request.eventStartedAt, 'eventStartedAt');
  const eventEndedAt = normalizeOptionalTimestamp(request.eventEndedAt, 'eventEndedAt');
  validateMemoryTemporalBounds({
    temporalType: request.temporalType,
    eventStartedAt,
    eventEndedAt,
  });
  if (!Array.isArray(request.keys) || request.keys.length === 0) {
    throw new Error('Memory Extraction candidate query requires at least one key');
  }
  if (request.keys.length > MAX_EXTRACTION_CANDIDATE_KEYS) {
    throw new Error(
      `Memory Extraction candidate query accepts at most ${MAX_EXTRACTION_CANDIDATE_KEYS} keys`,
    );
  }
  const keys = [...new Set(request.keys.map(normalizeSearchTerm))].sort(compareText);
  const sourceEventIdsInput = request.sourceEventIds ?? [];
  if (
    !Array.isArray(sourceEventIdsInput) ||
    sourceEventIdsInput.length > MAX_EXTRACTION_CANDIDATE_SOURCES
  ) {
    throw new Error(
      `Memory Extraction candidate query accepts at most ${MAX_EXTRACTION_CANDIDATE_SOURCES} sources`,
    );
  }
  const sourceEventIds = [
    ...new Set(
      sourceEventIdsInput.map((eventId) => normalizeIdentifier(eventId, 'source eventId')),
    ),
  ].sort(compareText);
  const limit = request.limit ?? MAX_EXTRACTION_CANDIDATES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXTRACTION_CANDIDATES) {
    throw new Error(
      `Memory Extraction candidate limit must be between 1 and ${MAX_EXTRACTION_CANDIDATES}`,
    );
  }
  return {
    contentHash: hashText(content.value),
    kind: request.kind,
    statementType: request.statementType,
    temporalType: request.temporalType,
    scopeType: request.scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    keys,
    sourceEventIds,
    limit,
  };
}

function buildExtractionCandidateQuery(input: NormalizedExtractionCandidateQuery): {
  readonly sql: string;
  readonly parameters: readonly (string | number | null)[];
} {
  const parameters: Array<string | number | null> = [input.contentHash];
  const sourceOverlap =
    input.sourceEventIds.length === 0
      ? '0'
      : `(SELECT COUNT(*) FROM memory_item_sources s
         WHERE s.item_id = i.item_id AND s.event_id IN (${placeholders(input.sourceEventIds.length)}))`;
  parameters.push(...input.sourceEventIds);
  const keyOverlap = `(SELECT COUNT(*) FROM memory_item_keys k
    WHERE k.item_id = i.item_id AND k.normalized_key IN (${placeholders(input.keys.length)}))`;
  parameters.push(...input.keys);
  parameters.push(
    input.kind,
    input.statementType,
    input.temporalType,
    input.eventStartedAt,
    input.eventEndedAt,
  );
  const scopeClause =
    input.scopeType === 'global'
      ? `i.scope_type = 'global' AND i.scope_key IS NULL`
      : `i.scope_type = 'workspace' AND i.scope_key = ?`;
  if (input.scopeType === 'workspace') parameters.push(input.scopeKey);
  parameters.push(input.limit + 1);
  return {
    sql: `
      WITH ranked AS MATERIALIZED (
        SELECT
          i.item_id,
          CASE WHEN i.content_hash = ? THEN 1 ELSE 0 END AS content_hash_match,
          ${sourceOverlap} AS source_overlap_count,
          ${keyOverlap} AS exact_key_match_count,
          CASE WHEN i.kind = ? THEN 1 ELSE 0 END AS kind_match,
          CASE WHEN i.statement_type = ? THEN 1 ELSE 0 END AS statement_type_match,
          CASE WHEN i.temporal_type = ?
                     AND i.event_started_at IS ?
                     AND i.event_ended_at IS ? THEN 1 ELSE 0 END AS temporal_match
        FROM memory_items i
        WHERE i.lifecycle_state = 'active' AND ${scopeClause}
      )
      SELECT * FROM ranked
      WHERE content_hash_match = 1 OR source_overlap_count > 0 OR exact_key_match_count > 0
      ORDER BY
        CASE WHEN content_hash_match = 1 OR source_overlap_count > 0 THEN 1 ELSE 0 END DESC,
        content_hash_match DESC,
        source_overlap_count DESC,
        exact_key_match_count DESC,
        kind_match DESC,
        statement_type_match DESC,
        temporal_match DESC,
        item_id ASC
      LIMIT ?`,
    parameters,
  };
}

function validateExtractionCommitShape(
  operation: MemoryExtractionOperation,
  resultType: CommitMemoryExtractionRequest['resultType'],
  mutations: readonly NormalizedMutation[],
): void {
  if (operation.mode === 'sweep') {
    if (resultType !== 'proposed' && resultType !== 'empty') {
      throw new Error('Sweep Memory Extraction result must be proposed or empty');
    }
  } else if (
    resultType !== 'proposed' &&
    resultType !== 'unresolved' &&
    resultType !== 'not_storable'
  ) {
    throw new Error('Targeted Memory Extraction result has an invalid type');
  }
  if (resultType !== 'proposed' && mutations.length !== 0) {
    throw new Error(`${resultType} Memory Extraction result cannot carry mutations`);
  }
}

function encodeExtractionMetrics(input: MemoryExtractionAttemptMetrics | null): string | null {
  if (input === null) return null;
  return JSON.stringify(normalizeExtractionMetrics(input));
}

function decodeExtractionMetrics(value: unknown): MemoryExtractionAttemptMetrics | null {
  if (value === null) return null;
  const json = requiredString(value, 'metrics_json');
  if (json.length > MAX_EXTRACTION_METRICS_JSON_CODE_UNITS) throw invalidColumn('metrics_json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidColumn('metrics_json');
  }
  return normalizeExtractionMetrics(parsed);
}

function normalizeExtractionMetrics(input: unknown): MemoryExtractionAttemptMetrics {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Memory Extraction metrics must be an object');
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set([
    'version',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'latencyMs',
    'searchCount',
    'readCount',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.version !== 1) {
    throw new Error('Invalid Memory Extraction metrics schema');
  }
  const optionalMetric = (name: string): number | undefined => {
    const value = record[name];
    if (value === undefined) return undefined;
    return normalizeNonNegativeInteger(value, `metrics.${name}`);
  };
  const inputTokens = optionalMetric('inputTokens');
  const outputTokens = optionalMetric('outputTokens');
  const cacheReadTokens = optionalMetric('cacheReadTokens');
  const cacheWriteTokens = optionalMetric('cacheWriteTokens');
  const latencyMs = optionalMetric('latencyMs');
  const searchCount = optionalMetric('searchCount');
  const readCount = optionalMetric('readCount');
  return {
    version: 1,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(searchCount === undefined ? {} : { searchCount }),
    ...(readCount === undefined ? {} : { readCount }),
  };
}

function decodeExtractionCommitReceipt(value: unknown): MemoryExtractionCommitReceipt | null {
  if (value === null) return null;
  const json = requiredString(value, 'result_json');
  if (json.length > MAX_OPERATION_RESULT_JSON_CODE_UNITS) throw invalidColumn('result_json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidColumn('result_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidColumn('result_json');
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'operationId',
    'attemptId',
    'resultType',
    'selectionSaturated',
    'evidenceDigest',
    'mutationDigest',
    'writeOperationId',
    'committedAt',
    'mutationResults',
    'cursors',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.schemaVersion !== 1) {
    throw invalidColumn('result_json');
  }
  const resultType = requiredString(record.resultType, 'resultType');
  if (!isMemoryExtractionResultType(resultType)) throw invalidColumn('resultType');
  if (typeof record.selectionSaturated !== 'boolean') throw invalidColumn('selectionSaturated');
  if (
    !Array.isArray(record.mutationResults) ||
    record.mutationResults.length > MAX_MUTATIONS_PER_OPERATION
  ) {
    throw invalidColumn('mutationResults');
  }
  if (!Array.isArray(record.cursors) || record.cursors.length > MEMORY_EXTRACTION_MAX_RANGES) {
    throw invalidColumn('cursors');
  }
  const mutationResults = record.mutationResults.map((result, index) => {
    const decoded = decodeMutationResult(result, index);
    validateMutationResultOutcome(decoded);
    return decoded;
  });
  const cursors = record.cursors.map(decodeExtractionCursorValue);
  return {
    schemaVersion: 1,
    operationId: requiredIdentifierString(record.operationId, 'operationId'),
    attemptId: requiredIdentifierString(record.attemptId, 'attemptId'),
    resultType,
    selectionSaturated: record.selectionSaturated,
    evidenceDigest: requiredSha256Digest(record.evidenceDigest, 'evidenceDigest'),
    mutationDigest: requiredSha256Digest(record.mutationDigest, 'mutationDigest'),
    writeOperationId: requiredIdentifierString(record.writeOperationId, 'writeOperationId'),
    committedAt: requiredNonNegativeInteger(record.committedAt, 'committedAt'),
    mutationResults,
    cursors,
  };
}

function decodeExtractionCursorValue(value: unknown): MemoryExtractionCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidColumn('receipt.cursor');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'sessionId',
    'invocationId',
    'runId',
    'turnId',
    'committedEventSeq',
    'committedEventId',
    'committedPrefixDigest',
    'requestedEventSeq',
    'requestedEventId',
    'requestedPrefixDigest',
    'activeSweepOperationId',
    'version',
    'createdAt',
    'updatedAt',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw invalidColumn('receipt.cursor');
  return decodeExtractionCursor({
    session_id: record.sessionId,
    invocation_id: record.invocationId,
    run_id: record.runId,
    turn_id: record.turnId,
    committed_event_seq: record.committedEventSeq,
    committed_event_id: record.committedEventId,
    committed_prefix_digest: record.committedPrefixDigest,
    requested_event_seq: record.requestedEventSeq,
    requested_event_id: record.requestedEventId,
    requested_prefix_digest: record.requestedPrefixDigest,
    active_sweep_operation_id: record.activeSweepOperationId,
    followup_eligible: 0,
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  });
}

function normalizeMutations(
  mutations: readonly MemoryItemMutation[],
  allowEmpty = false,
): readonly NormalizedMutation[] {
  if (!Array.isArray(mutations) || (!allowEmpty && mutations.length === 0)) {
    throw new Error('Memory operation requires at least one mutation');
  }
  if (mutations.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(`Memory operation accepts at most ${MAX_MUTATIONS_PER_OPERATION} mutations`);
  }
  return mutations.map((mutation): NormalizedMutation => {
    if (!mutation || typeof mutation !== 'object') throw new Error('Invalid Memory mutation');
    switch (mutation.type) {
      case 'create':
        return { type: 'create', item: normalizeWrite(mutation.item) };
      case 'update':
        return {
          type: 'update',
          itemId: normalizeIdentifier(mutation.itemId, 'itemId'),
          expectedVersion: normalizeVersion(mutation.expectedVersion),
          item: normalizeWrite(mutation.item),
        };
      case 'archive':
      case 'restore':
        return {
          type: mutation.type,
          itemId: normalizeIdentifier(mutation.itemId, 'itemId'),
          expectedVersion: normalizeVersion(mutation.expectedVersion),
        };
      default:
        throw new Error('Unknown Memory mutation type');
    }
  });
}

function assertChildCardinality(child: 'keys' | 'sources', count: number, maximum: number): void {
  if (count < 1 || count > maximum) {
    throw new Error(
      `Invalid Memory Item ${child} cardinality: expected 1..${maximum}, got ${count}`,
    );
  }
}

function validateObservedAtForCommit(
  mutations: readonly NormalizedMutation[],
  committedAt: number,
): void {
  for (const mutation of mutations) {
    if (
      (mutation.type === 'create' || mutation.type === 'update') &&
      mutation.item.observedAt > committedAt
    ) {
      throw new Error('observedAt cannot be later than commit time');
    }
  }
}

function normalizeWrite(input: MemoryItemWrite): NormalizedMemoryWrite {
  if (!input || typeof input !== 'object') throw new Error('Memory Item write must be an object');
  const content = normalizeLongTermMemoryContent(input.content);
  if (!content.ok) throw new Error(content.message);
  if (!isMemoryItemKind(input.kind)) throw new Error('Invalid Memory Item kind');
  if (!isMemoryStatementType(input.statementType)) throw new Error('Invalid Memory statement type');
  if (!isMemoryTemporalType(input.temporalType)) throw new Error('Invalid Memory temporal type');
  if (!isMemoryScopeType(input.scopeType)) throw new Error('Invalid Memory scope type');
  if (!isMemoryItemOrigin(input.origin)) throw new Error('Invalid Memory Item origin');

  const scopeKey = normalizeScopeKey(input.scopeType, input.scopeKey);
  const eventStartedAt = normalizeOptionalTimestamp(input.eventStartedAt, 'eventStartedAt');
  const eventEndedAt = normalizeOptionalTimestamp(input.eventEndedAt, 'eventEndedAt');
  validateMemoryTemporalBounds({
    temporalType: input.temporalType,
    eventStartedAt,
    eventEndedAt,
  });
  const observedAt = normalizeTimestamp(input.observedAt, 'observedAt');
  return {
    content: content.value,
    kind: input.kind,
    statementType: input.statementType,
    temporalType: input.temporalType,
    scopeType: input.scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    observedAt,
    origin: input.origin,
    contentHash: hashText(content.value),
    keys: normalizeKeys(input.keys),
    sources: normalizeSources(input.sources),
  };
}

function normalizeScopeKey(
  scopeType: MemoryItem['scopeType'],
  input: string | null | undefined,
): string | null {
  if (scopeType === 'global') {
    if (input !== undefined && input !== null) {
      throw new Error('Global Memory Item cannot have a scopeKey');
    }
    return null;
  }
  return normalizeIdentifier(input, 'workspace scopeKey');
}

function normalizeKeys(input: readonly MemoryItemKeyInput[]): readonly MemoryItemKey[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Memory Item requires at least one search key');
  }
  if (input.length > MAX_KEYS_PER_ITEM) {
    throw new Error(`Memory Item accepts at most ${MAX_KEYS_PER_ITEM} search keys`);
  }
  const winners = new Map<string, MemoryItemKey>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid Memory search key');
    if (!isMemoryKeyType(candidate.keyType)) throw new Error('Invalid Memory key type');
    if (!isMemoryKeyOrigin(candidate.keyOrigin)) throw new Error('Invalid Memory key origin');
    const key = normalizeVisibleText(candidate.key, 'Memory search key', MAX_KEY_CODE_POINTS);
    const normalized: MemoryItemKey = {
      key,
      normalizedKey: normalizeSearchTerm(key),
      keyType: candidate.keyType,
      keyOrigin: candidate.keyOrigin,
    };
    const existing = winners.get(normalized.normalizedKey);
    if (!existing || keyPriority(normalized) > keyPriority(existing)) {
      winners.set(normalized.normalizedKey, normalized);
    } else if (
      existing &&
      keyPriority(normalized) === keyPriority(existing) &&
      compareText(normalized.key, existing.key) < 0
    ) {
      winners.set(normalized.normalizedKey, normalized);
    }
  }
  return [...winners.values()].sort((left, right) =>
    compareText(left.normalizedKey, right.normalizedKey),
  );
}

function normalizeSources(input: readonly MemoryItemSource[]): readonly MemoryItemSource[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Memory Item requires at least one source Event');
  }
  if (input.length > MAX_SOURCES_PER_ITEM) {
    throw new Error(`Memory Item accepts at most ${MAX_SOURCES_PER_ITEM} sources`);
  }
  const sources = new Map<string, MemoryItemSource>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid Memory Item source');
    const source: MemoryItemSource = {
      sessionId: normalizeIdentifier(candidate.sessionId, 'source sessionId'),
      runId: normalizeIdentifier(candidate.runId, 'source runId'),
      turnId: normalizeIdentifier(candidate.turnId, 'source turnId'),
      eventId: normalizeIdentifier(candidate.eventId, 'source eventId'),
    };
    const existing = sources.get(source.eventId);
    if (existing && !sameSource(existing, source)) {
      throw new Error(`Source eventId ${source.eventId} has conflicting provenance`);
    }
    sources.set(source.eventId, source);
  }
  return [...sources.values()].sort((left, right) => compareText(left.eventId, right.eventId));
}

function sameSource(left: MemoryItemSource, right: MemoryItemSource): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.eventId === right.eventId
  );
}

function normalizeIdentifier(input: unknown, name: string): string {
  if (typeof input !== 'string') throw new Error(`${name} must be a string`);
  if (input.normalize('NFC') !== input || input.trim() !== input) {
    throw new Error(`${name} must already be NFC-normalized without surrounding whitespace`);
  }
  return normalizeVisibleText(input, name, MAX_IDENTIFIER_CODE_POINTS);
}

function normalizeVisibleText(input: unknown, name: string, maxCodePoints: number): string {
  if (typeof input !== 'string') throw new Error(`${name} must be a string`);
  const value = input.normalize('NFC').trim();
  if (value === '') throw new Error(`${name} cannot be empty`);
  if (/[\p{Cc}\p{Cs}\u200B\u200C\u200D\uFEFF]/u.test(value)) {
    throw new Error(`${name} cannot contain control or zero-width characters`);
  }
  if (Array.from(value).length > maxCodePoints) {
    throw new Error(`${name} must be ${maxCodePoints} code points or fewer`);
  }
  return value;
}

function normalizeSearchTerm(input: unknown): string {
  return normalizeVisibleText(input, 'Memory search term', MAX_KEY_CODE_POINTS)
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function normalizeVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('expectedVersion must be a positive safe integer');
  }
  return value as number;
}

function normalizeNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function normalizePositiveInteger(value: unknown, name: string): number {
  const normalized = normalizeNonNegativeInteger(value, name);
  if (normalized < 1) throw new Error(`${name} must be a positive safe integer`);
  return normalized;
}

function normalizeTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer UTC millisecond timestamp`);
  }
  return value as number;
}

function normalizeOptionalTimestamp(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return normalizeTimestamp(value, name);
}

function normalizeSha256Digest(value: unknown, name: string): MemorySha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase sha256:<64 hex> digest`);
  }
  return value as MemorySha256Digest;
}

function normalizeJsonObject(value: unknown, name: string, maximumCodeUnits: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a JSON string`);
  if (value.length > maximumCodeUnits) {
    throw new Error(`${name} must be ${maximumCodeUnits} code units or fewer`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return value;
}

function normalizeStableErrorCode(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/u.test(value)) {
    throw new Error(`${name} must be a stable lowercase error code`);
  }
  return value;
}

function keyPriority(key: MemoryItemKey): number {
  const origin = { user: 3, deterministic: 2, llm: 1 } as const;
  const type = { code: 5, exact: 4, entity: 3, concept: 2, alias: 1 } as const;
  return origin[key.keyOrigin] * 10 + type[key.keyType];
}

function recordMatchesWrite(record: MemoryItemRecord, write: NormalizedMemoryWrite): boolean {
  return hashCanonical(writeFromRecord(record)) === hashCanonical(write);
}

function writeFromRecord(record: MemoryItemRecord): NormalizedMemoryWrite {
  return {
    content: record.item.content,
    kind: record.item.kind,
    statementType: record.item.statementType,
    temporalType: record.item.temporalType,
    scopeType: record.item.scopeType,
    scopeKey: record.item.scopeKey,
    eventStartedAt: record.item.eventStartedAt,
    eventEndedAt: record.item.eventEndedAt,
    observedAt: record.item.observedAt,
    origin: record.item.origin,
    contentHash: record.item.contentHash,
    keys: record.keys,
    sources: record.sources,
  };
}

function factIdentityMatchesWrite(item: MemoryItem, write: NormalizedMemoryWrite): boolean {
  return (
    item.content === write.content &&
    item.kind === write.kind &&
    item.statementType === write.statementType &&
    item.temporalType === write.temporalType &&
    item.scopeType === write.scopeType &&
    item.scopeKey === write.scopeKey &&
    item.eventStartedAt === write.eventStartedAt &&
    item.eventEndedAt === write.eventEndedAt
  );
}

function mutationResult(
  mutationIndex: number,
  mutationType: MemoryMutationResult['mutationType'],
  item: MemoryItem,
  outcome: MemoryMutationResult['outcome'],
): MemoryMutationResult {
  return {
    mutationIndex,
    mutationType,
    itemId: item.itemId,
    version: item.version,
    lifecycleState: item.lifecycleState,
    outcome,
  };
}

function decodeItem(row: MemoryItemRow): MemoryItem {
  const kind = requiredString(row.kind, 'kind');
  const statementType = requiredString(row.statement_type, 'statement_type');
  const temporalType = requiredString(row.temporal_type, 'temporal_type');
  const scopeType = requiredString(row.scope_type, 'scope_type');
  const lifecycleState = requiredString(row.lifecycle_state, 'lifecycle_state');
  const origin = requiredString(row.origin, 'origin');
  if (!isMemoryItemKind(kind)) throw invalidColumn('kind');
  if (!isMemoryStatementType(statementType)) throw invalidColumn('statement_type');
  if (!isMemoryTemporalType(temporalType)) throw invalidColumn('temporal_type');
  if (!isMemoryScopeType(scopeType)) throw invalidColumn('scope_type');
  if (!isMemoryLifecycleState(lifecycleState)) throw invalidColumn('lifecycle_state');
  if (!isMemoryItemOrigin(origin)) throw invalidColumn('origin');
  const itemId = requiredIdentifierString(row.item_id, 'item_id');
  const version = requiredPositiveInteger(row.version, 'version');
  const content = requiredNonEmptyString(row.content, 'content');
  const normalizedContent = normalizeLongTermMemoryContent(content);
  if (!normalizedContent.ok || normalizedContent.value !== content) throw invalidColumn('content');
  const scopeKey = nullableIdentifierString(row.scope_key, 'scope_key');
  const eventStartedAt = nullableNonNegativeInteger(row.event_started_at, 'event_started_at');
  const eventEndedAt = nullableNonNegativeInteger(row.event_ended_at, 'event_ended_at');
  const observedAt = requiredNonNegativeInteger(row.observed_at, 'observed_at');
  const contentHash = requiredHash(row.content_hash, 'content_hash');
  const createdAt = requiredNonNegativeInteger(row.created_at, 'created_at');
  const updatedAt = requiredNonNegativeInteger(row.updated_at, 'updated_at');
  if (
    (scopeType === 'global' && scopeKey !== null) ||
    (scopeType === 'workspace' && (scopeKey === null || scopeKey.length === 0))
  ) {
    throw invalidColumn('scope_key');
  }
  validateMemoryTemporalBounds({ temporalType, eventStartedAt, eventEndedAt });
  if (createdAt > updatedAt || observedAt > updatedAt) throw invalidColumn('timestamps');
  if (hashText(content) !== contentHash) throw invalidColumn('content_hash');
  return {
    itemId,
    version,
    content,
    kind,
    statementType,
    temporalType,
    scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    observedAt,
    lifecycleState,
    origin,
    contentHash,
    createdAt,
    updatedAt,
  };
}

function decodeKey(row: MemoryKeyRow): MemoryItemKey {
  const keyType = requiredString(row.key_type, 'key_type');
  const keyOrigin = requiredString(row.key_origin, 'key_origin');
  if (!isMemoryKeyType(keyType)) throw invalidColumn('key_type');
  if (!isMemoryKeyOrigin(keyOrigin)) throw invalidColumn('key_origin');
  const key = requiredNonEmptyString(row.key_text, 'key_text');
  const normalizedKey = requiredNonEmptyString(row.normalized_key, 'normalized_key');
  if (normalizeSearchTerm(key) !== normalizedKey) throw invalidColumn('normalized_key');
  return {
    key,
    normalizedKey,
    keyType,
    keyOrigin,
  };
}

function decodeSource(row: MemorySourceRow): MemoryItemSource {
  return {
    sessionId: requiredIdentifierString(row.session_id, 'session_id'),
    runId: requiredIdentifierString(row.run_id, 'run_id'),
    turnId: requiredIdentifierString(row.turn_id, 'turn_id'),
    eventId: requiredIdentifierString(row.event_id, 'event_id'),
  };
}

function decodeOperation(row: MemoryOperationRow): MemoryWriteOperationResult {
  const operationId = requiredIdentifierString(row.operation_id, 'operation_id');
  const operationType = requiredString(row.operation_type, 'operation_type');
  if (!['create', 'update', 'archive', 'restore', 'batch'].includes(operationType)) {
    throw invalidColumn('operation_type');
  }
  requiredHash(row.request_hash, 'request_hash');
  const resultJson = requiredString(row.result_json, 'result_json');
  if (resultJson.length > MAX_OPERATION_RESULT_JSON_CODE_UNITS) {
    throw new Error(`Memory operation ${operationId} result JSON is too large`);
  }
  let results: unknown;
  try {
    results = JSON.parse(resultJson);
  } catch (error) {
    throw new Error(`Invalid result JSON for Memory operation ${operationId}`, { cause: error });
  }
  if (!Array.isArray(results))
    throw new Error(`Invalid results for Memory operation ${operationId}`);
  if (results.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(
      `Memory operation results accept at most ${MAX_MUTATIONS_PER_OPERATION} mutations`,
    );
  }
  const decodedResults = results.map((result, index) => decodeMutationResult(result, index));
  if (
    (operationType === 'batch' && decodedResults.length === 1) ||
    (operationType !== 'batch' &&
      (decodedResults.length !== 1 || decodedResults[0]?.mutationType !== operationType))
  ) {
    throw new Error(`Invalid results for Memory operation ${operationId}`);
  }
  for (const result of decodedResults) validateMutationResultOutcome(result);
  return {
    operationId,
    operationType: operationType as MemoryWriteOperationResult['operationType'],
    replayed: false,
    committedAt: requiredNonNegativeInteger(row.committed_at, 'committed_at'),
    results: decodedResults,
  };
}

function decodeMutationResult(value: unknown, expectedIndex: number): MemoryMutationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Memory mutation result');
  }
  const result = value as Record<string, unknown>;
  const mutationIndex = requiredNonNegativeInteger(result.mutationIndex, 'mutationIndex');
  const mutationType = requiredString(result.mutationType, 'mutationType');
  const lifecycleState = requiredString(result.lifecycleState, 'lifecycleState');
  const outcome = requiredString(result.outcome, 'outcome');
  if (mutationIndex !== expectedIndex) throw invalidColumn('mutationIndex');
  if (!['create', 'update', 'archive', 'restore'].includes(mutationType)) {
    throw invalidColumn('mutationType');
  }
  if (!isMemoryLifecycleState(lifecycleState)) throw invalidColumn('lifecycleState');
  if (!['created', 'updated', 'archived', 'restored', 'noop'].includes(outcome)) {
    throw invalidColumn('outcome');
  }
  return {
    mutationIndex,
    mutationType: mutationType as MemoryMutationResult['mutationType'],
    itemId: requiredIdentifierString(result.itemId, 'itemId'),
    version: requiredPositiveInteger(result.version, 'version'),
    lifecycleState,
    outcome: outcome as MemoryMutationResult['outcome'],
  };
}

function validateMutationResultOutcome(result: MemoryMutationResult): void {
  const valid =
    (result.mutationType === 'create' &&
      result.outcome === 'created' &&
      result.lifecycleState === 'active') ||
    (result.mutationType === 'update' &&
      (result.outcome === 'updated' || result.outcome === 'noop')) ||
    (result.mutationType === 'archive' &&
      result.outcome === 'archived' &&
      result.lifecycleState === 'archived') ||
    (result.mutationType === 'restore' &&
      result.outcome === 'restored' &&
      result.lifecycleState === 'active');
  if (!valid) throw new Error('Invalid Memory mutation result outcome');
}

function requiredString(value: unknown, column: string): string {
  if (typeof value !== 'string') throw invalidColumn(column);
  return value;
}

function nullableString(value: unknown, column: string): string | null {
  return value === null ? null : requiredString(value, column);
}

function requiredNonEmptyString(value: unknown, column: string): string {
  const result = requiredString(value, column);
  if (result.length === 0) throw invalidColumn(column);
  return result;
}

function requiredIdentifierString(value: unknown, column: string): string {
  const result = requiredNonEmptyString(value, column);
  try {
    return normalizeIdentifier(result, column);
  } catch {
    throw invalidColumn(column);
  }
}

function nullableIdentifierString(value: unknown, column: string): string | null {
  return value === null ? null : requiredIdentifierString(value, column);
}

function nullableStableErrorCode(value: unknown, column: string): string | null {
  if (value === null) return null;
  try {
    return normalizeStableErrorCode(value, column);
  } catch {
    throw invalidColumn(column);
  }
}

function requiredInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalidColumn(column);
  return value;
}

function requiredNonNegativeInteger(value: unknown, column: string): number {
  const result = requiredInteger(value, column);
  if (result < 0) throw invalidColumn(column);
  return result;
}

function requiredBooleanInteger(value: unknown, column: string): boolean {
  const result = requiredInteger(value, column);
  if (result !== 0 && result !== 1) throw invalidColumn(column);
  return result === 1;
}

function requiredPositiveInteger(value: unknown, column: string): number {
  const result = requiredInteger(value, column);
  if (result < 1) throw invalidColumn(column);
  return result;
}

function nullableNonNegativeInteger(value: unknown, column: string): number | null {
  return value === null ? null : requiredNonNegativeInteger(value, column);
}

function requiredHash(value: unknown, column: string): string {
  const result = requiredString(value, column);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw invalidColumn(column);
  return result;
}

function nullableHash(value: unknown, column: string): string | null {
  return value === null ? null : requiredHash(value, column);
}

function requiredSha256Digest(value: unknown, column: string): MemorySha256Digest {
  const result = requiredString(value, column);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw invalidColumn(column);
  return result as MemorySha256Digest;
}

function nullableSha256Digest(value: unknown, column: string): MemorySha256Digest | null {
  return value === null ? null : requiredSha256Digest(value, column);
}

function invalidColumn(column: string): Error {
  return new Error(`Invalid long-term memory SQLite column ${column}`);
}

function extractionOperationNotFound(operationId: string): MemoryItemStoreConflictError {
  return new MemoryItemStoreConflictError(
    'extraction_operation_not_found',
    `Memory Extraction Operation ${operationId} does not exist`,
  );
}

function extractionAttemptNotActive(attemptId: string): MemoryItemStoreConflictError {
  return new MemoryItemStoreConflictError(
    'extraction_attempt_not_active',
    `Memory Extraction Attempt ${attemptId} is not the active running Attempt`,
  );
}

function extractionCursorConflict(
  sessionId: string,
  runId: string,
  detail: string,
): MemoryItemStoreConflictError {
  return new MemoryItemStoreConflictError(
    'extraction_cursor_conflict',
    `Memory Extraction Cursor ${sessionId}/${runId} ${detail}`,
  );
}

function assertChanged(changes: number | bigint, itemId: string): void {
  if (Number(changes) !== 1) {
    throw new MemoryItemStoreConflictError(
      'version_conflict',
      `Memory Item ${itemId} changed concurrently`,
      itemId,
    );
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashCanonical(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Smallest Unicode string strictly greater than every string with this prefix. */
function prefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix, (character) => character.codePointAt(0)!);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point < 0x10ffff) {
      const successor = point === 0xd7ff ? 0xe000 : point + 1;
      return String.fromCodePoint(...points.slice(0, index), successor);
    }
  }
  return undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function preparePrivateDatabaseFiles(path: string): void {
  secureFile(path, true, false);
  for (const sidecar of databaseSidecars(path)) secureFile(sidecar, false, true);
}

function secureExistingDatabaseFiles(path: string): void {
  secureFile(path, false, false);
  for (const sidecar of databaseSidecars(path)) secureFile(sidecar, false, true);
}

function secureFile(path: string, create: boolean, allowUnlinked: boolean): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Long-term memory SQLite path must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error;
  }
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR | noFollow | (create ? fsConstants.O_CREAT : 0),
      0o600,
    );
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      throw new Error(`Long-term memory SQLite path is not a regular file: ${path}`);
    }
    if (status.nlink === 0 && allowUnlinked) return;
    if (status.nlink !== 1) {
      throw new Error(`Long-term memory SQLite path must not be hard-linked: ${path}`);
    }
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (!create && isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function databaseSidecars(path: string): readonly string[] {
  return [`${path}-wal`, `${path}-shm`, `${path}-journal`];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // Preserve the write failure that triggered rollback.
  }
}
