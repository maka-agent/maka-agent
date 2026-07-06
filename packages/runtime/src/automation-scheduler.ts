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

export interface AutomationSchedulerDeps {
  automationManager: AutomationManager;
  canFire: (sessionId: string) => Promise<boolean>;
  injectTurn: (sessionId: string, prompt: string, automationId: string) => void;
  createFreshRun?: (prompt: string, automationId: string) => void;
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
    for (const automation of active) {
      if (automation.expiresAt && now >= automation.expiresAt) {
        this.deps.automationManager.markFired(automation.id);
      }
    }

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

    let canFire: boolean;
    try {
      canFire = await this.deps.canFire(automation.sessionId);
    } catch {
      // canFire failure: skip this automation this tick, don't crash the loop.
      return;
    }

    if (this.disposed) return;

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
    const fired = this.deps.automationManager.markFired(automation.id);
    if (!fired) {
      this.deps.onStateChange?.();
      return;
    }

    try {
      if (automation.kind === 'heartbeat') {
        this.deps.injectTurn(
          automation.sessionId,
          `[Automation: ${automation.name}]\n\n${automation.prompt}`,
          automation.id,
        );
      } else if (automation.kind === 'cron') {
        if (!this.deps.createFreshRun) {
          this.deps.automationManager.markFailure(automation.id, 'Cron execution not configured (createFreshRun unavailable)');
          return;
        }
        this.deps.createFreshRun(automation.prompt, automation.id);
      }
      this.deps.automationManager.markSuccess(automation.id);
      this.deps.onStateChange?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.automationManager.markFailure(automation.id, message);
      this.deps.onStateChange?.();
    }
  }
}

export { FIRE_CHECK_INTERVAL_MS, MAX_DEFER_RETRIES };
