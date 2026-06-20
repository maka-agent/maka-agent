import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BackendKind,
  LlmConnection,
  ProviderType,
} from '@maka/core';
import { PROVIDER_DEFAULTS } from '@maka/core';
import {
  AiSdkBackend,
  BackendRegistry,
  PermissionEngine,
  SessionManager,
  buildBuiltinTools,
  buildProviderOptions,
  getAIModel,
  getBuiltinPricing,
  type InvocationResult,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createRuntimeEventStore,
  createSessionStore,
} from '@maka/storage';
import { registerFakeBackend } from './backends.js';
import { buildHarborCellOutput, validateHarborCellOutput, type HarborCellOutput } from './cell-output.js';
import type { Config, Task } from './contracts.js';
import type { HeadlessBackendContext, RealBackendIsolation } from './isolation.js';
import { validateRealBackendIsolation } from './isolation.js';
import { backendNeedsIsolation } from './runner.js';

export const HARBOR_CELL_OUTPUT_FILENAME = 'maka-cell-output.json';
export const HARBOR_CELL_RUNTIME_EVENTS_FILENAME = 'runtime-events.jsonl';

export interface RunHarborCellInput {
  config: Config;
  instruction: string;
  cwd: string;
  outputDir: string;
  storageRoot: string;
  registerBackends?: (
    registry: BackendRegistry,
    context: HeadlessBackendContext,
  ) => void | Promise<void>;
  realBackendIsolation?: RealBackendIsolation;
  now?: () => number;
  newId?: () => string;
}

export interface RunHarborCellResult {
  invocation: InvocationResult;
  output: HarborCellOutput;
  outputPath: string;
  runtimeEventsPath: string;
}

export type RunHarborCellEnv = Record<string, string | undefined>;

export interface RunHarborCellFromEnvOptions {
  registerBackends?: RunHarborCellInput['registerBackends'];
  now?: () => number;
  newId?: () => string;
}

export interface ResolvedHarborCellAiSdkEnv {
  connection: LlmConnection;
  apiKey: string;
}

export async function runHarborCell(input: RunHarborCellInput): Promise<RunHarborCellResult> {
  if (backendNeedsIsolation(input.config.backend)) {
    validateRealBackendIsolation(input.realBackendIsolation);
    if (!input.registerBackends) {
      throw new Error(
        `@maka/headless: backend "${input.config.backend}" requires registerBackends to wire an isolated backend factory`,
      );
    }
  }

  const now = input.now ?? Date.now;
  const newId = input.newId ?? randomId;
  const sessionStore = createSessionStore(input.storageRoot);
  const agentRunStore = createAgentRunStore(input.storageRoot);
  const runtimeEventStore = createRuntimeEventStore(input.storageRoot);
  const backends = new BackendRegistry();
  const task: Task = {
    id: 'harbor-cell',
    instruction: input.instruction,
    workspaceDir: input.cwd,
  };
  const registerBackends = input.registerBackends ?? ((registry: BackendRegistry) => registerFakeBackend(registry));
  await registerBackends(backends, {
    config: input.config,
    task,
    workspaceDir: input.cwd,
    ...(backendNeedsIsolation(input.config.backend)
      ? { realBackendIsolation: input.realBackendIsolation }
      : {}),
  });

  let invocation: InvocationResult | undefined;
  const manager = new SessionManager({
    store: sessionStore,
    runStore: agentRunStore,
    runtimeEventStore,
    backends,
    newId,
    now,
    runtimeSource: 'test',
    runtimeInvocationObserver: (result) => {
      invocation = result;
    },
  });

  const session = await manager.createSession({
    cwd: input.cwd,
    backend: input.config.backend,
    llmConnectionSlug: input.config.llmConnectionSlug,
    model: input.config.model,
    permissionMode: 'execute',
    name: `harbor-cell:${input.config.id}`,
  });

  const turnId = newId();
  let sendMessageError: unknown;
  try {
    for await (const event of manager.sendMessage(session.id, { turnId, text: input.instruction })) {
      if ((event as { type?: string }).type === 'permission_request') {
        const { requestId } = event as { requestId: string };
        await manager.respondToPermission(session.id, { requestId, decision: 'deny', rememberForTurn: true });
      }
    }
  } catch (error) {
    sendMessageError = error;
  }
  if (!invocation) {
    if (sendMessageError) throw sendMessageError;
    throw new Error('Harbor cell finished without a runtime invocation result');
  }

  await mkdir(input.outputDir, { recursive: true });
  const runtimeEventsPath = join(input.outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME);
  const outputPath = join(input.outputDir, HARBOR_CELL_OUTPUT_FILENAME);
  await writeFile(runtimeEventsPath, runtimeEventsJsonl(invocation), 'utf8');
  const output = validateHarborCellOutput(buildHarborCellOutput({ invocation, runtimeEventsPath }));
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  return { invocation, output, outputPath, runtimeEventsPath };
}

export async function runHarborCellFromEnv(
  env: RunHarborCellEnv = process.env,
  options: RunHarborCellFromEnvOptions = {},
): Promise<RunHarborCellResult> {
  const now = options.now ?? Date.now;
  const outputDir = env.MAKA_OUTPUT_DIR ?? '/logs/agent';
  const modelSpec = parseModelSpec(env.MAKA_MODEL ?? env.HARBOR_MODEL ?? 'deepseek/deepseek-chat', env.MAKA_PROVIDER);
  const backend = backendFromEnv(env.MAKA_BACKEND);
  const config: Config = {
    id: env.MAKA_CONFIG_ID ?? 'harbor-cell',
    backend,
    llmConnectionSlug: env.MAKA_LLM_CONNECTION_SLUG ?? modelSpec.provider,
    model: modelSpec.model,
    ...(env.MAKA_SYSTEM_PROMPT !== undefined ? { systemPrompt: env.MAKA_SYSTEM_PROMPT } : {}),
  };
  const registerBackends = options.registerBackends ?? (
    backend === 'fake'
      ? undefined
      : buildAiSdkCellBackendRegistration({
          provider: modelSpec.provider,
          model: modelSpec.model,
          env,
          now,
          newId: options.newId ?? randomId,
        })
  );

  return await runHarborCell({
    config,
    instruction: await instructionFromEnv(env),
    cwd: env.MAKA_WORKDIR ?? process.cwd(),
    outputDir,
    storageRoot: env.MAKA_STORAGE_ROOT ?? join(outputDir, 'maka-storage'),
    ...(registerBackends ? { registerBackends } : {}),
    ...(backendNeedsIsolation(backend) ? { realBackendIsolation: { kind: 'external', label: 'Harbor task container' } } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
  });
}

function buildAiSdkCellBackendRegistration(input: {
  provider: ProviderType;
  model: string;
  env: RunHarborCellEnv;
  now: () => number;
  newId: () => string;
}): RunHarborCellInput['registerBackends'] {
  const { connection, apiKey } = resolveHarborCellAiSdkEnv({
    provider: input.provider,
    model: input.model,
    env: input.env,
    ts: input.now(),
  });
  const permissionEngine = new PermissionEngine({ newId: input.newId, now: input.now });
  return (registry, context) => {
    registry.register('ai-sdk', (ctx) =>
      new AiSdkBackend({
        sessionId: ctx.sessionId,
        header: { ...ctx.header, model: input.model },
        appendMessage: ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
        connection,
        apiKey,
        modelId: input.model,
        permissionEngine,
        modelFactory: getAIModel,
        tools: buildBuiltinTools(),
        providerOptions: buildProviderOptions(connection, input.model),
        systemPrompt: context.config.systemPrompt,
        lookupPricing: getBuiltinPricing,
        newId: input.newId,
        now: input.now,
        recordRunTrace: ctx.recordRunTrace,
      }),
    );
  };
}

export function resolveHarborCellAiSdkEnv(input: {
  provider: ProviderType;
  model: string;
  env: RunHarborCellEnv;
  ts: number;
}): ResolvedHarborCellAiSdkEnv {
  return {
    connection: connectionFromEnv(input.provider, input.model, input.env, input.ts),
    apiKey: apiKeyFromEnv(input.provider, input.env),
  };
}

async function instructionFromEnv(env: RunHarborCellEnv): Promise<string> {
  if (env.MAKA_INSTRUCTION !== undefined) return env.MAKA_INSTRUCTION;
  if (env.MAKA_INSTRUCTION_FILE) return await readFile(env.MAKA_INSTRUCTION_FILE, 'utf8');
  throw new Error('MAKA_INSTRUCTION or MAKA_INSTRUCTION_FILE is required');
}

function backendFromEnv(value: string | undefined): BackendKind {
  if (!value) return 'ai-sdk';
  if (value === 'fake' || value === 'ai-sdk') return value;
  throw new Error(`unsupported MAKA_BACKEND: ${value}`);
}

function parseModelSpec(rawModel: string, rawProvider: string | undefined): { provider: ProviderType; model: string } {
  if (rawProvider !== undefined) {
    if (!rawModel) throw new Error('MAKA_MODEL must include a model id');
    return { provider: providerFromEnv(rawProvider), model: rawModel };
  }
  const separator = rawModel.indexOf('/');
  const [providerPart, modelPart] = separator >= 0
    ? [rawModel.slice(0, separator), rawModel.slice(separator + 1)]
    : ['deepseek', rawModel];
  const provider = providerFromEnv(providerPart);
  if (!modelPart) throw new Error('MAKA_MODEL must include a model id');
  return { provider, model: modelPart };
}

function providerFromEnv(value: string | undefined): ProviderType {
  if (!value || !(value in PROVIDER_DEFAULTS)) {
    throw new Error(`unsupported MAKA_PROVIDER: ${value ?? ''}`);
  }
  return value as ProviderType;
}

function connectionFromEnv(
  provider: ProviderType,
  model: string,
  env: RunHarborCellEnv,
  ts: number,
): LlmConnection {
  const defaults = PROVIDER_DEFAULTS[provider];
  return {
    slug: env.MAKA_LLM_CONNECTION_SLUG ?? provider,
    name: defaults.label,
    providerType: provider,
    baseUrl: env.MAKA_BASE_URL ?? providerBaseUrl(provider, env) ?? defaults.baseUrl,
    defaultModel: model,
    enabled: true,
    createdAt: ts,
    updatedAt: ts,
  };
}

function providerBaseUrl(provider: ProviderType, env: RunHarborCellEnv): string | undefined {
  switch (provider) {
    case 'deepseek':
      return env.DEEPSEEK_BASE_URL ?? env.OPENAI_BASE_URL;
    case 'openai':
    case 'openai-compatible':
      return env.OPENAI_BASE_URL;
    case 'moonshot':
      return env.MOONSHOT_BASE_URL;
    case 'zai-coding-plan':
      return env.ZAI_BASE_URL;
    default:
      return undefined;
  }
}

function apiKeyFromEnv(provider: ProviderType, env: RunHarborCellEnv): string {
  switch (provider) {
    case 'deepseek':
      return env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY ?? '';
    case 'openai':
    case 'openai-compatible':
      return env.OPENAI_API_KEY ?? '';
    case 'moonshot':
      return env.MOONSHOT_API_KEY ?? env.OPENAI_API_KEY ?? '';
    case 'zai-coding-plan':
      return env.ZAI_API_KEY ?? env.OPENAI_API_KEY ?? '';
    case 'google':
      return env.GOOGLE_API_KEY ?? '';
    case 'anthropic':
    case 'kimi-coding-plan':
    case 'claude-subscription':
      return env.ANTHROPIC_API_KEY ?? '';
    default:
      return env.OPENAI_API_KEY ?? '';
  }
}

function runtimeEventsJsonl(invocation: InvocationResult): string {
  if (invocation.events.length === 0) return '';
  return `${invocation.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
