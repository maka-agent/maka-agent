import {
  TASK_EVIDENCE_MAX_CHARS,
  TASK_SUBJECT_MAX_CHARS,
  isResumeTrust,
  isSafeTaskId,
  isTaskKey,
  isTaskOwner,
  isTaskStatus,
  normalizeTaskEvidenceText,
  normalizeTaskSubject,
  sanitizeTaskLedgerTask,
  type Task,
  type TaskOwner,
  validateTaskEvidence,
} from '@maka/core/task-ledger';
import {
  assertAllowedKeys,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const TASK_LEDGER_PAGE_MAX_ITEMS = 128;
export const TASK_LEDGER_PAGE_MAX_BYTES = 48 * 1024;
export const TASK_LEDGER_CURSOR_MAX_BYTES = 512;

const TASK_REQUIRED_FIELDS = ['id', 'key', 'subject', 'status', 'createdAt', 'updatedAt'] as const;
const TASK_FIELDS = [
  ...TASK_REQUIRED_FIELDS,
  'parentId',
  'owner',
  'endedAt',
  'blockedReason',
  'failureReason',
  'completionEvidence',
  'resumeTrust',
] as const;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'internal_failure',
  'invalid_request',
  'persistence_failed',
] as const;

export type TaskLedgerRevision = `sha256:${string}`;
export type TaskLedgerTask = Readonly<Task>;

export type TaskLedgerQueryInput =
  | { readonly kind: 'list_start'; readonly sessionId: string }
  | {
      readonly kind: 'list_continue';
      readonly sessionId: string;
      readonly revision: TaskLedgerRevision;
      readonly cursor: string;
    }
  | { readonly kind: 'get'; readonly sessionId: string; readonly taskRef: string };

export type TaskLedgerQueryResult =
  | {
      readonly kind: 'page';
      readonly sessionId: string;
      readonly revision: TaskLedgerRevision;
      readonly tasks: readonly TaskLedgerTask[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: TaskLedgerRevision;
      readonly actual: TaskLedgerRevision;
    }
  | {
      readonly kind: 'task';
      readonly sessionId: string;
      readonly revision: TaskLedgerRevision;
      readonly task: TaskLedgerTask | null;
    };

export const TASK_LEDGER_OPERATION_SPECS = {
  'task.ledger.query': defineOperation<
    TaskLedgerQueryInput,
    TaskLedgerQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'session',
    errors: QUERY_ERRORS,
    decodeInput: decodeTaskLedgerQueryInput,
    decodeOutput: decodeTaskLedgerQueryResult,
  }),
} as const;

export function decodeTaskLedgerQueryInput(value: unknown): TaskLedgerQueryInput {
  const record = requireRecord(value, 'task ledger query input');
  if (record.kind === 'list_start') {
    const input = requireExactRecord(record, 'task ledger list start input', ['kind', 'sessionId']);
    return { kind: 'list_start', sessionId: requireEntityId(input.sessionId, 'sessionId') };
  }
  if (record.kind === 'list_continue') {
    const input = requireExactRecord(record, 'task ledger list continuation input', [
      'kind',
      'sessionId',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      revision: taskLedgerRevision(input.revision, 'task ledger revision'),
      cursor: taskLedgerCursor(input.cursor, 'task ledger cursor'),
    };
  }
  if (record.kind === 'get') {
    const input = requireExactRecord(record, 'task ledger get input', [
      'kind',
      'sessionId',
      'taskRef',
    ]);
    return {
      kind: 'get',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      taskRef: taskReference(input.taskRef),
    };
  }
  throw invalidProtocolFrame('Invalid task ledger query kind');
}

export function decodeTaskLedgerQueryResult(value: unknown): TaskLedgerQueryResult {
  return decodeQueryResult(value, 'decode');
}

/** Sanitizes producer tasks and validates the exact wire shape before transmission. */
export function encodeTaskLedgerQueryResult(value: unknown): TaskLedgerQueryResult {
  return decodeQueryResult(value, 'encode');
}

function decodeQueryResult(value: unknown, direction: 'encode' | 'decode'): TaskLedgerQueryResult {
  const record = requireRecord(value, 'task ledger query result');
  if (record.kind === 'revision_changed') {
    const changed = requireExactRecord(record, 'task ledger revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: taskLedgerRevision(changed.expected, 'expected task ledger revision'),
      actual: taskLedgerRevision(changed.actual, 'actual task ledger revision'),
    };
  }
  if (record.kind === 'task') {
    const result = requireExactRecord(record, 'task ledger task result', [
      'kind',
      'sessionId',
      'revision',
      'task',
    ]);
    return {
      kind: 'task',
      sessionId: requireEntityId(result.sessionId, 'sessionId'),
      revision: taskLedgerRevision(result.revision, 'task ledger revision'),
      task: result.task === null ? null : decodeTask(result.task, direction),
    };
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid task ledger query result kind');
  const page = requireExactRecord(record, 'task ledger page result', [
    'kind',
    'sessionId',
    'revision',
    'tasks',
    'nextCursor',
  ]);
  if (!Array.isArray(page.tasks) || page.tasks.length > TASK_LEDGER_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Task ledger page exceeds item limit');
  }
  const decoded: TaskLedgerQueryResult = {
    kind: 'page',
    sessionId: requireEntityId(page.sessionId, 'sessionId'),
    revision: taskLedgerRevision(page.revision, 'task ledger revision'),
    tasks: page.tasks.map((task) => decodeTask(task, direction)),
    nextCursor:
      page.nextCursor === null
        ? null
        : taskLedgerCursor(page.nextCursor, 'task ledger next cursor'),
  };
  if (jsonByteLength(decoded) > TASK_LEDGER_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Task ledger page exceeds byte limit');
  }
  return decoded;
}

function decodeTask(value: unknown, direction: 'encode' | 'decode'): TaskLedgerTask {
  const record = requireRecord(value, 'task ledger task');
  assertAllowedKeys(record, 'task ledger task', TASK_FIELDS);
  if (TASK_REQUIRED_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw invalidProtocolFrame('Invalid task ledger task fields');
  }

  const task: Task = {
    id: stableTaskId(record.id, 'task id'),
    key: taskKey(record.key),
    subject: taskText(record.subject, 'subject', direction),
    status: taskStatus(record.status),
    createdAt: timestamp(record.createdAt, 'task createdAt'),
    updatedAt: timestamp(record.updatedAt, 'task updatedAt'),
    ...optionalStableTaskId(record, 'parentId'),
    ...optionalOwner(record),
    ...optionalTimestamp(record, 'endedAt'),
    ...optionalTaskText(record, 'blockedReason', direction),
    ...optionalTaskText(record, 'failureReason', direction),
    ...optionalTaskText(record, 'completionEvidence', direction),
    ...optionalResumeTrust(record),
  };
  if (!validateTaskEvidence(task).ok) throw invalidProtocolFrame('Invalid task evidence');

  const safe = sanitizeTaskLedgerTask(task);
  validateSafeTaskTextFields(safe);
  if (!validateTaskEvidence(safe).ok) {
    throw invalidProtocolFrame('Task sanitation removed required evidence');
  }
  if (direction === 'decode' && JSON.stringify(safe) !== JSON.stringify(task)) {
    throw invalidProtocolFrame('Task ledger task is not sanitized');
  }
  return safe;
}

function optionalStableTaskId(
  record: Record<string, unknown>,
  field: 'parentId',
): Pick<Task, 'parentId'> | Record<string, never> {
  return Object.hasOwn(record, field)
    ? { [field]: stableTaskId(record[field], `task ${field}`) }
    : {};
}

function optionalOwner(
  record: Record<string, unknown>,
): Pick<Task, 'owner'> | Record<string, never> {
  if (!Object.hasOwn(record, 'owner')) return {};
  const rawOwner = requireExactOwner(record.owner);
  return { owner: rawOwner };
}

function requireExactOwner(value: unknown): TaskOwner {
  const record = requireRecord(value, 'task owner');
  assertAllowedKeys(record, 'task owner', ['actor', 'agentId', 'runId', 'turnId']);
  if (!Object.hasOwn(record, 'actor') || !isTaskOwner(record)) {
    throw invalidProtocolFrame('Invalid task owner');
  }
  return {
    actor: record.actor as TaskOwner['actor'],
    ...(Object.hasOwn(record, 'agentId')
      ? { agentId: stableTaskId(record.agentId, 'task owner agentId') }
      : {}),
    ...(Object.hasOwn(record, 'runId')
      ? { runId: stableTaskId(record.runId, 'task owner runId') }
      : {}),
    ...(Object.hasOwn(record, 'turnId')
      ? { turnId: stableTaskId(record.turnId, 'task owner turnId') }
      : {}),
  };
}

function optionalTimestamp(
  record: Record<string, unknown>,
  field: 'endedAt',
): Pick<Task, 'endedAt'> | Record<string, never> {
  return Object.hasOwn(record, field) ? { [field]: timestamp(record[field], `task ${field}`) } : {};
}

function optionalTaskText<Field extends 'blockedReason' | 'failureReason' | 'completionEvidence'>(
  record: Record<string, unknown>,
  field: Field,
  direction: 'encode' | 'decode',
): Pick<Task, Field> | Record<string, never> {
  return Object.hasOwn(record, field)
    ? ({ [field]: taskText(record[field], field, direction) } as Pick<Task, Field>)
    : {};
}

function optionalResumeTrust(
  record: Record<string, unknown>,
): Pick<Task, 'resumeTrust'> | Record<string, never> {
  if (!Object.hasOwn(record, 'resumeTrust')) return {};
  if (!isResumeTrust(record.resumeTrust)) throw invalidProtocolFrame('Invalid task resumeTrust');
  return { resumeTrust: record.resumeTrust };
}

function taskText(
  value: unknown,
  field: 'subject' | 'blockedReason' | 'failureReason' | 'completionEvidence',
  direction: 'encode' | 'decode',
): string {
  if (direction === 'decode') return safeTaskText(value, field);
  const normalized =
    field === 'subject' ? normalizeTaskSubject(value) : normalizeTaskEvidenceText(value, field);
  if (!normalized.ok || normalized.value !== value) {
    throw invalidProtocolFrame(`Invalid task ${field}`);
  }
  return normalized.value;
}

function safeTaskText(
  value: unknown,
  field: 'subject' | 'blockedReason' | 'failureReason' | 'completionEvidence',
): string {
  const maxCharacters = field === 'subject' ? TASK_SUBJECT_MAX_CHARS : TASK_EVIDENCE_MAX_CHARS;
  if (typeof value !== 'string' || value.length === 0 || Array.from(value).length > maxCharacters) {
    throw invalidProtocolFrame(`Invalid task ${field}`);
  }
  return value;
}

function validateSafeTaskTextFields(task: Task): void {
  safeTaskText(task.subject, 'subject');
  if (task.blockedReason !== undefined) safeTaskText(task.blockedReason, 'blockedReason');
  if (task.failureReason !== undefined) safeTaskText(task.failureReason, 'failureReason');
  if (task.completionEvidence !== undefined) {
    safeTaskText(task.completionEvidence, 'completionEvidence');
  }
}

function stableTaskId(value: unknown, label: string): string {
  if (!isSafeTaskId(value)) throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function taskKey(value: unknown): string {
  if (!isTaskKey(value)) throw invalidProtocolFrame('Invalid task key');
  return value;
}

function taskReference(value: unknown): string {
  if (!isSafeTaskId(value) && !isTaskKey(value)) {
    throw invalidProtocolFrame('Invalid task reference');
  }
  return value;
}

function taskStatus(value: unknown): Task['status'] {
  if (!isTaskStatus(value)) throw invalidProtocolFrame('Invalid task status');
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}

function taskLedgerRevision(value: unknown, label: string): TaskLedgerRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as TaskLedgerRevision;
}

function taskLedgerCursor(value: unknown, label: string): string {
  return requireUtf8BoundedString(value, label, TASK_LEDGER_CURSOR_MAX_BYTES);
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
