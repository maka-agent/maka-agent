// Session-scoped task ledger primitive for the main agent. The model manages a
// flat task list via TaskCreate/TaskUpdate; each turn tail re-injects the
// current list. P0 scope is intentionally minimal: no priority, dependency, or
// assignee fields.

import { redactSecrets } from './redaction.js';

export const TASK_SUBJECT_MAX_CHARS = 200;
/**
 * Hard cap on total tasks per session ledger (any status). The full ledger is
 * re-injected into every turn tail, so an unbounded ledger burns context on
 * every turn; this is a runaway guard on the total count, not a workflow quota
 * — completing or cancelling tasks does not free capacity.
 */
export const TASK_LEDGER_MAX_TASKS = 200;

/**
 * Max length of a task id accepted on both the write and read paths. The write
 * path generates randomUUID (36 chars); the bound leaves headroom for a future
 * id format while keeping the turn-tail `(id: ...)` render bounded.
 */
export const TASK_ID_MAX_CHARS = 64;

export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export interface Task {
  id: string;
  subject: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Store contract shared by the storage implementation and the runtime tools.
 * Mutations return the full post-mutation ledger (`all`) computed inside the
 * store's serialized write section, so callers render exactly the state their
 * mutation produced instead of re-reading outside the write queue.
 */
export interface TaskLedgerStore {
  list(sessionId: string): Promise<Task[]>;
  create(sessionId: string, drafts: unknown): Promise<{ created: Task[]; all: Task[] }>;
  update(sessionId: string, id: string, patch: unknown): Promise<{ updated: Task; all: Task[] }>;
}

export interface CreateTaskInput {
  subject: unknown;
}

export interface UpdateTaskInput {
  subject?: unknown;
  status?: unknown;
}

export type TaskLedgerNormalizeResult<T> =
  | { ok: true; value: T }
  | {
    ok: false;
    reason: 'invalid_subject' | 'invalid_status' | 'empty_patch';
    message: string;
  };

type TaskLedgerNormalizeErrorReason = Extract<TaskLedgerNormalizeResult<never>, { ok: false }>['reason'];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Stable-token id contract shared by the runtime tool schema (front-door) and
 * the storage read path. The shared renderer strips `<\/?task-ledger[^>]*>`
 * from the whole formatted output, including the id, so an id carrying angle
 * brackets, slashes, quotes, parens, or equals would render as a different id
 * than the store holds, and a later TaskUpdate on the rendered id would miss.
 * Whitespace would break the list-line structure; a huge id would bloat every
 * turn tail. The whitelist (alphanumeric plus . _ : -, 1-64 chars) excludes
 * every such character without coupling to the UUID format.
 */
export function isSafeTaskId(value: unknown): value is string {
  // Stable token (alphanumeric plus . _ : -, 1-64 chars) AND redaction-stable:
  // the renderer runs redactSecrets over the whole formatted list, including
  // the id, so a secret-shaped id (ghp_..., sk-..., a 40-char hex, AIza...) would
  // render as (id: [redacted]) while the store holds the real id, and a later
  // TaskUpdate on [redacted] would miss. Requiring redactSecrets(id) === id
  // keeps the rendered id and the stored id identical.
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
    && redactSecrets(value) === value;
}

export function normalizeTaskSubject(input: unknown): TaskLedgerNormalizeResult<string> {
  if (typeof input !== 'string') {
    return invalid('invalid_subject', 'Task subject must be a string');
  }
  const subject = input.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (subject.length === 0) {
    return invalid('invalid_subject', 'Task subject cannot be empty');
  }
  if (Array.from(subject).length > TASK_SUBJECT_MAX_CHARS) {
    return invalid('invalid_subject', `Task subject must be ${TASK_SUBJECT_MAX_CHARS} characters or fewer`);
  }
  return { ok: true, value: subject };
}

export function normalizeTaskStatus(input: unknown): TaskLedgerNormalizeResult<TaskStatus> {
  if (!isTaskStatus(input)) {
    return invalid('invalid_status', `Task status must be one of ${TASK_STATUSES.join(', ')}`);
  }
  return { ok: true, value: input };
}

export function normalizeCreateTaskInput(input: unknown): TaskLedgerNormalizeResult<{ subject: string }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('invalid_subject', 'Task input must be an object');
  }
  const record = input as CreateTaskInput;
  const subject = normalizeTaskSubject(record.subject);
  if (!subject.ok) return subject;
  return { ok: true, value: { subject: subject.value } };
}

export function normalizeUpdateTaskInput(
  input: unknown,
): TaskLedgerNormalizeResult<{ subject?: string; status?: TaskStatus }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('empty_patch', 'Task update must be an object');
  }
  const record = input as UpdateTaskInput;
  const patch: { subject?: string; status?: TaskStatus } = {};
  if (record.subject !== undefined) {
    const subject = normalizeTaskSubject(record.subject);
    if (!subject.ok) return subject;
    patch.subject = subject.value;
  }
  if (record.status !== undefined) {
    const status = normalizeTaskStatus(record.status);
    if (!status.ok) return status;
    patch.status = status.value;
  }
  if (patch.subject === undefined && patch.status === undefined) {
    return invalid('empty_patch', 'Task update must change at least one of subject or status');
  }
  return { ok: true, value: patch };
}

/**
 * Safe-render the task ledger for any face that persists into history or is
 * re-injected into a prompt (tool results, turn-tail fragment). The invariant
 * this guards: what the model sees is byte-identical to what the store holds,
 * so a later TaskUpdate on the rendered id always hits the right task.
 *
 * Rendering is per-task, not over the whole joined string: each subject is
 * redacted and stripped independently, so a subject on one task can never eat
 * or deform text on another task's line. The id is rendered verbatim -- it is
 * a redaction-stable stable token validated on write and read, so running it
 * through redactSecrets or the tag strip could only deform it (and break
 * TaskUpdate); it must not be scrubbed. Other angle brackets in a subject
 * (e.g. `a < b`) are left intact; only complete `<task-ledger ...>` /
 * `</task-ledger ...>` tags (matched on a single line) are stripped so a
 * model-authored subject cannot open or close the <task-ledger> data envelope.
 * Returns '' for an empty ledger.
 */
export function renderSafeTaskLedgerText(tasks: readonly Task[]): string {
  if (tasks.length === 0) return '';
  return tasks.map((task) => {
    const safeSubject = redactSecrets(task.subject).replace(/<\/?task-ledger[^\n>]*>/gi, '');
    return `- [${task.status}] ${safeSubject} (id: ${task.id})`;
  }).join('\n');
}

function invalid<T extends TaskLedgerNormalizeErrorReason>(
  reason: T,
  message: string,
): Extract<TaskLedgerNormalizeResult<never>, { ok: false }> {
  return { ok: false, reason, message };
}
