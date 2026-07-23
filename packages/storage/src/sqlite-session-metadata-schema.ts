import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_SESSION_METADATA_SCHEMA_VERSION = 1;

const MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [
    1,
    `
    CREATE TABLE session_metadata (
      session_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      last_message_at INTEGER,
      name TEXT NOT NULL,
      is_flagged INTEGER NOT NULL CHECK (is_flagged IN (0, 1)),
      is_archived INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
      status TEXT NOT NULL,
      status_updated_at INTEGER,
      parent_session_id TEXT,
      revision_root_session_id TEXT,
      revision_index INTEGER,
      has_unread INTEGER NOT NULL CHECK (has_unread IN (0, 1)),
      backend TEXT NOT NULL,
      llm_connection_slug TEXT NOT NULL,
      model TEXT NOT NULL,
      metadata_version INTEGER NOT NULL CHECK (metadata_version > 0),
      committed_at INTEGER NOT NULL
    );

    CREATE INDEX session_metadata_by_recency
      ON session_metadata(is_archived, last_message_at DESC, last_used_at DESC, session_id);

    CREATE INDEX session_metadata_by_flag
      ON session_metadata(is_flagged, is_archived, session_id);

    CREATE INDEX session_metadata_by_status
      ON session_metadata(status, status_updated_at DESC, session_id);

    CREATE INDEX session_metadata_by_parent
      ON session_metadata(parent_session_id, session_id);

    CREATE INDEX session_metadata_by_revision
      ON session_metadata(revision_root_session_id, revision_index, session_id);

    CREATE TABLE session_metadata_labels (
      session_id TEXT NOT NULL,
      label_index INTEGER NOT NULL CHECK (label_index >= 0),
      label TEXT NOT NULL,
      PRIMARY KEY(session_id, label_index),
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );

    CREATE INDEX session_metadata_labels_by_label
      ON session_metadata_labels(label, session_id);

    CREATE TABLE session_metadata_import_sources (
      source_path TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      session_id TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );
  `,
  ],
]);

export function configureSqliteSessionMetadataDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

export function migrateSqliteSessionMetadataDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_metadata_schema (
      scope TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 0)
    )
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readSqliteSessionMetadataSchemaVersion(db);
    if (current > SQLITE_SESSION_METADATA_SCHEMA_VERSION) {
      throw new Error(
        `SQLite session metadata schema ${current} is newer than supported version ${SQLITE_SESSION_METADATA_SCHEMA_VERSION}`,
      );
    }
    for (
      let version = current + 1;
      version <= SQLITE_SESSION_METADATA_SCHEMA_VERSION;
      version += 1
    ) {
      const sql = MIGRATIONS.get(version);
      if (!sql) throw new Error(`Missing SQLite session metadata migration ${version}`);
      db.exec(sql);
      db.prepare(`
        INSERT INTO session_metadata_schema(scope, version)
        VALUES ('session_metadata', ?)
        ON CONFLICT(scope) DO UPDATE SET version = excluded.version
      `).run(version);
    }
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export function readSqliteSessionMetadataSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare(`
      SELECT version
      FROM session_metadata_schema
      WHERE scope = 'session_metadata'
    `)
    .get() as { version?: unknown } | undefined;
  if (!row) return 0;
  const value = row.version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid SQLite session metadata schema version');
  }
  return value;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
