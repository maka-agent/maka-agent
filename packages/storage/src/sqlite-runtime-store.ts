import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
  type RuntimeEvent,
  type RuntimeEventStore,
  type ToolRecoveryMode,
} from '@maka/core';
import {
  configureSqliteRuntimeDatabase,
  migrateSqliteRuntimeDatabase,
  readUserVersion,
} from './sqlite-runtime-schema.js';

export { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';

export type { ToolRecoveryMode } from '@maka/core';

const require = createRequire(import.meta.url);

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

export type ToolJournalState = 'prepared' | 'outcome_committed';

export type SqliteRuntimeStoreFailpoint =
  | 'after_runtime_event_insert'
  | 'after_journal_event_insert';

export interface SqliteRuntimeStoreOptions {
  failpoint?: (point: SqliteRuntimeStoreFailpoint) => void;
}

export interface CommitToolPreparedInput {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  dispatchRuntimeEvent: RuntimeEvent;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  committedAt: number;
}

export interface CommitToolOutcomeInput {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  committedAt: number;
}

export interface ToolCommitResult {
  created: boolean;
  runtimeEventSeq: number;
}

export interface RuntimeEventBatchImportResult {
  created: boolean[];
  sourceAlreadyImported: boolean;
}

export interface ToolProjectionRebuildResult {
  operations: number;
  journalEvents: number;
}

export interface ToolOperationRecord {
  operationId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  currentState: 'prepared' | 'outcome_committed';
  callEventId: string;
  dispatchEventId?: string;
  resultEventId?: string;
  version: number;
}

export interface ToolJournalEventRecord {
  journalEventId: string;
  operationId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  state: ToolJournalState;
  runtimeEventId?: string;
  canonicalArgsHash?: string;
  recoveryMode?: ToolRecoveryMode;
  externalHandle?: string;
  metadata?: unknown;
  committedAt: number;
}

export function createSqliteRuntimeStore(
  path: string,
  options: SqliteRuntimeStoreOptions = {},
): SqliteRuntimeStore {
  return new SqliteRuntimeStore(path, options);
}

export class SqliteRuntimeStore implements RuntimeEventStore {
  readonly durability = 'canonical' as const;
  readonly toolBoundaryProtocol = 't1_after_preflight_v1' as const;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(
    path: string,
    private readonly options: SqliteRuntimeStoreOptions = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(path);
    configureSqliteRuntimeDatabase(this.db);
    migrateSqliteRuntimeDatabase(this.db);
  }

  schemaVersion(): number {
    return readUserVersion(this.db);
  }

  journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
  }

  foreignKeysEnabled(): boolean {
    const row = this.db.prepare('PRAGMA foreign_keys').get() as
      | { foreign_keys?: unknown }
      | undefined;
    return row?.foreign_keys === 1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    await this.importRuntimeEvent(sessionId, runId, event);
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    if (isPartialRuntimeEvent(event) || !isTerminalRuntimeEvent(event)) {
      throw new Error(
        'Only a final terminal RuntimeEvent can cross the terminal durability barrier',
      );
    }
    const existing = await this.readImmutableRuntimeEvents(sessionId, runId);
    const matching = existing.filter((candidate) => candidate.id === event.id);
    if (matching.length > 1) {
      throw new Error(`RuntimeEvent ${event.id} appears more than once in run ${runId}`);
    }
    if (matching.length === 1) {
      if (!isDeepStrictEqual(matching[0], event)) {
        throw new Error(`RuntimeEvent ${event.id} does not match the durable ledger record`);
      }
      return;
    }
    const existingTerminal = existing.find(isTerminalRuntimeEvent);
    if (existingTerminal) {
      throw new Error(`Run ${runId} already has terminal RuntimeEvent ${existingTerminal.id}`);
    }
    await this.importRuntimeEvent(sessionId, runId, event);
  }

  async importRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<boolean> {
    if (sessionId !== event.sessionId || runId !== event.runId) {
      throw new Error(`RuntimeEvent store identity does not match event ${event.id}`);
    }
    return this.transaction(() => this.importRuntimeEventSync(event));
  }

  async importRuntimeEventsBatch(input: {
    sessionId: string;
    runId: string;
    events: readonly RuntimeEvent[];
    source?: { path: string; fingerprint: string };
  }): Promise<RuntimeEventBatchImportResult> {
    for (const event of input.events) {
      if (event.sessionId !== input.sessionId || event.runId !== input.runId) {
        throw new Error(`RuntimeEvent store identity does not match event ${event.id}`);
      }
    }
    return this.transaction(() => {
      if (input.source) {
        const existing = this.db
          .prepare(`
          SELECT fingerprint FROM runtime_import_sources WHERE source_path = ?
        `)
          .get(input.source.path) as { fingerprint: string } | undefined;
        if (existing?.fingerprint === input.source.fingerprint) {
          return { created: [], sourceAlreadyImported: true };
        }
      }
      const created = input.events.map((event) => this.importRuntimeEventSync(event));
      if (input.source) {
        this.db
          .prepare(`
          INSERT INTO runtime_import_sources (source_path, fingerprint, imported_at)
          VALUES (?, ?, ?)
          ON CONFLICT(source_path) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            imported_at = excluded.imported_at
        `)
          .run(input.source.path, input.source.fingerprint, Date.now());
      }
      return { created, sourceAlreadyImported: false };
    });
  }

  async isRuntimeImportSourceCurrent(path: string, fingerprint: string): Promise<boolean> {
    const existing = this.db
      .prepare(`
      SELECT fingerprint FROM runtime_import_sources WHERE source_path = ?
    `)
      .get(path) as { fingerprint: string } | undefined;
    return existing?.fingerprint === fingerprint;
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    const immutable = await this.readImmutableRuntimeEvents(sessionId, runId);
    const partials = this.db
      .prepare(`
      SELECT payload_json, text_content, after_event_id
      FROM runtime_partial_snapshots
      WHERE session_id = ? AND run_id = ?
      ORDER BY updated_at ASC, stream_key ASC
    `)
      .all(sessionId, runId) as Array<{
      payload_json: string;
      text_content: string;
      after_event_id: string | null;
    }>;
    return mergeRuntimePartialSnapshots(
      immutable,
      partials.map((row) => {
        const event = JSON.parse(row.payload_json) as RuntimeEvent;
        if (event.content?.kind === 'text' || event.content?.kind === 'thinking') {
          event.content = { ...event.content, text: row.text_content };
        }
        return {
          event,
          ...(row.after_event_id ? { afterEventId: row.after_event_id } : {}),
        };
      }),
    );
  }

  async readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    const rows = this.db
      .prepare(`
      SELECT payload_json
      FROM runtime_events
      WHERE session_id = ? AND run_id = ?
      ORDER BY event_seq ASC, event_id ASC
    `)
      .all(sessionId, runId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RuntimeEvent);
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const rows = this.db
      .prepare(`
      SELECT run_id FROM runtime_events WHERE session_id = ?
      UNION
      SELECT run_id FROM runtime_partial_snapshots WHERE session_id = ?
      ORDER BY run_id ASC
    `)
      .all(sessionId, sessionId) as Array<{ run_id: string }>;
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const row of rows) {
      const events = await this.readRuntimeEvents(sessionId, row.run_id);
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        ordered.push({ event: events[eventIndex]!, runId: row.run_id, eventIndex });
      }
    }
    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runId.localeCompare(b.runId) ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
    );
    return ordered.map((item) => item.event);
  }

  async commitToolPrepared(input: CommitToolPreparedInput): Promise<ToolCommitResult> {
    assertPreparedInput(input);
    return this.transaction(() => {
      const existing = this.readToolOperationSync(input.operationId);
      if (existing) {
        assertPreparedIdentity(existing, input);
        assertStoredRuntimeEventEquals(
          input.runtimeEvent,
          this.readRuntimeEventJson(input.runtimeEvent.id),
        );
        assertStoredRuntimeEventEquals(
          input.dispatchRuntimeEvent,
          this.readRuntimeEventJson(input.dispatchRuntimeEvent.id),
        );
        return {
          created: false,
          runtimeEventSeq: this.runtimeEventSeq(input.dispatchRuntimeEvent.id),
        };
      }
      this.insertRuntimeEvent(input.runtimeEvent, input.committedAt, true);
      const runtimeEventSeq = this.insertRuntimeEvent(
        input.dispatchRuntimeEvent,
        input.committedAt,
        false,
      );
      this.options.failpoint?.('after_runtime_event_insert');
      this.db
        .prepare(`
        INSERT INTO tool_journal_events (
          journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
          runtime_event_id, canonical_args_hash, recovery_mode, committed_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)
      `)
        .run(
          input.journalEventId,
          input.operationId,
          input.runtimeEvent.invocationId,
          input.runtimeEvent.runId,
          input.runtimeEvent.turnId,
          input.dispatchRuntimeEvent.id,
          input.canonicalArgsHash,
          input.recoveryMode,
          input.committedAt,
        );
      this.options.failpoint?.('after_journal_event_insert');
      this.db
        .prepare(`
        INSERT INTO tool_operations (
          operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
          tool_name, canonical_args_hash, recovery_mode, current_state,
          call_event_id, dispatch_event_id, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, 1)
      `)
        .run(
          input.operationId,
          input.runtimeEvent.invocationId,
          input.runtimeEvent.runId,
          input.runtimeEvent.turnId,
          input.providerToolCallId,
          input.toolName,
          input.canonicalArgsHash,
          input.recoveryMode,
          input.runtimeEvent.id,
          input.dispatchRuntimeEvent.id,
        );
      return { created: true, runtimeEventSeq };
    });
  }

  async commitToolOutcome(input: CommitToolOutcomeInput): Promise<ToolCommitResult> {
    assertOutcomeInput(input);
    return this.transaction(() => {
      const operation = this.readToolOperationSync(input.operationId);
      if (!operation) throw new Error(`Unknown tool operation ${input.operationId}`);
      assertOutcomeIdentity(operation, input.runtimeEvent);
      if (operation.resultEventId) {
        if (operation.resultEventId !== input.runtimeEvent.id) {
          throw new Error(`Tool operation outcome conflict for ${input.operationId}`);
        }
        assertStoredRuntimeEventEquals(
          input.runtimeEvent,
          this.readRuntimeEventJson(input.runtimeEvent.id),
        );
        return { created: false, runtimeEventSeq: this.runtimeEventSeq(input.runtimeEvent.id) };
      }
      const runtimeEventSeq = this.insertRuntimeEvent(input.runtimeEvent, input.committedAt, false);
      this.options.failpoint?.('after_runtime_event_insert');
      this.db
        .prepare(`
        INSERT INTO tool_journal_events (
          journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
          runtime_event_id, canonical_args_hash, recovery_mode, committed_at
        ) VALUES (?, ?, ?, ?, ?, 'outcome_committed', ?, ?, ?, ?)
      `)
        .run(
          input.journalEventId,
          input.operationId,
          operation.invocationId,
          operation.runId,
          operation.turnId,
          input.runtimeEvent.id,
          operation.canonicalArgsHash,
          operation.recoveryMode,
          input.committedAt,
        );
      this.options.failpoint?.('after_journal_event_insert');
      const updated = this.db
        .prepare(`
        UPDATE tool_operations
        SET current_state = 'outcome_committed', result_event_id = ?, version = version + 1
        WHERE operation_id = ? AND current_state = 'prepared' AND result_event_id IS NULL
      `)
        .run(input.runtimeEvent.id, input.operationId);
      if (updated.changes !== 1) {
        throw new Error(`Tool operation compare-and-set failed for ${input.operationId}`);
      }
      return { created: true, runtimeEventSeq };
    });
  }

  async readToolOperation(operationId: string): Promise<ToolOperationRecord | undefined> {
    return this.readToolOperationSync(operationId);
  }

  async listUnsettledToolOperations(): Promise<ToolOperationRecord[]> {
    const rows = this.db
      .prepare(`
      SELECT operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
        tool_name, canonical_args_hash, recovery_mode, current_state,
        call_event_id, dispatch_event_id, result_event_id, version
      FROM tool_operations
      WHERE current_state = 'prepared' AND result_event_id IS NULL
      ORDER BY invocation_id ASC, operation_id ASC
    `)
      .all() as unknown as ToolOperationRow[];
    return rows.map(toolOperationFromRow);
  }

  async readToolJournal(operationId: string): Promise<ToolJournalEventRecord[]> {
    const rows = this.db
      .prepare(`
      SELECT journal_event_id, operation_id, invocation_id, run_id, turn_id,
        state, runtime_event_id, canonical_args_hash, recovery_mode,
        external_handle, metadata_json, committed_at
      FROM tool_journal_events
      WHERE operation_id = ?
      ORDER BY journal_seq ASC
    `)
      .all(operationId) as unknown as ToolJournalRow[];
    return rows.map(toolJournalRecordFromRow);
  }

  async rebuildToolProjectionsFromRuntimeEvents(): Promise<ToolProjectionRebuildResult> {
    return this.transaction(() => {
      const legacy = this.db
        .prepare(`
        SELECT operation_id FROM tool_operations
        WHERE dispatch_event_id IS NULL
        LIMIT 1
      `)
        .get() as { operation_id: string } | undefined;
      if (legacy) {
        throw new Error(
          `Cannot rebuild legacy tool operation ${legacy.operation_id} without a dispatch RuntimeEvent`,
        );
      }
      const events = (
        this.db
          .prepare(`
        SELECT payload_json FROM runtime_events
        ORDER BY invocation_id ASC, event_seq ASC, event_id ASC
      `)
          .all() as Array<{ payload_json: string }>
      ).map((row) => JSON.parse(row.payload_json) as RuntimeEvent);
      const calls = new Map<string, RuntimeEvent>();
      const dispatches: Array<{
        event: RuntimeEvent;
        call: RuntimeEvent;
        dispatch: NonNullable<NonNullable<RuntimeEvent['actions']>['toolDispatch']>;
      }> = [];
      const responses = new Map<string, RuntimeEvent>();

      for (const event of events) {
        if (event.partial) continue;
        if (event.content?.kind === 'function_call') {
          calls.set(toolCallProjectionKey(event.invocationId, event.content.id), event);
          continue;
        }
        const dispatch = event.actions?.toolDispatch;
        if (dispatch) {
          const call = calls.get(
            toolCallProjectionKey(event.invocationId, dispatch.providerToolCallId),
          );
          if (
            !call ||
            call.content?.kind !== 'function_call' ||
            call.content.name !== dispatch.toolName ||
            event.refs?.operationId !== dispatch.operationId ||
            event.refs?.toolCallId !== dispatch.providerToolCallId
          ) {
            throw new Error(`Corrupt tool dispatch RuntimeEvent ${event.id}`);
          }
          dispatches.push({ event, call, dispatch });
          continue;
        }
        if (event.content?.kind === 'function_response' && event.refs?.operationId) {
          const previous = responses.get(event.refs.operationId);
          if (previous && !isDeepStrictEqual(previous, event)) {
            throw new Error(`Conflicting tool response for ${event.refs.operationId}`);
          }
          responses.set(event.refs.operationId, event);
        }
      }

      this.db.exec('DELETE FROM tool_journal_events; DELETE FROM tool_operations;');
      let journalEvents = 0;
      for (const { event, call, dispatch } of dispatches) {
        this.db
          .prepare(`
          INSERT INTO tool_journal_events (
            journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
            runtime_event_id, canonical_args_hash, recovery_mode, committed_at
          ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)
        `)
          .run(
            `${dispatch.operationId}_prepared`,
            dispatch.operationId,
            event.invocationId,
            event.runId,
            event.turnId,
            event.id,
            dispatch.canonicalArgsHash,
            dispatch.recoveryMode,
            event.ts,
          );
        journalEvents += 1;
        const response = responses.get(dispatch.operationId);
        if (
          response &&
          (response.content?.kind !== 'function_response' ||
            response.invocationId !== event.invocationId ||
            response.runId !== event.runId ||
            response.turnId !== event.turnId ||
            response.content.id !== dispatch.providerToolCallId ||
            response.content.name !== dispatch.toolName ||
            response.refs?.toolCallId !== dispatch.providerToolCallId)
        ) {
          throw new Error(`Corrupt tool response RuntimeEvent ${response.id}`);
        }
        this.db
          .prepare(`
          INSERT INTO tool_operations (
            operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
            tool_name, canonical_args_hash, recovery_mode, current_state,
            call_event_id, dispatch_event_id, result_event_id, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            dispatch.operationId,
            event.invocationId,
            event.runId,
            event.turnId,
            dispatch.providerToolCallId,
            dispatch.toolName,
            dispatch.canonicalArgsHash,
            dispatch.recoveryMode,
            response ? 'outcome_committed' : 'prepared',
            call.id,
            event.id,
            response?.id ?? null,
            response ? 2 : 1,
          );
        if (response) {
          this.db
            .prepare(`
            INSERT INTO tool_journal_events (
              journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
              runtime_event_id, canonical_args_hash, recovery_mode, committed_at
            ) VALUES (?, ?, ?, ?, ?, 'outcome_committed', ?, ?, ?, ?)
          `)
            .run(
              `${dispatch.operationId}_outcome`,
              dispatch.operationId,
              response.invocationId,
              response.runId,
              response.turnId,
              response.id,
              dispatch.canonicalArgsHash,
              dispatch.recoveryMode,
              response.ts,
            );
          journalEvents += 1;
        }
      }
      return { operations: dispatches.length, journalEvents };
    });
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
        // Preserve the protocol failure that caused rollback.
      }
      throw error;
    }
  }

  private importRuntimeEventSync(event: RuntimeEvent): boolean {
    const partial = partialRuntimeStream(event);
    if (partial) return this.upsertRuntimePartial(event, partial);
    const existing = this.readRuntimeEventJson(event.id) !== undefined;
    this.insertRuntimeEvent(event, event.ts, true);
    return !existing;
  }

  private insertRuntimeEvent(
    event: RuntimeEvent,
    committedAt: number,
    allowExactDuplicate: boolean,
  ): number {
    assertRuntimeEventIdentity(event);
    const existingJson = this.readRuntimeEventJson(event.id);
    if (existingJson !== undefined) {
      assertStoredRuntimeEventEquals(event, existingJson);
      this.deleteCompletedPartialSnapshot(event);
      if (!allowExactDuplicate) {
        throw new Error(`RuntimeEvent ${event.id} already exists outside this tool transaction`);
      }
      return this.runtimeEventSeq(event.id);
    }
    const next = this.nextRuntimeEventSeq(event.invocationId);
    this.db
      .prepare(`
      INSERT INTO runtime_events (
        event_id, session_id, invocation_id, run_id, turn_id, event_seq,
        event_kind, payload_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        event.id,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        next,
        runtimeEventKind(event),
        JSON.stringify(event),
        committedAt,
      );
    this.deleteCompletedPartialSnapshot(event);
    return next;
  }

  private deleteCompletedPartialSnapshot(event: RuntimeEvent): void {
    const completedPartialKey = completedPartialRuntimeStreamKey(event);
    if (!completedPartialKey) return;
    this.db
      .prepare('DELETE FROM runtime_partial_snapshots WHERE stream_key = ?')
      .run(completedPartialKey);
  }

  private upsertRuntimePartial(
    event: RuntimeEvent,
    partial: { key: string; snapshot: RuntimeEvent; text: string },
  ): boolean {
    const existing = this.db
      .prepare(`
      SELECT 1 AS found FROM runtime_partial_snapshots WHERE stream_key = ?
    `)
      .get(partial.key) as { found: number } | undefined;
    if (!existing && this.hasCompletedPartialStream(event.sessionId, event.runId, partial.key)) {
      return false;
    }
    const anchor = existing
      ? undefined
      : (this.db
          .prepare(`
      SELECT event_id FROM runtime_events
      WHERE session_id = ? AND run_id = ?
      ORDER BY event_seq DESC LIMIT 1
    `)
          .get(event.sessionId, event.runId) as { event_id: string } | undefined);
    this.db
      .prepare(`
      INSERT INTO runtime_partial_snapshots (
        stream_key, session_id, invocation_id, run_id, turn_id,
        after_event_id, payload_json, text_content, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream_key) DO UPDATE SET
        text_content = runtime_partial_snapshots.text_content || excluded.text_content,
        updated_at = excluded.updated_at
    `)
      .run(
        partial.key,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        anchor?.event_id ?? null,
        JSON.stringify(partial.snapshot),
        partial.text,
        event.ts,
      );
    return !existing;
  }

  private hasCompletedPartialStream(sessionId: string, runId: string, streamKey: string): boolean {
    const rows = this.db
      .prepare(`
      SELECT payload_json FROM runtime_events WHERE session_id = ? AND run_id = ?
    `)
      .all(sessionId, runId) as Array<{ payload_json: string }>;
    return rows.some(
      (row) =>
        completedPartialRuntimeStreamKey(JSON.parse(row.payload_json) as RuntimeEvent) ===
        streamKey,
    );
  }

  private nextRuntimeEventSeq(invocationId: string): number {
    const row = this.db
      .prepare(`
      SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq
      FROM runtime_events
      WHERE invocation_id = ?
    `)
      .get(invocationId) as { next_seq: number };
    return row.next_seq;
  }

  private runtimeEventSeq(eventId: string): number {
    const row = this.db
      .prepare(`
      SELECT event_seq FROM runtime_events WHERE event_id = ?
    `)
      .get(eventId) as { event_seq: number } | undefined;
    if (!row) throw new Error(`Missing RuntimeEvent ${eventId}`);
    return row.event_seq;
  }

  private readRuntimeEventJson(eventId: string): string | undefined {
    const row = this.db
      .prepare(`
      SELECT payload_json FROM runtime_events WHERE event_id = ?
    `)
      .get(eventId) as { payload_json: string } | undefined;
    return row?.payload_json;
  }

  private readToolOperationSync(operationId: string): ToolOperationRecord | undefined {
    const row = this.db
      .prepare(`
      SELECT operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
        tool_name, canonical_args_hash, recovery_mode, current_state,
        call_event_id, dispatch_event_id, result_event_id, version
      FROM tool_operations
      WHERE operation_id = ?
    `)
      .get(operationId) as ToolOperationRow | undefined;
    return row ? toolOperationFromRow(row) : undefined;
  }
}

interface ToolOperationRow {
  operation_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  provider_tool_call_id: string;
  tool_name: string;
  canonical_args_hash: string;
  recovery_mode: ToolRecoveryMode;
  current_state: 'prepared' | 'outcome_committed';
  call_event_id: string;
  dispatch_event_id: string | null;
  result_event_id: string | null;
  version: number;
}

interface ToolJournalRow {
  journal_event_id: string;
  operation_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  state: ToolJournalState;
  runtime_event_id: string | null;
  canonical_args_hash: string | null;
  recovery_mode: ToolRecoveryMode | null;
  external_handle: string | null;
  metadata_json: string | null;
  committed_at: number;
}

function toolOperationFromRow(row: ToolOperationRow): ToolOperationRecord {
  return {
    operationId: row.operation_id,
    invocationId: row.invocation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    providerToolCallId: row.provider_tool_call_id,
    toolName: row.tool_name,
    canonicalArgsHash: row.canonical_args_hash,
    recoveryMode: row.recovery_mode,
    currentState: row.current_state,
    callEventId: row.call_event_id,
    ...(row.dispatch_event_id ? { dispatchEventId: row.dispatch_event_id } : {}),
    ...(row.result_event_id ? { resultEventId: row.result_event_id } : {}),
    version: row.version,
  };
}

function toolJournalRecordFromRow(row: ToolJournalRow): ToolJournalEventRecord {
  return {
    journalEventId: row.journal_event_id,
    operationId: row.operation_id,
    invocationId: row.invocation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    state: row.state,
    ...(row.runtime_event_id ? { runtimeEventId: row.runtime_event_id } : {}),
    ...(row.canonical_args_hash ? { canonicalArgsHash: row.canonical_args_hash } : {}),
    ...(row.recovery_mode ? { recoveryMode: row.recovery_mode } : {}),
    ...(row.external_handle ? { externalHandle: row.external_handle } : {}),
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) } : {}),
    committedAt: row.committed_at,
  };
}

function assertPreparedInput(input: CommitToolPreparedInput): void {
  const content = input.runtimeEvent.content;
  if (content?.kind !== 'function_call')
    throw new Error('T1 requires a function_call RuntimeEvent');
  if (content.id !== input.providerToolCallId || content.name !== input.toolName) {
    throw new Error('T1 RuntimeEvent identity does not match the tool operation');
  }
  const dispatch = input.dispatchRuntimeEvent.actions?.toolDispatch;
  if (
    !dispatch ||
    input.dispatchRuntimeEvent.content !== undefined ||
    input.dispatchRuntimeEvent.partial ||
    dispatch.operationId !== input.operationId ||
    dispatch.providerToolCallId !== input.providerToolCallId ||
    dispatch.toolName !== input.toolName ||
    dispatch.canonicalArgsHash !== input.canonicalArgsHash ||
    dispatch.recoveryMode !== input.recoveryMode
  ) {
    throw new Error('T1 requires a matching tool-dispatch RuntimeEvent');
  }
  assertSameRuntimeIdentity(input.runtimeEvent, input.dispatchRuntimeEvent, 'T1');
}

function assertOutcomeInput(input: CommitToolOutcomeInput): void {
  const content = input.runtimeEvent.content;
  if (content?.kind !== 'function_response') {
    throw new Error('T2 requires a function_response RuntimeEvent');
  }
  if (
    input.runtimeEvent.refs?.operationId !== input.operationId ||
    input.runtimeEvent.refs?.toolCallId !== content.id
  ) {
    throw new Error(
      'T2 requires operation and tool-call refs on the function_response RuntimeEvent',
    );
  }
}

function assertPreparedIdentity(
  operation: ToolOperationRecord,
  input: CommitToolPreparedInput,
): void {
  const event = input.runtimeEvent;
  const matches =
    operation.invocationId === event.invocationId &&
    operation.runId === event.runId &&
    operation.turnId === event.turnId &&
    operation.providerToolCallId === input.providerToolCallId &&
    operation.toolName === input.toolName &&
    operation.canonicalArgsHash === input.canonicalArgsHash &&
    operation.recoveryMode === input.recoveryMode &&
    operation.callEventId === event.id &&
    operation.dispatchEventId === input.dispatchRuntimeEvent.id;
  if (!matches) throw new Error(`Tool operation identity conflict for ${input.operationId}`);
}

function assertSameRuntimeIdentity(
  first: RuntimeEvent,
  second: RuntimeEvent,
  boundary: string,
): void {
  if (
    first.sessionId !== second.sessionId ||
    first.invocationId !== second.invocationId ||
    first.runId !== second.runId ||
    first.turnId !== second.turnId
  ) {
    throw new Error(`${boundary} RuntimeEvents do not share one execution identity`);
  }
}

function assertOutcomeIdentity(operation: ToolOperationRecord, event: RuntimeEvent): void {
  const content = event.content;
  const matches =
    content?.kind === 'function_response' &&
    operation.invocationId === event.invocationId &&
    operation.runId === event.runId &&
    operation.turnId === event.turnId &&
    operation.providerToolCallId === content.id &&
    operation.toolName === content.name;
  if (!matches)
    throw new Error(`Tool operation outcome identity conflict for ${operation.operationId}`);
}

function assertRuntimeEventIdentity(event: RuntimeEvent): void {
  for (const [field, value] of Object.entries({
    id: event.id,
    sessionId: event.sessionId,
    invocationId: event.invocationId,
    runId: event.runId,
    turnId: event.turnId,
  })) {
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`Invalid RuntimeEvent ${field}`);
  }
}

function assertStoredRuntimeEventEquals(event: RuntimeEvent, storedJson: string | undefined): void {
  if (storedJson === undefined) return;
  const stored = JSON.parse(storedJson) as RuntimeEvent;
  if (!isDeepStrictEqual(stored, event)) {
    throw new Error(`RuntimeEvent identity conflict for ${event.id}`);
  }
}

function runtimeEventKind(event: RuntimeEvent): string {
  return (
    event.content?.kind ??
    event.status ??
    (event.actions?.toolDispatch ? 'tool_dispatch' : undefined) ??
    (event.actions?.endInvocation ? 'invocation_end' : 'runtime_fact')
  );
}

function toolCallProjectionKey(invocationId: string, providerToolCallId: string): string {
  return `${invocationId}\0${providerToolCallId}`;
}

interface RuntimePartialSnapshot {
  event: RuntimeEvent;
  afterEventId?: string;
}

function mergeRuntimePartialSnapshots(
  immutableEvents: readonly RuntimeEvent[],
  snapshots: readonly RuntimePartialSnapshot[],
): RuntimeEvent[] {
  const leading: RuntimePartialSnapshot[] = [];
  const afterEvent = new Map<string, RuntimePartialSnapshot[]>();
  for (const snapshot of snapshots) {
    if (!snapshot.afterEventId) {
      leading.push(snapshot);
      continue;
    }
    const grouped = afterEvent.get(snapshot.afterEventId) ?? [];
    grouped.push(snapshot);
    afterEvent.set(snapshot.afterEventId, grouped);
  }
  const order = (a: RuntimePartialSnapshot, b: RuntimePartialSnapshot) =>
    a.event.ts - b.event.ts || a.event.id.localeCompare(b.event.id);
  const merged = leading.sort(order).map(({ event }) => event);
  for (const event of immutableEvents) {
    merged.push(event);
    const anchored = afterEvent.get(event.id);
    if (!anchored) continue;
    merged.push(...anchored.sort(order).map((snapshot) => snapshot.event));
    afterEvent.delete(event.id);
  }
  for (const orphaned of afterEvent.values()) {
    merged.push(...orphaned.sort(order).map((snapshot) => snapshot.event));
  }
  return merged;
}

function partialRuntimeStream(event: RuntimeEvent):
  | {
      key: string;
      snapshot: RuntimeEvent;
      text: string;
    }
  | undefined {
  if (!event.partial || event.status !== undefined || event.actions) return undefined;
  const content = event.content;
  let identity: string | undefined;
  let text = '';
  if (
    content?.kind === 'text' &&
    content.attachments === undefined &&
    event.refs?.providerEventId &&
    hasOnlyKeys(event.refs, ['providerEventId'])
  ) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
    text = content.text;
  } else if (
    content?.kind === 'thinking' &&
    content.signature === undefined &&
    event.refs?.providerEventId &&
    hasOnlyKeys(event.refs, ['providerEventId'])
  ) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
    text = content.text;
  } else if (!content && event.refs?.toolCallId && hasOnlyKeys(event.refs, ['toolCallId'])) {
    identity = `tool:call:${event.refs.toolCallId}`;
  }
  if (!identity) return undefined;
  const key = runtimePartialStreamKey(identity, event);
  const snapshot =
    content?.kind === 'text' || content?.kind === 'thinking'
      ? { ...event, content: { ...content, text: '' } }
      : event;
  return { key, snapshot, text };
}

function completedPartialRuntimeStreamKey(event: RuntimeEvent): string | undefined {
  if (event.partial) return undefined;
  const content = event.content;
  let identity: string | undefined;
  if ((content?.kind === 'text' || content?.kind === 'thinking') && event.refs?.providerEventId) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
  } else if (content?.kind === 'function_response' && event.refs?.toolCallId) {
    identity = `tool:call:${event.refs.toolCallId}`;
  }
  return identity ? runtimePartialStreamKey(identity, event) : undefined;
}

function runtimePartialStreamKey(identity: string, event: RuntimeEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        event.branch ?? null,
        event.role,
        event.author,
      ]),
    )
    .digest('hex');
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
