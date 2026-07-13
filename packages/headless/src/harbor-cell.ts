import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { exec as nodeExec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  BackendKind,
  LlmConnection,
  PricingConfig,
  ProviderType,
  RuntimeEvent,
} from '@maka/core';
import { PROVIDER_DEFAULTS } from '@maka/core';
import { isThinkingLevel } from '@maka/core';
import {
  AiSdkBackend,
  BackendRegistry,
  PermissionEngine,
  PiAgentBackend,
  SessionManager,
  buildProviderOptions,
  defaultShellPlan,
  getAIModel,
  getBuiltinPricing,
  runShellWithBoundedTail,
  type MakaTool,
  type InvocationResult,
  type ContextBudgetPolicy,
  type ToolResultArchiveReader,
  type ToolResultArchiveRecorder,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createRuntimeEventStore,
  createSessionStore,
} from '@maka/storage';
import { registerFakeBackend } from './backends.js';
import {
  buildHarborCellOutput,
  hashHarborSystemPrompt,
  validateHarborCellOutput,
  type HarborCellContextBudgetPolicySnapshot,
  type HarborCellOutput,
} from './cell-output.js';
import type { Config, Task } from './contracts.js';
import { configWithHeavyTaskPolicy, resolveHeavyTaskMode } from './heavy-task-policy.js';
import { configWithEconomyTaskPolicy, resolveEconomyTaskMode } from './economy-task-policy.js';
import type { HeadlessBackendContext, IsolatedToolExecutor, RealBackendIsolation } from './isolation.js';
import { ISOLATED_HEADLESS_TOOL_NAMES, validateRealBackendIsolation } from './isolation.js';
import { PiCliJsonTransport } from './pi-cli-json-transport.js';
import { providerCredentialEnv, requireProviderCredentialEnv } from './provider-env.js';
import { backendNeedsIsolation } from './runner.js';
import { buildIsolatedHeadlessToolAvailability, buildIsolatedHeadlessTools, type BuildIsolatedHeadlessToolsOptions } from './tools.js';
import {
  createInMemoryTaskLedgerExperimentStore,
  renderTaskLedgerExperimentReplay,
} from './task-ledger-experiment.js';

export const HARBOR_CELL_OUTPUT_FILENAME = 'maka-cell-output.json';
export const HARBOR_CELL_RUNTIME_EVENTS_FILENAME = 'runtime-events.jsonl';
export const HARBOR_CELL_EXECUTION_IDENTITY_FILENAME = 'maka-cell-execution-identity.json';
const execAsync = promisify(nodeExec);
const HARBOR_CELL_TOOL_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface RunHarborCellInput {
  config: Config;
  instruction: string;
  cwd: string;
  outputDir: string;
  storageRoot: string;
  pricingProfile?: string;
  registerBackends?: (
    registry: BackendRegistry,
    context: HeadlessBackendContext,
  ) => void | Promise<void>;
  realBackendIsolation?: RealBackendIsolation;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  continuationPolicy?: HarborCellContinuationPolicy;
  taskToolSummaryEnabled?: boolean;
  now?: () => number;
  newId?: () => string;
}

export interface HarborCellContinuationPolicy {
  enabled: boolean;
  maxTurns: number;
  maxTotalRuntimeSteps: number;
  prompt: string;
}

export interface HarborCellContinuationSummary {
  enabled: boolean;
  maxTurns: number;
  maxTotalRuntimeSteps: number;
  turnsUsed: number;
  continuedTurns: number;
  stepCapHits: number;
  capExhausted: boolean;
  totalRuntimeSteps: number;
  turns: HarborCellContinuationTurnSummary[];
}

export interface HarborCellContinuationTurnSummary {
  turnIndex: number;
  status: InvocationResult['status'];
  stepCapHit: boolean;
  runtimeSteps: number;
}

export interface RunHarborCellResult {
  invocation: InvocationResult;
  output: HarborCellOutput;
  outputPath: string;
  runtimeEventsPath: string;
}

export type RunHarborCellEnv = Record<string, string | undefined>;

export function providerApiKeyEnvName(provider: string): string {
  return requireProviderCredentialEnv(provider).apiKeys[0]!;
}

export const HARBOR_CELL_DEFAULT_CONTINUATION_PROMPT = 'Continue the same benchmark task from the current workspace state. Do not restart. If the task is complete, provide the final response.';
const HARBOR_CELL_DEFAULT_MAX_STEPS_PER_TURN = 50;

export interface RunHarborCellFromEnvOptions {
  registerBackends?: RunHarborCellInput['registerBackends'];
  now?: () => number;
  newId?: () => string;
}

export interface ResolvedHarborCellAiSdkEnv {
  connection: LlmConnection;
  apiKey: string;
}

export interface HarborCellContextBudgetBackendOptions {
  contextBudget?: ContextBudgetPolicy;
  archiveToolResult?: ToolResultArchiveRecorder;
  readToolResultArchive?: ToolResultArchiveReader;
}

export interface HarborCellTaskLedgerExperimentPolicy {
  enabled: true;
  replayMaxChars: number;
}

export const HARBOR_CELL_CONTEXT_ENV_KEYS = [
  'MAKA_CONTEXT_BUDGET',
  'MAKA_CONTEXT_BUDGET_NAME',
  'MAKA_CONTEXT_CHARS_PER_TOKEN',
  'MAKA_CONTEXT_MAX_HISTORY_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_MAX_HISTORY_TURNS',
  'MAKA_CONTEXT_HISTORY_BUDGET_TOKENS',
  'MAKA_CONTEXT_HISTORY_BUDGET_TURNS',
  'MAKA_CONTEXT_MIN_RECENT_TURNS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MODE',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_FORCE_RATIO',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_TARGET_RATIO',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_TOOL_PAIRS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_ARCHIVE_REQUIRED',
  'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME',
  'MAKA_CONTEXT_SEMANTIC_COMPACT',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MODE',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_RATIO',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_FORCE_RATIO',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_TARGET_RATIO',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_BENCHMARK_STATE_CARDS',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION',
  'MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS',
  'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES',
  'MAKA_CONTEXT_TOOL_RESULT_ARCHIVE_DIR',
  'MAKA_CONTEXT_TASK_TOOLS',
  'MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS',
] as const;

export type HarborCellContextEnvKey = typeof HARBOR_CELL_CONTEXT_ENV_KEYS[number];

const HARBOR_CELL_CONTEXT_ENV_KEY_SET = new Set<string>(HARBOR_CELL_CONTEXT_ENV_KEYS);

export function normalizeHarborCellContextEnv(
  env: RunHarborCellEnv,
): Partial<Record<HarborCellContextEnvKey, string>> {
  const result: Partial<Record<HarborCellContextEnvKey, string>> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('MAKA_CONTEXT_')) continue;
    if (!HARBOR_CELL_CONTEXT_ENV_KEY_SET.has(key)) throw new Error(`unsupported Harbor context env key: ${key}`);
    if (value !== undefined) result[key as HarborCellContextEnvKey] = value;
  }
  return result;
}

interface HarborCellToolResultArchiveRecord {
  version: 1;
  sessionId: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  serializedResult: string;
}

const PI_BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'SystemRoot', 'COMSPEC'];
const PI_PROVIDER_ENV_RULES = [
  { includes: ['volcengine'], prefixes: ['XIAOMI_', 'VOLCENGINE_'] },
  { includes: ['deepseek'], keys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_FILE', 'DEEPSEEK_BASE_URL'] },
  { includes: ['openai'], keys: ['OPENAI_API_KEY', 'OPENAI_API_KEY_FILE', 'OPENAI_BASE_URL'] },
  { includes: ['anthropic', 'claude'], keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_FILE'] },
  {
    includes: ['google', 'gemini'],
    keys: [
      'GOOGLE_API_KEY',
      'GOOGLE_API_KEY_FILE',
      'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_GENAI_USE_VERTEXAI',
    ],
  },
  { includes: ['moonshot', 'kimi'], keys: ['MOONSHOT_API_KEY', 'MOONSHOT_API_KEY_FILE', 'MOONSHOT_BASE_URL'] },
  {
    includes: ['zai'],
    keys: ['ZAI_API_KEY', 'ZAI_API_KEY_FILE', 'ZAI_CODING_CN_API_KEY', 'ZAI_CODING_CN_API_KEY_FILE', 'ZAI_BASE_URL'],
  },
  { includes: ['minimax'], keys: ['MINIMAX_API_KEY', 'MINIMAX_API_KEY_FILE', 'MINIMAX_BASE_URL'] },
] satisfies Array<{ includes: string[]; keys?: string[]; prefixes?: string[] }>;

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
  const heavyTaskMode = resolveHeavyTaskMode(input.config, task);
  const configAfterHeavy = configWithHeavyTaskPolicy(input.config, heavyTaskMode);
  const economyTaskMode = resolveEconomyTaskMode(configAfterHeavy, task);
  const config = configWithEconomyTaskPolicy(configAfterHeavy, economyTaskMode);
  const registerBackends = input.registerBackends ?? ((registry: BackendRegistry) => registerFakeBackend(registry));
  await registerBackends(backends, {
    config,
    task,
    workspaceDir: input.cwd,
    ...(backendNeedsIsolation(input.config.backend)
      ? { realBackendIsolation: input.realBackendIsolation, toolExecutor: input.realBackendIsolation?.toolExecutor }
      : {}),
  });
  if (!config.model) throw new Error('Harbor cell config must include a model for execution identity');
  const executionIdentity = {
    llmConnectionSlug: config.llmConnectionSlug,
    model: config.model,
    ...(config.thinkingLevel ? { reasoningEffort: config.thinkingLevel } : {}),
    systemPromptHash: hashHarborSystemPrompt(config.systemPrompt ?? ''),
    pricingProfile: input.pricingProfile ?? 'unconfigured',
  };
  await mkdir(input.outputDir, { recursive: true });
  await writeFile(
    join(input.outputDir, HARBOR_CELL_EXECUTION_IDENTITY_FILENAME),
    `${JSON.stringify(executionIdentity, null, 2)}\n`,
    'utf8',
  );

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
    llmConnectionSlug: config.llmConnectionSlug,
    model: config.model,
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    permissionMode: 'execute',
    name: `harbor-cell:${input.config.id}`,
  });

  const continuationPolicy = input.continuationPolicy ?? {
    enabled: false,
    maxTurns: 1,
    maxTotalRuntimeSteps: HARBOR_CELL_DEFAULT_MAX_STEPS_PER_TURN,
    prompt: HARBOR_CELL_DEFAULT_CONTINUATION_PROMPT,
  };
  const invocations: InvocationResult[] = [];
  let sendMessageError: unknown;
  let nextText = input.instruction;
  let stepCapHits = 0;
  let attemptedTurnId: string | undefined;
  try {
    for (let turnIndex = 0; turnIndex < continuationPolicy.maxTurns; turnIndex += 1) {
      const turnId = newId();
      attemptedTurnId = turnId;
      invocation = undefined;
      for await (const event of manager.sendMessage(session.id, { turnId, text: nextText })) {
        if ((event as { type?: string }).type === 'permission_request') {
          const { requestId } = event as { requestId: string };
          await manager.respondToPermission(session.id, { requestId, decision: 'deny', rememberForTurn: true });
        }
      }
      if (!invocation) throw new Error('Harbor cell turn finished without a runtime invocation result');
      invocations.push(invocation);
      if (!isToolCallStepCap(invocation)) break;
      stepCapHits += 1;
      if (totalRuntimeSteps(invocations) >= continuationPolicy.maxTotalRuntimeSteps) break;
      if (!continuationPolicy.enabled || turnIndex + 1 >= continuationPolicy.maxTurns) break;
      nextText = continuationPolicy.prompt;
    }
  } catch (error) {
    sendMessageError = error;
  }
  if (sendMessageError) {
    invocations.push(failedInvocationFromError(sendMessageError, {
      newId,
      now,
      sessionId: session.id,
      turnId: attemptedTurnId ?? newId(),
    }));
  } else if (invocations.length === 0) {
    throw new Error('Harbor cell finished without a runtime invocation result');
  }
  const combinedInvocation = combineInvocations(invocations);
  const continuationSummary = continuationPolicy.enabled
    ? buildContinuationSummary(continuationPolicy, invocations, stepCapHits)
    : undefined;

  await mkdir(input.outputDir, { recursive: true });
  const runtimeEventsPath = join(input.outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME);
  const outputPath = join(input.outputDir, HARBOR_CELL_OUTPUT_FILENAME);
  await writeFile(runtimeEventsPath, runtimeEventsJsonl(combinedInvocation), 'utf8');
  const output = validateHarborCellOutput(buildHarborCellOutput({
    invocation: combinedInvocation,
    runtimeEventsPath,
    executionIdentity,
    ...(input.contextBudgetPolicy ? { contextBudgetPolicy: input.contextBudgetPolicy } : {}),
    ...(continuationSummary ? { continuationSummary } : {}),
    ...(input.taskToolSummaryEnabled !== undefined ? { taskToolSummaryEnabled: input.taskToolSummaryEnabled } : {}),
  }));
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  return { invocation: combinedInvocation, output, outputPath, runtimeEventsPath };
}

export async function runHarborCellFromEnv(
  env: RunHarborCellEnv = process.env,
  options: RunHarborCellFromEnvOptions = {},
): Promise<RunHarborCellResult> {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomId;
  const outputDir = env.MAKA_OUTPUT_DIR ?? '/logs/agent';
  const storageRoot = env.MAKA_STORAGE_ROOT ?? join(outputDir, 'maka-storage');
  const resolvedEnv: RunHarborCellEnv = { ...env, MAKA_OUTPUT_DIR: outputDir, MAKA_STORAGE_ROOT: storageRoot };
  const backend = backendFromEnv(resolvedEnv.MAKA_BACKEND);
  const contextBudgetPolicy = buildHarborCellContextBudgetPolicySnapshot(resolvedEnv);
  const continuationPolicy = buildHarborCellContinuationPolicy(resolvedEnv);
  const economyTaskMode = economyTaskModeFromEnv(resolvedEnv.MAKA_ECONOMY_TASK_MODE);
  const taskLedgerExperimentPolicy = buildHarborCellTaskLedgerExperimentPolicy(resolvedEnv);
  const maxSteps = harborCellMaxStepsFromEnv(resolvedEnv);
  const reasoningEffort = reasoningEffortFromEnv(resolvedEnv.MAKA_REASONING_EFFORT);
  const baseConfig = {
    id: resolvedEnv.MAKA_CONFIG_ID ?? 'harbor-cell',
    backend,
    ...(reasoningEffort ? { thinkingLevel: reasoningEffort } : {}),
    ...(resolvedEnv.MAKA_SYSTEM_PROMPT !== undefined ? { systemPrompt: resolvedEnv.MAKA_SYSTEM_PROMPT } : {}),
    ...(economyTaskMode !== undefined ? { economyTaskMode } : {}),
  };
  let config: Config;
  let registerBackends = options.registerBackends;

  switch (backend) {
    case 'ai-sdk': {
      const modelSpec = parseModelSpec(
        resolvedEnv.MAKA_MODEL ?? resolvedEnv.HARBOR_MODEL ?? 'deepseek/deepseek-v4-flash',
        resolvedEnv.MAKA_PROVIDER,
      );
      config = {
        ...baseConfig,
        llmConnectionSlug: resolvedEnv.MAKA_LLM_CONNECTION_SLUG ?? modelSpec.provider,
        model: modelSpec.model,
      };
      registerBackends ??= buildAiSdkCellBackendRegistration({
        provider: modelSpec.provider,
        model: modelSpec.model,
        env: resolvedEnv,
        now,
        newId,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
      });
      break;
    }
    case 'pi-agent': {
      const model = resolvedEnv.MAKA_PI_MODEL ?? resolvedEnv.MAKA_MODEL ?? resolvedEnv.HARBOR_MODEL;
      if (!model) throw new Error('MAKA_PI_MODEL, MAKA_MODEL, or HARBOR_MODEL must include a model id');
      const piProvider = resolvedEnv.MAKA_PI_PROVIDER;
      if (!registerBackends && !piProvider) {
        throw new Error('MAKA_PI_PROVIDER is required when using the default Pi CLI transport');
      }
      config = {
        ...baseConfig,
        llmConnectionSlug: resolvedEnv.MAKA_LLM_CONNECTION_SLUG ?? piProvider ?? 'pi-agent',
        model,
      };
      registerBackends ??= (registry) => {
        registry.register('pi-agent', (ctx) =>
          new PiAgentBackend({
            sessionId: ctx.sessionId,
            header: ctx.header,
            appendMessage: ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
            permissionEngine: new PermissionEngine({ newId, now }),
            transport: new PiCliJsonTransport({
              command: resolvedEnv.MAKA_PI_COMMAND ?? 'pi',
              ...(piProvider ? { provider: piProvider } : {}),
              model,
              env: buildPiCliEnv(resolvedEnv, piProvider),
            }),
          }),
        );
      };
      break;
    }
    case 'fake':
      config = {
        ...baseConfig,
        llmConnectionSlug: resolvedEnv.MAKA_LLM_CONNECTION_SLUG ?? 'fake',
        model: resolvedEnv.MAKA_MODEL ?? resolvedEnv.HARBOR_MODEL ?? 'fake',
      };
      break;
  }

  return await runHarborCell({
    config,
    instruction: await instructionFromEnv(resolvedEnv),
    cwd: resolvedEnv.MAKA_WORKDIR ?? process.cwd(),
    outputDir,
    storageRoot,
    pricingProfile: resolvedEnv.MAKA_TRIAL_PRICING_SOURCE ?? 'unconfigured',
    ...(contextBudgetPolicy ? { contextBudgetPolicy } : {}),
    ...(continuationPolicy ? { continuationPolicy } : {}),
    ...(taskLedgerExperimentPolicy ? { taskToolSummaryEnabled: true } : {}),
    ...(registerBackends ? { registerBackends } : {}),
    ...(backendNeedsIsolation(backend)
      ? {
          realBackendIsolation: {
            kind: 'external',
            label: 'Harbor task container',
            toolExecutor: createHarborCellLocalToolExecutor(resolvedEnv),
          },
        }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
  });
}

export function reasoningEffortFromEnv(value: string | undefined): import('@maka/core').ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (!isThinkingLevel(value)) throw new Error(`unsupported MAKA_REASONING_EFFORT: ${value}`);
  return value;
}

function economyTaskModeFromEnv(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function buildHarborCellContinuationPolicy(
  env: RunHarborCellEnv = process.env,
): HarborCellContinuationPolicy | undefined {
  const enabled = booleanEnv(env.MAKA_HARBOR_CONTINUATION, 'MAKA_HARBOR_CONTINUATION') ?? false;
  if (!enabled) return undefined;
  const maxTurns = positiveIntEnv(env.MAKA_HARBOR_CONTINUATION_MAX_TURNS, 'MAKA_HARBOR_CONTINUATION_MAX_TURNS') ?? 3;
  return {
    enabled: true,
    maxTurns,
    maxTotalRuntimeSteps: positiveIntEnv(
      env.MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS,
      'MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS',
    ) ?? maxTurns * HARBOR_CELL_DEFAULT_MAX_STEPS_PER_TURN,
    prompt: env.MAKA_HARBOR_CONTINUATION_PROMPT ?? HARBOR_CELL_DEFAULT_CONTINUATION_PROMPT,
  };
}

export function harborCellMaxStepsFromEnv(env: RunHarborCellEnv = process.env): number | undefined {
  return positiveIntEnv(env.MAKA_MAX_STEPS, 'MAKA_MAX_STEPS');
}

function isToolCallStepCap(invocation: InvocationResult): boolean {
  return invocation.failure?.class === 'tool_step_cap_reached'
    || invocation.failure?.class === 'incomplete_tool_calls';
}

function combineInvocations(invocations: readonly InvocationResult[]): InvocationResult {
  const first = invocations[0];
  const last = invocations[invocations.length - 1];
  if (!first || !last) throw new Error('cannot combine empty Harbor invocations');
  return {
    invocationId: last.invocationId,
    sessionId: last.sessionId,
    runId: last.runId,
    turnId: last.turnId,
    status: last.status,
    ...(last.failure ? { failure: last.failure } : {}),
    events: invocations.flatMap((candidate) => candidate.events),
    startedAt: first.startedAt,
    finishedAt: last.finishedAt,
  };
}

function buildContinuationSummary(
  policy: HarborCellContinuationPolicy,
  invocations: readonly InvocationResult[],
  stepCapHits: number,
): HarborCellContinuationSummary {
  const turns = invocations.map((invocation, index) => continuationTurnSummary(invocation, index));
  const runtimeSteps = turns.reduce((sum, turn) => sum + turn.runtimeSteps, 0);
  return {
    enabled: policy.enabled,
    maxTurns: policy.maxTurns,
    maxTotalRuntimeSteps: policy.maxTotalRuntimeSteps,
    turnsUsed: invocations.length,
    continuedTurns: Math.max(0, invocations.length - 1),
    stepCapHits,
    capExhausted: stepCapHits > 0
      && isToolCallStepCap(invocations[invocations.length - 1]!)
      && (invocations.length >= policy.maxTurns || runtimeSteps >= policy.maxTotalRuntimeSteps),
    totalRuntimeSteps: runtimeSteps,
    turns,
  };
}

function totalRuntimeSteps(invocations: readonly InvocationResult[]): number {
  return invocations.reduce((sum, candidate) => sum + invocationRuntimeSteps(candidate), 0);
}

function continuationTurnSummary(
  invocation: InvocationResult,
  turnIndex: number,
): HarborCellContinuationTurnSummary {
  return {
    turnIndex,
    status: invocation.status,
    stepCapHit: isToolCallStepCap(invocation),
    runtimeSteps: invocationRuntimeSteps(invocation),
  };
}

function invocationRuntimeSteps(invocation: InvocationResult): number {
  return invocation.events.reduce((sum, event) => {
    const runtimeSteps = event.actions?.tokenUsage?.runtimeSteps;
    return sum + (runtimeSteps ?? 0);
  }, 0);
}

function failedInvocationFromError(error: unknown, input: {
  newId: () => string;
  now: () => number;
  sessionId: string;
  turnId: string;
}): InvocationResult {
  const ts = input.now();
  const failureClass = error instanceof Error ? error.name : 'Error';
  return {
    invocationId: input.newId(),
    sessionId: input.sessionId,
    runId: input.newId(),
    turnId: input.turnId,
    status: 'failed',
    failure: {
      class: failureClass,
      message: error instanceof Error ? error.message : String(error),
    },
    events: [],
    startedAt: ts,
    finishedAt: ts,
  };
}

export function buildAiSdkCellBackendRegistration(input: {
  provider: ProviderType;
  model: string;
  env: RunHarborCellEnv;
  now: () => number;
  newId: () => string;
  maxSteps?: number;
}): NonNullable<RunHarborCellInput['registerBackends']> {
  const { connection, apiKey } = resolveHarborCellAiSdkEnv({
    provider: input.provider,
    model: input.model,
    env: input.env,
    ts: input.now(),
  });
  const modelKey = `${connection.providerType}:${input.model}`;
  const pricingOverride = resolveHarborCellPricingOverride(input.env, modelKey);
  const lookupPricing = pricingOverride
    ? (key: string): PricingConfig | null => (key === modelKey ? pricingOverride : getBuiltinPricing(key))
    : getBuiltinPricing;
  const permissionEngine = new PermissionEngine({ newId: input.newId, now: input.now });
  const contextBudgetBackendOptions = buildHarborCellContextBudgetBackendOptions(input.env);
  const taskLedgerExperimentPolicy = buildHarborCellTaskLedgerExperimentPolicy(input.env);
  const taskLedgerExperimentStore = taskLedgerExperimentPolicy
    ? createInMemoryTaskLedgerExperimentStore({ now: input.now, newId: input.newId })
    : undefined;
  return (registry, context) => {
    if (!context.toolExecutor) {
      throw new Error('Harbor ai-sdk backend requires an isolated tool executor');
    }
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
        tools: buildHarborCellAiSdkTools(context.toolExecutor!, {
          ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
          ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
          ...(context.heavyTaskSelfCheck ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck } : {}),
          ...(taskLedgerExperimentStore && taskLedgerExperimentPolicy
            ? { taskLedgerExperiment: { store: taskLedgerExperimentStore } }
            : {}),
        }),
        toolAvailability: buildIsolatedHeadlessToolAvailability(),
        providerOptions: buildProviderOptions(connection, input.model, ctx.header.thinkingLevel),
        systemPrompt: harborCellSystemPrompt(context.config.systemPrompt),
        ...(taskLedgerExperimentStore && taskLedgerExperimentPolicy
          ? {
              turnTailPrompt: async ({ sessionId }) =>
                renderTaskLedgerExperimentReplay(await taskLedgerExperimentStore.list(sessionId), {
                  maxChars: taskLedgerExperimentPolicy.replayMaxChars,
                }),
            }
          : {}),
        lookupPricing,
        ...contextBudgetBackendOptions,
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        newId: input.newId,
        now: input.now,
        recordRunTrace: ctx.recordRunTrace,
        recordActiveFullCompactBlock: ctx.recordActiveFullCompactBlock,
        recordSemanticCompactBlock: ctx.recordSemanticCompactBlock,
      }),
    );
  };
}

export const buildHarborAiSdkBackendRegistration = buildAiSdkCellBackendRegistration;

export function buildHarborCellAiSdkTools(
  executor: IsolatedToolExecutor,
  options: BuildIsolatedHeadlessToolsOptions = {},
): MakaTool[] {
  const nonInteractiveToolNames = new Set<string>(ISOLATED_HEADLESS_TOOL_NAMES);
  return buildIsolatedHeadlessTools(executor, options).map((tool) => (
    nonInteractiveToolNames.has(tool.name)
      ? { ...tool, permissionRequired: false }
      : tool
  ));
}

export function buildHarborCellContextBudgetBackendOptions(
  env: RunHarborCellEnv = process.env,
): HarborCellContextBudgetBackendOptions {
  normalizeHarborCellContextEnv(env);
  if (env.MAKA_CONTEXT_BUDGET === 'off') return {};
  const pruneEnabled = booleanEnv(
    env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE ??
    env.MAKA_HARBOR_CONTEXT_STALE_TOOL_RESULT_PRUNE ??
    env.MAKA_TOOL_RESULT_PRUNE,
    'MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE',
  ) ?? true;
  const activePruneEnabled = booleanEnv(
    env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE ??
    env.MAKA_HARBOR_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE ??
    env.MAKA_ACTIVE_TOOL_RESULT_PRUNE,
    'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
  ) ?? true;
  const archiveRetrievalEnabled = booleanEnv(
    env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL ??
    env.MAKA_HARBOR_CONTEXT_ARCHIVE_RETRIEVAL,
    'MAKA_CONTEXT_ARCHIVE_RETRIEVAL',
  ) ?? false;
  const activeFullCompactEnabled = booleanEnv(
    env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT ??
    env.MAKA_HARBOR_CONTEXT_ACTIVE_FULL_COMPACT,
    'MAKA_CONTEXT_ACTIVE_FULL_COMPACT',
  ) ?? false;
  const semanticCompactEnabled = booleanEnv(
    env.MAKA_CONTEXT_SEMANTIC_COMPACT ??
    env.MAKA_HARBOR_CONTEXT_SEMANTIC_COMPACT,
    'MAKA_CONTEXT_SEMANTIC_COMPACT',
  ) ?? false;
  if (!pruneEnabled && !activePruneEnabled && !archiveRetrievalEnabled && !activeFullCompactEnabled && !semanticCompactEnabled) return {};

  const contextBudget: ContextBudgetPolicy = {
    name: env.MAKA_CONTEXT_BUDGET_NAME ?? 'harbor-cell-context-budget',
  };
  const charsPerToken = numericEnv(env.MAKA_CONTEXT_CHARS_PER_TOKEN);
  const maxHistoryEstimatedTokens = firstContextNonNegativeIntEnv(env, [
    'MAKA_CONTEXT_MAX_HISTORY_ESTIMATED_TOKENS',
    'MAKA_CONTEXT_HISTORY_BUDGET_TOKENS',
  ]);
  const maxHistoryTurns = firstContextNonNegativeIntEnv(env, [
    'MAKA_CONTEXT_MAX_HISTORY_TURNS',
    'MAKA_CONTEXT_HISTORY_BUDGET_TURNS',
  ]);
  const minRecentTurns = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_MIN_RECENT_TURNS']);
  if (charsPerToken !== undefined) contextBudget.charsPerToken = charsPerToken;
  if (maxHistoryEstimatedTokens !== undefined) contextBudget.maxHistoryEstimatedTokens = maxHistoryEstimatedTokens;
  if (maxHistoryTurns !== undefined) contextBudget.maxHistoryTurns = maxHistoryTurns;
  if (minRecentTurns !== undefined) contextBudget.minRecentTurns = minRecentTurns;

  if (pruneEnabled) {
    const maxResultEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS ??
      env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE_MAX_ESTIMATED_TOKENS ??
      env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS,
      'MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
    );
    const minRecentTurnsFull = firstContextNonNegativeIntEnv(env, [
      'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL',
      'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS',
    ]);
    contextBudget.staleToolResultPrune = {
      enabled: true,
      ...(maxResultEstimatedTokens !== undefined ? { maxResultEstimatedTokens } : {}),
      // Explicit so the runtime protection window matches the policy snapshot
      // and desktop default (2) instead of the runtime's internal ?? 1 fallback.
      minRecentTurnsFull: minRecentTurnsFull ?? minRecentTurns ?? 2,
    };
  }

  if (activePruneEnabled) {
    const maxCurrentResultEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS ??
      env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
    );
    const minStepNumber = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER']);
    contextBudget.activeToolResultPrune = {
      enabled: true,
      ...(maxCurrentResultEstimatedTokens !== undefined ? { maxCurrentResultEstimatedTokens } : {}),
      ...(minStepNumber !== undefined ? { minStepNumber } : {}),
    };
  }

  if (archiveRetrievalEnabled) {
    const mode = archiveRetrievalModeEnv(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE);
    const maxResults = positiveIntEnv(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS, 'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS');
    const maxEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_ESTIMATED_TOKENS ??
      env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS,
      'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_ESTIMATED_TOKENS',
    );
    const maxBytes = positiveIntEnv(env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES, 'MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES');
    contextBudget.archiveRetrieval = {
      enabled: true,
      ...(mode ? { mode } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
      ...(maxEstimatedTokens !== undefined ? { maxEstimatedTokens } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    };
  }

  if (activeFullCompactEnabled) {
    const mode = activeFullCompactModeEnv(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MODE);
    const maxActiveEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS ??
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS',
    );
    const minStepNumber = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER']);
    const minRecentMessages = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES']);
    const minRecentToolPairs = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_TOOL_PAIRS']);
    const maxSummaryEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS ??
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS',
    );
    const archiveRequired = booleanEnv(
      env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_ARCHIVE_REQUIRED,
      'MAKA_CONTEXT_ACTIVE_FULL_COMPACT_ARCHIVE_REQUIRED',
    );
    const highWaterRatio = numericEnv(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO);
    const forceRatio = numericEnv(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_FORCE_RATIO);
    const targetRatio = numericEnv(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_TARGET_RATIO);
    contextBudget.activeFullCompact = {
      enabled: true,
      ...(mode ? { mode } : {}),
      ...(minStepNumber !== undefined ? { minStepNumber } : {}),
      ...(highWaterRatio !== undefined ? { highWaterRatio } : {}),
      ...(forceRatio !== undefined ? { forceRatio } : {}),
      ...(targetRatio !== undefined ? { targetRatio } : {}),
      ...(maxActiveEstimatedTokens !== undefined ? { maxActiveEstimatedTokens } : {}),
      ...(minRecentMessages !== undefined ? { minRecentMessages } : {}),
      ...(minRecentToolPairs !== undefined ? { minRecentToolPairs } : {}),
      ...(maxSummaryEstimatedTokens !== undefined ? { maxSummaryEstimatedTokens } : {}),
      ...(archiveRequired !== undefined ? { archiveRequired } : {}),
      ...(env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME
        ? { highWaterName: env.MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME }
        : {}),
    };
  }

  if (semanticCompactEnabled) {
    const mode = semanticCompactModeEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODE);
    const maxActiveEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS ??
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS',
    );
    const minStepNumber = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER']);
    const minRecentMessages = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES']);
    const minRecentToolPairs = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS']);
    const maxSummaryEstimatedTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS ??
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_SUMMARY_MAX_ESTIMATED_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS',
    );
    const minSavingsTokens = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS']);
    const minNetSavingsTokens = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS']);
    const maxCompactCallTokens = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS',
    );
    const maxConsecutiveInvalidSummaries = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES']);
    const invalidSummaryCooldownSteps = firstContextNonNegativeIntEnv(env, ['MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS']);
    const timeoutMs = positiveIntEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS',
    );
    const archiveRequired = booleanEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED',
    );
    const benchmarkStateCards = booleanEnv(
      env.MAKA_CONTEXT_SEMANTIC_COMPACT_BENCHMARK_STATE_CARDS,
      'MAKA_CONTEXT_SEMANTIC_COMPACT_BENCHMARK_STATE_CARDS',
    );
    const highWaterRatio = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_RATIO);
    const forceRatio = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_FORCE_RATIO);
    const targetRatio = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_TARGET_RATIO);
    const minSavingsRatio = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO);
    const compactCallTokenCostWeight = numericEnv(env.MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT);
    contextBudget.semanticCompact = {
      enabled: true,
      ...(mode ? { mode } : {}),
      ...(minStepNumber !== undefined ? { minStepNumber } : {}),
      ...(highWaterRatio !== undefined ? { highWaterRatio } : {}),
      ...(forceRatio !== undefined ? { forceRatio } : {}),
      ...(targetRatio !== undefined ? { targetRatio } : {}),
      ...(maxActiveEstimatedTokens !== undefined ? { maxActiveEstimatedTokens } : {}),
      ...(minRecentMessages !== undefined ? { minRecentMessages } : {}),
      ...(minRecentToolPairs !== undefined ? { minRecentToolPairs } : {}),
      ...(maxSummaryEstimatedTokens !== undefined ? { maxSummaryEstimatedTokens } : {}),
      ...(minSavingsTokens !== undefined ? { minSavingsTokens } : {}),
      ...(minSavingsRatio !== undefined ? { minSavingsRatio } : {}),
      ...(minNetSavingsTokens !== undefined ? { minNetSavingsTokens } : {}),
      ...(compactCallTokenCostWeight !== undefined ? { compactCallTokenCostWeight } : {}),
      ...(maxCompactCallTokens !== undefined ? { maxCompactCallTokens } : {}),
      ...(maxConsecutiveInvalidSummaries !== undefined ? { maxConsecutiveInvalidSummaries } : {}),
      ...(invalidSummaryCooldownSteps !== undefined ? { invalidSummaryCooldownSteps } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(archiveRequired !== undefined ? { archiveRequired } : {}),
      ...(benchmarkStateCards !== undefined ? { benchmarkStateCards } : {}),
      ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL
        ? { summarizerModel: env.MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL }
        : {}),
      ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION
        ? { promptVersion: env.MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION }
        : {}),
      ...(env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME
        ? { highWaterName: env.MAKA_CONTEXT_SEMANTIC_COMPACT_HIGH_WATER_NAME }
        : {}),
    };
  }

  const archiveDir = harborCellToolResultArchiveDir(env);
  if (!archiveDir) return { contextBudget };
  return {
    contextBudget,
    archiveToolResult: async (input) => {
      await mkdir(archiveDir, { recursive: true });
      const artifactId = harborCellToolResultArchiveArtifactId(input);
      const record: HarborCellToolResultArchiveRecord = {
        version: 1,
        sessionId: input.sessionId,
        runtimeEventId: input.runtimeEventId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        bodySha256: input.bodySha256,
        originalEstimatedTokens: input.originalEstimatedTokens,
        originalBytes: input.originalBytes,
        serializedResult: input.serializedResult,
      };
      await writeFile(join(archiveDir, artifactId), `${JSON.stringify(record)}\n`, 'utf8');
      return { artifactId };
    },
    readToolResultArchive: async (input) => {
      if (!isSafeHarborCellArchiveArtifactId(input.artifactId)) return { ok: false, reason: 'not_allowed' };
      let raw: string;
      try {
        raw = await readFile(join(archiveDir, input.artifactId), 'utf8');
      } catch {
        return { ok: false, reason: 'not_found' };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, reason: 'corrupt' };
      }
      if (!isHarborCellToolResultArchiveRecord(parsed)) return { ok: false, reason: 'corrupt' };
      if (parsed.sessionId !== input.sessionId) return { ok: false, reason: 'session_mismatch' };
      if (parsed.runtimeEventId !== input.runtimeEventId || parsed.toolCallId !== input.toolCallId) {
        return { ok: false, reason: 'source_mismatch' };
      }
      if (parsed.originalBytes !== input.originalBytes) return { ok: false, reason: 'size_mismatch' };
      if (parsed.bodySha256 !== input.bodySha256) return { ok: false, reason: 'source_mismatch' };
      const actualSha = createHash('sha256').update(parsed.serializedResult).digest('hex');
      if (actualSha !== input.bodySha256) return { ok: false, reason: 'corrupt' };
      if (Buffer.byteLength(parsed.serializedResult, 'utf8') !== input.originalBytes) {
        return { ok: false, reason: 'size_mismatch' };
      }
      return { ok: true, serializedResult: parsed.serializedResult };
    },
  };
}

export function buildHarborCellTaskLedgerExperimentPolicy(
  env: RunHarborCellEnv = process.env,
): HarborCellTaskLedgerExperimentPolicy | undefined {
  normalizeHarborCellContextEnv(env);
  const enabled = booleanEnv(env.MAKA_CONTEXT_TASK_TOOLS, 'MAKA_CONTEXT_TASK_TOOLS') ?? false;
  if (!enabled) return undefined;
  return {
    enabled: true,
    replayMaxChars: positiveIntEnv(env.MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS, 'MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS') ?? 4_000,
  };
}

export function buildHarborCellContextBudgetPolicySnapshot(
  env: RunHarborCellEnv,
): HarborCellContextBudgetPolicySnapshot | undefined {
  if (env.MAKA_CONTEXT_BUDGET === 'off') return { enabled: false };
  const contextBudget = buildHarborCellContextBudgetBackendOptions(env).contextBudget;
  if (!contextBudget) return undefined;
  const minRecentTurns = contextBudget.minRecentTurns ?? 2;
  return {
    enabled: true,
    name: contextBudget.name,
    ...(contextBudget.maxHistoryTurns !== undefined ? { maxHistoryTurns: contextBudget.maxHistoryTurns } : {}),
    ...(contextBudget.maxHistoryEstimatedTokens !== undefined
      ? { maxHistoryEstimatedTokens: contextBudget.maxHistoryEstimatedTokens }
      : {}),
    ...(contextBudget.staleToolResultPrune
      ? {
          staleToolResultPrune: {
            enabled: contextBudget.staleToolResultPrune.enabled,
            maxResultEstimatedTokens: contextBudget.staleToolResultPrune.maxResultEstimatedTokens ?? 2048,
            minRecentTurnsFull: contextBudget.staleToolResultPrune.minRecentTurnsFull ?? minRecentTurns,
          },
        }
      : {}),
    ...(contextBudget.activeToolResultPrune
      ? {
          activeToolResultPrune: {
            enabled: contextBudget.activeToolResultPrune.enabled,
            maxCurrentResultEstimatedTokens: contextBudget.activeToolResultPrune.maxCurrentResultEstimatedTokens ?? 2048,
            minStepNumber: contextBudget.activeToolResultPrune.minStepNumber ?? 1,
          },
        }
      : {}),
    ...(contextBudget.activeFullCompact
      ? {
          activeFullCompact: {
            enabled: contextBudget.activeFullCompact.enabled,
            ...(contextBudget.activeFullCompact.mode ? { mode: contextBudget.activeFullCompact.mode } : {}),
            ...(contextBudget.activeFullCompact.minStepNumber !== undefined
              ? { minStepNumber: contextBudget.activeFullCompact.minStepNumber }
              : {}),
            ...(contextBudget.activeFullCompact.highWaterRatio !== undefined
              ? { highWaterRatio: contextBudget.activeFullCompact.highWaterRatio }
              : {}),
            ...(contextBudget.activeFullCompact.forceRatio !== undefined
              ? { forceRatio: contextBudget.activeFullCompact.forceRatio }
              : {}),
            ...(contextBudget.activeFullCompact.targetRatio !== undefined
              ? { targetRatio: contextBudget.activeFullCompact.targetRatio }
              : {}),
            ...(contextBudget.activeFullCompact.maxActiveEstimatedTokens !== undefined
              ? { maxActiveEstimatedTokens: contextBudget.activeFullCompact.maxActiveEstimatedTokens }
              : {}),
            ...(contextBudget.activeFullCompact.minRecentMessages !== undefined
              ? { minRecentMessages: contextBudget.activeFullCompact.minRecentMessages }
              : {}),
            ...(contextBudget.activeFullCompact.minRecentToolPairs !== undefined
              ? { minRecentToolPairs: contextBudget.activeFullCompact.minRecentToolPairs }
              : {}),
            ...(contextBudget.activeFullCompact.maxSummaryEstimatedTokens !== undefined
              ? { maxSummaryEstimatedTokens: contextBudget.activeFullCompact.maxSummaryEstimatedTokens }
              : {}),
            ...(contextBudget.activeFullCompact.archiveRequired !== undefined
              ? { archiveRequired: contextBudget.activeFullCompact.archiveRequired }
              : {}),
            ...(contextBudget.activeFullCompact.highWaterName
              ? { highWaterName: contextBudget.activeFullCompact.highWaterName }
              : {}),
          },
        }
      : {}),
    ...(contextBudget.semanticCompact
      ? {
          semanticCompact: {
            enabled: contextBudget.semanticCompact.enabled,
            ...(contextBudget.semanticCompact.mode ? { mode: contextBudget.semanticCompact.mode } : {}),
            ...(contextBudget.semanticCompact.minStepNumber !== undefined
              ? { minStepNumber: contextBudget.semanticCompact.minStepNumber }
              : {}),
            ...(contextBudget.semanticCompact.highWaterRatio !== undefined
              ? { highWaterRatio: contextBudget.semanticCompact.highWaterRatio }
              : {}),
            ...(contextBudget.semanticCompact.forceRatio !== undefined
              ? { forceRatio: contextBudget.semanticCompact.forceRatio }
              : {}),
            ...(contextBudget.semanticCompact.targetRatio !== undefined
              ? { targetRatio: contextBudget.semanticCompact.targetRatio }
              : {}),
            ...(contextBudget.semanticCompact.maxActiveEstimatedTokens !== undefined
              ? { maxActiveEstimatedTokens: contextBudget.semanticCompact.maxActiveEstimatedTokens }
              : {}),
            ...(contextBudget.semanticCompact.minRecentMessages !== undefined
              ? { minRecentMessages: contextBudget.semanticCompact.minRecentMessages }
              : {}),
            ...(contextBudget.semanticCompact.minRecentToolPairs !== undefined
              ? { minRecentToolPairs: contextBudget.semanticCompact.minRecentToolPairs }
              : {}),
            ...(contextBudget.semanticCompact.maxSummaryEstimatedTokens !== undefined
              ? { maxSummaryEstimatedTokens: contextBudget.semanticCompact.maxSummaryEstimatedTokens }
              : {}),
            ...(contextBudget.semanticCompact.minSavingsTokens !== undefined
              ? { minSavingsTokens: contextBudget.semanticCompact.minSavingsTokens }
              : {}),
            ...(contextBudget.semanticCompact.minSavingsRatio !== undefined
              ? { minSavingsRatio: contextBudget.semanticCompact.minSavingsRatio }
              : {}),
            ...(contextBudget.semanticCompact.minNetSavingsTokens !== undefined
              ? { minNetSavingsTokens: contextBudget.semanticCompact.minNetSavingsTokens }
              : {}),
            ...(contextBudget.semanticCompact.compactCallTokenCostWeight !== undefined
              ? { compactCallTokenCostWeight: contextBudget.semanticCompact.compactCallTokenCostWeight }
              : {}),
            ...(contextBudget.semanticCompact.maxCompactCallTokens !== undefined
              ? { maxCompactCallTokens: contextBudget.semanticCompact.maxCompactCallTokens }
              : {}),
            ...(contextBudget.semanticCompact.maxConsecutiveInvalidSummaries !== undefined
              ? { maxConsecutiveInvalidSummaries: contextBudget.semanticCompact.maxConsecutiveInvalidSummaries }
              : {}),
            ...(contextBudget.semanticCompact.invalidSummaryCooldownSteps !== undefined
              ? { invalidSummaryCooldownSteps: contextBudget.semanticCompact.invalidSummaryCooldownSteps }
              : {}),
            ...(contextBudget.semanticCompact.timeoutMs !== undefined
              ? { timeoutMs: contextBudget.semanticCompact.timeoutMs }
              : {}),
            ...(contextBudget.semanticCompact.archiveRequired !== undefined
              ? { archiveRequired: contextBudget.semanticCompact.archiveRequired }
              : {}),
            ...(contextBudget.semanticCompact.benchmarkStateCards !== undefined
              ? { benchmarkStateCards: contextBudget.semanticCompact.benchmarkStateCards }
              : {}),
            ...(contextBudget.semanticCompact.summarizerModel
              ? { summarizerModel: contextBudget.semanticCompact.summarizerModel }
              : {}),
            ...(contextBudget.semanticCompact.promptVersion
              ? { promptVersion: contextBudget.semanticCompact.promptVersion }
              : {}),
            ...(contextBudget.semanticCompact.highWaterName
              ? { highWaterName: contextBudget.semanticCompact.highWaterName }
              : {}),
          },
        }
      : {}),
    ...(contextBudget.archiveRetrieval
      ? {
          archiveRetrieval: {
            enabled: contextBudget.archiveRetrieval.enabled,
            ...(contextBudget.archiveRetrieval.mode ? { mode: contextBudget.archiveRetrieval.mode } : {}),
            maxResults: contextBudget.archiveRetrieval.maxResults ?? 3,
            maxEstimatedTokens: contextBudget.archiveRetrieval.maxEstimatedTokens ?? 8192,
            maxBytes: contextBudget.archiveRetrieval.maxBytes ?? 1024 * 1024,
            order: 'newest_first',
          },
        }
      : {}),
    minRecentTurns,
  };
}

export const HARBOR_CELL_DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

export function createHarborHttpToolExecutor(env: RunHarborCellEnv = process.env): IsolatedToolExecutor {
  const baseUrl = requiredHarborEnv(env, 'MAKA_HARBOR_TOOL_EXECUTOR_URL');
  const token = requiredHarborEnv(env, 'MAKA_HARBOR_TOOL_EXECUTOR_TOKEN');
  return {
    exec: async (input) => {
      const timeoutSec = input.timeoutMs === undefined
        ? undefined
        : Math.max(1, Math.ceil(input.timeoutMs / 1000));
      const response = await fetch(new URL('/exec', baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...input,
          ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        }),
      });
      const body = await response.text();
      if (!response.ok) return { exitCode: 1, stdout: '', stderr: body };
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed)) return { exitCode: 1, stdout: '', stderr: 'Harbor bridge returned a non-object response' };
      const exitCode = parsed.exitCode ?? parsed.returnCode;
      return {
        exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : 1,
        stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
        stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
      };
    },
  };
}

export function createHarborCellLocalToolExecutor(env: RunHarborCellEnv = process.env): IsolatedToolExecutor {
  const childEnv = childProcessEnv(env);
  // A command that does not request its own timeout falls back to this. Some
  // Terminal-Bench tasks build or test for longer than the 2-minute default, so
  // the floor is operator-configurable instead of a hard-coded failure source.
  const defaultTimeoutMs = numericEnv(env.MAKA_CELL_COMMAND_TIMEOUT_MS) ?? HARBOR_CELL_DEFAULT_COMMAND_TIMEOUT_MS;
  // The shell this executor spawns in (PowerShell on Windows). Exposed as
  // `shell` so buildIsolatedBashTool DECLARES the dialect to the model, and
  // passed to runShellWithBoundedTail so the declaration matches execution —
  // selection without declaration is the original Windows bug (shell-detect.ts).
  const shell = defaultShellPlan();
  return {
    shell,
    exec: async ({ command, cwd, timeoutMs, boundedTail }) => {
      if (boundedTail) {
        // Bash opted in: stream into a bounded tail (shared with the in-process
        // builtin Bash) instead of execAsync({ maxBuffer }). A command whose
        // output passes 10MB is no longer KILLED with only its head returned —
        // it runs to completion and we keep the last ~1MB (the recoverable tail).
        try {
          const result = await runShellWithBoundedTail(command, {
            cwd,
            env: childEnv,
            timeoutMs: timeoutMs ?? defaultTimeoutMs,
            shell,
          });
          return {
            exitCode: result.timedOut ? 124 : result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
          };
        } catch (error) {
          // runShellWithBoundedTail only rejects when the process cannot be
          // spawned at all (e.g. the shell binary is missing).
          return {
            exitCode: shellErrorExitCode(error),
            stdout: shellErrorText(error, 'stdout'),
            stderr: shellErrorText(error, 'stderr') || shellErrorMessage(error),
          };
        }
      }
      // Default (Read/Glob/Grep/Edit fallbacks): FULL output up to the buffer
      // cap. These must return complete, head-first content — a bounded tail
      // would silently drop the head of a file or search result and the model
      // would edit code from a partial view.
      try {
        const result = await execAsync(command, {
          cwd,
          env: childEnv,
          timeout: timeoutMs ?? defaultTimeoutMs,
          maxBuffer: HARBOR_CELL_TOOL_MAX_BUFFER_BYTES,
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return {
          exitCode: shellErrorExitCode(error),
          stdout: shellErrorText(error, 'stdout'),
          stderr: shellErrorText(error, 'stderr') || shellErrorMessage(error),
        };
      }
    },
  };
}

function requiredHarborEnv(env: RunHarborCellEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// When the cell is given an explicit system prompt (MAKA_SYSTEM_PROMPT), it is
// the complete prompt and is passed through byte-for-byte: the prompt-optimization
// controller hashes exactly this string and verifies the round-trip against the
// systemPromptHash the runtime stamps, so any wrapping here would break the check
// (and make "the prompt being optimized" differ from "the prompt that ran").
// The built-in preamble is only the default for prompt-less ad-hoc cell runs.
function harborCellSystemPrompt(configPrompt: string | undefined): string {
  if (configPrompt !== undefined) return configPrompt;
  return [
    'You are Maka Runtime running inside an isolated Harbor benchmark task container.',
    'Prefer Read, Glob, and Grep for file inspection and search.',
    'Prefer Edit and Write for file changes.',
    'Use Bash for running programs, tests, and shell-specific debugging only.',
  ].join('\n');
}

// Builtin pricing has no entry for newer DeepSeek models (e.g. deepseek-v4-flash),
// so without an override the cell would emit costUsd=0 and the controller would
// flag every task as a zero_cost_with_tokens plumbing failure. Honor the same
// MAKA_TRIAL_*_USD_PER_1M env the Python adapter (trial_pricing.py) already reads,
// so one pricing source feeds both the runtime cell cost and the Harbor trial cost.
function resolveHarborCellPricingOverride(env: RunHarborCellEnv, modelKey: string): PricingConfig | null {
  const inputUsdPer1M = numericEnv(env.MAKA_TRIAL_INPUT_USD_PER_1M);
  const outputUsdPer1M = numericEnv(env.MAKA_TRIAL_OUTPUT_USD_PER_1M);
  if (inputUsdPer1M === undefined || outputUsdPer1M === undefined) return null;
  const cacheReadUsdPer1M = numericEnv(env.MAKA_TRIAL_CACHE_READ_USD_PER_1M);
  const cacheWriteUsdPer1M = numericEnv(env.MAKA_TRIAL_CACHE_WRITE_USD_PER_1M);
  return {
    modelKey,
    inputUsdPer1M,
    outputUsdPer1M,
    ...(cacheReadUsdPer1M !== undefined ? { cacheReadUsdPer1M } : {}),
    ...(cacheWriteUsdPer1M !== undefined ? { cacheWriteUsdPer1M } : {}),
  };
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveIntEnv(raw: string | undefined, name: string): number | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return Number(value);
}

function firstContextNonNegativeIntEnv(
  env: RunHarborCellEnv,
  names: readonly string[],
): number | undefined {
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined) return contextNonNegativeIntEnv(raw, name);
  }
  return undefined;
}

function contextNonNegativeIntEnv(raw: string | undefined, name: string): number | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(value);
}

function archiveRetrievalModeEnv(
  raw: string | undefined,
): NonNullable<ContextBudgetPolicy['archiveRetrieval']>['mode'] | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (value === 'eager' || value === 'history_search_gated') return value;
  throw new Error(`MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE must be one of eager, history_search_gated, got ${JSON.stringify(raw)}`);
}

function activeFullCompactModeEnv(
  raw: string | undefined,
): NonNullable<ContextBudgetPolicy['activeFullCompact']>['mode'] | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (value === 'off' || value === 'index_only' || value === 'validate_only' || value === 'prepare_step_dry_run') {
    return value;
  }
  throw new Error(
    `MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MODE must be one of off, index_only, validate_only, prepare_step_dry_run, got ${JSON.stringify(raw)}`,
  );
}

function semanticCompactModeEnv(
  raw: string | undefined,
): NonNullable<ContextBudgetPolicy['semanticCompact']>['mode'] | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (value === 'off' || value === 'validate_only' || value === 'prepare_step_dry_run' || value === 'replace') {
    return value;
  }
  throw new Error(
    `MAKA_CONTEXT_SEMANTIC_COMPACT_MODE must be one of off, validate_only, prepare_step_dry_run, replace, got ${JSON.stringify(raw)}`,
  );
}

function booleanEnv(raw: string | undefined, name: string): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return undefined;
  switch (value) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
    case 'disabled':
      return false;
    default:
      throw new Error(`${name} must be a boolean, got ${JSON.stringify(raw)}`);
  }
}

function harborCellToolResultArchiveDir(env: RunHarborCellEnv): string | undefined {
  return (
    env.MAKA_CONTEXT_TOOL_RESULT_ARCHIVE_DIR ??
    env.MAKA_TOOL_RESULT_ARCHIVE_DIR ??
    env.MAKA_HARBOR_TOOL_RESULT_ARCHIVE_DIR ??
    (env.MAKA_OUTPUT_DIR ? join(env.MAKA_OUTPUT_DIR, 'tool-result-archives') : undefined)
  );
}

function harborCellToolResultArchiveArtifactId(input: {
  sessionId: string;
  runtimeEventId: string;
  bodySha256: string;
}): string {
  return [
    safeArtifactIdPart(input.sessionId),
    safeArtifactIdPart(input.runtimeEventId),
    safeArtifactIdPart(input.bodySha256.slice(0, 16)),
  ].join('--') + '.json';
}

function safeArtifactIdPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.=-]/g, '_').slice(0, 96);
  return safe || 'unknown';
}

function isSafeHarborCellArchiveArtifactId(value: string): boolean {
  return /^[A-Za-z0-9_.=-]+\.json$/.test(value);
}

function isHarborCellToolResultArchiveRecord(value: unknown): value is HarborCellToolResultArchiveRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.sessionId === 'string' &&
    typeof value.runtimeEventId === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.bodySha256 === 'string' &&
    typeof value.originalEstimatedTokens === 'number' &&
    typeof value.originalBytes === 'number' &&
    typeof value.serializedResult === 'string'
  );
}

/** Provider secrets the LLM backend already captured; task tool subprocesses must
 * never see them, or a candidate prompt could `cat $..._API_KEY_FILE` and exfiltrate. */
const TOOL_CHILD_SECRET_ENV = /_API_KEY(_FILE)?$/;

function childProcessEnv(env: RunHarborCellEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  for (const key of Object.keys(childEnv)) {
    if (TOOL_CHILD_SECRET_ENV.test(key)) delete childEnv[key];
  }
  return childEnv;
}

function shellErrorExitCode(error: unknown): number {
  if (isRecord(error) && typeof error.code === 'number') return error.code;
  if (isRecord(error) && typeof error.signal === 'string') return 124;
  return 1;
}

function shellErrorText(error: unknown, field: 'stdout' | 'stderr'): string {
  if (isRecord(error) && typeof error[field] === 'string') return error[field];
  return '';
}

function shellErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildPiCliEnv(env: RunHarborCellEnv, provider: string | undefined): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  copyEnv(result, { ...process.env, ...env }, PI_BASE_ENV_KEYS);
  copyPrefixedEnv(result, env, 'PI_');

  const normalizedProvider = provider?.toLowerCase() ?? '';
  const rule = PI_PROVIDER_ENV_RULES.find((candidate) =>
    candidate.includes.some((value) => normalizedProvider.includes(value)),
  );
  copyEnv(result, env, rule?.keys ?? []);
  for (const prefix of rule?.prefixes ?? []) copyPrefixedEnv(result, env, prefix);

  return result;
}

function copyPrefixedEnv(target: NodeJS.ProcessEnv, source: RunHarborCellEnv, prefix: string): void {
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(prefix) && value !== undefined) target[key] = value;
  }
}

function copyEnv(target: NodeJS.ProcessEnv, source: RunHarborCellEnv, keys: string[]): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

export function resolveHarborCellAiSdkEnv(input: {
  provider: ProviderType;
  model: string;
  env: RunHarborCellEnv;
  ts: number;
}): ResolvedHarborCellAiSdkEnv {
  const connection = connectionFromEnv(input.provider, input.model, input.env, input.ts);
  return {
    connection,
    apiKey: apiKeyFromEnv(input.provider, input.env, connection.slug),
  };
}

async function instructionFromEnv(env: RunHarborCellEnv): Promise<string> {
  if (env.MAKA_INSTRUCTION !== undefined) return env.MAKA_INSTRUCTION;
  if (env.MAKA_INSTRUCTION_FILE) return await readFile(env.MAKA_INSTRUCTION_FILE, 'utf8');
  throw new Error('MAKA_INSTRUCTION or MAKA_INSTRUCTION_FILE is required');
}

function backendFromEnv(value: string | undefined): BackendKind {
  if (!value) return 'ai-sdk';
  if (value === 'fake' || value === 'ai-sdk' || value === 'pi-agent') return value;
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
  for (const name of providerCredentialEnv(provider)?.baseUrls ?? []) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function apiKeyFromEnv(provider: ProviderType, env: RunHarborCellEnv, connectionSlug: string): string {
  return resolveApiKey(env, providerCredentialEnv(provider)?.apiKeys ?? [], connectionSlug);
}

// Resolve an API key from either the raw env var or its `<NAME>_FILE` companion.
// The file path is what travels through the Harbor CLI / job config, so the secret
// itself stays in a mounted file — never on a command line or in config.json.
function resolveApiKey(env: RunHarborCellEnv, names: readonly string[], connectionSlug?: string): string {
  for (const name of names) {
    const raw = env[name];
    if (raw) return raw;
    const filePath = env[`${name}_FILE`];
    if (filePath) {
      try {
        return readFileSync(filePath, 'utf8').trim();
      } catch {
        // Fall through to the next candidate (or empty) when the file is unreadable.
      }
    }
  }
  if (connectionSlug) {
    return readStoredMakaApiKey(env, connectionSlug);
  }
  return '';
}

function readStoredMakaApiKey(env: RunHarborCellEnv, connectionSlug: string): string {
  const credentialPath = env.MAKA_CREDENTIALS_PATH
    ?? join(homedir(), 'Library', 'Application Support', 'Maka', 'workspaces', 'default', 'credentials.json');
  try {
    const parsed = JSON.parse(readFileSync(credentialPath, 'utf8')) as {
      version?: unknown;
      values?: unknown;
    };
    if (parsed.version !== 1 || !parsed.values || typeof parsed.values !== 'object') return '';
    const value = (parsed.values as Record<string, unknown>)[`${connectionSlug}:apiKey`];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function runtimeEventsJsonl(invocation: InvocationResult): string {
  if (invocation.events.length === 0) return '';
  return `${invocation.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
