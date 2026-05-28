export const PLAN_REMINDER_TITLE_MAX_CHARS = 120;
export const PLAN_REMINDER_NOTE_MAX_CHARS = 1000;
export const PLAN_REMINDER_MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
export const PLAN_REMINDER_RUN_HISTORY_LIMIT = 10;

export const PLAN_REMINDER_STATUSES = ['scheduled', 'paused', 'completed'] as const;
export type PlanReminderStatus = typeof PLAN_REMINDER_STATUSES[number];

export const PLAN_REMINDER_RUN_STATUSES = ['triggered', 'blocked', 'failed'] as const;
export type PlanReminderRunStatus = typeof PLAN_REMINDER_RUN_STATUSES[number];

export type PlanReminderBlockReason = 'incognito_active';

export const PLAN_REMINDER_RECURRENCES = ['none', 'daily', 'weekly', 'monthly'] as const;
export type PlanReminderRecurrence = typeof PLAN_REMINDER_RECURRENCES[number];
export type PlanReminderRecurringFrequency = Exclude<PlanReminderRecurrence, 'none'>;

export type PlanReminderSchedule = PlanReminderOnceSchedule | PlanReminderRecurringSchedule;

export interface PlanReminderOnceSchedule {
  kind: 'once';
  runAt: number;
}

export interface PlanReminderRecurringSchedule {
  kind: 'recurring';
  startAt: number;
  recurrence: PlanReminderRecurringFrequency;
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
  runs: PlanReminderRunRecord[];
  runCount: number;
}

export interface CreatePlanReminderInput {
  title: unknown;
  note?: unknown;
  runAt: unknown;
  recurrence?: unknown;
}

export interface UpdatePlanReminderInput {
  title?: unknown;
  note?: unknown;
  runAt?: unknown;
  recurrence?: unknown;
  enabled?: unknown;
}

export type PlanReminderNormalizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid_title' | 'invalid_note' | 'invalid_run_at' | 'invalid_recurrence' | 'invalid_enabled'; message: string };

type PlanReminderNormalizeErrorReason = Extract<PlanReminderNormalizeResult<never>, { ok: false }>['reason'];

export function isPlanReminderStatus(value: unknown): value is PlanReminderStatus {
  return typeof value === 'string' && (PLAN_REMINDER_STATUSES as readonly string[]).includes(value);
}

export function normalizeCreatePlanReminderInput(
  input: unknown,
  now: number,
): PlanReminderNormalizeResult<{ title: string; note: string; schedule: PlanReminderSchedule; nextRunAt: number }> {
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
  const recurrence = normalizePlanReminderRecurrence(record.recurrence);
  if (!recurrence.ok) return recurrence;
  const schedule = createPlanReminderSchedule(runAt.value, recurrence.value);
  return { ok: true, value: { title: title.value, note: note.value, schedule, nextRunAt: runAt.value } };
}

export function normalizeUpdatePlanReminderInput(
  input: unknown,
  now: number,
): PlanReminderNormalizeResult<{ title?: string; note?: string; runAt?: number; recurrence?: PlanReminderRecurrence; enabled?: boolean }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('invalid_title', 'Plan reminder update must be an object');
  }
  const record = input as UpdatePlanReminderInput;
  const patch: { title?: string; note?: string; runAt?: number; recurrence?: PlanReminderRecurrence; enabled?: boolean } = {};
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
  if (record.recurrence !== undefined) {
    const recurrence = normalizePlanReminderRecurrence(record.recurrence);
    if (!recurrence.ok) return recurrence;
    patch.recurrence = recurrence.value;
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

export function normalizePlanReminderRecurrence(input: unknown): PlanReminderNormalizeResult<PlanReminderRecurrence> {
  if (input === undefined || input === null || input === '' || input === 'none') {
    return { ok: true, value: 'none' };
  }
  if (typeof input !== 'string') {
    return invalid('invalid_recurrence', 'Plan reminder recurrence must be a string');
  }
  if (!PLAN_REMINDER_RECURRENCES.includes(input as PlanReminderRecurrence)) {
    return invalid('invalid_recurrence', 'Plan reminder recurrence must be none, daily, weekly, or monthly');
  }
  return { ok: true, value: input as PlanReminderRecurrence };
}

export function createPlanReminderSchedule(runAt: number, recurrence: PlanReminderRecurrence): PlanReminderSchedule {
  if (recurrence === 'none') return { kind: 'once', runAt };
  return { kind: 'recurring', startAt: runAt, recurrence };
}

export function planReminderScheduleStartAt(schedule: PlanReminderSchedule): number {
  return schedule.kind === 'once' ? schedule.runAt : schedule.startAt;
}

export function nextPlanReminderRunAtAfter(schedule: PlanReminderSchedule, after: number): number | undefined {
  if (schedule.kind === 'once') return schedule.runAt > after ? schedule.runAt : undefined;
  if (schedule.startAt > after) return schedule.startAt;
  return nextRecurringRunAt(schedule, after);
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
  const runs = appendPlanReminderRun(reminder.runs, run);
  const nextRunAt = nextPlanReminderRunAtAfter(reminder.schedule, run.at);
  if (typeof nextRunAt === 'number') {
    return {
      ...reminder,
      status: 'scheduled',
      enabled: true,
      nextRunAt,
      lastRun: run,
      runs,
      runCount: reminder.runCount + 1,
      updatedAt: run.at,
    };
  }
  return {
    ...reminder,
    status: 'completed',
    enabled: false,
    nextRunAt: undefined,
    lastRun: run,
    runs,
    runCount: reminder.runCount + 1,
    updatedAt: run.at,
  };
}

export function appendPlanReminderRun(
  runs: readonly PlanReminderRunRecord[] | undefined,
  run: PlanReminderRunRecord,
): PlanReminderRunRecord[] {
  return [run, ...(runs ?? [])].slice(0, PLAN_REMINDER_RUN_HISTORY_LIMIT);
}

function nextRecurringRunAt(schedule: PlanReminderRecurringSchedule, after: number): number {
  if (schedule.recurrence === 'daily') {
    const dayMs = 24 * 60 * 60 * 1000;
    const steps = Math.floor((after - schedule.startAt) / dayMs) + 1;
    return schedule.startAt + steps * dayMs;
  }
  if (schedule.recurrence === 'weekly') {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const steps = Math.floor((after - schedule.startAt) / weekMs) + 1;
    return schedule.startAt + steps * weekMs;
  }
  let next = schedule.startAt;
  for (let i = 0; i < 480 && next <= after; i += 1) {
    next = addMonthsClamped(schedule.startAt, i + 1);
  }
  return next > after ? next : addMonthsClamped(after, 1);
}

function addMonthsClamped(anchor: number, monthOffset: number): number {
  const date = new Date(anchor);
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() + monthOffset;
  const day = date.getDate();
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(
    targetYear,
    targetMonth,
    Math.min(day, lastDay),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ).getTime();
}

function invalid<T extends PlanReminderNormalizeErrorReason>(
  reason: T,
  message: string,
): Extract<PlanReminderNormalizeResult<never>, { ok: false }> {
  return { ok: false, reason, message };
}
