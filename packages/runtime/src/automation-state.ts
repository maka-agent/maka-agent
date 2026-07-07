/**
 * Unified Automation — Codex-style automation system.
 *
 * Two kinds:
 * - "heartbeat": session-scoped polling (resume into same session)
 * - "cron": standalone scheduled runs (create fresh session each time)
 */

export type AutomationKind = 'heartbeat' | 'cron';
export type AutomationStatus = 'active' | 'paused' | 'completed' | 'expired';

export interface AutomationDefinition {
  id: string;
  kind: AutomationKind;
  name: string;
  status: AutomationStatus;
  prompt: string;
  sessionId: string;
  schedule: AutomationSchedule;
  createdAt: number;
  updatedAt: number;
  nextFireAt: number | null;
  lastFireAt: number | null;
  lastRunId: string | null;
  fireCount: number;
  maxFires: number | null;
  expiresAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** When true, this automation persists across app restarts. */
  durable?: boolean;
}

export type AutomationSchedule =
  | { type: 'cron'; expression: string }
  | { type: 'interval'; seconds: number }
  | { type: 'once'; delaySeconds: number };

export interface AutomationManagerDeps {
  generateId: () => string;
  now: () => number;
}

const MAX_AUTOMATIONS_PER_SESSION = 20;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_EXPIRY_DAYS = 7;

export class AutomationManager {
  private automations = new Map<string, AutomationDefinition>();

  constructor(private readonly deps: AutomationManagerDeps) {}

  create(input: {
    kind: AutomationKind;
    name: string;
    prompt: string;
    sessionId: string;
    schedule: AutomationSchedule;
    maxFires?: number;
    expiresAt?: number;
    durable?: boolean;
  }): AutomationDefinition | { error: string } {
    // Only count active/paused automations toward the limit (not completed/expired).
    const activeCount = this.listForSession(input.sessionId)
      .filter(a => a.status === 'active' || a.status === 'paused').length;
    if (activeCount >= MAX_AUTOMATIONS_PER_SESSION) {
      return { error: `Maximum ${MAX_AUTOMATIONS_PER_SESSION} active automations per session reached.` };
    }

    if (input.kind === 'heartbeat') {
      const existing = this.listForSession(input.sessionId)
        .filter(a => a.kind === 'heartbeat' && a.status === 'active');
      if (existing.length >= 5) {
        return { error: 'Maximum 5 active heartbeat automations per session.' };
      }
    }

    const now = this.deps.now();
    const id = this.deps.generateId();
    const nextFireAt = this.computeNextFire(input.schedule, now);

    if (nextFireAt === null && input.schedule.type === 'cron') {
      return { error: `Invalid cron expression: "${input.schedule.expression}". Could not compute next fire time.` };
    }

    const defaultExpiry = now + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

    // Cron is a standalone scheduled task (fresh session each run) — it is
    // meaningless if it dies on restart, so it defaults to durable. Heartbeat
    // resumes into its creator session, whose lifetime bounds it, so it stays
    // opt-in. An explicit `durable` value always wins.
    const durable = input.durable ?? input.kind === 'cron';

    const automation: AutomationDefinition = {
      id,
      kind: input.kind,
      name: input.name,
      status: 'active',
      prompt: input.prompt,
      sessionId: input.sessionId,
      schedule: input.schedule,
      createdAt: now,
      updatedAt: now,
      nextFireAt,
      lastFireAt: null,
      lastRunId: null,
      fireCount: 0,
      maxFires: input.maxFires ?? null,
      expiresAt: input.expiresAt ?? defaultExpiry,
      lastError: null,
      consecutiveFailures: 0,
      ...(durable ? { durable: true } : {}),
    };

    this.automations.set(id, automation);
    this.pruneTerminal(input.sessionId);
    return automation;
  }

  get(id: string): AutomationDefinition | undefined {
    return this.automations.get(id);
  }

  delete(id: string, sessionId?: string): boolean {
    const automation = this.automations.get(id);
    if (!automation) return false;
    if (sessionId && automation.sessionId !== sessionId) return false;
    this.automations.delete(id);
    return true;
  }

  pause(id: string, sessionId: string): AutomationDefinition | undefined {
    const automation = this.automations.get(id);
    if (!automation || automation.sessionId !== sessionId) return undefined;
    if (automation.status !== 'active') return undefined;
    automation.status = 'paused';
    automation.updatedAt = this.deps.now();
    return automation;
  }

  resume(id: string, sessionId: string): AutomationDefinition | undefined {
    const automation = this.automations.get(id);
    if (!automation || automation.sessionId !== sessionId) return undefined;
    if (automation.status !== 'paused') return undefined;
    // Refuse to resume an automation whose fire budget is already spent. A
    // maxFires-exhausted (or a one-shot that already fired) automation only
    // reaches 'paused' via the attemptFailed path, which leaves nextFireAt=null.
    // Re-arming it here would grant a fire beyond the declared hard cap — the
    // next tick would bump fireCount past maxFires (or re-fire a 'once'),
    // spawning a real extra run. maxFires is a cap on ATTEMPTS, so a spent
    // budget cannot be revived by resume.
    if (automation.maxFires && automation.fireCount >= automation.maxFires) return undefined;
    if (automation.schedule.type === 'once' && automation.fireCount > 0) return undefined;
    automation.status = 'active';
    automation.updatedAt = this.deps.now();
    automation.nextFireAt = this.computeNextFire(automation.schedule, this.deps.now());
    return automation;
  }

  listForSession(sessionId: string): AutomationDefinition[] {
    return [...this.automations.values()].filter(a => a.sessionId === sessionId);
  }

  listActive(): AutomationDefinition[] {
    return [...this.automations.values()].filter(a => a.status === 'active');
  }

  /**
   * Mark an expired automation terminal. Returns true if it was expired.
   * Used by the scheduler's eager expiry sweep.
   */
  sweepExpired(id: string): boolean {
    const automation = this.automations.get(id);
    if (!automation || automation.status !== 'active') return false;
    const now = this.deps.now();
    if (automation.expiresAt && now >= automation.expiresAt) {
      automation.status = 'expired';
      automation.nextFireAt = null;
      automation.updatedAt = now;
      return true;
    }
    return false;
  }

  /**
   * Begin a fire attempt: advance the schedule and counters, but do NOT commit
   * terminal completion — that happens only on a real success (attemptSucceeded).
   * Checks expiry first. Returns the automation if it should fire, else undefined.
   */
  attemptStarted(id: string): AutomationDefinition | undefined {
    const automation = this.automations.get(id);
    if (!automation || automation.status !== 'active') return undefined;

    const now = this.deps.now();
    // Check expiry BEFORE firing — don't execute expired automations.
    if (automation.expiresAt && now >= automation.expiresAt) {
      automation.status = 'expired';
      automation.nextFireAt = null;
      automation.updatedAt = now;
      return undefined;
    }

    automation.lastFireAt = now;
    automation.fireCount++;
    automation.updatedAt = now;

    // A one-shot does not auto-retry: null its nextFireAt now. A recurring job
    // advances to its next slot. Completion (once / maxFires) is committed only
    // after a successful outcome in attemptSucceeded.
    automation.nextFireAt = automation.schedule.type === 'once'
      ? null
      : this.computeNextFire(automation.schedule, now);

    // maxFires is a hard cap on the number of fire ATTEMPTS: once this attempt
    // reaches the cap, no further fire is scheduled — regardless of whether this
    // one ultimately succeeds or fails. (Terminal status is still committed by
    // attemptSucceeded/attemptFailed based on this attempt's outcome.) Without
    // this, a failing recurring automation would keep firing past maxFires until
    // the consecutive-failure cap, and fireCount could exceed maxFires.
    if (automation.maxFires && automation.fireCount >= automation.maxFires) {
      automation.nextFireAt = null;
    }

    return automation;
  }

  /**
   * Skip a fire without executing — advance to next schedule time.
   * Used when the session is busy for too long.
   */
  skipFire(id: string): void {
    const automation = this.automations.get(id);
    if (!automation || automation.status !== 'active') return;
    const now = this.deps.now();
    automation.nextFireAt = this.computeNextFire(automation.schedule, now);
    automation.updatedAt = now;
  }

  /**
   * Commit a successful fire outcome: reset failure state, record the run id,
   * and NOW apply completion (once / maxFires reached).
   */
  attemptSucceeded(id: string, runId?: string): void {
    const automation = this.automations.get(id);
    if (!automation) return;
    if (automation.status !== 'active') return;
    automation.consecutiveFailures = 0;
    automation.lastError = null;
    if (runId) automation.lastRunId = runId;
    automation.updatedAt = this.deps.now();

    if (automation.schedule.type === 'once') {
      automation.status = 'completed';
      automation.nextFireAt = null;
    } else if (automation.maxFires && automation.fireCount >= automation.maxFires) {
      automation.status = 'completed';
      automation.nextFireAt = null;
    }
  }

  /**
   * Record a failed fire outcome. Accumulates toward the consecutive-failure
   * cap (→ paused). A one-shot that fails has no next fire, so it is paused so
   * it is visible rather than a silent idle zombie.
   */
  attemptFailed(id: string, error: string): void {
    const automation = this.automations.get(id);
    if (!automation) return;
    if (automation.status !== 'active') return;
    automation.consecutiveFailures++;
    automation.lastError = error;
    automation.updatedAt = this.deps.now();

    if (automation.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      automation.status = 'paused';
    } else if (automation.nextFireAt === null) {
      // Nothing will fire this again (one-shot failure) — pause so it is a
      // visible terminal-ish state, not a silent zombie.
      automation.status = 'paused';
    }
  }

  removeAllForSession(sessionId: string): number {
    let count = 0;
    for (const [id, auto] of this.automations) {
      if (auto.sessionId === sessionId && auto.kind === 'heartbeat') {
        this.automations.delete(id);
        count++;
      }
    }
    return count;
  }

  dispose(): void {
    this.automations.clear();
  }

  /** Bulk-register pre-existing automations (e.g. loaded from durable store on startup). */
  registerAll(automations: AutomationDefinition[]): void {
    for (const automation of automations) {
      this.automations.set(automation.id, automation);
    }
  }

  /** Return all automations (all statuses, all sessions). */
  listAll(): AutomationDefinition[] {
    return [...this.automations.values()];
  }

  /** Remove completed/expired automations beyond a small grace buffer. */
  private pruneTerminal(sessionId: string): void {
    const terminal = this.listForSession(sessionId)
      .filter(a => a.status === 'completed' || a.status === 'expired');
    const MAX_TERMINAL_KEPT = 5;
    if (terminal.length <= MAX_TERMINAL_KEPT) return;
    terminal.sort((a, b) => a.updatedAt - b.updatedAt);
    for (let i = 0; i < terminal.length - MAX_TERMINAL_KEPT; i++) {
      this.automations.delete(terminal[i].id);
    }
  }

  private computeNextFire(schedule: AutomationSchedule, fromTime: number): number | null {
    switch (schedule.type) {
      case 'once':
        return fromTime + schedule.delaySeconds * 1000;
      case 'interval':
        return fromTime + schedule.seconds * 1000;
      case 'cron':
        return computeNextCronFire(schedule.expression, fromTime);
    }
  }
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Upper bound on the minute-by-minute search window.
 *
 * A valid but sparse cron such as `0 0 29 2 *` (Feb 29, leap years only) can be
 * several years out. The maximum gap between two consecutive Feb 29ths is
 * 8 years: a century year that is not divisible by 400 (e.g. 2100, 2200) is NOT
 * a leap year, so the sequence 2096 -> 2104 skips 2100 entirely. Searching a
 * full ~8-year window guarantees every legally-satisfiable expression resolves,
 * while the bound still lets genuinely-impossible expressions (e.g.
 * `0 0 30 2 *`, Feb 30 never exists) terminate and return null instead of
 * looping forever.
 */
const MAX_SEARCH_MINUTES = 8 * 366 * MINUTES_PER_DAY; // ~8 years, bounded

/**
 * Compute the next Unix-ms timestamp at which a 5-field cron expression fires,
 * strictly after `fromTime`. Returns null for a malformed expression or one
 * that cannot occur within the bounded search window.
 *
 * TIMEZONE CONTRACT: evaluation happens in the HOST's local timezone. Candidate
 * instants are decomposed with `Date` local getters (`getMinutes`, `getHours`,
 * `getDate`, `getMonth`, `getDay`), so `0 9 * * *` means "09:00 local wall-clock
 * time" on the machine running this process. Across DST transitions the wall
 * clock is respected (a skipped/repeated local hour shifts the fire instant
 * accordingly). There is no per-automation IANA timezone; if the process moves
 * timezones, schedules re-anchor to the new local time. Threading an explicit
 * IANA zone would ripple through the schedule type and every caller, so it is
 * intentionally out of scope for this parser.
 */
export function computeNextCronFire(expression: string, fromTime: number): number | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  // Vixie-cron day semantics: when BOTH the day-of-month and day-of-week fields
  // are restricted (neither is "*"), a day matches if it satisfies EITHER field
  // (OR) — e.g. `0 0 13 * 5` fires on the 13th of any month OR on any Friday,
  // NOT only on Friday the 13th. When at least one field is "*", that field
  // matches every value, so the two are combined with AND (the "*" field is a
  // no-op and only the other constrains).
  const domIsStar = domField === '*';
  const dowIsStar = dowField === '*';
  const bothDayFieldsRestricted = !domIsStar && !dowIsStar;

  // Zero out seconds/ms for clean minute boundaries.
  const fromDate = new Date(fromTime);
  fromDate.setSeconds(0, 0);
  const baseTime = fromDate.getTime() + 60000; // start from next minute

  for (let attempt = 0; attempt < MAX_SEARCH_MINUTES; attempt++) {
    const candidateTime = baseTime + attempt * 60000;
    const candidate = new Date(candidateTime);

    // Cheapest, most-selective checks first so most candidates are pruned before
    // the day-field matching runs.
    if (!matchesCronField(minuteField, candidate.getMinutes(), 0, 59)) continue;
    if (!matchesCronField(hourField, candidate.getHours(), 0, 23)) continue;
    if (!matchesCronField(monthField, candidate.getMonth() + 1, 1, 12)) continue;

    const domMatch = matchesCronField(domField, candidate.getDate(), 1, 31);
    // Day-of-week: cron allows both 0 and 7 for Sunday, but Date.getDay() only
    // returns 0-6 (0=Sunday). Match against the raw value, plus the 7-alias when
    // the day is Sunday, so fields like "7", "5-7", "0,7" all fire on Sundays.
    const dow = candidate.getDay();
    const dowMatch = matchesCronField(dowField, dow, 0, 7)
      || (dow === 0 && matchesCronField(dowField, 7, 0, 7));
    const dayMatch = bothDayFieldsRestricted
      ? domMatch || dowMatch // OR when both are constrained
      : domMatch && dowMatch; // AND when one is "*"

    if (dayMatch) return candidateTime;
  }
  return null;
}

export function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      let start = min;
      let end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          const [lo, hi] = range.split('-').map(Number);
          if (isNaN(lo) || isNaN(hi)) continue;
          start = lo;
          end = hi;
        } else {
          start = parseInt(range, 10);
          if (isNaN(start)) continue;
        }
      }
      if (value >= start && value <= end && (value - start) % step === 0) return true;
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

export { MAX_AUTOMATIONS_PER_SESSION, MAX_CONSECUTIVE_FAILURES, DEFAULT_EXPIRY_DAYS };
