import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION = 2;

const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 10;
const initializationRetryGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type SqliteLongTermMemoryMigrationFailpoint = 'after_schema_sql';

export interface SqliteLongTermMemoryMigrationOptions {
  readonly failpoint?: (point: SqliteLongTermMemoryMigrationFailpoint) => void;
}

const MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [
    1,
    `
    CREATE TABLE memory_items (
      item_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 1),
      content TEXT NOT NULL CHECK (length(content) > 0),
      kind TEXT NOT NULL CHECK (
        kind IN ('preference', 'identity', 'context', 'knowledge', 'failure', 'note')
      ),
      statement_type TEXT NOT NULL CHECK (statement_type IN ('fact', 'plan', 'prediction')),
      temporal_type TEXT NOT NULL CHECK (
        temporal_type IN ('undated', 'point', 'interval', 'open_ended')
      ),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace')),
      scope_key TEXT,
      event_started_at INTEGER,
      event_ended_at INTEGER,
      observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'archived')),
      origin TEXT NOT NULL CHECK (origin IN ('agent_extracted', 'user_requested')),
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (scope_type = 'global' AND scope_key IS NULL)
        OR
        (scope_type = 'workspace' AND scope_key IS NOT NULL AND length(scope_key) > 0)
      ),
      CHECK (
        (temporal_type = 'undated'
          AND event_started_at IS NULL
          AND event_ended_at IS NULL)
        OR
        (temporal_type = 'point'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND (event_ended_at IS NULL OR event_ended_at > event_started_at))
        OR
        (temporal_type = 'interval'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NOT NULL
          AND event_ended_at > event_started_at)
        OR
        (temporal_type = 'open_ended'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NULL)
      ),
      CHECK (created_at <= updated_at),
      CHECK (observed_at <= updated_at)
    );

    CREATE INDEX memory_items_by_scope_and_lifecycle
      ON memory_items(scope_type, scope_key, lifecycle_state, updated_at DESC, item_id);

    CREATE INDEX memory_items_by_active_hash
      ON memory_items(lifecycle_state, scope_type, scope_key, content_hash, item_id);

    CREATE TABLE memory_item_keys (
      item_id TEXT NOT NULL,
      key_text TEXT NOT NULL CHECK (length(key_text) > 0),
      normalized_key TEXT NOT NULL CHECK (length(normalized_key) > 0),
      key_type TEXT NOT NULL CHECK (key_type IN ('exact', 'entity', 'concept', 'alias', 'code')),
      key_origin TEXT NOT NULL CHECK (key_origin IN ('deterministic', 'llm', 'user')),
      PRIMARY KEY(item_id, normalized_key),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX memory_item_keys_by_normalized_key
      ON memory_item_keys(normalized_key, item_id);

    CREATE TABLE memory_item_sources (
      item_id TEXT NOT NULL,
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      run_id TEXT NOT NULL CHECK (length(run_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      event_id TEXT NOT NULL CHECK (length(event_id) > 0),
      PRIMARY KEY(item_id, event_id),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX memory_item_sources_by_event
      ON memory_item_sources(event_id, item_id);

    CREATE INDEX memory_item_sources_by_turn
      ON memory_item_sources(session_id, turn_id, item_id);

    CREATE TABLE memory_write_operations (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL CHECK (
        operation_type IN ('create', 'update', 'archive', 'restore', 'batch')
      ),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      result_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0)
    );
    `,
  ],
  [
    2,
    `
    CREATE TABLE memory_extraction_operations (
      operation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      mode TEXT NOT NULL CHECK (mode IN ('sweep', 'targeted')),
      trigger_kind TEXT NOT NULL CHECK (
        trigger_kind IN ('context_threshold', 'compaction', 'user_requested', 'agent_requested')
      ),
      internal_session_id TEXT NOT NULL UNIQUE CHECK (length(internal_session_id) > 0),
      session_create_fingerprint TEXT NOT NULL CHECK (
        length(session_create_fingerprint) = 71
        AND substr(session_create_fingerprint, 1, 7) = 'sha256:'
      ),
      request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 71 AND substr(request_hash, 1, 7) = 'sha256:'
      ),
      request_json TEXT NOT NULL CHECK (
        json_valid(request_json) AND json_type(request_json) = 'object'
      ),
      trigger_epoch TEXT,

      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      active_attempt_id TEXT,
      lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
      next_attempt_at INTEGER CHECK (next_attempt_at IS NULL OR next_attempt_at >= 0),
      last_error_code TEXT,
      last_error_stage TEXT CHECK (
        last_error_stage IS NULL OR last_error_stage IN (
          'admission', 'provider', 'search', 'read', 'submit', 'commit', 'recovery', 'cleanup'
        )
      ),
      last_error_at INTEGER CHECK (last_error_at IS NULL OR last_error_at >= 0),
      last_failed_attempt_id TEXT,
      started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      result_type TEXT CHECK (
        result_type IS NULL OR result_type IN ('proposed', 'empty', 'unresolved', 'not_storable')
      ),
      commit_hash TEXT CHECK (commit_hash IS NULL OR length(commit_hash) = 64),
      result_json TEXT CHECK (
        result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')
      ),
      diagnostic_retention_until INTEGER CHECK (
        diagnostic_retention_until IS NULL OR diagnostic_retention_until >= 0
      ),
      cleanup_state TEXT CHECK (
        cleanup_state IS NULL OR cleanup_state IN ('pending', 'running', 'completed')
      ),
      cleanup_claim_id TEXT,
      cleanup_lease_expires_at INTEGER CHECK (
        cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at >= 0
      ),
      cleanup_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempt_count >= 0),
      cleanup_error_code TEXT,
      cleaned_at INTEGER CHECK (cleaned_at IS NULL OR cleaned_at >= 0),

      UNIQUE(session_id, request_hash),
      CHECK (created_at <= updated_at),
      CHECK (started_at IS NULL OR created_at <= started_at),
      CHECK (completed_at IS NULL OR started_at IS NOT NULL),
      CHECK (
        (state = 'running' AND active_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (state <> 'running' AND active_attempt_id IS NULL AND lease_expires_at IS NULL)
      ),
      CHECK (state = 'pending' OR next_attempt_at IS NULL),
      CHECK (
        (state = 'succeeded'
          AND completed_at IS NOT NULL
          AND result_type IS NOT NULL
          AND commit_hash IS NOT NULL
          AND result_json IS NOT NULL)
        OR
        (state = 'failed'
          AND completed_at IS NOT NULL
          AND result_type IS NULL
          AND commit_hash IS NULL
          AND result_json IS NULL)
        OR
        (state IN ('pending', 'running')
          AND completed_at IS NULL
          AND result_type IS NULL
          AND commit_hash IS NULL
          AND result_json IS NULL)
      ),
      CHECK (
        (state IN ('succeeded', 'failed')
          AND diagnostic_retention_until IS NOT NULL
          AND cleanup_state IS NOT NULL)
        OR
        (state IN ('pending', 'running')
          AND diagnostic_retention_until IS NULL
          AND cleanup_state IS NULL)
      ),
      CHECK (
        (cleanup_state = 'running'
          AND cleanup_claim_id IS NOT NULL
          AND cleanup_lease_expires_at IS NOT NULL
          AND cleaned_at IS NULL)
        OR
        (cleanup_state = 'completed'
          AND cleanup_claim_id IS NULL
          AND cleanup_lease_expires_at IS NULL
          AND cleaned_at IS NOT NULL)
        OR
        ((cleanup_state = 'pending' OR cleanup_state IS NULL)
          AND cleanup_claim_id IS NULL
          AND cleanup_lease_expires_at IS NULL
          AND cleaned_at IS NULL)
      )
    );

    CREATE INDEX memory_extraction_operations_by_claim
      ON memory_extraction_operations(state, next_attempt_at, created_at, operation_id);

    CREATE INDEX memory_extraction_operations_by_lease
      ON memory_extraction_operations(state, lease_expires_at, operation_id);

    CREATE INDEX memory_extraction_operations_by_session
      ON memory_extraction_operations(session_id, mode, state, created_at, operation_id);

    CREATE INDEX memory_extraction_operations_by_cleanup
      ON memory_extraction_operations(
        cleanup_state, diagnostic_retention_until, cleanup_lease_expires_at, operation_id
      );

    CREATE TABLE memory_extraction_attempts (
      attempt_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 1),
      state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'abandoned')),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) > 0),
      snapshot_kind TEXT NOT NULL CHECK (
        snapshot_kind IN ('provider_prefix', 'runtime_delta', 'reconstructed_full')
      ),
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      failure_code TEXT,
      failure_stage TEXT CHECK (
        failure_stage IS NULL OR failure_stage IN (
          'admission', 'provider', 'search', 'read', 'submit', 'commit', 'recovery', 'cleanup'
        )
      ),
      metrics_json TEXT CHECK (
        metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json) = 'object')
      ),
      UNIQUE(operation_id, attempt_ordinal),
      UNIQUE(operation_id, attempt_id),
      FOREIGN KEY(operation_id) REFERENCES memory_extraction_operations(operation_id) ON DELETE CASCADE,
      CHECK (
        (state = 'running'
          AND completed_at IS NULL
          AND failure_code IS NULL
          AND failure_stage IS NULL)
        OR
        (state = 'succeeded'
          AND completed_at IS NOT NULL
          AND failure_code IS NULL
          AND failure_stage IS NULL)
        OR
        (state IN ('failed', 'abandoned')
          AND completed_at IS NOT NULL
          AND failure_code IS NOT NULL
          AND failure_stage IS NOT NULL)
      )
    );

    CREATE INDEX memory_extraction_attempts_by_operation
      ON memory_extraction_attempts(operation_id, attempt_ordinal, attempt_id);

    CREATE TABLE memory_extraction_operation_ranges (
      operation_id TEXT NOT NULL,
      range_ordinal INTEGER NOT NULL CHECK (range_ordinal >= 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      invocation_id TEXT NOT NULL CHECK (length(invocation_id) > 0),
      run_id TEXT NOT NULL CHECK (length(run_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      from_event_seq_exclusive INTEGER NOT NULL CHECK (from_event_seq_exclusive >= 0),
      from_event_id TEXT,
      from_prefix_digest TEXT,
      to_event_seq_inclusive INTEGER NOT NULL CHECK (to_event_seq_inclusive > 0),
      to_event_id TEXT NOT NULL CHECK (length(to_event_id) > 0),
      to_prefix_digest TEXT NOT NULL CHECK (
        length(to_prefix_digest) = 71 AND substr(to_prefix_digest, 1, 7) = 'sha256:'
      ),
      PRIMARY KEY(operation_id, range_ordinal),
      UNIQUE(operation_id, run_id),
      FOREIGN KEY(operation_id) REFERENCES memory_extraction_operations(operation_id) ON DELETE CASCADE,
      CHECK (to_event_seq_inclusive > from_event_seq_exclusive),
      CHECK (
        (from_event_seq_exclusive = 0
          AND from_event_id IS NULL
          AND from_prefix_digest IS NULL)
        OR
        (from_event_seq_exclusive > 0
          AND from_event_id IS NOT NULL
          AND length(from_event_id) > 0
          AND from_prefix_digest IS NOT NULL
          AND length(from_prefix_digest) = 71
          AND substr(from_prefix_digest, 1, 7) = 'sha256:')
      )
    ) WITHOUT ROWID;

    CREATE INDEX memory_extraction_operation_ranges_by_run
      ON memory_extraction_operation_ranges(session_id, run_id, operation_id);

    CREATE TABLE memory_extraction_cursors (
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      invocation_id TEXT NOT NULL CHECK (length(invocation_id) > 0),
      run_id TEXT NOT NULL CHECK (length(run_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      committed_event_seq INTEGER NOT NULL CHECK (committed_event_seq >= 0),
      committed_event_id TEXT,
      committed_prefix_digest TEXT,
      requested_event_seq INTEGER NOT NULL CHECK (requested_event_seq >= 0),
      requested_event_id TEXT,
      requested_prefix_digest TEXT,
      active_sweep_operation_id TEXT,
      followup_eligible INTEGER NOT NULL DEFAULT 0 CHECK (followup_eligible IN (0, 1)),
      version INTEGER NOT NULL CHECK (version >= 1),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY(session_id, run_id),
      FOREIGN KEY(active_sweep_operation_id)
        REFERENCES memory_extraction_operations(operation_id) ON DELETE SET NULL,
      CHECK (committed_event_seq <= requested_event_seq),
      CHECK (created_at <= updated_at),
      CHECK (
        (committed_event_seq = 0
          AND committed_event_id IS NULL
          AND committed_prefix_digest IS NULL)
        OR
        (committed_event_seq > 0
          AND committed_event_id IS NOT NULL
          AND length(committed_event_id) > 0
          AND committed_prefix_digest IS NOT NULL
          AND length(committed_prefix_digest) = 71
          AND substr(committed_prefix_digest, 1, 7) = 'sha256:')
      ),
      CHECK (
        (requested_event_seq = 0
          AND requested_event_id IS NULL
          AND requested_prefix_digest IS NULL)
        OR
        (requested_event_seq > 0
          AND requested_event_id IS NOT NULL
          AND length(requested_event_id) > 0
          AND requested_prefix_digest IS NOT NULL
          AND length(requested_prefix_digest) = 71
          AND substr(requested_prefix_digest, 1, 7) = 'sha256:')
      )
    ) WITHOUT ROWID;

    CREATE INDEX memory_extraction_cursors_by_active_sweep
      ON memory_extraction_cursors(active_sweep_operation_id, session_id, run_id);
    `,
  ],
]);

interface MinimumTableShape {
  readonly name: string;
  readonly requiredColumns: readonly string[];
}

interface MinimumIndexShape {
  readonly name: string;
  readonly tableName: string;
  readonly requiredColumnPrefix: readonly string[];
}

interface MinimumSchemaShape {
  readonly tables: readonly MinimumTableShape[];
  readonly indexes: readonly MinimumIndexShape[];
}

// Each entry describes the complete minimum shape required by that schema version. Extra
// columns and indexes are allowed so additive migrations do not fail exact-DDL validation.
const MINIMUM_SCHEMA_SHAPES: ReadonlyMap<number, MinimumSchemaShape> = new Map([
  [
    1,
    {
      tables: [
        {
          name: 'memory_items',
          requiredColumns: [
            'item_id',
            'version',
            'content',
            'kind',
            'statement_type',
            'temporal_type',
            'scope_type',
            'scope_key',
            'event_started_at',
            'event_ended_at',
            'observed_at',
            'lifecycle_state',
            'origin',
            'content_hash',
            'created_at',
            'updated_at',
          ],
        },
        {
          name: 'memory_item_keys',
          requiredColumns: ['item_id', 'key_text', 'normalized_key', 'key_type', 'key_origin'],
        },
        {
          name: 'memory_item_sources',
          requiredColumns: ['item_id', 'session_id', 'run_id', 'turn_id', 'event_id'],
        },
        {
          name: 'memory_write_operations',
          requiredColumns: [
            'operation_id',
            'operation_type',
            'request_hash',
            'result_json',
            'committed_at',
          ],
        },
      ],
      indexes: [
        {
          name: 'memory_item_keys_by_normalized_key',
          tableName: 'memory_item_keys',
          requiredColumnPrefix: ['normalized_key', 'item_id'],
        },
      ],
    },
  ],
  [
    2,
    {
      tables: [
        {
          name: 'memory_items',
          requiredColumns: [
            'item_id',
            'version',
            'content',
            'kind',
            'statement_type',
            'temporal_type',
            'scope_type',
            'scope_key',
            'event_started_at',
            'event_ended_at',
            'observed_at',
            'lifecycle_state',
            'origin',
            'content_hash',
            'created_at',
            'updated_at',
          ],
        },
        {
          name: 'memory_item_keys',
          requiredColumns: ['item_id', 'key_text', 'normalized_key', 'key_type', 'key_origin'],
        },
        {
          name: 'memory_item_sources',
          requiredColumns: ['item_id', 'session_id', 'run_id', 'turn_id', 'event_id'],
        },
        {
          name: 'memory_write_operations',
          requiredColumns: [
            'operation_id',
            'operation_type',
            'request_hash',
            'result_json',
            'committed_at',
          ],
        },
        {
          name: 'memory_extraction_operations',
          requiredColumns: [
            'operation_id',
            'session_id',
            'mode',
            'trigger_kind',
            'internal_session_id',
            'session_create_fingerprint',
            'request_hash',
            'request_json',
            'trigger_epoch',
            'state',
            'attempt_count',
            'active_attempt_id',
            'lease_expires_at',
            'next_attempt_at',
            'last_error_code',
            'last_error_stage',
            'last_error_at',
            'last_failed_attempt_id',
            'started_at',
            'created_at',
            'updated_at',
            'completed_at',
            'result_type',
            'commit_hash',
            'result_json',
            'diagnostic_retention_until',
            'cleanup_state',
            'cleanup_claim_id',
            'cleanup_lease_expires_at',
            'cleanup_attempt_count',
            'cleanup_error_code',
            'cleaned_at',
          ],
        },
        {
          name: 'memory_extraction_attempts',
          requiredColumns: [
            'attempt_id',
            'operation_id',
            'attempt_ordinal',
            'state',
            'turn_id',
            'run_id',
            'snapshot_kind',
            'started_at',
            'completed_at',
            'failure_code',
            'failure_stage',
            'metrics_json',
          ],
        },
        {
          name: 'memory_extraction_operation_ranges',
          requiredColumns: [
            'operation_id',
            'range_ordinal',
            'session_id',
            'invocation_id',
            'run_id',
            'turn_id',
            'from_event_seq_exclusive',
            'from_event_id',
            'from_prefix_digest',
            'to_event_seq_inclusive',
            'to_event_id',
            'to_prefix_digest',
          ],
        },
        {
          name: 'memory_extraction_cursors',
          requiredColumns: [
            'session_id',
            'invocation_id',
            'run_id',
            'turn_id',
            'committed_event_seq',
            'committed_event_id',
            'committed_prefix_digest',
            'requested_event_seq',
            'requested_event_id',
            'requested_prefix_digest',
            'active_sweep_operation_id',
            'followup_eligible',
            'version',
            'created_at',
            'updated_at',
          ],
        },
      ],
      indexes: [
        {
          name: 'memory_item_keys_by_normalized_key',
          tableName: 'memory_item_keys',
          requiredColumnPrefix: ['normalized_key', 'item_id'],
        },
        {
          name: 'memory_extraction_operations_by_claim',
          tableName: 'memory_extraction_operations',
          requiredColumnPrefix: ['state', 'next_attempt_at', 'created_at', 'operation_id'],
        },
        {
          name: 'memory_extraction_operations_by_cleanup',
          tableName: 'memory_extraction_operations',
          requiredColumnPrefix: [
            'cleanup_state',
            'diagnostic_retention_until',
            'cleanup_lease_expires_at',
            'operation_id',
          ],
        },
        {
          name: 'memory_extraction_attempts_by_operation',
          tableName: 'memory_extraction_attempts',
          requiredColumnPrefix: ['operation_id', 'attempt_ordinal', 'attempt_id'],
        },
        {
          name: 'memory_extraction_operation_ranges_by_run',
          tableName: 'memory_extraction_operation_ranges',
          requiredColumnPrefix: ['session_id', 'run_id', 'operation_id'],
        },
        {
          name: 'memory_extraction_cursors_by_active_sweep',
          tableName: 'memory_extraction_cursors',
          requiredColumnPrefix: ['active_sweep_operation_id', 'session_id', 'run_id'],
        },
      ],
    },
  ],
]);

for (let version = 1; version <= SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION; version += 1) {
  if (!MIGRATIONS.has(version)) {
    throw new Error(`Missing long-term memory SQLite migration ${version}`);
  }
  if (!MINIMUM_SCHEMA_SHAPES.has(version)) {
    throw new Error(`Missing long-term memory SQLite minimum schema shape ${version}`);
  }
}

export function configureSqliteLongTermMemoryDatabase(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS}`);
  ensureWalJournalMode(db);
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function migrateSqliteLongTermMemoryDatabase(
  db: DatabaseSync,
  options: SqliteLongTermMemoryMigrationOptions = {},
): void {
  const observedVersion = readSqliteLongTermMemorySchemaVersion(db);
  if (observedVersion > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    throw newerSchemaError(observedVersion);
  }
  if (observedVersion === SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    validateMinimumSchemaShape(db, observedVersion);
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readSqliteLongTermMemorySchemaVersion(db);
    if (current > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) throw newerSchemaError(current);
    for (
      let version = current + 1;
      version <= SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION;
      version += 1
    ) {
      const sql = MIGRATIONS.get(version);
      if (!sql) throw new Error(`Missing long-term memory SQLite migration ${version}`);
      db.exec(sql);
      options.failpoint?.('after_schema_sql');
      db.exec(`PRAGMA user_version = ${version}`);
    }
    validateMinimumSchemaShape(db, SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export function assertSupportedSqliteLongTermMemorySchemaVersion(db: DatabaseSync): void {
  const observedVersion = readSqliteLongTermMemorySchemaVersion(db);
  if (observedVersion > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    throw newerSchemaError(observedVersion);
  }
}

export function readSqliteLongTermMemorySchemaVersion(db: DatabaseSync): number {
  return retryWhileSqliteBusy(() => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const value = row?.user_version;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid long-term memory SQLite schema version');
    }
    return value;
  });
}

function readJournalMode(db: DatabaseSync): string {
  return retryWhileSqliteBusy(() => {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
    if (typeof row?.journal_mode !== 'string') {
      throw new Error('Invalid long-term memory SQLite journal mode');
    }
    return row.journal_mode.toLowerCase();
  });
}

function ensureWalJournalMode(db: DatabaseSync): void {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    const journalMode = readJournalMode(db);
    if (journalMode === 'wal' || journalMode === 'memory') return;
    try {
      db.exec('PRAGMA journal_mode = WAL');
      const configuredMode = readJournalMode(db);
      if (configuredMode !== 'wal') {
        throw new Error(
          `Long-term memory SQLite requires WAL journal mode, received ${configuredMode}`,
        );
      }
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  return code === 'SQLITE_BUSY' || /database is locked/i.test(error.message);
}

function retryWhileSqliteBusy<T>(operation: () => T): T {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function newerSchemaError(version: number): Error {
  return new Error(
    `Long-term memory SQLite schema ${version} is newer than supported version ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION}`,
  );
}

function validateMinimumSchemaShape(db: DatabaseSync, version: number): void {
  const shape = MINIMUM_SCHEMA_SHAPES.get(version);
  if (!shape) {
    throw new Error(`Missing long-term memory SQLite minimum schema shape ${version}`);
  }

  const readSchemaObject = db.prepare('SELECT type, tbl_name FROM sqlite_schema WHERE name = ?');
  for (const table of shape.tables) {
    const object = readSchemaObject.get(table.name) as
      | { type?: unknown; tbl_name?: unknown }
      | undefined;
    if (object?.type !== 'table' || object.tbl_name !== table.name) {
      throw incompleteSchemaError(`missing required table ${table.name}`);
    }

    const columns = new Set(
      (
        db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table.name)})`).all() as Array<{
          name?: unknown;
        }>
      )
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string'),
    );
    for (const column of table.requiredColumns) {
      if (!columns.has(column)) {
        throw incompleteSchemaError(`table ${table.name} is missing required column ${column}`);
      }
    }
  }

  for (const index of shape.indexes) {
    const object = readSchemaObject.get(index.name) as
      | { type?: unknown; tbl_name?: unknown }
      | undefined;
    if (object?.type !== 'index' || object.tbl_name !== index.tableName) {
      throw incompleteSchemaError(`missing required index ${index.name}`);
    }

    const columns = (
      db.prepare(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`).all() as Array<{
        seqno?: unknown;
        name?: unknown;
      }>
    )
      .filter(
        (row): row is { seqno: number; name: string } =>
          typeof row.seqno === 'number' && typeof row.name === 'string',
      )
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (index.requiredColumnPrefix.some((column, position) => columns[position] !== column)) {
      throw incompleteSchemaError(`required index ${index.name} has incompatible columns`);
    }
  }
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function incompleteSchemaError(detail: string): Error {
  return new Error(`Incomplete long-term memory SQLite schema: ${detail}`);
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
