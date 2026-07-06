import { randomUUID } from 'node:crypto';
import { AutomationManager, AutomationScheduler, buildAutomationTool, type AutomationDefinition, type MakaTool } from '@maka/runtime';
import { createAutomationStore } from '@maka/storage';

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
  canFire: (sessionId: string) => Promise<boolean>;
  injectTurn: (sessionId: string, prompt: string, automationId: string) => void;
  createFreshRun?: (prompt: string, automationId: string) => void;
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
  })];

  const loadDurableAutomations = async (): Promise<void> => {
    const saved = await store.loadAll();
    manager.registerAll(saved);
  };

  return { manager, scheduler, tools, loadDurableAutomations };
}
