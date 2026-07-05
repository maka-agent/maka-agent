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
 * Language-neutral bullet rendering shared by the tool result and the turn-tail
 * fragment. Returns an empty string for an empty ledger so callers can suppress
 * the whole fragment. The status token is the exact enum the model must echo
 * back to TaskUpdate.
 */
export function formatTaskLedgerList(tasks: readonly Task[]): string {
  return tasks.map((task) => `- [${task.status}] ${task.subject} (id: ${task.id})`).join('\n');
}

/**
 * Safe-render the task list for any face that persists into history or is
 * re-injected into a prompt: redact secrets, then strip any literal
 * <task-ledger ...> / </task-ledger ...> tag variants (attributes, whitespace
 * before `>`, self-closing) so a model-authored subject cannot open or close
 * the <task-ledger> data envelope early. Other angle brackets (e.g. `a < b`)
 * are left intact. Returns '' for an empty ledger.
 */
export function renderSafeTaskLedgerText(tasks: readonly Task[]): string {
  return redactSecrets(formatTaskLedgerList(tasks)).replace(/<\/?task-ledger[^>]*>/gi, '');
}

function invalid<T extends TaskLedgerNormalizeErrorReason>(
  reason: T,
  message: string,
): Extract<TaskLedgerNormalizeResult<never>, { ok: false }> {
  return { ok: false, reason, message };
}
