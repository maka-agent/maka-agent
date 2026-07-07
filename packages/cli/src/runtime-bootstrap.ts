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
  buildProviderOptions,
  buildSubscriptionModelFetch,
  getAIModel,
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
  type AutomationDefinition,
  type GoalContinuationDeps,
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
  goalManager: GoalManager;
  goalContinuationDeps: GoalContinuationDeps;
  close(): Promise<void>;
}

export interface CreateMakaCliRuntimeContextInput {
  workspaceRoot: string;
  cwd: string;
  requestedModel?: string;
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
  const automationStore = createAutomationStore<AutomationDefinition>(input.workspaceRoot);
  const syncAutomations = (): void => {
    const durable = automationManager.listAll().filter(a => a.durable && (a.status === 'active' || a.status === 'paused'));
    automationStore.sync(durable).catch(() => {});
  };
  const automationTool = buildAutomationTool({ automationManager, onAutomationChange: syncAutomations });

  const goalManager = new GoalManager({ generateId: () => randomUUID(), now: () => Date.now() });
  const goalTokenCache = new Map<string, number>();
  const goalTools = buildGoalTools({
    goalManager,
    getTokenCount: (sessionId) => goalTokenCache.get(sessionId) ?? 0,
  });
  const allTools = [...tools, automationTool, ...goalTools];

  // Load durable automations from disk.
  try {
    const saved = await automationStore.loadAll();
    automationManager.registerAll(saved);
  } catch { /* best-effort */ }

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
      turnTailPrompt: ({ cwd }) => buildCliTurnTailPrompt({ cwd, sessionId: ctx.sessionId, automationManager, goalManager }),
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
    canFire: async (sessionId) => {
      const header = await store.readHeader(sessionId);
      if (!header || header.archivedAt) return false;
      if (header.status === 'running' || header.status === 'blocked' || header.status === 'aborted') return false;
      return true;
    },
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
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onStateChange: syncAutomations,
  });

  automationScheduler.start();

  // Goal execution — external-evaluator continuation, sharing the runtime
  // sendMessage pipeline (so each continuation turn is a real, traced AgentRun).
  const goalContinuationDeps: GoalContinuationDeps = {
    goalManager,
    inFlight: new Set<string>(),
    evaluator: {
      async evaluate(prompt: string): Promise<string> {
        const ai = await import('ai') as unknown as {
          generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
        };
        const modelFetch = buildSubscriptionModelFetch({
          connection: target.connection,
          sessionId: 'goal-evaluator',
          modelId: target.model,
        });
        const result = await ai.generateText({
          model: getAIModel({ connection: target.connection, apiKey: target.apiKey ?? '', modelId: target.model, fetch: modelFetch }),
          prompt,
          providerOptions: buildProviderOptions(target.connection, target.model),
          maxTokens: 250,
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
      if (header.status === 'running' || header.status === 'blocked' || header.status === 'aborted') return false;
      return true;
    },
    // The CLI automation scheduler injects turns via a silent drain that does
    // not re-invoke handleGoalContinuation, so a heartbeat poll loop could not
    // close. We therefore do NOT wire the waiting → heartbeat bridge in the CLI;
    // a waiting goal falls through to normal per-turn continuation instead.
  };

  return {
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    runtime,
    target,
    tools,
    automationManager,
    automationScheduler,
    goalManager,
    goalContinuationDeps,
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
