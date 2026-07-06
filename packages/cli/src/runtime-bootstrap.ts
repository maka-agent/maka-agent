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
  buildAutomationTool,
  buildBuiltinTools,
  buildDefaultContextBudgetPolicy,
  buildManualCompactLookupPolicy,
  buildProviderOptions,
  buildSubscriptionModelFetch,
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
  const tools = buildBuiltinTools();
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
  const allTools = [...tools, automationTool];

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
      contextBudget: buildManualCompactLookupPolicy(
        buildDefaultContextBudgetPolicy(ready.connection, { name: 'cli-default-history-budget' }),
        { highWaterName: 'cli-manual-history-compact' },
      ),
      loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
      writeHistoryCompact: (event) => persistHistoryCompactBlocksToArtifacts(artifactStore, event),
      systemPrompt: async ({ cwd }) => {
        const settings = await settingsStore.get();
        return buildCliSystemPrompt({ settings, cwd });
      },
      turnTailPrompt: ({ cwd }) => buildCliTurnTailPrompt({ cwd, sessionId: ctx.sessionId, automationManager }),
      newId: randomUUID,
      now: Date.now,
    });
  });

  const runtime = new SessionManager({
    store,
    runStore,
    runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
  });

  const automationScheduler = new AutomationScheduler({
    automationManager,
    canFire: async (sessionId) => {
      const header = await store.readHeader(sessionId);
      if (!header || header.archivedAt) return false;
      if (header.status === 'running' || header.status === 'blocked') return false;
      return true;
    },
    injectTurn: (sessionId, prompt) => {
      const turnId = randomUUID();
      const iterator = runtime.sendMessage(sessionId, { turnId, text: prompt });
      void (async () => { for await (const _ of iterator) { /* drain */ } })().catch(() => {});
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
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
