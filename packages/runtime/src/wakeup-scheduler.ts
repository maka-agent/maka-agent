/**
 * WakeupScheduler — session-internal timer that re-injects a turn after a delay.
 *
 * The agent calls `schedule_wakeup` to arrange a future synthetic turn in the
 * same session, enabling polling/monitoring loops without user interaction.
 * Analogous to Claude Code's ScheduleWakeup tool.
 */

// ─── Minimal cron parser (no import from core to avoid circular deps) ────────

interface ParsedCronField {
  wildcard: boolean;
  values: Set<number>;
}

interface ParsedCronExpression {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

function parseCronInteger(input: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(input)) return null;
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

function parseCronField(input: string, min: number, max: number, normalizeSevenToZero: boolean): ParsedCronField | null {
  if (!/^[\d*,/\-]+$/.test(input)) return null;
  const values = new Set<number>();
  let wildcard = false;

  for (const rawPart of input.split(',')) {
    if (!rawPart) return null;
    const stepSplit = rawPart.split('/');
    if (stepSplit.length > 2) return null;

    const base = stepSplit[0] ?? '';
    const stepVal = stepSplit[1] === undefined ? 1 : parseCronInteger(stepSplit[1], 1, max - min + 1);
    if (stepVal === null) return null;

    let start: number;
    let end: number;

    if (base === '*') {
      if (stepSplit.length === 1) wildcard = true;
      start = min;
      end = max;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2) return null;
      const parsedStart = parseCronInteger(range[0] ?? '', min, max);
      const parsedEnd = parseCronInteger(range[1] ?? '', min, max);
      if (parsedStart === null || parsedEnd === null || parsedStart > parsedEnd) return null;
      start = parsedStart;
      end = parsedEnd;
    } else {
      const parsed = parseCronInteger(base, min, max);
      if (parsed === null) return null;
      start = parsed;
      end = parsed;
    }

    for (let v = start; v <= end; v += stepVal) {
      values.add(normalizeSevenToZero && v === 7 ? 0 : v);
    }
  }

  if (values.size === 0) return null;
  return { wildcard, values };
}

function parseCronExpression(expression: string): ParsedCronExpression | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minute = parseCronField(parts[0]!, 0, 59, false);
  if (!minute) return null;
  const hour = parseCronField(parts[1]!, 0, 23, false);
  if (!hour) return null;
  const dayOfMonth = parseCronField(parts[2]!, 1, 31, false);
  if (!dayOfMonth) return null;
  const month = parseCronField(parts[3]!, 1, 12, false);
  if (!month) return null;
  const dayOfWeek = parseCronField(parts[4]!, 0, 7, true);
  if (!dayOfWeek) return null;

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function cronExpressionMatches(expr: ParsedCronExpression, date: Date): boolean {
  if (!expr.minute.values.has(date.getMinutes())) return false;
  if (!expr.hour.values.has(date.getHours())) return false;
  if (!expr.month.values.has(date.getMonth() + 1)) return false;

  const dayOfMonthMatches = expr.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = expr.dayOfWeek.values.has(date.getDay());

  // Standard cron: if both day-of-month and day-of-week are restricted (non-wildcard),
  // match if EITHER matches. If only one is restricted, both must match.
  if (!expr.dayOfMonth.wildcard && !expr.dayOfWeek.wildcard) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

/**
 * Compute the next cron run time after the given epoch-ms timestamp.
 * Scans minute-by-minute up to ~366 days into the future.
 * Returns epoch-ms of next matching minute, or null if expression is invalid
 * or no match found within the scan window.
 */
export function computeNextCronRun(expression: string, afterMs: number): number | null {
  const parsed = parseCronExpression(expression);
  if (!parsed) return null;

  // Start from the next full minute after `afterMs`
  const start = new Date(afterMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Scan up to 366 days * 24 hours * 60 minutes = 527,040 iterations max
  const maxIterations = 366 * 24 * 60;
  const candidate = new Date(start.getTime());

  for (let i = 0; i < maxIterations; i++) {
    if (cronExpressionMatches(parsed, candidate)) {
      return candidate.getTime();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

// ─── WakeupScheduler ─────────────────────────────────────────────────────────

export interface WakeupRecord {
  id: string;
  sessionId: string;
  message: string;
  reason: string;
  scheduledAt: number;
  firesAt: number;
  delaySeconds: number;
  recurring: boolean;
  /** Standard 5-field cron expression (minute hour dom month dow). */
  cronExpression?: string;
  status: 'pending' | 'fired' | 'cancelled' | 'expired';
  /** For recurring jobs: absolute timestamp when this job chain expires. */
  expiresAt: number | null;
  /** Number of times fire() was attempted (including idle-deferred attempts). */
  fireAttempts: number;
  /** Timestamps when fire was deferred due to non-idle session. */
  deferredFires: number[];
}

export interface WakeupSchedulerDeps {
  newId: () => string;
  now: () => number;
  injectTurn: (sessionId: string, input: { turnId: string; text: string }) => void;
  canFire: (sessionId: string) => Promise<boolean>;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
}

const MAX_WAKEUPS_PER_SESSION = 5;
const MAX_DELAY_SECONDS = 86_400;
const BACKOFF_BASE_MS = 5_000;
/** Idle-gate backoff cap: retries stretch 5s → 10s → … → 5min. */
const BACKOFF_MAX_MS = 5 * 60 * 1000;
/**
 * Review fix (first-principles): the whole point of a wakeup is to fire
 * after long-running work; a 3×5s retry window silently dropped any wakeup
 * that landed mid-turn (agent turns routinely run for minutes). Exponential
 * backoff up to 5min × 12 attempts waits ~45 minutes before giving up.
 */
const MAX_FIRE_RETRIES = 12;

/** Recurring jobs auto-expire after 7 days to prevent infinite loops. */
const MAX_RECURRING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum jitter cap for recurring re-schedules: 15 minutes. */
const MAX_JITTER_MS = 15 * 60 * 1000;

/** Maximum early jitter for one-shot jobs firing on round minutes: 90 seconds. */
const ONE_SHOT_JITTER_MS = 90 * 1000;

/** Maximum total records per session before oldest fired/expired records are pruned. */
export const MAX_RECORDS_PER_SESSION = 50;

/**
 * Compute jitter to add to a scheduled delay.
 *
 * - Recurring: up to 10% of the delay, capped at 15 minutes.
 * - One-shot firing on :00 or :30: up to 90s early jitter (returned as negative).
 *   Otherwise 0 for one-shot.
 */
export function computeJitter(
  delayMs: number,
  recurring: boolean,
  random: () => number = Math.random,
  firesAtMs?: number,
): number {
  if (recurring) {
    const maxJitter = Math.min(delayMs * 0.1, MAX_JITTER_MS);
    return Math.floor(random() * maxJitter);
  }
  // One-shot thundering-herd mitigation: if the ACTUAL fire time lands on a
  // :00/:30 wall-clock minute, pull it up to 90s early. (Review fix: this
  // used to test `delayMs % 30min`, but a 30-minute delay from 10:07 fires
  // at 10:37 — the round-mark property belongs to the timestamp, not the
  // delay.)
  if (firesAtMs !== undefined && new Date(firesAtMs).getMinutes() % 30 === 0) {
    return -(Math.floor(random() * ONE_SHOT_JITTER_MS));
  }
  return 0;
}

export class WakeupScheduler {
  private readonly records = new Map<string, WakeupRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retries = new Map<string, number>();
  private readonly deps: Required<WakeupSchedulerDeps>;
  private disposed = false;

  constructor(deps: WakeupSchedulerDeps) {
    this.deps = {
      setTimer: deps.setTimer ?? setTimeout,
      clearTimer: deps.clearTimer ?? clearTimeout,
      random: deps.random ?? Math.random,
      ...deps,
    } as Required<WakeupSchedulerDeps>;
  }

  schedule(
    sessionId: string,
    input: {
      delaySeconds?: number;
      cronExpression?: string;
      message: string;
      reason: string;
      recurring?: boolean;
    },
  ): WakeupRecord {
    const pendingCount = this.listForSession(sessionId).filter(r => r.status === 'pending').length;
    if (pendingCount >= MAX_WAKEUPS_PER_SESSION) {
      throw new Error(`Max ${MAX_WAKEUPS_PER_SESSION} pending wakeups per session.`);
    }

    const now = this.deps.now();
    const recurring = input.recurring ?? false;
    let firesAt: number;
    let delaySeconds: number;

    if (input.cronExpression && input.delaySeconds !== undefined) {
      throw new Error('Provide cronExpression or delaySeconds, not both.');
    }

    if (input.cronExpression) {
      // Cron-based scheduling: compute next matching time
      const nextRun = computeNextCronRun(input.cronExpression, now);
      if (nextRun === null) {
        throw new Error('Invalid cron expression or no matching time found within scan window.');
      }
      firesAt = nextRun;
      delaySeconds = Math.round((nextRun - now) / 1000);
    } else if (input.delaySeconds !== undefined) {
      if (input.delaySeconds < 1 || input.delaySeconds > MAX_DELAY_SECONDS) {
        throw new Error(`delay_seconds must be between 1 and ${MAX_DELAY_SECONDS}.`);
      }
      delaySeconds = input.delaySeconds;
      const delayMs = delaySeconds * 1000;
      // Apply jitter to the initial fire time (round-mark check uses the
      // actual candidate timestamp, not the delay)
      const jitter = computeJitter(delayMs, recurring, this.deps.random, now + delayMs);
      const adjustedDelay = Math.max(0, delayMs + jitter);
      firesAt = now + adjustedDelay;
    } else {
      throw new Error('Either cronExpression or delaySeconds must be provided.');
    }

    const record: WakeupRecord = {
      id: this.deps.newId(),
      sessionId,
      message: input.message,
      reason: input.reason,
      scheduledAt: now,
      firesAt,
      delaySeconds,
      recurring,
      cronExpression: input.cronExpression,
      status: 'pending',
      expiresAt: recurring ? now + MAX_RECURRING_AGE_MS : null,
      fireAttempts: 0,
      deferredFires: [],
    };

    this.records.set(record.id, record);
    this.pruneSession(sessionId);
    this.scheduleTimer(record);
    return record;
  }

  cancel(wakeupId: string): boolean {
    const record = this.records.get(wakeupId);
    if (!record || record.status !== 'pending') return false;
    record.status = 'cancelled';
    const timer = this.timers.get(wakeupId);
    if (timer !== undefined) {
      this.deps.clearTimer(timer);
      this.timers.delete(wakeupId);
    }
    this.retries.delete(wakeupId);
    return true;
  }

  cancelAllForSession(sessionId: string): void {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && record.status === 'pending') {
        this.cancel(record.id);
      }
    }
  }

  listForSession(sessionId: string, opts?: { activeOnly?: boolean }): WakeupRecord[] {
    const all = [...this.records.values()].filter(r => r.sessionId === sessionId);
    if (opts?.activeOnly) {
      return all.filter(r => r.status === 'pending');
    }
    return all;
  }

  /**
   * Remove fired/expired/cancelled records for a session that exceed the cap.
   * Keeps all pending records; drops oldest terminal records first.
   */
  private pruneSession(sessionId: string): void {
    const sessionRecords = [...this.records.values()].filter(r => r.sessionId === sessionId);
    if (sessionRecords.length <= MAX_RECORDS_PER_SESSION) return;

    // Sort terminal records by scheduledAt ascending (oldest first)
    const terminal = sessionRecords
      .filter(r => r.status === 'fired' || r.status === 'expired' || r.status === 'cancelled')
      .sort((a, b) => a.scheduledAt - b.scheduledAt);

    const excess = sessionRecords.length - MAX_RECORDS_PER_SESSION;
    for (let i = 0; i < excess && i < terminal.length; i++) {
      this.records.delete(terminal[i].id);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      this.deps.clearTimer(timer);
    }
    for (const record of this.records.values()) {
      if (record.status === 'pending') record.status = 'cancelled';
    }
    this.timers.clear();
    this.records.clear();
    this.retries.clear();
  }

  private scheduleTimer(record: WakeupRecord): void {
    const delay = Math.max(0, record.firesAt - this.deps.now());
    const timer = this.deps.setTimer(() => {
      this.timers.delete(record.id);
      void this.fire(record);
    }, delay);
    this.timers.set(record.id, timer);
  }

  private async fire(record: WakeupRecord): Promise<void> {
    if (this.disposed) return;
    if (record.status !== 'pending') return;

    // Track fire attempts for idle-gate observability
    record.fireAttempts += 1;

    // Auto-expire check for recurring jobs
    if (record.recurring && record.expiresAt !== null) {
      const now = this.deps.now();
      if (now >= record.expiresAt) {
        record.status = 'expired';
        this.retries.delete(record.id);
        return;
      }
    }

    const canFire = await this.deps.canFire(record.sessionId).catch(() => false);
    // Re-check after async gap: cancel() or dispose() may have changed status
    if (record.status !== 'pending') return;
    if (!canFire) {
      // Idle-gate: log the deferred fire attempt
      record.deferredFires.push(this.deps.now());

      const retryCount = (this.retries.get(record.id) ?? 0) + 1;
      this.retries.set(record.id, retryCount);
      if (retryCount >= MAX_FIRE_RETRIES) {
        record.status = 'expired';
        this.retries.delete(record.id);
        return;
      }
      const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (retryCount - 1), BACKOFF_MAX_MS);
      const backoffTimer = this.deps.setTimer(() => {
        this.timers.delete(record.id);
        void this.fire(record);
      }, backoffMs);
      this.timers.set(record.id, backoffTimer);
      return;
    }

    record.status = 'fired';
    this.retries.delete(record.id);
    const turnId = this.deps.newId();
    this.deps.injectTurn(record.sessionId, {
      turnId,
      text: `[Scheduled wakeup: ${record.reason}]\n\n${record.message}`,
    });

    if (record.recurring) {
      const now = this.deps.now();

      // Check auto-expire before scheduling next occurrence
      if (record.expiresAt !== null && now >= record.expiresAt) {
        // Chain has expired; keep the terminal record for observability.
        record.status = 'expired';
        this.pruneSession(record.sessionId);
        return;
      }

      let nextFiresAt: number;
      let nextDelaySeconds: number;

      if (record.cronExpression) {
        // For cron-based recurring: compute the NEXT cron match after now
        const nextRun = computeNextCronRun(record.cronExpression, now);
        if (nextRun === null) {
          // No future match found — stop recurring; keep the terminal record.
          record.status = 'expired';
          this.pruneSession(record.sessionId);
          return;
        }
        nextFiresAt = nextRun;
        nextDelaySeconds = Math.round((nextRun - now) / 1000);
      } else {
        // Fixed-delay recurring: same delay as before, with jitter
        const delayMs = record.delaySeconds * 1000;
        const jitter = computeJitter(delayMs, true, this.deps.random);
        const adjustedDelay = Math.max(0, delayMs + jitter);
        nextFiresAt = now + adjustedDelay;
        nextDelaySeconds = record.delaySeconds;
      }

      // Reuse the same record in-place: update fields for next occurrence
      record.status = 'pending';
      record.scheduledAt = now;
      record.firesAt = nextFiresAt;
      record.delaySeconds = nextDelaySeconds;
      record.fireAttempts = 0;
      record.deferredFires = [];
      this.scheduleTimer(record);
    } else {
      // Non-recurring job: keep the fired record for observability
      // (list/CronList can show what just fired); pruneSession caps
      // per-session terminal history at MAX_RECORDS_PER_SESSION.
      this.pruneSession(record.sessionId);
    }
  }
}
