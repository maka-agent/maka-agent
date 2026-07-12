import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AiSdkBackend,
  AutomationManager,
  AutomationScheduler,
  BackendRegistry,
  GoalManager,
  PermissionEngine,
  SessionManager,
  ShellRunProcessManager,
  buildAutomationTool,
  buildBuiltinTools,
  buildDefaultContextBudgetPolicy,
  buildGoalTools,
  buildLlmHistorySummarizer,
  cleanupLegacyHistoryCompactArtifacts,
  buildProviderOptions,
  buildSubscriptionModelFetch,
  evaluateAutomationCanFire,
  getAIModel,
  loadHistoryCompactBlocksFromArtifacts,
  type AutomationDefinition,
  type GoalContinuationDeps,
  type InvocationResult,
  type ShellRunUpdate,
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
import type { ToolResultContent } from '@maka/core/events';
import type { ModelChoice, ReadySessionTarget } from './connection-target.js';
import { listReadyModelChoices, resolveDefaultSessionTarget, resolveSessionTargetForSlug } from './connection-target.js';
import { buildCliSystemPrompt, buildCliTurnTailPrompt } from './cli-system-prompt.js';

export interface MakaCliRuntimeContext {
  workspaceRoot: string;
  cwd: string;
  runtime: SessionManager;
  target: ReadySessionTarget;
  /** Selectable models across every ready connection, for the `/model` picker. */
  modelChoices: ModelChoice[];
  tools: ReturnType<typeof buildBuiltinTools>;
  automationManager: AutomationManager;
  automationScheduler: AutomationScheduler;
  subscribeShellRunUpdates(listener: (update: ShellRunUpdate) => void): () => void;
  readShellRun(sessionId: string, ref: string): Promise<{
    ownerSessionId: string;
    result: Extract<ToolResultContent, { kind: 'shell_run' }>;
  }>;
  goalManager: GoalManager;
  goalContinuationDeps: GoalContinuationDeps;
  close(): Promise<void>;
}

export interface CreateMakaCliRuntimeContextInput {
  workspaceRoot: string;
  cwd: string;
  requestedConnectionSlug?: string;
  requestedModel?: string;
  maxSteps?: number;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
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
  const targetInput = {
    connectionStore,
    credentialStore,
    requestedModel: input.requestedModel,
  };
  const target = input.requestedConnectionSlug
    ? await resolveSessionTargetForSlug(input.requestedConnectionSlug, targetInput)
    : await resolveDefaultSessionTarget(targetInput);
  const modelChoices = await listReadyModelChoices({ connectionStore, credentialStore });
  const permissionEngine = new PermissionEngine({ newId: randomUUID, now: Date.now });
  const backends = new BackendRegistry();
  const shellRunListeners = new Set<(update: ShellRunUpdate) => void>();
  const shellRuns = new ShellRunProcessManager({
    store: shellRunStore,
    newId: randomUUID,
    now: Date.now,
    onShellRunUpdate: (update) => {
      for (const listener of shellRunListeners) {
        try {
          listener(update);
        } catch {
          // One UI observer must not suppress updates for the rest.
        }
      }
    },
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

  const goalManager = new GoalManager({ generateId: () => randomUUID(), now: () => Date.now() });
  const goalTokenCache = new Map<string, number>();
  const goalTools = buildGoalTools({
    goalManager,
    getTokenCount: (sessionId) => goalTokenCache.get(sessionId) ?? 0,
  });
  const allTools = [...tools, automationTool, ...goalTools];

  backends.register('ai-sdk', async (ctx) => {
    // Resolve the session's own connection — not the global default — so a
    // /model switch that rebinds the session to another provider actually runs
    // on that provider (the desktop app resolves the backend the same way).
    const ready = await resolveSessionTargetForSlug(ctx.header.llmConnectionSlug, {
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
      contextBudget: buildCliContextBudgetPolicy(ready.connection, ready.model),
      loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
      loadHistoryCompactCheckpoint: ctx.loadHistoryCompactCheckpoint,
      summarizeHistoryCompact: buildLlmHistorySummarizer({
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
      recordHistoryCompactCheckpoint: ctx.recordHistoryCompactCheckpoint,
      systemPrompt: async ({ cwd }) => {
        const settings = await settingsStore.get();
        return buildCliSystemPrompt({ settings, cwd });
      },
      turnTailPrompt: ({ cwd }) => buildCliTurnTailPrompt({ cwd, sessionId: ctx.sessionId, automationManager, goalManager }),
      shellRunContextSummary: ctx.shellRunContextSummary,
      newId: randomUUID,
      now: Date.now,
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    });
  });

  const runtime = new SessionManager({
    store,
    runStore,
    runtimeEventStore,
    shellRuns,
    backends,
    runtimeInvocationObserver: input.runtimeInvocationObserver,
    cleanupHistoryCompactArtifacts: async (cleanupInput) => {
      await cleanupLegacyHistoryCompactArtifacts({
        ...cleanupInput,
        artifactStore,
        onDiagnostic: (diagnostic) => console.warn('[history-compact-cleanup]', diagnostic),
      });
    },
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

  const readShellRun = async (sessionId: string, ref: string) => {
    let ownerSessionId: string | undefined = sessionId;
    const visited = new Set<string>();
    while (ownerSessionId && !visited.has(ownerSessionId)) {
      visited.add(ownerSessionId);
      try {
        return {
          ownerSessionId,
          result: await shellRuns.inspectResource(ownerSessionId, ref),
        };
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        ownerSessionId = (await store.readHeader(ownerSessionId)).parentSessionId;
        if (!ownerSessionId) throw error;
      }
    }
    throw new Error(`Cannot resolve ShellRun owner for session ${sessionId}`);
  };

  // Goal execution — external-evaluator continuation, sharing the runtime
  // sendMessage pipeline (so each continuation turn is a real, traced AgentRun).
  const goalContinuationDeps: GoalContinuationDeps = {
    goalManager,
    inFlight: new Set<string>(),
    evaluator: {
      async evaluate(prompt: string, sessionId: string): Promise<string> {
        const ai = await import('ai') as unknown as {
          generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
        };
        const header = await store.readHeader(sessionId);
        const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
          connectionStore,
          credentialStore,
          requestedModel: header.model,
        });
        const modelFetch = buildSubscriptionModelFetch({
          connection: ready.connection,
          sessionId: 'goal-evaluator',
          modelId: ready.model,
          ...(ready.connection.providerType === 'claude-subscription' ? {
            claude: {
              cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
              deviceId: await getOrCreateCliClaudeDeviceId(input.workspaceRoot),
              accountUuid: ready.oauthTokens?.account_uuid ?? '',
            },
          } : {}),
        });
        const result = await ai.generateText({
          model: getAIModel({
            connection: ready.connection,
            apiKey: ready.apiKey ?? '',
            modelId: ready.model,
            fetch: modelFetch,
          }),
          prompt,
          providerOptions: buildProviderOptions(ready.connection, ready.model, header.thinkingLevel),
          // Ceiling, not a target — the verdict is tiny JSON. Kept well above the
          // JSON size so any model-side reasoning before the JSON doesn't consume
          // the whole budget and return empty text (finishReason=length). 250 was
          // too tight once the cap is actually honored (AI SDK v6 maxOutputTokens).
          maxOutputTokens: 1024,
        });
        return result.text;
      },
    },
    async getRecentContext(sessionId: string): Promise<string> {
      const messages = await runtime.getMessages(sessionId);
      // Refresh the token snapshot while the session is open.
      let total = 0;
      for (const m of messages) {
        if (m.type === 'token_usage') total += (m.total ?? (m.input + m.output));
      }
      goalTokenCache.set(sessionId, total);
      return messages
        .slice(-10)
        .filter((m) => m.type === 'user' || m.type === 'assistant')
        .slice(-6)
        .map((m) => `[${m.type}]: ${(m.type === 'user' || m.type === 'assistant' ? m.text : '').slice(0, 500)}`)
        .join('\n');
    },
    getTokenCount: (sessionId) => goalTokenCache.get(sessionId) ?? 0,
    injectTurn: (sessionId, text) => {
      const turnId = randomUUID();
      const iterator = runtime.sendMessage(sessionId, { turnId, text });
      void (async () => { for await (const _ of iterator) { /* drain */ } })().catch(() => {});
    },
    canContinue: async (sessionId) => {
      const header = await store.readHeader(sessionId);
      if (!header || header.archivedAt) return false;
      // Never auto-continue into a session that is running (mid-turn), aborted,
      // blocked, or parked waiting on the user — injecting a turn there would
      // race the live turn or override the human the agent is waiting on.
      if (
        header.status === 'running' ||
        header.status === 'blocked' ||
        header.status === 'aborted' ||
        header.status === 'waiting_for_user'
      ) return false;
      return true;
    },
  };

  return {
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    runtime,
    target,
    modelChoices,
    tools,
    automationManager,
    automationScheduler,
    subscribeShellRunUpdates: (listener) => {
      shellRunListeners.add(listener);
      return () => shellRunListeners.delete(listener);
    },
    readShellRun,
    goalManager,
    goalContinuationDeps,
    close: async () => {
      // Stop the automation scheduler's timer (else it keeps the process alive
      // and ticks into a stopped session), then terminate background shell runs.
      automationScheduler.dispose();
      await shellRuns.terminateAll();
      shellRunListeners.clear();
    },
  };
}

// The CLI keeps turn-boundary history compaction but disables *in-turn* semantic
// compaction by default. Firing mid-turn, it interrupts the live reply with a
// `Context compacted: semanticCompact` notice for small savings, which reads as
// noise in an interactive session. So we drop it from the default policy rather
// than setting an env override, leaving the rest of the budget (history compact,
// tool-result pruning) untouched.
//
// But only the *default* is off: if the user explicitly opts in via
// `MAKA_CONTEXT_SEMANTIC_COMPACT` or `MAKA_CONTEXT_SEMANTIC_COMPACT_MODE`, honor
// it so the path can still be exercised and debugged from the CLI.
function buildCliContextBudgetPolicy(
  connection: Parameters<typeof buildDefaultContextBudgetPolicy>[0],
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof buildDefaultContextBudgetPolicy> {
  const policy = buildDefaultContextBudgetPolicy(connection, {
    name: 'cli-default-history-budget',
    modelId,
  });
  if (!policy?.semanticCompact) return policy;
  // buildDefaultContextBudgetPolicy already reflects env-off (policy would have
  // no semanticCompact), so reaching here means default-on or an explicit opt-in.
  // Keep it only for the explicit opt-in; otherwise apply the CLI default (off).
  if (userOptedIntoSemanticCompact(env)) return policy;
  const { semanticCompact: _omitted, ...rest } = policy;
  return rest;
}

// True when the environment explicitly turns semantic compaction on — either a
// truthy `MAKA_CONTEXT_SEMANTIC_COMPACT`, or a `MAKA_CONTEXT_SEMANTIC_COMPACT_MODE`
// set to a mode other than `off`. Mirrors the spellings the runtime policy
// accepts. An invalid boolean would already have thrown inside the default
// policy build above, so this only classifies well-formed values.
function userOptedIntoSemanticCompact(env: Record<string, string | undefined>): boolean {
  const enable = env.MAKA_CONTEXT_SEMANTIC_COMPACT?.trim().toLowerCase();
  if (enable === '1' || enable === 'true' || enable === 'yes' || enable === 'on' || enable === 'enabled') {
    return true;
  }
  const mode = env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODE?.trim().toLowerCase();
  return mode === 'validate_only' || mode === 'prepare_step_dry_run' || mode === 'replace';
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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
