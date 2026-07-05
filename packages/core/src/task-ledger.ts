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
 * id format while keeping the turn-tail `id=` fielded render bounded.
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
 * Mutations return the changed task(s) and the new total, computed inside the
 * store's serialized write section, so callers render exactly the state their
 * mutation produced instead of re-reading outside the write queue. The full
 * ledger never leaves the store through the mutation result.
 */
export interface TaskLedgerStore {
  list(sessionId: string): Promise<Task[]>;
  create(sessionId: string, drafts: unknown): Promise<{ created: Task[]; total: number }>;
  update(sessionId: string, id: string, patch: unknown): Promise<{ updated: Task; total: number }>;
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
 * the storage read path. The id is rendered verbatim (see
 * renderSafeTaskLedgerText), so it must not be deformable by any face that has
 * ever rendered it: no angle brackets/slashes/quotes/parens/equals (a past
 * whole-string tag strip would have eaten them; even the fielded renderer
 * emits the id bare), no whitespace (would break the list-line structure), no
 * huge length (would bloat every turn tail), and redaction-stable (a renderer
 * that runs redactSecrets must not turn the id into [redacted] while the store
 * keeps the real id -- a later TaskUpdate would miss). The whitelist
 * (alphanumeric plus . _ : -, 1-64 chars) plus redactSecrets(id) === id enforces
 * these constraints without coupling to the UUID format.
 */
export function isSafeTaskId(value: unknown): value is string {
  // Stable token (alphanumeric plus . _ : -, 1-64 chars) AND redaction-stable:
  // the id is rendered verbatim, so a secret-shaped id (ghp_..., sk-..., a
  // 40-char hex, AIza...) must be rejected -- otherwise a renderer that does
  // run redactSecrets would turn it into [redacted] while the store keeps the
  // real id, and a later TaskUpdate would miss.
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
 * re-injected into a prompt (tool results, turn-tail fragment). Two invariants:
 *   - the canonical id is rendered verbatim, and the subject is a safe
 *     (redacted, tag-stripped) rendered payload of what the store holds; and
 *   - the model can unambiguously recover each task's id from what it sees, so
 *     a later TaskUpdate hits the right task.
 *
 * Rendering is per-task and fielded, not a free-text bullet: each line is
 * `id=<id> status=<status> subject=<JSON-stringified safe subject>`. The
 * canonical id is a distinct leading field, so a subject cannot smuggle a fake
 * `id=` field or any other id-like span past it -- any id-like text in the subject stays
 * inside the quoted JSON payload. The id is emitted verbatim: it is a
 * redaction-stable stable token validated on write and read, so scrubbing it
 * could only deform it (and break TaskUpdate); it must not be redacted or
 * tag-stripped. Each subject is redacted (secrets) and tag-stripped (complete
 * `<task-ledger ...>` / `</task-ledger ...>` tags on a single line, so a
 * model-authored subject cannot open or close the <task-ledger> data envelope)
 * independently -- a subject on one task can never eat or deform text on
 * another task's line. Other angle brackets (e.g. `a < b`) are left intact.
 * Returns '' for an empty ledger.
 */
export function renderSafeTaskLedgerText(tasks: readonly Task[]): string {
  if (tasks.length === 0) return '';
  return tasks.map((task) => {
    const safeSubject = redactSecrets(task.subject).replace(/<\/?task-ledger[^\n>]*>/gi, '');
    return `id=${task.id} status=${task.status} subject=${JSON.stringify(safeSubject)}`;
  }).join('\n');
}

function invalid<T extends TaskLedgerNormalizeErrorReason>(
  reason: T,
  message: string,
): Extract<TaskLedgerNormalizeResult<never>, { ok: false }> {
  return { ok: false, reason, message };
}
