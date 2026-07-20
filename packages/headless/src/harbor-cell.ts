import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BackendKind, PricingConfig, ProviderType } from '@maka/core';
import { isThinkingLevel } from '@maka/core';
import {
  AiSdkBackend,
  BackendRegistry,
  PermissionEngine,
  PiAgentBackend,
  SessionManager,
  buildChildAgentTools,
  buildProviderOptions,
  buildSubscriptionModelFetch,
  createProviderRequestCaptureRecorder,
  getAIModel,
  getBuiltinPricing,
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
  type InvocationResult,
  type SynthesisCacheLoader,
  type SynthesisCacheWriter,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createArtifactStore,
  createRuntimeEventStore,
  createSessionStore,
  persistProviderRequestCaptureArtifact,
} from '@maka/storage';
import { registerFakeBackend } from './backends.js';
import {
  buildHarborCellOutput,
  countRuntimeSteps,
  validateHarborCellOutput,
  type HarborCellContextBudgetPolicySnapshot,
  type HarborCellOutput,
} from './cell-output.js';
import type { Config, Task } from './contracts.js';
import { resolveHeavyTaskMode } from './heavy-task-policy.js';
import { resolveEconomyTaskMode } from './economy-task-policy.js';
import type { HeadlessBackendContext, RealBackendIsolation } from './isolation.js';
import { validateRealBackendIsolation } from './isolation.js';
import { PiCliJsonTransport } from './pi-cli-json-transport.js';
import { providerFromEnv, resolveHarborCellAiSdkEnv } from './provider-env.js';
import { backendNeedsIsolation } from './runner.js';
import { buildIsolatedHeadlessToolAvailability, buildIsolatedHeadlessTools } from './tools.js';
import { createHeadlessSessionCapabilityBridge } from './session-capabilities.js';
import { resolveHeadlessSystemPrompt } from './system-prompts.js';
import {
  createInMemoryTaskLedgerExperimentStore,
  renderTaskLedgerExperimentReplay,
} from './task-ledger-experiment.js';
import {
  booleanEnv,
  numericEnv,
  positiveIntEnv,
  type RunHarborCellEnv,
} from './headless-run-env.js';
import {
  buildHarborCellContextBudgetBackendOptions,
  buildHarborCellContextBudgetPolicySnapshot,
  buildHarborCellTaskLedgerExperimentPolicy,
} from './harbor-cell-context-budget-env.js';
import {
  buildHarborCellAiSdkTools,
  createHarborCellLocalToolExecutor,
} from './harbor-cell-tool-executor.js';

// The Harbor cell orchestration module keeps `#harbor-cell` (and './harbor-cell.js')
// as the stable public surface. After the sink-file split the moved symbols live in
// dedicated leaves; re-export them here so existing importers keep resolving them
// from the orchestration module.
export {
  HARBOR_CELL_CONTEXT_ENV_KEYS,
  normalizeHarborCellContextEnv,
  buildHarborCellContextBudgetBackendOptions,
  buildHarborCellContextBudgetPolicySnapshot,
  buildHarborCellTaskLedgerExperimentPolicy,
  type HarborCellContextEnvKey,
  type HarborCellContextBudgetBackendOptions,
  type HarborCellTaskLedgerExperimentPolicy,
} from './harbor-cell-context-budget-env.js';
export {
  HARBOR_CELL_DEFAULT_COMMAND_TIMEOUT_MS,
  buildHarborCellAiSdkTools,
  createHarborCellLocalToolExecutor,
  createHarborHttpToolExecutor,
} from './harbor-cell-tool-executor.js';
export {
  providerApiKeyEnvName,
  resolveHarborCellAiSdkEnv,
  type ResolvedHarborCellAiSdkEnv,
} from './provider-env.js';
export type { RunHarborCellEnv } from './headless-run-env.js';

export const HARBOR_CELL_OUTPUT_FILENAME = 'maka-cell-output.json';
export const HARBOR_CELL_RUNTIME_EVENTS_FILENAME = 'runtime-events.jsonl';
export const HARBOR_CELL_EXECUTION_IDENTITY_FILENAME = 'maka-cell-execution-identity.json';
export const HARBOR_CELL_USAGE_CHECKPOINT_FILENAME = 'maka-cell-usage-checkpoint.json';

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
  settleAfterMs?: number;
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
  settledByDeadline: boolean;
}

export const HARBOR_CELL_DEFAULT_CONTINUATION_PROMPT =
  'Continue the same benchmark task from the current workspace state. Do not restart. If the task is complete, provide the final response.';
const HARBOR_CELL_DEFAULT_MAX_STEPS_PER_TURN = 50;

export interface RunHarborCellFromEnvOptions {
  registerBackends?: RunHarborCellInput['registerBackends'];
  now?: () => number;
  newId?: () => string;
}

export interface HarborCellUsageCheckpoint {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  cacheMissInputSource: 'explicit' | 'derived';
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd?: number;
}

const PI_BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'SystemRoot',
  'COMSPEC',
];
const PI_PROVIDER_ENV_RULES = [
  { includes: ['volcengine'], prefixes: ['XIAOMI_', 'VOLCENGINE_'] },
  {
    includes: ['deepseek'],
    keys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_FILE', 'DEEPSEEK_BASE_URL'],
  },
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
  {
    includes: ['moonshot', 'kimi'],
    keys: ['MOONSHOT_API_KEY', 'MOONSHOT_API_KEY_FILE', 'MOONSHOT_BASE_URL'],
  },
  {
    includes: ['zai'],
    keys: [
      'ZAI_API_KEY',
      'ZAI_API_KEY_FILE',
      'ZAI_CODING_CN_API_KEY',
      'ZAI_CODING_CN_API_KEY_FILE',
      'ZAI_BASE_URL',
    ],
  },
  { includes: ['minimax'], keys: ['MINIMAX_API_KEY', 'MINIMAX_API_KEY_FILE', 'MINIMAX_BASE_URL'] },
] satisfies Array<{ includes: string[]; keys?: string[]; prefixes?: string[] }>;

export async function runHarborCell(input: RunHarborCellInput): Promise<RunHarborCellResult> {
  if (
    input.settleAfterMs !== undefined &&
    (!Number.isFinite(input.settleAfterMs) || input.settleAfterMs <= 0)
  ) {
    throw new Error('settleAfterMs must be a finite positive number');
  }
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
  const sessionCapabilities = createHeadlessSessionCapabilityBridge();
  const task: Task = {
    id: 'harbor-cell',
    instruction: input.instruction,
    workspaceDir: input.cwd,
  };
  const heavyTaskMode = resolveHeavyTaskMode(input.config, task);
  const economyTaskMode = resolveEconomyTaskMode(input.config, task);
  const prompt = resolveHeadlessSystemPrompt(input.config, { heavyTaskMode, economyTaskMode });
  const config = { ...input.config, systemPrompt: prompt.systemPrompt };
  const registerBackends =
    input.registerBackends ?? ((registry: BackendRegistry) => registerFakeBackend(registry));
  await registerBackends(backends, {
    config,
    task,
    storageRoot: input.storageRoot,
    workspaceDir: input.cwd,
    ...sessionCapabilities.capabilities,
    ...(backendNeedsIsolation(input.config.backend)
      ? {
          realBackendIsolation: input.realBackendIsolation,
          toolExecutor: input.realBackendIsolation?.toolExecutor,
        }
      : {}),
  });
  if (!config.model)
    throw new Error('Harbor cell config must include a model for execution identity');
  const executionIdentity = {
    llmConnectionSlug: config.llmConnectionSlug,
    model: config.model,
    ...(config.thinkingLevel ? { reasoningEffort: config.thinkingLevel } : {}),
    systemPromptMode: prompt.mode,
    systemPromptHash: prompt.systemPromptHash,
    pricingProfile: input.pricingProfile ?? 'unconfigured',
  };
  await mkdir(input.outputDir, { recursive: true });
  await writeFile(
    join(input.outputDir, HARBOR_CELL_EXECUTION_IDENTITY_FILENAME),
    `${JSON.stringify(executionIdentity, null, 2)}\n`,
    { encoding: 'utf8', flush: true },
  );

  let invocation: InvocationResult | undefined;
  const manager = new SessionManager({
    store: sessionStore,
    runStore: agentRunStore,
    runtimeEventStore,
    backends,
    ...(input.realBackendIsolation?.toolExecutor
      ? {
          childTools: buildChildAgentTools(
            buildIsolatedHeadlessTools(input.realBackendIsolation.toolExecutor),
          ),
        }
      : {}),
    newId,
    now,
    runtimeSource: 'test',
    runtimeInvocationObserver: (result) => {
      invocation = result;
    },
  });
  sessionCapabilities.bind(manager);

  const session = await manager.createSession({
    cwd: input.cwd,
    backend: input.config.backend,
    llmConnectionSlug: config.llmConnectionSlug,
    model: config.model,
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    permissionMode: 'execute',
    name: `harbor-cell:${input.config.id}`,
  });

  let deadlineReached = false;
  let settlementError: unknown;
  let settlementAttempt: Promise<void> | undefined;
  const settlementTimer =
    input.settleAfterMs === undefined
      ? undefined
      : setTimeout(() => {
          deadlineReached = true;
          settlementAttempt = manager
            .stopSession(session.id, {
              source: 'benchmark_deadline',
              mode: 'immediate',
            })
            .catch((error) => {
              settlementError = error;
            });
        }, input.settleAfterMs);

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
      if (deadlineReached) break;
      const turnId = newId();
      attemptedTurnId = turnId;
      invocation = undefined;
      for await (const event of manager.sendMessage(session.id, { turnId, text: nextText })) {
        if ((event as { type?: string }).type === 'permission_request') {
          const { requestId } = event as { requestId: string };
          await manager.respondToPermission(session.id, {
            requestId,
            decision: 'deny',
            rememberForTurn: true,
          });
        }
      }
      if (!invocation)
        throw new Error('Harbor cell turn finished without a runtime invocation result');
      invocations.push(invocation);
      if (deadlineReached) break;
      if (!isToolCallStepCap(invocation)) break;
      stepCapHits += 1;
      if (totalRuntimeSteps(invocations) >= continuationPolicy.maxTotalRuntimeSteps) break;
      if (!continuationPolicy.enabled || turnIndex + 1 >= continuationPolicy.maxTurns) break;
      nextText = continuationPolicy.prompt;
    }
  } catch (error) {
    sendMessageError = error;
  } finally {
    if (settlementTimer) clearTimeout(settlementTimer);
  }
  await settlementAttempt;
  if (settlementError) throw settlementError;
  if (sendMessageError) {
    invocations.push(
      failedInvocationFromError(sendMessageError, {
        newId,
        now,
        sessionId: session.id,
        turnId: attemptedTurnId ?? newId(),
      }),
    );
  } else if (invocations.length === 0) {
    throw new Error('Harbor cell finished without a runtime invocation result');
  }
  const combinedInvocation = combineInvocations(invocations);
  const terminalRun = deadlineReached
    ? await agentRunStore.readRun(session.id, combinedInvocation.runId).catch(() => undefined)
    : undefined;
  const settledByDeadline =
    terminalRun?.status === 'cancelled' && terminalRun.abortSource === 'benchmark.deadline';
  const continuationSummary = continuationPolicy.enabled
    ? buildContinuationSummary(continuationPolicy, invocations, stepCapHits)
    : undefined;

  await mkdir(input.outputDir, { recursive: true });
  const runtimeEventsPath = join(input.outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME);
  const outputPath = join(input.outputDir, HARBOR_CELL_OUTPUT_FILENAME);
  await writeHarborCellArtifact(runtimeEventsPath, runtimeEventsJsonl(combinedInvocation));
  const output = validateHarborCellOutput(
    buildHarborCellOutput({
      invocation: combinedInvocation,
      runtimeEventsPath,
      executionIdentity,
      ...(settledByDeadline
        ? {
            deadlineSettlement: {
              source: 'benchmark.deadline' as const,
              mode: 'immediate' as const,
            },
          }
        : {}),
      ...(input.contextBudgetPolicy ? { contextBudgetPolicy: input.contextBudgetPolicy } : {}),
      ...(continuationSummary ? { continuationSummary } : {}),
      ...(input.taskToolSummaryEnabled !== undefined
        ? { taskToolSummaryEnabled: input.taskToolSummaryEnabled }
        : {}),
    }),
  );
  await writeHarborCellArtifact(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  return {
    invocation: combinedInvocation,
    output,
    outputPath,
    runtimeEventsPath,
    settledByDeadline,
  };
}

export async function runHarborCellFromEnv(
  env: RunHarborCellEnv = process.env,
  options: RunHarborCellFromEnvOptions = {},
): Promise<RunHarborCellResult> {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomId;
  const outputDir = env.MAKA_OUTPUT_DIR ?? '/logs/agent';
  const storageRoot = env.MAKA_STORAGE_ROOT ?? join(outputDir, 'maka-storage');
  const resolvedEnv: RunHarborCellEnv = {
    ...env,
    MAKA_OUTPUT_DIR: outputDir,
    MAKA_STORAGE_ROOT: storageRoot,
  };
  const backend = backendFromEnv(resolvedEnv.MAKA_BACKEND);
  const contextBudgetPolicy = buildHarborCellContextBudgetPolicySnapshot(resolvedEnv);
  const continuationPolicy = buildHarborCellContinuationPolicy(resolvedEnv);
  const economyTaskMode = economyTaskModeFromEnv(resolvedEnv.MAKA_ECONOMY_TASK_MODE);
  const taskLedgerExperimentPolicy = buildHarborCellTaskLedgerExperimentPolicy(resolvedEnv);
  const maxSteps = harborCellMaxStepsFromEnv(resolvedEnv);
  const settleAfterMs = harborCellSoftTimeoutMsFromEnv(resolvedEnv);
  const reasoningEffort = reasoningEffortFromEnv(resolvedEnv.MAKA_REASONING_EFFORT);
  const baseConfig = {
    id: resolvedEnv.MAKA_CONFIG_ID ?? 'harbor-cell',
    backend,
    ...(reasoningEffort ? { thinkingLevel: reasoningEffort } : {}),
    ...(resolvedEnv.MAKA_SYSTEM_PROMPT !== undefined
      ? { systemPrompt: resolvedEnv.MAKA_SYSTEM_PROMPT }
      : {}),
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
        recordUsageCheckpoint: (usage) => writeHarborCellUsageCheckpoint(outputDir, usage),
      });
      break;
    }
    case 'pi-agent': {
      const model = resolvedEnv.MAKA_PI_MODEL ?? resolvedEnv.MAKA_MODEL ?? resolvedEnv.HARBOR_MODEL;
      if (!model)
        throw new Error('MAKA_PI_MODEL, MAKA_MODEL, or HARBOR_MODEL must include a model id');
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
        registry.register(
          'pi-agent',
          (ctx) =>
            new PiAgentBackend({
              sessionId: ctx.sessionId,
              header: ctx.header,
              appendMessage:
                ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
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
    ...(settleAfterMs !== undefined ? { settleAfterMs } : {}),
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

export function reasoningEffortFromEnv(
  value: string | undefined,
): import('@maka/core').ThinkingLevel | undefined {
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
  const maxTurns =
    positiveIntEnv(env.MAKA_HARBOR_CONTINUATION_MAX_TURNS, 'MAKA_HARBOR_CONTINUATION_MAX_TURNS') ??
    3;
  return {
    enabled: true,
    maxTurns,
    maxTotalRuntimeSteps:
      positiveIntEnv(
        env.MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS,
        'MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS',
      ) ?? maxTurns * HARBOR_CELL_DEFAULT_MAX_STEPS_PER_TURN,
    prompt: env.MAKA_HARBOR_CONTINUATION_PROMPT ?? HARBOR_CELL_DEFAULT_CONTINUATION_PROMPT,
  };
}

export function harborCellMaxStepsFromEnv(env: RunHarborCellEnv = process.env): number | undefined {
  return positiveIntEnv(env.MAKA_MAX_STEPS, 'MAKA_MAX_STEPS');
}

export function harborCellSoftTimeoutMsFromEnv(
  env: RunHarborCellEnv = process.env,
): number | undefined {
  return positiveIntEnv(env.MAKA_CELL_SOFT_TIMEOUT_MS, 'MAKA_CELL_SOFT_TIMEOUT_MS');
}

function isToolCallStepCap(invocation: InvocationResult): boolean {
  return (
    invocation.failure?.class === 'tool_step_cap_reached' ||
    invocation.failure?.class === 'incomplete_tool_calls'
  );
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
    capExhausted:
      stepCapHits > 0 &&
      isToolCallStepCap(invocations[invocations.length - 1]!) &&
      (invocations.length >= policy.maxTurns || runtimeSteps >= policy.maxTotalRuntimeSteps),
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
  return countRuntimeSteps(invocation.events);
}

function failedInvocationFromError(
  error: unknown,
  input: {
    newId: () => string;
    now: () => number;
    sessionId: string;
    turnId: string;
  },
): InvocationResult {
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
  recordUsageCheckpoint?: (usage: HarborCellUsageCheckpoint) => void | Promise<void>;
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
    ? (key: string): PricingConfig | null =>
        key === modelKey ? pricingOverride : getBuiltinPricing(key)
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
    // FileArtifactStore owns an in-memory metadata index, so every artifact
    // consumer under the run's authoritative storage root shares this instance.
    const artifactStore = createArtifactStore(context.storageRoot);
    const synthesisCacheCallbacks = buildHarborCellSynthesisCacheCallbacks(
      artifactStore,
      contextBudgetBackendOptions.contextBudget?.synthesisCache?.enabled === true,
    );
    registry.register('ai-sdk', (ctx) => {
      const subscriptionFetch = buildSubscriptionModelFetch({
        connection,
        sessionId: ctx.sessionId,
        modelId: input.model,
      });
      const tools = buildHarborCellAiSdkTools(context.toolExecutor!, {
        ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
        ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
        ...(context.heavyTaskSelfCheck ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck } : {}),
        ...(taskLedgerExperimentStore && taskLedgerExperimentPolicy
          ? { taskLedgerExperiment: { store: taskLedgerExperimentStore } }
          : {}),
      });
      return new AiSdkBackend({
        sessionId: ctx.sessionId,
        header: { ...ctx.header, model: input.model },
        appendMessage:
          ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
        connection,
        apiKey,
        modelId: input.model,
        permissionEngine,
        modelFactory: (modelInput) =>
          getAIModel({
            ...modelInput,
            ...(subscriptionFetch ? { fetch: subscriptionFetch } : {}),
          }),
        tools,
        toolAvailability: buildIsolatedHeadlessToolAvailability(tools.map((tool) => tool.name)),
        spawnChildAgent: context.spawnChildAgent
          ? (childInput) => context.spawnChildAgent!(ctx.sessionId, childInput)
          : undefined,
        listChildAgents: context.listChildAgents
          ? () => context.listChildAgents!(ctx.sessionId)
          : undefined,
        readChildAgentOutput: context.readChildAgentOutput
          ? (childInput) => context.readChildAgentOutput!(ctx.sessionId, childInput)
          : undefined,
        providerOptions: buildProviderOptions(connection, input.model, ctx.header.thinkingLevel),
        systemPrompt: context.config.systemPrompt,
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
        ...synthesisCacheCallbacks,
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        newId: input.newId,
        now: input.now,
        recordRunTrace: ctx.recordRunTrace,
        ...(ctx.recordProviderRequestCapture
          ? {
              recordProviderRequestCapture: createProviderRequestCaptureRecorder({
                persistArtifact: async (capture) => {
                  const artifact = await persistProviderRequestCaptureArtifact(artifactStore, {
                    sessionId: ctx.sessionId,
                    turnId: capture.turnId,
                    captureId: capture.captureId,
                    step: capture.step,
                    serializedRequest: capture.serializedRequest,
                    now: input.now(),
                  });
                  return { artifactId: artifact.id };
                },
                recordLedger: ctx.recordProviderRequestCapture,
              }),
              recordProviderRequestAttempt: ctx.recordProviderRequestAttempt,
            }
          : {}),
        recordActiveFullCompactBlock: ctx.recordActiveFullCompactBlock,
        recordSemanticCompactBlock: ctx.recordSemanticCompactBlock,
        ...(input.recordUsageCheckpoint
          ? { recordUsageCheckpoint: input.recordUsageCheckpoint }
          : {}),
      });
    });
  };
}

export const buildHarborAiSdkBackendRegistration = buildAiSdkCellBackendRegistration;

export async function writeHarborCellUsageCheckpoint(
  outputDir: string,
  usage: HarborCellUsageCheckpoint,
): Promise<void> {
  if (usage.costUsd === undefined) return;
  const tokenSummary: HarborCellOutput['tokenSummary'] = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cachedInput: usage.cacheHitInputTokens,
    cacheHitInput: usage.cacheHitInputTokens,
    cacheMissInput: usage.cacheMissInputTokens,
    cacheWriteInput: usage.cacheWriteInputTokens,
    cacheMissInputSource: usage.cacheMissInputSource,
    reasoning: usage.reasoningTokens,
    total: usage.totalTokens,
    costUsd: usage.costUsd,
    pricingSource: 'runtime',
  };
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, HARBOR_CELL_USAGE_CHECKPOINT_FILENAME);
  await writeHarborCellArtifact(path, `${JSON.stringify(tokenSummary, null, 2)}\n`);
}

async function writeHarborCellArtifact(path: string, contents: string): Promise<void> {
  const pendingPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(pendingPath, contents, { encoding: 'utf8', flush: true });
    await rename(pendingPath, path);
  } finally {
    await rm(pendingPath, { force: true });
  }
}

function buildHarborCellSynthesisCacheCallbacks(
  artifactStore: ReturnType<typeof createArtifactStore>,
  enabled: boolean,
): { loadSynthesisCache?: SynthesisCacheLoader; writeSynthesisCache?: SynthesisCacheWriter } {
  if (!enabled) return {};
  return {
    loadSynthesisCache: (event) => loadSynthesisCacheBlocksFromArtifacts(artifactStore, event),
    writeSynthesisCache: (event) => persistSynthesisCacheBlocksToArtifacts(artifactStore, event),
  };
}

// Builtin pricing has no entry for newer DeepSeek models (e.g. deepseek-v4-flash),
// so without an override the cell would emit costUsd=0 and the controller would
// flag every task as a zero_cost_with_tokens plumbing failure. Honor the same
// MAKA_TRIAL_*_USD_PER_1M env the Python adapter (trial_pricing.py) already reads,
// so one pricing source feeds both the runtime cell cost and the Harbor trial cost.
function resolveHarborCellPricingOverride(
  env: RunHarborCellEnv,
  modelKey: string,
): PricingConfig | null {
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

function copyPrefixedEnv(
  target: NodeJS.ProcessEnv,
  source: RunHarborCellEnv,
  prefix: string,
): void {
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

function parseModelSpec(
  rawModel: string,
  rawProvider: string | undefined,
): { provider: ProviderType; model: string } {
  if (rawProvider !== undefined) {
    if (!rawModel) throw new Error('MAKA_MODEL must include a model id');
    return { provider: providerFromEnv(rawProvider), model: rawModel };
  }
  const separator = rawModel.indexOf('/');
  const [providerPart, modelPart] =
    separator >= 0
      ? [rawModel.slice(0, separator), rawModel.slice(separator + 1)]
      : ['deepseek', rawModel];
  const provider = providerFromEnv(providerPart);
  if (!modelPart) throw new Error('MAKA_MODEL must include a model id');
  return { provider, model: modelPart };
}

function runtimeEventsJsonl(invocation: InvocationResult): string {
  if (invocation.events.length === 0) return '';
  return `${invocation.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `cell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  );
}
