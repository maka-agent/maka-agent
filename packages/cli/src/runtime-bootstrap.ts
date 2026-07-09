import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AiSdkBackend,
  BackendRegistry,
  PermissionEngine,
  SessionManager,
  ShellRunProcessManager,
  buildBuiltinTools,
  buildDefaultContextBudgetPolicy,
  buildLlmHistorySummarizer,
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
      contextBudget: buildCliContextBudgetPolicy(ready.connection, ready.model),
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
      turnTailPrompt: ({ cwd }) => buildCliTurnTailPrompt({ cwd }),
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

  return {
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    runtime,
    target,
    tools,
    close: () => shellRuns.terminateAll(),
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
