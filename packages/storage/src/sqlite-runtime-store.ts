import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent, RuntimeEventStore } from '@maka/core';
import {
  configureSqliteRuntimeDatabase,
  migrateSqliteRuntimeDatabase,
  readUserVersion,
} from './sqlite-runtime-schema.js';

export { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';

export type ToolRecoveryMode =
  | 'replay_safe'
  | 'idempotent'
  | 'reconcile'
  | 'reattach'
  | 'never_auto_retry';

export type ToolJournalState =
  | 'prepared'
  | 'dispatch_acknowledged'
  | 'outcome_committed'
  | 'indeterminate'
  | 'reconciled'
  | 'parked';

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
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string, private readonly options: SqliteRuntimeStoreOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    configureSqliteRuntimeDatabase(this.db);
    migrateSqliteRuntimeDatabase(this.db);
  }

  schemaVersion(): number {
    return readUserVersion(this.db);
  }

  journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
  }

  foreignKeysEnabled(): boolean {
    const row = this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: unknown } | undefined;
    return row?.foreign_keys === 1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async appendRuntimeEvent(_sessionId: string, _runId: string, event: RuntimeEvent): Promise<void> {
    this.transaction(() => {
      this.insertRuntimeEvent(event, event.ts, true);
    });
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM runtime_events
      WHERE session_id = ? AND run_id = ?
      ORDER BY event_seq ASC
    `).all(sessionId, runId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RuntimeEvent);
  }

  async readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return this.readRuntimeEvents(sessionId, runId);
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM runtime_events
      WHERE session_id = ?
      ORDER BY committed_at ASC, rowid ASC
    `).all(sessionId) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RuntimeEvent);
  }

  async runtimeHighWater(invocationId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(event_seq), 0) AS high_water
      FROM runtime_events
      WHERE invocation_id = ?
    `).get(invocationId) as { high_water: number };
    return row.high_water;
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
        return { created: false, runtimeEventSeq: this.runtimeEventSeq(input.runtimeEvent.id) };
      }
      const runtimeEventSeq = this.insertRuntimeEvent(input.runtimeEvent, input.committedAt, false);
      this.options.failpoint?.('after_runtime_event_insert');
      this.db.prepare(`
        INSERT INTO tool_journal_events (
          journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
          runtime_event_id, canonical_args_hash, recovery_mode, committed_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)
      `).run(
        input.journalEventId,
        input.operationId,
        input.runtimeEvent.invocationId,
        input.runtimeEvent.runId,
        input.runtimeEvent.turnId,
        input.runtimeEvent.id,
        input.canonicalArgsHash,
        input.recoveryMode,
        input.committedAt,
      );
      this.options.failpoint?.('after_journal_event_insert');
      this.db.prepare(`
        INSERT INTO tool_operations (
          operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
          tool_name, canonical_args_hash, recovery_mode, current_state,
          call_event_id, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, 1)
      `).run(
        input.operationId,
        input.runtimeEvent.invocationId,
        input.runtimeEvent.runId,
        input.runtimeEvent.turnId,
        input.providerToolCallId,
        input.toolName,
        input.canonicalArgsHash,
        input.recoveryMode,
        input.runtimeEvent.id,
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
        assertStoredRuntimeEventEquals(input.runtimeEvent, this.readRuntimeEventJson(input.runtimeEvent.id));
        return { created: false, runtimeEventSeq: this.runtimeEventSeq(input.runtimeEvent.id) };
      }
      const runtimeEventSeq = this.insertRuntimeEvent(input.runtimeEvent, input.committedAt, false);
      this.options.failpoint?.('after_runtime_event_insert');
      this.db.prepare(`
        INSERT INTO tool_journal_events (
          journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
          runtime_event_id, canonical_args_hash, recovery_mode, committed_at
        ) VALUES (?, ?, ?, ?, ?, 'outcome_committed', ?, ?, ?, ?)
      `).run(
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
      this.db.prepare(`
        UPDATE tool_operations
        SET current_state = 'outcome_committed', result_event_id = ?, version = version + 1
        WHERE operation_id = ? AND current_state = 'prepared' AND result_event_id IS NULL
      `).run(input.runtimeEvent.id, input.operationId);
      return { created: true, runtimeEventSeq };
    });
  }

  async readToolOperation(operationId: string): Promise<ToolOperationRecord | undefined> {
    return this.readToolOperationSync(operationId);
  }

  async readToolJournal(operationId: string): Promise<ToolJournalEventRecord[]> {
    const rows = this.db.prepare(`
      SELECT journal_event_id, operation_id, invocation_id, run_id, turn_id,
        state, runtime_event_id, canonical_args_hash, recovery_mode,
        external_handle, metadata_json, committed_at
      FROM tool_journal_events
      WHERE operation_id = ?
      ORDER BY journal_seq ASC
    `).all(operationId) as unknown as ToolJournalRow[];
    return rows.map(toolJournalRecordFromRow);
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

  private insertRuntimeEvent(event: RuntimeEvent, committedAt: number, allowExactDuplicate: boolean): number {
    assertRuntimeEventIdentity(event);
    const existingJson = this.readRuntimeEventJson(event.id);
    if (existingJson !== undefined) {
      assertStoredRuntimeEventEquals(event, existingJson);
      if (!allowExactDuplicate) {
        throw new Error(`RuntimeEvent ${event.id} already exists outside this tool transaction`);
      }
      return this.runtimeEventSeq(event.id);
    }
    const next = this.nextRuntimeEventSeq(event.invocationId);
    this.db.prepare(`
      INSERT INTO runtime_events (
        event_id, session_id, invocation_id, run_id, turn_id, event_seq,
        event_kind, payload_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    return next;
  }

  private nextRuntimeEventSeq(invocationId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq
      FROM runtime_events
      WHERE invocation_id = ?
    `).get(invocationId) as { next_seq: number };
    return row.next_seq;
  }

  private runtimeEventSeq(eventId: string): number {
    const row = this.db.prepare(`
      SELECT event_seq FROM runtime_events WHERE event_id = ?
    `).get(eventId) as { event_seq: number } | undefined;
    if (!row) throw new Error(`Missing RuntimeEvent ${eventId}`);
    return row.event_seq;
  }

  private readRuntimeEventJson(eventId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT payload_json FROM runtime_events WHERE event_id = ?
    `).get(eventId) as { payload_json: string } | undefined;
    return row?.payload_json;
  }

  private readToolOperationSync(operationId: string): ToolOperationRecord | undefined {
    const row = this.db.prepare(`
      SELECT operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
        tool_name, canonical_args_hash, recovery_mode, current_state,
        call_event_id, result_event_id, version
      FROM tool_operations
      WHERE operation_id = ?
    `).get(operationId) as ToolOperationRow | undefined;
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
  if (content?.kind !== 'function_call') throw new Error('T1 requires a function_call RuntimeEvent');
  if (content.id !== input.providerToolCallId || content.name !== input.toolName) {
    throw new Error('T1 RuntimeEvent identity does not match the tool operation');
  }
}

function assertOutcomeInput(input: CommitToolOutcomeInput): void {
  if (input.runtimeEvent.content?.kind !== 'function_response') {
    throw new Error('T2 requires a function_response RuntimeEvent');
  }
}

function assertPreparedIdentity(operation: ToolOperationRecord, input: CommitToolPreparedInput): void {
  const event = input.runtimeEvent;
  const matches = operation.invocationId === event.invocationId
    && operation.runId === event.runId
    && operation.turnId === event.turnId
    && operation.providerToolCallId === input.providerToolCallId
    && operation.toolName === input.toolName
    && operation.canonicalArgsHash === input.canonicalArgsHash
    && operation.recoveryMode === input.recoveryMode
    && operation.callEventId === event.id;
  if (!matches) throw new Error(`Tool operation identity conflict for ${input.operationId}`);
}

function assertOutcomeIdentity(operation: ToolOperationRecord, event: RuntimeEvent): void {
  const content = event.content;
  const matches = content?.kind === 'function_response'
    && operation.invocationId === event.invocationId
    && operation.runId === event.runId
    && operation.turnId === event.turnId
    && operation.providerToolCallId === content.id
    && operation.toolName === content.name;
  if (!matches) throw new Error(`Tool operation outcome identity conflict for ${operation.operationId}`);
}

function assertRuntimeEventIdentity(event: RuntimeEvent): void {
  for (const [field, value] of Object.entries({
    id: event.id,
    sessionId: event.sessionId,
    invocationId: event.invocationId,
    runId: event.runId,
    turnId: event.turnId,
  })) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid RuntimeEvent ${field}`);
  }
}

function assertStoredRuntimeEventEquals(event: RuntimeEvent, storedJson: string | undefined): void {
  if (storedJson === undefined) return;
  if (storedJson !== JSON.stringify(event)) {
    throw new Error(`RuntimeEvent identity conflict for ${event.id}`);
  }
}

function runtimeEventKind(event: RuntimeEvent): string {
  return event.content?.kind ?? event.status ?? (event.actions?.endInvocation ? 'invocation_end' : 'runtime_fact');
}
