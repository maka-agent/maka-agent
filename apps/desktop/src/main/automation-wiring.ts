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

  const syncDurableToStore = (): void => {
    const all = manager.listAll().filter(a => a.durable && (a.status === 'active' || a.status === 'paused'));
    store.sync(all).catch(err => {
      console.warn('[automation-wiring] failed to sync durable automations to disk:', err);
    });
  };

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
    const saved = await store.loadAll();
    manager.registerAll(saved);
  };

  return { manager, scheduler, tools, loadDurableAutomations };
}

