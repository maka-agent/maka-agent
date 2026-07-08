import { randomUUID } from 'node:crypto';
import { AutomationManager, AutomationScheduler, buildAutomationTool, type AutomationDefinition, type AutomationFireResult, type MakaTool } from '@maka/runtime';
import { createAutomationStore } from '@maka/storage';

// The kind-aware fire gate lives in @maka/runtime so the desktop and CLI hosts
// share one definition and cannot diverge. Re-exported for existing importers.
export { evaluateAutomationCanFire, HEARTBEAT_IDLE_STATUSES } from '@maka/runtime';
export type { CanFireSessionHeader, EvaluateAutomationCanFireDeps } from '@maka/runtime';

/**
 * Unified Automation wiring for the desktop main process.
 */
export interface MainAutomationWiring {
  manager: AutomationManager;
  scheduler: AutomationScheduler;
  tools: MakaTool[];
  /** Load durable automations from disk and register them. Call once at startup. */
  loadDurableAutomations: () => Promise<void>;
}

export interface CreateMainAutomationWiringDeps {
  workspaceRoot: string;
  canFire: (automation: AutomationDefinition) => Promise<boolean>;
  /** Inject a turn into the automation's session; resolves after the stream finishes. */
  injectTurn: (sessionId: string, prompt: string, automationId: string) => Promise<AutomationFireResult>;
  /** Spawn a fresh session + run (cron); resolves after the stream finishes. Omit to disable cron. */
  createFreshRun?: (prompt: string, automationId: string) => Promise<AutomationFireResult>;
}

export function createMainAutomationWiring(deps: CreateMainAutomationWiringDeps): MainAutomationWiring {
  const manager = new AutomationManager({
    generateId: () => randomUUID(),
    now: () => Date.now(),
  });

  const store = createAutomationStore<AutomationDefinition>(deps.workspaceRoot);

  // Durable persistence is tied to cron capability: only a host that can run
  // crons (createFreshRun present) owns durable automations and may load/write
  // the shared automations.json. A cron-disabled host has no durable state of
  // its own and must never overwrite the store (its full-file sync would clobber
  // the owning host's crons). The desktop always provides createFreshRun; this
  // gate keeps the invariant explicit and symmetric with the CLI.
  const cronEnabled = deps.createFreshRun !== undefined;

  // If we fail to READ the existing durable store, we must not WRITE over it — a
  // full-overwrite sync would erase crons we never loaded. Disable persistence
  // (loudly) until the next restart re-reads successfully.
  let durableStoreReadable = true;

  const syncDurableToStore = cronEnabled
    ? (): void => {
        if (!durableStoreReadable) return;
        const all = manager.listAll().filter(a => a.durable && (a.status === 'active' || a.status === 'paused'));
        store.sync(all).catch(err => {
          console.warn('[automation-wiring] failed to sync durable automations to disk:', err);
        });
      }
    : (): void => { /* no durable automations to persist on a cron-disabled host */ };

  const scheduler = new AutomationScheduler({
    automationManager: manager,
    canFire: deps.canFire,
    injectTurn: deps.injectTurn,
    createFreshRun: deps.createFreshRun,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onStateChange: syncDurableToStore,
  });

  const tools = [buildAutomationTool({
    automationManager: manager,
    onAutomationChange: syncDurableToStore,
    // Only advertise the cron kind when the host can actually spawn fresh runs.
    cronEnabled: deps.createFreshRun !== undefined,
  })];

  const loadDurableAutomations = async (): Promise<void> => {
    if (!cronEnabled) return; // a cron-disabled host must not adopt/reconcile crons it doesn't own
    try {
      const saved = await store.loadAll();
      manager.registerAll(saved);
    } catch (err) {
      // Could not read the existing durable state — disable persistence so a
      // later create/mutate cannot overwrite (and erase) the unread crons.
      durableStoreReadable = false;
      console.error('[automation-wiring] durable automation store unreadable; persistence disabled to avoid data loss:', err);
    }
  };

  return { manager, scheduler, tools, loadDurableAutomations };
}

