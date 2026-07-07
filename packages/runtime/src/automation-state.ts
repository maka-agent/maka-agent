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
      ...(input.durable ? { durable: true } : {}),
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

export function computeNextCronFire(expression: string, fromTime: number): number | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minuteField, hourField, domField, monthField, dowField] = fields;
  // Zero out seconds/ms for clean minute boundaries.
  const fromDate = new Date(fromTime);
  fromDate.setSeconds(0, 0);
  const baseTime = fromDate.getTime() + 60000; // start from next minute

  for (let attempt = 0; attempt < 527040; attempt++) {
    const candidateTime = baseTime + attempt * 60000;
    const candidate = new Date(candidateTime);
    const minute = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const month = candidate.getMonth() + 1;
    const dow = candidate.getDay();

    if (
      matchesCronField(minuteField, minute, 0, 59) &&
      matchesCronField(hourField, hour, 0, 23) &&
      matchesCronField(domField, dom, 1, 31) &&
      matchesCronField(monthField, month, 1, 12) &&
      matchesCronField(dowField, dow, 0, 6)
    ) {
      return candidateTime;
    }
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
