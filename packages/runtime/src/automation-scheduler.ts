/**
 * Automation scheduler — manages a tick loop that fires active automations.
 *
 * Fixes applied from adversarial review:
 * - canFire errors are caught per-automation (don't abort the whole tick)
 * - injectTurn/createFreshRun failures properly mark the automation as failed
 * - Defer-skip advances nextFireAt via skipFire() instead of looping forever
 * - deferCounts are pruned when automations disappear
 * - dispose() sets flag checked in async paths to prevent post-dispose execution
 * - Uses deps.now() consistently (injectable for testing)
 */

import type { AutomationDefinition, AutomationManager } from './automation-state.js';

/** Outcome of a dispatched fire, decided only after the run's stream finishes. */
export interface AutomationFireResult {
  /** The run/turn id the fire produced (for attribution / lastRunId). */
  runId?: string;
  /** Whether the run completed successfully (no error / abort). */
  ok: boolean;
  /** Failure reason when !ok. */
  error?: string;
}

export interface AutomationSchedulerDeps {
  automationManager: AutomationManager;
  canFire: (sessionId: string) => Promise<boolean>;
  /**
   * Inject a turn into the automation's own session (heartbeat kind).
   * Resolves with the run outcome AFTER the turn's stream finishes.
   */
  injectTurn: (sessionId: string, prompt: string, automationId: string) => Promise<AutomationFireResult>;
  /**
   * Spawn a fresh session and run the prompt there (cron kind).
   * Resolves with the run outcome AFTER the run's stream finishes.
   * When absent, the host does not support cron and cron fires fail.
   */
  createFreshRun?: (prompt: string, automationId: string) => Promise<AutomationFireResult>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  now?: () => number;
  onStateChange?: () => void;
}

const FIRE_CHECK_INTERVAL_MS = 5000; // 5s tick (must be < minimum interval of 10s)
const MAX_DEFER_RETRIES = 24; // 24 * 5s tick = ~120s max wait for idle

export class AutomationScheduler {
  private tickTimer: unknown = null;
  private disposed = false;
  private deferCounts = new Map<string, number>();
  /** Automation ids whose fire is currently executing (prevents concurrent re-fire). */
  private inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: AutomationSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.disposed) return;
    this.scheduleTick();
  }

  stop(): void {
    if (this.tickTimer !== null) {
      this.deps.clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.deferCounts.clear();
    this.inFlight.clear();
  }

  private scheduleTick(): void {
    if (this.disposed) return;
    this.tickTimer = this.deps.setTimeout(() => {
      if (this.disposed) return;
      this.checkAndFire().catch(() => {}).finally(() => {
        if (!this.disposed) this.scheduleTick();
      });
    }, FIRE_CHECK_INTERVAL_MS);
  }

  private async checkAndFire(): Promise<void> {
    const now = this.now();
    const active = this.deps.automationManager.listActive();

    // Prune deferCounts for automations that no longer exist.
    const activeIds = new Set(active.map(a => a.id));
    for (const id of this.deferCounts.keys()) {
      if (!activeIds.has(id)) this.deferCounts.delete(id);
    }

    // Eager expiry sweep: expire automations whose expiresAt has passed,
    // regardless of nextFireAt. Prevents zombie-active entries.
    let sweptAny = false;
    for (const automation of active) {
      if (automation.expiresAt && now >= automation.expiresAt) {
        if (this.deps.automationManager.sweepExpired(automation.id)) sweptAny = true;
      }
    }
    if (sweptAny) this.deps.onStateChange?.();

    // Re-fetch active list after expiry sweep.
    const stillActive = this.deps.automationManager.listActive();
    for (const automation of stillActive) {
      if (this.disposed) return;
      if (!automation.nextFireAt || automation.nextFireAt > now) continue;
      await this.attemptFire(automation);
    }
  }

  private async attemptFire(automation: AutomationDefinition): Promise<void> {
    if (this.disposed) return;

    // In-flight guard: a fire whose run is still executing must not be started
    // again. canFire protects heartbeat (its run occupies the automation's own
    // session), but NOT cron (createFreshRun spawns a separate session, leaving
    // the creator session idle), so a cron whose run outlasts its cadence would
    // otherwise re-fire every tick — spawning duplicate sessions, blowing past
    // maxFires, and committing outcomes out of order. This guard closes that
    // window for every kind, independent of canFire.
    if (this.inFlight.has(automation.id)) return;

    let canFire: boolean;
    try {
      canFire = await this.deps.canFire(automation.sessionId);
    } catch {
      // canFire failure: skip this automation this tick, don't crash the loop.
      return;
    }

    if (this.disposed) return;
    // Re-check the guard after the async canFire (another tick may have started).
    if (this.inFlight.has(automation.id)) return;

    if (!canFire) {
      const deferCount = (this.deferCounts.get(automation.id) ?? 0) + 1;
      if (deferCount >= MAX_DEFER_RETRIES) {
        this.deferCounts.delete(automation.id);
        // Skip this fire entirely — advance to next scheduled time.
        this.deps.automationManager.skipFire(automation.id);
        this.deps.onStateChange?.();
        return;
      }
      this.deferCounts.set(automation.id, deferCount);
      return;
    }

    this.deferCounts.delete(automation.id);

    // Cron without an executor cannot run — fail fast, do not advance the fire.
    if (automation.kind === 'cron' && !this.deps.createFreshRun) {
      this.deps.automationManager.attemptFailed(automation.id, 'Cron execution not configured (createFreshRun unavailable)');
      this.deps.onStateChange?.();
      return;
    }

    const started = this.deps.automationManager.attemptStarted(automation.id);
    if (!started) {
      this.deps.onStateChange?.();
      return;
    }
    // Persist the started state (fireCount/nextFireAt advanced) immediately.
    this.deps.onStateChange?.();

    const id = automation.id;
    this.inFlight.add(id);
    // Dispatch WITHOUT awaiting the tick — the run resolves its outcome later.
    // The outcome (success/failure) is committed only after the stream finishes,
    // so a failed or aborted fire is never recorded as a success.
    const dispatch = automation.kind === 'heartbeat'
      ? this.deps.injectTurn(automation.sessionId, `[Automation: ${automation.name}]\n\n${automation.prompt}`, id)
      : this.deps.createFreshRun!(automation.prompt, id);

    void dispatch.then((result) => {
      this.inFlight.delete(id);
      if (this.disposed) return;
      if (result.ok) {
        this.deps.automationManager.attemptSucceeded(id, result.runId);
      } else {
        this.deps.automationManager.attemptFailed(id, result.error ?? 'Automation run failed');
      }
      this.deps.onStateChange?.();
    }).catch((err) => {
      this.inFlight.delete(id);
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.deps.automationManager.attemptFailed(id, message);
      this.deps.onStateChange?.();
    });
  }
}

export { FIRE_CHECK_INTERVAL_MS, MAX_DEFER_RETRIES };

