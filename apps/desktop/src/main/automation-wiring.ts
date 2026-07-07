import { randomUUID } from 'node:crypto';
import { AutomationManager, AutomationScheduler, buildAutomationTool, type AutomationDefinition, type AutomationFireResult, type MakaTool } from '@maka/runtime';
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
  canFire: (automation: AutomationDefinition) => Promise<boolean>;
  /** Inject a turn into the automation's session; resolves after the stream finishes. */
  injectTurn: (sessionId: string, prompt: string, automationId: string) => Promise<AutomationFireResult>;
  /** Spawn a fresh session + run (cron); resolves after the stream finishes. Omit to disable cron. */
  createFreshRun?: (prompt: string, automationId: string) => Promise<AutomationFireResult>;
}

/** Minimal session-header shape the fire gate reads. */
export interface CanFireSessionHeader { archivedAt?: number | null; status: string }

export interface EvaluateAutomationCanFireDeps {
  /** Global privacy gate — true blocks every kind. */
  isIncognitoActive: () => Promise<boolean>;
  /** Reads the session header; may THROW if the session file is gone (deleted). */
  readSessionHeader: (sessionId: string) => Promise<CanFireSessionHeader | null>;
  /** Session statuses a heartbeat may fire into (idle). */
  idleStatuses: ReadonlySet<string>;
}

/**
 * Decide whether an automation may fire now. Kind-aware:
 * - Global privacy (incognito) blocks every kind.
 * - Cron spawns a FRESH session, so its creator session is irrelevant — it is
 *   never gated on that session. This is what lets a durable cron keep firing
 *   after the conversation that created it is archived or deleted.
 * - Heartbeat injects into its own session, so that session must exist (reading
 *   it must not throw) and be idle (not archived, an idle status).
 * Pure and injectable so the gate is unit-testable without Electron/disk.
 */
export async function evaluateAutomationCanFire(
  automation: Pick<AutomationDefinition, 'kind' | 'sessionId'>,
  deps: EvaluateAutomationCanFireDeps,
): Promise<boolean> {
  if (await deps.isIncognitoActive()) return false;
  if (automation.kind === 'cron') return true;
  let header: CanFireSessionHeader | null;
  try {
    header = await deps.readSessionHeader(automation.sessionId);
  } catch {
    return false; // session file gone (deleted) → nothing to inject into
  }
  if (!header || header.archivedAt) return false;
  return deps.idleStatuses.has(header.status);
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

