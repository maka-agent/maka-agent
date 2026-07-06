import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AiSdkBackend,
  BackendRegistry,
  PermissionEngine,
  SessionManager,
  buildBuiltinTools,
  buildDefaultContextBudgetPolicy,
  buildManualCompactLookupPolicy,
  buildProviderOptions,
  buildSubscriptionModelFetch,
  getAIModel,
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createArtifactStore,
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
      tools,
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
      turnTailPrompt: ({ cwd }) => buildCliTurnTailPrompt({ cwd }),
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

  return {
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    runtime,
    target,
    tools,
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
