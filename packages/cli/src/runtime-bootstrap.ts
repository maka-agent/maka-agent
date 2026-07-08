import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AiSdkBackend,
  AutomationManager,
  AutomationScheduler,
  BackendRegistry,
  PermissionEngine,
  SessionManager,
  ShellRunProcessManager,
  buildAutomationTool,
  buildBuiltinTools,
  buildDefaultContextBudgetPolicy,
  buildLlmHistorySummarizer,
  buildProviderOptions,
  buildSubscriptionModelFetch,
  evaluateAutomationCanFire,
  getAIModel,
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
  type AutomationDefinition,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createArtifactStore,
  createAutomationStore,
  createConnectionStore,
  createFileCredentialStore,
  createRuntimeEventStore,
  createSessionStore,
  createSettingsStore,
  createShellRunStore,
} from '@maka/storage';
import type { ReadySessionTarget } from './connection-target.js';
import { resolveDefaultSessionTarget } from './connection-target.js';
import { buildCliSystemPrompt, buildCliTurnTailPrompt } from './cli-system-prompt.js';

export interface MakaCliRuntimeContext {
  workspaceRoot: string;
  cwd: string;
  runtime: SessionManager;
  target: ReadySessionTarget;
  tools: ReturnType<typeof buildBuiltinTools>;
  automationManager: AutomationManager;
  automationScheduler: AutomationScheduler;
  close(): Promise<void>;
}

export interface CreateMakaCliRuntimeContextInput {
  workspaceRoot: string;
  cwd: string;
  requestedModel?: string;
  /**
   * Optional cron executor. When provided, the Automation tool advertises the
   * cron kind and cron fires spawn a fresh session + run via this callback
   * (reviewer G1: a host derives cron support from the executor it passes in).
   * Omitted by the default CLI (no multi-session surface) — heartbeat only.
   */
  automationCreateFreshRun?: (prompt: string, automationId: string) => Promise<import('@maka/runtime').AutomationFireResult>;
}

export interface GetOrCreateCliClaudeDeviceIdDeps {
  newId?: () => string;
}

export function isMakaClaudeSubscriptionCloakEnabled(
  env: { MAKA_CLAUDE_SUBSCRIPTION_CLOAK?: string } = process.env,
): boolean {
  return env.MAKA_CLAUDE_SUBSCRIPTION_CLOAK !== '0';
}

export async function createMakaCliRuntimeContext(
  input: CreateMakaCliRuntimeContextInput,
): Promise<MakaCliRuntimeContext> {
  const store = createSessionStore(input.workspaceRoot);
  const runStore = createAgentRunStore(input.workspaceRoot);
  const runtimeEventStore = createRuntimeEventStore(input.workspaceRoot);
  const shellRunStore = createShellRunStore(input.workspaceRoot);
  const artifactStore = createArtifactStore(input.workspaceRoot);
  const connectionStore = createConnectionStore(input.workspaceRoot);
  const credentialStore = createFileCredentialStore(input.workspaceRoot);
  const settingsStore = createSettingsStore(input.workspaceRoot);
  const target = await resolveDefaultSessionTarget({
    connectionStore,
    credentialStore,
    requestedModel: input.requestedModel,
  });
  const permissionEngine = new PermissionEngine({ newId: randomUUID, now: Date.now });
  const backends = new BackendRegistry();
  const shellRuns = new ShellRunProcessManager({
    store: shellRunStore,
    newId: randomUUID,
    now: Date.now,
  });
  const tools = buildBuiltinTools({ shellRuns });
  const automationManager = new AutomationManager({
    generateId: () => randomUUID(),
    now: () => Date.now(),
  });
  // Durable persistence is tied to cron capability. A cron-disabled host is
  // heartbeat-only, and heartbeats are never durable — so it has NO durable
  // automations of its own. Critically, the CLI shares the desktop's workspace
  // (resolveMakaWorkspaceRoot reconstructs the Electron userData path), so its
  // automations.json IS the desktop's. store.sync() is a full-file overwrite,
  // so a heartbeat-only CLI writing its (empty) durable list would erase the
  // desktop's crons, and loading+reconciling crons it can't run would mutate
  // them. It therefore does neither — it leaves durable state entirely to the
  // host that owns it. (Two cron-enabled hosts sharing a store is the separate,
  // still-deferred leader-lock concern.)
  const cronEnabled = input.automationCreateFreshRun !== undefined;
  const automationStore = createAutomationStore<AutomationDefinition>(input.workspaceRoot);
  // If the durable store fails to READ, we must not WRITE over it (a full sync
  // would erase unread crons). Disable persistence loudly until restart.
  let durableStoreReadable = true;
  const syncAutomations = cronEnabled
    ? (): void => {
        if (!durableStoreReadable) return;
        const durable = automationManager.listAll().filter(a => a.durable && (a.status === 'active' || a.status === 'paused'));
        automationStore.sync(durable).catch(err => {
          console.warn('[runtime-bootstrap] failed to persist durable automations:', err);
        });
      }
    : (): void => { /* heartbeat-only host owns no durable automations; never overwrite the shared store */ };
  const automationTool = buildAutomationTool({
    automationManager,
    onAutomationChange: syncAutomations,
    cronEnabled,
  });

  const allTools = [...tools, automationTool];

  // Load durable automations only on a host that can run them — a cron-disabled
  // host must not adopt/reconcile crons it doesn't own (see above).
  if (cronEnabled) {
    try {
      const saved = await automationStore.loadAll();
      automationManager.registerAll(saved);
    } catch (err) {
      durableStoreReadable = false;
      console.error('[runtime-bootstrap] durable automation store unreadable; persistence disabled to avoid data loss:', err);
    }
  }

  backends.register('ai-sdk', async (ctx) => {
    const ready = await resolveDefaultSessionTarget({
      connectionStore,
      credentialStore,
      requestedModel: ctx.header.model,
    });
    const modelFetch = buildSubscriptionModelFetch({
      connection: ready.connection,
      sessionId: ctx.sessionId,
      modelId: ready.model,
      ...(ready.connection.providerType === 'claude-subscription' ? {
        claude: {
          cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
          deviceId: await getOrCreateCliClaudeDeviceId(input.workspaceRoot),
          accountUuid: ready.oauthTokens?.account_uuid ?? '',
        },
      } : {}),
    });
    return new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...ctx.header, model: ready.model },
      appendMessage: ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
      connection: ready.connection,
      apiKey: ready.apiKey,
      modelId: ready.model,
      permissionEngine,
      modelFactory: (modelInput) => getAIModel({ ...modelInput, fetch: modelFetch }),
      tools: allTools,
      providerOptions: buildProviderOptions(ready.connection, ready.model, ctx.header.thinkingLevel),
      contextBudget: buildDefaultContextBudgetPolicy(ready.connection, {
        name: 'cli-default-history-budget',
        modelId: ready.model,
      }),
      loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
      writeHistoryCompact: (event) => persistHistoryCompactBlocksToArtifacts(artifactStore, event, {
        summarize: buildLlmHistorySummarizer({
          // Reuse the same connection/model the session already drives, so the
          // summary stays consistent with the model that will consume it.
          resolveModel: () =>
            getAIModel({
              connection: ready.connection,
              apiKey: ready.apiKey,
              modelId: ready.model,
              fetch: modelFetch,
            }),
          maxOutputTokens: 4096,
        }),
      }),
      systemPrompt: async ({ cwd }) => {
        const settings = await settingsStore.get();
        return buildCliSystemPrompt({ settings, cwd });
      },
      turnTailPrompt: ({ cwd }) => buildCliTurnTailPrompt({ cwd, sessionId: ctx.sessionId, automationManager }),
      shellRunContextSummary: ctx.shellRunContextSummary,
      newId: randomUUID,
      now: Date.now,
    });
  });

  const runtime = new SessionManager({
    store,
    runStore,
    runtimeEventStore,
    shellRuns,
    backends,
    newId: randomUUID,
    now: Date.now,
  });
  await runtime.recoverInterruptedSessions();

  const automationScheduler = new AutomationScheduler({
    automationManager,
    canFire: (automation) => evaluateAutomationCanFire(automation, {
      // The CLI has no incognito UI, but the setting is shared — honour it if set.
      isIncognitoActive: async () => (await settingsStore.get()).privacy?.incognitoActive === true,
      readSessionHeader: (sessionId) => store.readHeader(sessionId),
      // Default idle set {active, done, waiting_for_user} — a session parked
      // waiting for the user IS the wakeup's home scenario (#639): the
      // heartbeat starts a turn in place of the user. It still never fires
      // into a 'running' (mid-turn) session.
      // Cron is disabled here (createFreshRun omitted); the scheduler ignores it.
    }),
    // Heartbeat: inject into the automation's session; resolve after the drain.
    // The CLI has no multi-session UI, so cron (fresh-session) is disabled —
    // createFreshRun is omitted, so the tool advertises heartbeat only.
    injectTurn: async (sessionId, prompt, automationId) => {
      const turnId = randomUUID();
      const iterator = runtime.sendMessage(sessionId, {
        turnId, text: prompt, origin: { kind: 'automation', automationId },
      });
      try {
        for await (const _ of iterator) { /* drain */ }
        return { runId: turnId, ok: true };
      } catch (err) {
        return { runId: turnId, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    createFreshRun: input.automationCreateFreshRun,
    // unref() the tick timer: a background poll must never hold the CLI
    // process open. Without this, any bootstrap consumer that exits without
    // close() (a finished one-shot run, a test) hangs on the 5s tick forever.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onStateChange: syncAutomations,
  });

  automationScheduler.start();

  return {
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    runtime,
    target,
    tools,
    automationManager,
    automationScheduler,
    close: async () => {
      // Stop the automation scheduler's timer (else it keeps the process alive
      // and ticks into a stopped session), then terminate background shell runs.
      automationScheduler.dispose();
      await shellRuns.terminateAll();
    },
  };
}

export async function getOrCreateCliClaudeDeviceId(
  workspaceRoot: string,
  deps: GetOrCreateCliClaudeDeviceIdDeps = {},
): Promise<string> {
  const deviceIdFilePath = join(workspaceRoot, '.maka_cli_claude_device_id');
  try {
    const existing = (await readFile(deviceIdFilePath, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
  } catch {
    // fall through to create; device id persistence is best-effort metadata.
  }

  const next = (deps.newId ?? (() => randomBytes(32).toString('hex')))().toLowerCase();
  try {
    await mkdir(dirname(deviceIdFilePath), { recursive: true });
    await writeFile(deviceIdFilePath, next, { mode: 0o600 });
    await chmod(deviceIdFilePath, 0o600);
  } catch {
    // best-effort persistence; use the generated id for this process if disk fails.
  }
  return next;
}
