import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionHeader, SessionListFilter } from '@maka/core';
import { assertSafeSessionId, normalizeSessionHeader } from './session-store.js';
import {
  configureSqliteSessionMetadataDatabase,
  migrateSqliteSessionMetadataDatabase,
  readSqliteSessionMetadataSchemaVersion,
} from './sqlite-session-metadata-schema.js';

export { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from './sqlite-session-metadata-schema.js';

const require = createRequire(import.meta.url);

function loadSqliteModule(): typeof import('node:sqlite') {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningType = typeof args[0] === 'string' ? args[0] : undefined;
    if (
      warningType === 'ExperimentalWarning' &&
      String(warning).startsWith('SQLite is an experimental feature')
    ) {
      return;
    }
    Reflect.apply(emitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

export type SqliteSessionMetadataStoreFailpoint =
  | 'after_session_row_write'
  | 'after_session_labels_write'
  | 'after_session_import_marker_write';

export interface SqliteSessionMetadataStoreOptions {
  now?: () => number;
  failpoint?: (point: SqliteSessionMetadataStoreFailpoint) => void;
}

export interface SessionMetadataRecord {
  header: SessionHeader;
  metadataVersion: number;
  committedAt: number;
}

export interface SessionMetadataImportEntry {
  header: SessionHeader;
  source: {
    path: string;
    fingerprint: string;
  };
}

export interface SessionMetadataImportResult {
  created: boolean[];
  sourcesAlreadyImported: number;
  sourcesTombstoned: number;
}

export class SessionMetadataConflictError extends Error {
  readonly name = 'SessionMetadataConflictError';
}

export function createSqliteSessionMetadataStore(
  path: string,
  options: SqliteSessionMetadataStoreOptions = {},
): SqliteSessionMetadataStore {
  return new SqliteSessionMetadataStore(path, options);
}

export class SqliteSessionMetadataStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly options: SqliteSessionMetadataStoreOptions = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = loadSqliteModule();
    this.db = new DatabaseSync(path);
    configureSqliteSessionMetadataDatabase(this.db);
    migrateSqliteSessionMetadataDatabase(this.db);
    this.now = options.now ?? Date.now;
  }

  schemaVersion(): number {
    this.assertOpen();
    return readSqliteSessionMetadataSchemaVersion(this.db);
  }

  journalMode(): string {
    this.assertOpen();
    const row = this.db.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async backup(destinationPath: string): Promise<number> {
    this.assertOpen();
    if (!destinationPath) throw new Error('Session metadata backup destination is required');
    if (this.path !== ':memory:' && resolve(destinationPath) === resolve(this.path)) {
      throw new Error('Session metadata backup destination must differ from the source database');
    }
    if (existsSync(destinationPath)) {
      throw new Error(`Session metadata backup destination already exists: ${destinationPath}`);
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    return loadSqliteModule().backup(this.db, destinationPath);
  }

  async create(header: SessionHeader): Promise<SessionMetadataRecord> {
    this.assertOpen();
    const normalized = normalizeSessionHeader(header);
    assertSafeSessionId(normalized.id);
    return this.transaction(() => {
      if (this.hasTombstone(normalized.id)) {
        throw new SessionMetadataConflictError(
          `Session metadata id is tombstoned: ${normalized.id}`,
        );
      }
      if (this.readRecordSync(normalized.id)) {
        throw new SessionMetadataConflictError(`Session metadata already exists: ${normalized.id}`);
      }
      return this.insertHeader(normalized, 1, this.now());
    });
  }

  async read(sessionId: string): Promise<SessionMetadataRecord> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    const record = this.readRecordSync(sessionId);
    if (!record) throw new Error(`Session metadata not found: ${sessionId}`);
    return record;
  }

  async has(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.readRecordSync(sessionId) !== undefined;
  }

  async isTombstoned(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.hasTombstone(sessionId);
  }

  async list(filter: SessionListFilter = {}): Promise<SessionMetadataRecord[]> {
    this.assertOpen();
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter.isArchived !== undefined) {
      where.push('metadata.is_archived = ?');
      parameters.push(filter.isArchived ? 1 : 0);
    }
    if (filter.isFlagged !== undefined) {
      where.push('metadata.is_flagged = ?');
      parameters.push(filter.isFlagged ? 1 : 0);
    }
    if (filter.labelSlug !== undefined) {
      where.push(`
        EXISTS (
          SELECT 1
          FROM session_metadata_labels labels
          WHERE labels.session_id = metadata.session_id
            AND labels.label = ?
        )
      `);
      parameters.push(filter.labelSlug);
    }
    const rows = this.db
      .prepare(`
        SELECT session_id, payload_json, metadata_version, committed_at
        FROM session_metadata metadata
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY
          COALESCE(last_message_at, last_used_at, created_at) DESC,
          session_id ASC
      `)
      .all(...parameters) as unknown as SessionMetadataRow[];
    return rows.map(decodeRecord);
  }

  async update(
    sessionId: string,
    patch: Partial<SessionHeader>,
    options: { expectedVersion?: number } = {},
  ): Promise<SessionMetadataRecord> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const current = this.readRecordSync(sessionId);
      if (!current) throw new Error(`Session metadata not found: ${sessionId}`);
      if (
        options.expectedVersion !== undefined &&
        options.expectedVersion !== current.metadataVersion
      ) {
        throw new SessionMetadataConflictError(
          `Session metadata version conflict for ${sessionId}: expected ${options.expectedVersion}, found ${current.metadataVersion}`,
        );
      }
      const next = normalizeSessionHeader({ ...current.header, ...patch }, sessionId);
      if (next.id !== sessionId) {
        throw new SessionMetadataConflictError('Session metadata identity cannot be changed');
      }
      const metadataVersion = current.metadataVersion + 1;
      const committedAt = this.now();
      const updated = this.db
        .prepare(`
          UPDATE session_metadata
          SET
            payload_json = ?,
            created_at = ?,
            last_used_at = ?,
            last_message_at = ?,
            name = ?,
            is_flagged = ?,
            is_archived = ?,
            status = ?,
            status_updated_at = ?,
            parent_session_id = ?,
            revision_root_session_id = ?,
            revision_index = ?,
            has_unread = ?,
            backend = ?,
            llm_connection_slug = ?,
            model = ?,
            metadata_version = ?,
            committed_at = ?
          WHERE session_id = ? AND metadata_version = ?
        `)
        .run(
          JSON.stringify(next),
          next.createdAt,
          next.lastUsedAt,
          next.lastMessageAt ?? null,
          next.name,
          booleanInteger(next.isFlagged),
          booleanInteger(next.isArchived),
          next.status,
          next.statusUpdatedAt ?? null,
          next.parentSessionId ?? null,
          next.revisionRootSessionId ?? null,
          next.revisionIndex ?? null,
          booleanInteger(next.hasUnread),
          next.backend,
          next.llmConnectionSlug,
          next.model,
          metadataVersion,
          committedAt,
          sessionId,
          current.metadataVersion,
        );
      if (updated.changes !== 1) {
        throw new SessionMetadataConflictError(
          `Session metadata compare-and-set failed: ${sessionId}`,
        );
      }
      this.options.failpoint?.('after_session_row_write');
      this.replaceLabels(next);
      this.options.failpoint?.('after_session_labels_write');
      return { header: next, metadataVersion, committedAt };
    });
  }

  async remove(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const deleted =
        this.db.prepare('DELETE FROM session_metadata WHERE session_id = ?').run(sessionId)
          .changes === 1;
      this.db
        .prepare(`
          INSERT INTO session_metadata_tombstones(session_id, deleted_at)
          VALUES (?, ?)
          ON CONFLICT(session_id) DO NOTHING
        `)
        .run(sessionId, this.now());
      return deleted;
    });
  }

  async importEntries(
    entries: readonly SessionMetadataImportEntry[],
  ): Promise<SessionMetadataImportResult> {
    this.assertOpen();
    const sourcePaths = new Set<string>();
    const normalized = entries.map((entry) => {
      const header = normalizeSessionHeader(entry.header);
      assertSafeSessionId(header.id);
      if (!entry.source.path || !entry.source.fingerprint) {
        throw new Error(`Invalid session metadata import source for ${header.id}`);
      }
      if (sourcePaths.has(entry.source.path)) {
        throw new Error(`Duplicate session metadata import source: ${entry.source.path}`);
      }
      sourcePaths.add(entry.source.path);
      return { header, source: entry.source };
    });
    return this.transaction(() => {
      const created: boolean[] = [];
      let sourcesAlreadyImported = 0;
      let sourcesTombstoned = 0;
      for (const entry of normalized) {
        if (this.hasTombstone(entry.header.id)) {
          sourcesTombstoned += 1;
          continue;
        }
        const source = this.db
          .prepare(`
            SELECT fingerprint
            FROM session_metadata_import_sources
            WHERE source_path = ?
          `)
          .get(entry.source.path) as { fingerprint: string } | undefined;
        if (source?.fingerprint === entry.source.fingerprint) {
          const existing = this.readRecordSync(entry.header.id);
          if (!existing) {
            throw new SessionMetadataConflictError(
              `Imported session metadata is missing: ${entry.header.id}`,
            );
          }
          sourcesAlreadyImported += 1;
          continue;
        }
        const existing = this.readRecordSync(entry.header.id);
        if (existing) {
          if (!isDeepStrictEqual(existing.header, entry.header)) {
            throw new SessionMetadataConflictError(
              `Session metadata import conflict for ${entry.header.id}`,
            );
          }
          created.push(false);
        } else {
          this.insertHeader(entry.header, 1, this.now());
          created.push(true);
        }
        this.db
          .prepare(`
            INSERT INTO session_metadata_import_sources(
              source_path, fingerprint, session_id, imported_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(source_path) DO UPDATE SET
              fingerprint = excluded.fingerprint,
              session_id = excluded.session_id,
              imported_at = excluded.imported_at
          `)
          .run(entry.source.path, entry.source.fingerprint, entry.header.id, this.now());
        this.options.failpoint?.('after_session_import_marker_write');
      }
      return { created, sourcesAlreadyImported, sourcesTombstoned };
    });
  }

  private insertHeader(
    header: SessionHeader,
    metadataVersion: number,
    committedAt: number,
  ): SessionMetadataRecord {
    this.db
      .prepare(`
        INSERT INTO session_metadata(
          session_id,
          payload_json,
          created_at,
          last_used_at,
          last_message_at,
          name,
          is_flagged,
          is_archived,
          status,
          status_updated_at,
          parent_session_id,
          revision_root_session_id,
          revision_index,
          has_unread,
          backend,
          llm_connection_slug,
          model,
          metadata_version,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        header.id,
        JSON.stringify(header),
        header.createdAt,
        header.lastUsedAt,
        header.lastMessageAt ?? null,
        header.name,
        booleanInteger(header.isFlagged),
        booleanInteger(header.isArchived),
        header.status,
        header.statusUpdatedAt ?? null,
        header.parentSessionId ?? null,
        header.revisionRootSessionId ?? null,
        header.revisionIndex ?? null,
        booleanInteger(header.hasUnread),
        header.backend,
        header.llmConnectionSlug,
        header.model,
        metadataVersion,
        committedAt,
      );
    this.options.failpoint?.('after_session_row_write');
    this.replaceLabels(header);
    this.options.failpoint?.('after_session_labels_write');
    return { header, metadataVersion, committedAt };
  }

  private replaceLabels(header: SessionHeader): void {
    this.db.prepare('DELETE FROM session_metadata_labels WHERE session_id = ?').run(header.id);
    const insert = this.db.prepare(`
      INSERT INTO session_metadata_labels(session_id, label_index, label)
      VALUES (?, ?, ?)
    `);
    for (let index = 0; index < header.labels.length; index += 1) {
      insert.run(header.id, index, header.labels[index]!);
    }
  }

  private readRecordSync(sessionId: string): SessionMetadataRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT session_id, payload_json, metadata_version, committed_at
        FROM session_metadata
        WHERE session_id = ?
      `)
      .get(sessionId) as SessionMetadataRow | undefined;
    return row ? decodeRecord(row) : undefined;
  }

  private hasTombstone(sessionId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS found FROM session_metadata_tombstones WHERE session_id = ?')
        .get(sessionId) !== undefined
    );
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original storage or protocol failure.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite session metadata store is closed');
  }
}

interface SessionMetadataRow {
  session_id: string;
  payload_json: string;
  metadata_version: number;
  committed_at: number;
}

function decodeRecord(row: SessionMetadataRow): SessionMetadataRecord {
  const parsed = JSON.parse(row.payload_json) as SessionHeader;
  if (
    !Number.isSafeInteger(row.metadata_version) ||
    row.metadata_version < 1 ||
    !Number.isFinite(row.committed_at)
  ) {
    throw new Error(`Invalid SQLite session metadata record for ${row.session_id}`);
  }
  return {
    header: normalizeSessionHeader(parsed, row.session_id),
    metadataVersion: row.metadata_version,
    committedAt: row.committed_at,
  };
}

function booleanInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
