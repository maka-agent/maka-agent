export const PLAN_REMINDER_TITLE_MAX_CHARS = 120;
export const PLAN_REMINDER_NOTE_MAX_CHARS = 1000;
export const PLAN_REMINDER_MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;

export const PLAN_REMINDER_STATUSES = ['scheduled', 'paused', 'completed'] as const;
export type PlanReminderStatus = typeof PLAN_REMINDER_STATUSES[number];

export const PLAN_REMINDER_RUN_STATUSES = ['triggered', 'blocked', 'failed'] as const;
export type PlanReminderRunStatus = typeof PLAN_REMINDER_RUN_STATUSES[number];

export type PlanReminderBlockReason = 'incognito_active';

export interface PlanReminderSchedule {
  kind: 'once';
  runAt: number;
}

export interface PlanReminderRunRecord {
  id: string;
  at: number;
  status: PlanReminderRunStatus;
  message: string;
  blockReason?: PlanReminderBlockReason;
}

export interface PlanReminder {
  id: string;
  title: string;
  note: string;
  schedule: PlanReminderSchedule;
  status: PlanReminderStatus;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRun?: PlanReminderRunRecord;
  runCount: number;
}

export interface CreatePlanReminderInput {
  title: unknown;
  note?: unknown;
  runAt: unknown;
}

export interface UpdatePlanReminderInput {
  title?: unknown;
  note?: unknown;
  runAt?: unknown;
  enabled?: unknown;
}

export type PlanReminderNormalizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid_title' | 'invalid_note' | 'invalid_run_at' | 'invalid_enabled'; message: string };

type PlanReminderNormalizeErrorReason = Extract<PlanReminderNormalizeResult<never>, { ok: false }>['reason'];

export function isPlanReminderStatus(value: unknown): value is PlanReminderStatus {
  return typeof value === 'string' && (PLAN_REMINDER_STATUSES as readonly string[]).includes(value);
}

export function normalizeCreatePlanReminderInput(
  input: unknown,
  now: number,
): PlanReminderNormalizeResult<{ title: string; note: string; runAt: number }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('invalid_title', 'Plan reminder input must be an object');
  }
  const record = input as CreatePlanReminderInput;
  const title = normalizePlanReminderTitle(record.title);
  if (!title.ok) return title;
  const note = normalizePlanReminderNote(record.note);
  if (!note.ok) return note;
  const runAt = normalizePlanReminderRunAt(record.runAt, now);
  if (!runAt.ok) return runAt;
  return { ok: true, value: { title: title.value, note: note.value, runAt: runAt.value } };
}

export function normalizeUpdatePlanReminderInput(
  input: unknown,
  now: number,
): PlanReminderNormalizeResult<{ title?: string; note?: string; runAt?: number; enabled?: boolean }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('invalid_title', 'Plan reminder update must be an object');
  }
  const record = input as UpdatePlanReminderInput;
  const patch: { title?: string; note?: string; runAt?: number; enabled?: boolean } = {};
  if (record.title !== undefined) {
    const title = normalizePlanReminderTitle(record.title);
    if (!title.ok) return title;
    patch.title = title.value;
  }
  if (record.note !== undefined) {
    const note = normalizePlanReminderNote(record.note);
    if (!note.ok) return note;
    patch.note = note.value;
  }
  if (record.runAt !== undefined) {
    const runAt = normalizePlanReminderRunAt(record.runAt, now);
    if (!runAt.ok) return runAt;
    patch.runAt = runAt.value;
  }
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') {
      return invalid('invalid_enabled', 'Plan reminder enabled must be a boolean');
    }
    patch.enabled = record.enabled;
  }
  return { ok: true, value: patch };
}

export function normalizePlanReminderTitle(input: unknown): PlanReminderNormalizeResult<string> {
  if (typeof input !== 'string') {
    return invalid('invalid_title', 'Plan reminder title must be a string');
  }
  const title = input.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (title.length === 0) {
    return invalid('invalid_title', 'Plan reminder title cannot be empty');
  }
  if (Array.from(title).length > PLAN_REMINDER_TITLE_MAX_CHARS) {
    return invalid('invalid_title', `Plan reminder title must be ${PLAN_REMINDER_TITLE_MAX_CHARS} characters or fewer`);
  }
  return { ok: true, value: title };
}

export function normalizePlanReminderNote(input: unknown): PlanReminderNormalizeResult<string> {
  if (input === undefined || input === null) return { ok: true, value: '' };
  if (typeof input !== 'string') {
    return invalid('invalid_note', 'Plan reminder note must be a string');
  }
  const note = input.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (Array.from(note).length > PLAN_REMINDER_NOTE_MAX_CHARS) {
    return invalid('invalid_note', `Plan reminder note must be ${PLAN_REMINDER_NOTE_MAX_CHARS} characters or fewer`);
  }
  return { ok: true, value: note };
}

export function normalizePlanReminderRunAt(input: unknown, now: number): PlanReminderNormalizeResult<number> {
  let value: number;
  if (typeof input === 'number') {
    value = input;
  } else if (typeof input === 'string' && input.trim().length > 0) {
    value = Date.parse(input);
  } else {
    return invalid('invalid_run_at', 'Plan reminder runAt must be a timestamp or ISO date string');
  }
  if (!Number.isFinite(value)) {
    return invalid('invalid_run_at', 'Plan reminder runAt must be a valid time');
  }
  const runAt = Math.trunc(value);
  if (runAt < now) {
    return invalid('invalid_run_at', 'Plan reminder runAt must be in the future');
  }
  if (runAt - now > PLAN_REMINDER_MAX_DELAY_MS) {
    return invalid('invalid_run_at', 'Plan reminder runAt must be within one year');
  }
  return { ok: true, value: runAt };
}

export function isPlanReminderDue(reminder: PlanReminder, now: number): boolean {
  return reminder.enabled &&
    reminder.status === 'scheduled' &&
    typeof reminder.nextRunAt === 'number' &&
    reminder.nextRunAt <= now;
}

export function nextPlanReminderStateAfterTrigger(
  reminder: PlanReminder,
  run: PlanReminderRunRecord,
): PlanReminder {
  return {
    ...reminder,
    status: 'completed',
    enabled: false,
    nextRunAt: undefined,
    lastRun: run,
    runCount: reminder.runCount + 1,
    updatedAt: run.at,
  };
}

function invalid<T extends PlanReminderNormalizeErrorReason>(
  reason: T,
  message: string,
): Extract<PlanReminderNormalizeResult<never>, { ok: false }> {
  return { ok: false, reason, message };
}
