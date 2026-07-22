import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { PROVIDER_DEFAULTS, type ProviderType } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { validateHarborCellOutput, type HarborCellOutput } from './cell-output.js';
import {
  FixedPromptBudgetExhaustedError,
  type FixedPromptBudgetExhaustedError as FixedPromptBudgetExhaustedErrorType,
  type TaskRunInput,
  type TaskRunOutput,
  type TaskRunner,
} from './fixed-prompt-controller.js';
import { lenientPositiveIntEnv } from './headless-run-env.js';
import { modelIdForProvider } from './harbor-task-runner.js';
import {
  KIMI_CODE_TOOLCHAIN_CONTAINER_PATH,
  KIMI_CODE_TOOLCHAIN_FINGERPRINT,
} from './kimi-code-toolchain.js';
import {
  summarizeProviderTelemetry,
  startProviderAuthProxy,
  type ProviderRequestTelemetry,
  type ProviderTokenUsage,
  type ProviderUpstreamCredentialResolver,
  type ProviderUsageProtocol,
} from './provider-auth-proxy.js';
import { isSensitiveEnvName } from './provider-env.js';

const execFileAsync = promisify(execFile);

const CONTAINER_MAKA_REPO = '/opt/maka-agent';
const TRIAL_CELL_OUTPUT = 'agent/maka-cell-output.json';
const TRIAL_RUNTIME_EVENTS = 'agent/runtime-events.jsonl';
const TRIAL_COMBINED_TRACE_EVENTS = 'agent/trace-events.jsonl';
const TRIAL_REWARD_JSON = 'verifier/reward.json';
const TRIAL_RESULT = 'result.json';
const PROVIDER_REQUEST_TELEMETRY = 'provider-request-telemetry.json';

/** The default port the Kimi arm binds the host provider proxy to. Pier's Squid
 * egress for offline (`allow_internet=false`) tasks only permits destination
 * ports 80/443 (`acl Safe_ports port 80 443`), so a container reaching the host
 * proxy through Squid must present one of those. 443 keeps the model endpoint on
 * the conventional TLS port. */
export const PIER_PROVIDER_PROXY_DEFAULT_PORT = 443;

/** A Pier-side failure (build/docker/timeout/missing artifact) — NOT a benchmark
 * result. The fixed-prompt controller turns a thrown error into an infra_failed
 * event, excluding it from scoring instead of recording reward 0. Mirrors
 * `HarborInfraError`; kept Pier-local so this runner does not depend on the
 * Harbor runner's error identity. */
export class PierInfraError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly kind: 'infra_failed' | 'timed_out' = 'infra_failed',
    readonly artifactRefs?: { providerTelemetryPath?: string },
  ) {
    super(message);
    this.name = 'PierInfraError';
  }
}

export interface PierTaskPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
  source?: string;
}

export interface PierTaskRunnerOptions {
  /** Host path to the maka repo, bind-mounted read-only at /opt/maka-agent. */
  makaRepoPath: string;
  /** Pier adapter under test (default: Maka, host-side LLM + offline container). */
  agent?: 'maka' | 'kimi-code';
  /** In-container/host cell backend. Only the Maka arm reads it. `fake` runs the
   * inert cell for zero-cost structural checks; `ai-sdk` is the real run. */
  backend?: 'ai-sdk' | 'fake';
  /** Prepared Kimi Code toolchain bind-mounted read-only into task containers. */
  kimiCodeToolchainPath?: string;
  /** Base directory under which each task gets an isolated per-task job dir. */
  jobsDir: string;
  /** MAKA_MODEL / pier `-m`, e.g. "k3" or "deepseek/deepseek-v4-flash". */
  model: string;
  /** MAKA_PROVIDER, e.g. "kimi-coding-plan". */
  provider?: string;
  reasoningEffort?: ThinkingLevel;
  /** Upstream model base URL. Falls back to the provider's registry default. */
  baseUrl?: string;
  /** Host path to an API key file. The key stays in the host control process
   * (read by the host cell, or minted into a scoped token by the proxy); the task
   * container never receives a provider key env, key-file path, or secret mount. */
  apiKeyFile?: string;
  /** Resolves the upstream authority inside the host proxy for every request. */
  resolveProviderCredential?: ProviderUpstreamCredentialResolver;
  /** Route the Maka arm's host cell through the auth proxy instead of reading the
   * key file directly. The Kimi arm always uses the proxy. */
  useProviderProxy?: boolean;
  /** Explicit host proxy listen port for the Kimi arm (default 443). */
  providerProxyPort?: number;
  /** Per-1M USD pricing forwarded as MAKA_TRIAL_* so the cell emits real costUsd. */
  pricing?: PierTaskPricing;
  /** Extra agent env merged last (e.g. MAKA_HARBOR_MODE). Never provider secrets. */
  agentEnv?: Record<string, string>;
  /** Pier launcher (default "pier"). */
  pierBin?: string;
  /** Pier environment type (default "docker"). */
  environment?: string;
  /** Explicit Docker target platform shared by comparison arms. */
  dockerPlatform?: 'linux/amd64';
  timeoutMultiplier?: number;
  /** Wall-clock ceiling for a single `pier run`; a hung Docker/Pier would
   * otherwise stall the unattended loop forever. Defaults to 45 minutes. */
  pierTimeoutMs?: number;
  /** Injectable Pier process runner (default: execFile the pier binary). */
  runPier?: PierProcessRunner;
  now?: () => number;
}

export interface PierRunRequest {
  pierBin: string;
  jobName: string;
  jobsDir: string;
  args: readonly string[];
  cwd: string;
  /** Wall-clock ceiling in ms; the default runner kills pier past this. */
  timeoutMs?: number;
  /** Env overlaid onto the pier process: PYTHONPATH, MAKA_BACKEND (the adapter's
   * CliFlag env_fallback reads only os.environ), and MAKA_SYSTEM_PROMPT (byte-
   * exact; pier's --ae parser would strip its whitespace). */
  env?: Record<string, string>;
}

export interface PierRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string;
}

export type PierProcessRunner = (request: PierRunRequest) => Promise<PierRunResult>;

const DEFAULT_PIER_TIMEOUT_MS = 45 * 60_000;

interface PierProviderRuntime {
  /** Proxy-minted secret env delivered via `--env-file` (kept off argv). */
  envFile: Record<string, string>;
  /** Non-secret host env delivered via `--ae` (paths, base URLs). */
  agentEnv: Record<string, string>;
  usage?: () => ProviderTokenUsage | null;
  telemetry?: () => ProviderRequestTelemetry[];
  close?: () => Promise<void>;
}

export function createPierTaskRunner(options: PierTaskRunnerOptions): TaskRunner {
  const runPier = options.runPier ?? defaultPierProcessRunner;
  const pierBin = options.pierBin ?? 'pier';
  // The bare adapter import path (`maka_agent:MakaAgent`) resolves only when the
  // adapter directory is on pier's PYTHONPATH; pier is a uv-installed tool, so its
  // cwd is not enough. Prepend it, keeping any inherited PYTHONPATH.
  const harborAdapterDir = join(options.makaRepoPath, 'packages', 'headless', 'harbor');
  const pythonPath = [harborAdapterDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter);

  const runner: TaskRunner = async (input: TaskRunInput): Promise<TaskRunOutput> => {
    const agent = options.agent ?? 'maka';
    const jobsDir = join(
      options.jobsDir,
      sanitize(input.runId),
      sanitize(input.roundId),
      sanitize(input.task.id),
    );
    const jobName = 'trial';
    const jobDir = join(jobsDir, jobName);
    // Start each attempt from a clean dir so a crashed prior attempt cannot be
    // mistaken for this attempt's trial output.
    await rm(jobsDir, { recursive: true, force: true });
    await mkdir(jobsDir, { recursive: true });

    const attemptAgentEnv = mergeAgentEnv(options.agentEnv, input.agentEnv);
    assertNoProviderSecretsInAgentEnv(attemptAgentEnv);

    const providerTelemetryPath = join(jobsDir, PROVIDER_REQUEST_TELEMETRY);
    let providerUsage: ProviderTokenUsage | null = null;
    let providerTelemetry: ProviderRequestTelemetry[] = [];
    let result: PierRunResult;
    const envFilePath = join(jobsDir, 'pier-agent.env');
    // Setup errors here are configuration faults, not infra flakes: validate the
    // mount set and start the proxy BEFORE the launch try so they surface with
    // their own message (and never leak a listening socket behind a wrapped error).
    const mounts = buildPierMounts(options, agent);
    const providerRuntime = await pierProviderRuntime(options, agent);
    const envFileEntries = providerRuntime?.envFile ?? {};
    const usesEnvFile = Object.keys(envFileEntries).length > 0;
    try {
      const aeEnv = buildPierAgentEnv(input, options, agent, providerRuntime?.agentEnv ?? {});
      const processEnv: Record<string, string> = {
        PYTHONPATH: pythonPath,
        // MAKA_BACKEND is a CliFlag whose env_fallback reads os.environ only, so
        // `--ae MAKA_BACKEND=` is silently ignored — it must ride the pier process
        // env. The Kimi adapter ignores it.
        MAKA_BACKEND: options.backend ?? 'ai-sdk',
        // Byte-safe channel for the prompt: pier's --ae parser strips leading and
        // trailing whitespace from values (pier/cli/utils.py key.strip() /
        // value.strip()), which would drop the prompt's trailing newline and break
        // the execution-identity hash round-trip on every task. Both adapters fall
        // back to os.environ (CliFlag env_fallback for Maka, _get_env for Kimi) and
        // forward the exact bytes into the cell, so the value rides the pier
        // process env verbatim — and must never also appear in --ae, where the
        // stripped extra_env copy would take precedence in _get_env.
        MAKA_SYSTEM_PROMPT: input.systemPrompt,
      };
      if (usesEnvFile) await writeEnvFile(envFilePath, envFileEntries);
      const args = buildPierRunArgs({
        agent,
        // Provider-local bare id (same normalization contract as the Harbor
        // runner): the adapter's model_name takes precedence over MAKA_MODEL, so
        // a provider-prefixed `-m` would leak the prefixed id into the cell.
        model: modelIdForProvider(options.model, options.provider ?? 'deepseek'),
        taskPath: input.task.path,
        jobsDir,
        jobName,
        environment: options.environment ?? 'docker',
        timeoutMultiplier: options.timeoutMultiplier ?? 1,
        mounts,
        agentEnv: aeEnv,
        ...(usesEnvFile ? { envFile: envFilePath } : {}),
      });
      try {
        result = await runPier({
          pierBin,
          jobName,
          jobsDir,
          args,
          cwd: harborAdapterDir,
          timeoutMs: options.pierTimeoutMs ?? DEFAULT_PIER_TIMEOUT_MS,
          env: processEnv,
        });
      } finally {
        await providerRuntime?.close?.();
        if (usesEnvFile) await rm(envFilePath, { force: true });
        providerUsage = providerRuntime?.usage?.() ?? null;
        providerTelemetry = providerRuntime?.telemetry?.() ?? [];
        if (providerTelemetry.length > 0) {
          await writeFile(
            providerTelemetryPath,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                summary: summarizeProviderTelemetry(providerTelemetry),
                requests: providerTelemetry,
              },
              null,
              2,
            )}\n`,
            'utf8',
          );
        }
      }
    } catch (error) {
      if (isBudgetExhaustedError(error)) throw error;
      throw new PierInfraError(
        `pier run failed to launch for task ${input.task.id}`,
        errorText(error),
        'infra_failed',
        providerTelemetryArtifactRefs(providerTelemetry, providerTelemetryPath),
      );
    }

    try {
      if (result.timedOut) {
        throw new PierInfraError(
          `pier run timed out for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
          'timed_out',
        );
      }
      let trialDir: string;
      try {
        trialDir = await findTrialDir(jobDir, basename(input.task.path));
      } catch (error) {
        if (result.exitCode === 0) throw error;
        throw new PierInfraError(
          `pier run exited ${result.exitCode} for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }

      // A populated `exception_info` means the trial errored before/while the
      // verifier graded it. A model budget exhaustion is a benchmark outcome the
      // controller records separately; anything else is infra.
      const trialException = await readTrialException(join(trialDir, TRIAL_RESULT));
      if (trialException) {
        if (isBudgetExhaustedTrialException(trialException)) {
          throw new FixedPromptBudgetExhaustedError(
            `agent budget exhausted for task ${input.task.id}`,
            trialException,
            providerTelemetry.length > 0 ? { providerTelemetryPath } : undefined,
          );
        }
        throw new PierInfraError(
          `pier trial errored for task ${input.task.id}: ${trialException}`,
          tail(result.stderr || result.stdout),
        );
      }
      if (result.exitCode !== 0) {
        throw new PierInfraError(
          `pier run exited ${result.exitCode} for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }

      const reward = await readPierReward(trialDir, input.task.id);
      const rawCell = await readCellOutput(join(trialDir, TRIAL_CELL_OUTPUT), input.task.id);
      const cell =
        rawCell.tokenSummary || !providerUsage || !options.pricing
          ? rawCell
          : { ...rawCell, tokenSummary: providerTokenSummary(providerUsage, options.pricing) };
      const hostEventsPath = join(trialDir, TRIAL_RUNTIME_EVENTS);
      const combinedTracePath = join(trialDir, TRIAL_COMBINED_TRACE_EVENTS);
      return {
        harbor: { reward },
        cell: {
          ...cell,
          ...(providerTelemetry.length > 0 ? { providerTelemetryPath } : {}),
          runtimeEventsPath: hostEventsPath,
          ...(existsSync(combinedTracePath) ? { traceEventsPath: combinedTracePath } : {}),
        },
      };
    } catch (error) {
      throw withProviderTelemetryArtifact(error, providerTelemetry, providerTelemetryPath);
    }
  };
  return runner;
}

export interface BuildPierRunArgsInput {
  agent: 'maka' | 'kimi-code';
  model: string;
  taskPath: string;
  jobsDir: string;
  jobName: string;
  environment: string;
  timeoutMultiplier: number;
  mounts: ReadonlyArray<Record<string, unknown>>;
  agentEnv: Record<string, string>;
  envFile?: string;
}

/** Assemble the `pier run` argv. Exported for deterministic unit tests. */
export function buildPierRunArgs(input: BuildPierRunArgsInput): string[] {
  const importPath =
    input.agent === 'kimi-code' ? 'kimi_code_agent:MakaKimiCodeAgent' : 'maka_agent:MakaAgent';
  const args = [
    'run',
    '--agent-import-path',
    importPath,
    '-m',
    input.model,
    '-p',
    input.taskPath,
    '-o',
    input.jobsDir,
    '--job-name',
    input.jobName,
    // -k attempts / -n concurrent: one attempt, one trial — Pass@1 semantics.
    '-k',
    '1',
    '-n',
    '1',
    '--timeout-multiplier',
    String(input.timeoutMultiplier),
    '-e',
    input.environment,
    '--mounts-json',
    JSON.stringify(input.mounts),
    '--yes',
    '--quiet',
  ];
  if (input.envFile) args.push('--env-file', input.envFile);
  for (const [key, value] of Object.entries(input.agentEnv)) {
    args.push('--ae', `${key}=${value}`);
  }
  return args;
}

function buildPierMounts(
  options: PierTaskRunnerOptions,
  agent: 'maka' | 'kimi-code',
): Array<Record<string, unknown>> {
  const mounts: Array<Record<string, unknown>> = [
    { type: 'bind', source: options.makaRepoPath, target: CONTAINER_MAKA_REPO, read_only: true },
  ];
  if (agent === 'kimi-code') {
    if (!options.kimiCodeToolchainPath) {
      throw new Error('kimiCodeToolchainPath is required for the Kimi Code adapter');
    }
    mounts.push({
      type: 'bind',
      source: options.kimiCodeToolchainPath,
      target: KIMI_CODE_TOOLCHAIN_CONTAINER_PATH,
      read_only: true,
    });
  }
  return mounts;
}

function buildPierAgentEnv(
  input: TaskRunInput,
  options: PierTaskRunnerOptions,
  agent: 'maka' | 'kimi-code',
  providerAgentEnv: Record<string, string>,
): Record<string, string> {
  const provider = options.provider ?? 'deepseek';
  const makaModel = modelIdForProvider(options.model, provider);
  const env: Record<string, string> = {
    MAKA_MODEL: makaModel,
    MAKA_PROVIDER: provider,
    MAKA_LLM_CONNECTION_SLUG: provider,
    MAKA_REPO_ROOT: CONTAINER_MAKA_REPO,
    // MAKA_SYSTEM_PROMPT deliberately does NOT ride --ae: pier's CLI strips
    // whitespace from --ae values, and a stripped copy in the adapter's
    // extra_env would shadow the byte-exact os.environ value. See processEnv.
  };
  if (options.reasoningEffort) env.MAKA_REASONING_EFFORT = options.reasoningEffort;
  if (agent === 'kimi-code') {
    env.MAKA_KIMI_CODE_TOOLCHAIN_FINGERPRINT = KIMI_CODE_TOOLCHAIN_FINGERPRINT;
  }
  if (options.pricing) {
    env.MAKA_TRIAL_INPUT_USD_PER_1M = String(options.pricing.inputUsdPer1M);
    env.MAKA_TRIAL_OUTPUT_USD_PER_1M = String(options.pricing.outputUsdPer1M);
    if (options.pricing.cacheReadUsdPer1M !== undefined) {
      env.MAKA_TRIAL_CACHE_READ_USD_PER_1M = String(options.pricing.cacheReadUsdPer1M);
    }
    if (options.pricing.cacheWriteUsdPer1M !== undefined) {
      env.MAKA_TRIAL_CACHE_WRITE_USD_PER_1M = String(options.pricing.cacheWriteUsdPer1M);
    }
    if (options.pricing.source) env.MAKA_TRIAL_PRICING_SOURCE = options.pricing.source;
  }
  Object.assign(env, providerAgentEnv);
  Object.assign(env, mergeAgentEnv(options.agentEnv, input.agentEnv) ?? {});
  // Lenient by shared contract with the Python adapter: a malformed value must
  // fall back to the task metadata rather than fail the run.
  const cellTimeoutSec =
    lenientPositiveIntEnv(env.MAKA_CELL_TIMEOUT_SEC) ?? input.task.metadata?.agentTimeoutSec;
  if (cellTimeoutSec !== undefined) {
    env.MAKA_CELL_TIMEOUT_SEC = String(cellTimeoutSec);
    const streamTimeoutMs = cellTimeoutSec * 1_000;
    if (agent === 'maka' && Number.isSafeInteger(streamTimeoutMs)) {
      // Pier already owns the task-native hard deadline. Keep the runtime's
      // first-event and between-event watchdogs from imposing a shorter cutoff.
      env.MAKA_STREAM_CONNECT_TIMEOUT_MS = String(streamTimeoutMs);
      env.MAKA_STREAM_IDLE_TIMEOUT_MS = String(streamTimeoutMs);
    }
  }
  return env;
}

async function pierProviderRuntime(
  options: PierTaskRunnerOptions,
  agent: 'maka' | 'kimi-code',
): Promise<PierProviderRuntime | null> {
  const provider = options.provider ?? 'deepseek';
  const baseUrl = options.baseUrl ?? providerDefaultBaseUrl(provider);
  const usesProxy = agent === 'kimi-code' || options.useProviderProxy === true;

  if (!usesProxy) {
    // Maka arm, direct host-side key file: the host cell reads the real key from
    // the file path. The path (not the key) rides `--ae`; the container stays
    // offline and never sees a key. No proxy, so no token metering.
    if (agent !== 'maka') return null;
    if (!options.apiKeyFile) return null;
    return {
      envFile: {},
      agentEnv: {
        MAKA_HOST_REPO_ROOT: options.makaRepoPath,
        MAKA_HOST_API_KEY_FILE: options.apiKeyFile,
        ...(baseUrl ? { MAKA_HOST_BASE_URL: baseUrl } : {}),
      },
    };
  }

  if (!options.apiKeyFile && !options.resolveProviderCredential) {
    throw new Error(
      `${agent} Pier runs require apiKeyFile or resolveProviderCredential to mint the proxy credential`,
    );
  }
  if (!baseUrl) throw new Error(`Pier ${agent} provider ${provider} requires a base URL`);

  const proxyPort =
    agent === 'kimi-code'
      ? (options.providerProxyPort ?? PIER_PROVIDER_PROXY_DEFAULT_PORT)
      : undefined;
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: baseUrl,
    // The Maka host cell runs on the host and reaches the proxy on loopback; the
    // Kimi container reaches it through Docker's host gateway on a Squid-legal port.
    ...(agent === 'maka' ? { advertisedHost: '127.0.0.1' } : {}),
    ...(proxyPort !== undefined ? { port: proxyPort } : {}),
    ...(options.resolveProviderCredential
      ? { resolveUpstreamCredential: options.resolveProviderCredential }
      : { apiKeyFile: options.apiKeyFile! }),
    authMode: agent === 'kimi-code' ? 'bearer' : providerProxyAuthMode(provider),
    usageProtocol: providerProxyUsageProtocol(agent, provider),
  });

  return {
    // Proxy-minted, scoped, ephemeral token — never the real provider key. Routed
    // through `--env-file` (0600, removed after the run) so it stays off argv.
    envFile:
      agent === 'maka'
        ? {
            MAKA_HOST_REPO_ROOT: options.makaRepoPath,
            MAKA_HOST_BASE_URL: proxy.baseUrl,
            MAKA_HOST_API_KEY: proxy.token,
          }
        : { MAKA_PROVIDER_PROXY_URL: proxy.baseUrl, MAKA_PROVIDER_PROXY_TOKEN: proxy.token },
    agentEnv: {},
    usage: proxy.usage,
    telemetry: proxy.telemetry,
    close: proxy.close,
  };
}

function providerDefaultBaseUrl(provider: string): string | undefined {
  const definition = (
    PROVIDER_DEFAULTS as Partial<Record<string, (typeof PROVIDER_DEFAULTS)[ProviderType]>>
  )[provider];
  return definition?.baseUrl;
}

function providerProxyAuthMode(provider: string): 'bearer' | 'x-api-key' {
  const definition = (
    PROVIDER_DEFAULTS as Partial<Record<string, (typeof PROVIDER_DEFAULTS)[ProviderType]>>
  )[provider];
  return definition?.runtimeAdapter.kind === 'anthropic' &&
    definition.runtimeAdapter.auth === 'api-key'
    ? 'x-api-key'
    : 'bearer';
}

function providerProxyUsageProtocol(
  agent: 'maka' | 'kimi-code',
  provider: string,
): ProviderUsageProtocol | undefined {
  if (agent === 'kimi-code') return 'openai-chat-sse';
  const definition = (
    PROVIDER_DEFAULTS as Partial<Record<string, (typeof PROVIDER_DEFAULTS)[ProviderType]>>
  )[provider];
  if (definition?.runtimeAdapter.kind === 'anthropic') return 'anthropic-sse';
  if (definition?.runtimeAdapter.kind === 'openai-compatible') return 'openai-chat-sse';
  return undefined;
}

function providerTokenSummary(
  usage: ProviderTokenUsage,
  pricing: PierTaskPricing,
): NonNullable<HarborCellOutput['tokenSummary']> {
  const cacheMissInput = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
  const costUsd =
    (cacheMissInput * pricing.inputUsdPer1M +
      usage.cacheRead * (pricing.cacheReadUsdPer1M ?? pricing.inputUsdPer1M) +
      usage.cacheWrite * (pricing.cacheWriteUsdPer1M ?? pricing.inputUsdPer1M) +
      usage.output * pricing.outputUsdPer1M) /
    1_000_000;
  return {
    input: usage.input,
    output: usage.output,
    cachedInput: usage.cacheRead,
    cacheHitInput: usage.cacheRead,
    cacheMissInput,
    cacheWriteInput: usage.cacheWrite,
    cacheMissInputSource: 'explicit',
    reasoning: usage.reasoning ?? 0,
    total: usage.input + usage.output,
    costUsd,
    pricingSource: 'runtime',
  };
}

async function writeEnvFile(path: string, env: Record<string, string>): Promise<void> {
  // dotenv KEY=VALUE lines. Values here are minted/scoped proxy tokens and URLs,
  // never the real provider key; the file is created 0600 and removed after run.
  const body = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await writeFile(path, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

async function readPierReward(trialDir: string, taskId: string): Promise<number> {
  // Prefer the DeepSWE task verifier's reward.json; fall back to the trial
  // result's verifier_result.rewards.reward (same value, always present on a
  // completed trial). Unlike the Maka oracle verifier, Pier tasks write no
  // reward.txt and no structured maka-verifier-outcome.json.
  const rewardJson = await readOptionalText(join(trialDir, TRIAL_REWARD_JSON));
  if (rewardJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rewardJson);
    } catch (error) {
      throw new PierInfraError(
        `verifier reward.json is not valid JSON for task ${taskId}`,
        errorText(error),
      );
    }
    if (isRecord(parsed) && typeof parsed.reward === 'number' && Number.isFinite(parsed.reward)) {
      return parsed.reward;
    }
  }
  const result = await readOptionalJson(join(trialDir, TRIAL_RESULT));
  const verifierResult = isRecord(result?.verifier_result) ? result.verifier_result : undefined;
  const rewards =
    verifierResult && isRecord(verifierResult.rewards) ? verifierResult.rewards : undefined;
  if (rewards && typeof rewards.reward === 'number' && Number.isFinite(rewards.reward)) {
    return rewards.reward;
  }
  throw new PierInfraError(`missing verifier reward for task ${taskId}`);
}

async function readCellOutput(cellOutputPath: string, taskId: string): Promise<HarborCellOutput> {
  let raw: string;
  try {
    raw = await readFile(cellOutputPath, 'utf8');
  } catch (error) {
    throw new PierInfraError(`maka cell did not write output for task ${taskId}`, errorText(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PierInfraError(
      `maka cell output is not valid JSON for task ${taskId}`,
      errorText(error),
    );
  }
  try {
    return validateHarborCellOutput(parsed);
  } catch (error) {
    throw new PierInfraError(`maka cell output is malformed for task ${taskId}`, errorText(error));
  }
}

async function findTrialDir(jobDir: string, taskName: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(jobDir, { withFileTypes: true });
  } catch (error) {
    throw new PierInfraError(`pier produced no job output at ${jobDir}`, errorText(error));
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const resultTrialName = await readResultTrialName(join(jobDir, TRIAL_RESULT));
  if (resultTrialName && dirs.includes(resultTrialName)) return join(jobDir, resultTrialName);
  const match =
    dirs.find((name) => name === taskName || name.startsWith(`${taskName}__`)) ?? dirs[0];
  if (!match) {
    throw new PierInfraError(
      `pier produced no trial directory under ${jobDir} for task ${taskName}`,
    );
  }
  return join(jobDir, match);
}

async function readResultTrialName(resultPath: string): Promise<string | null> {
  const parsed = await readOptionalJson(resultPath);
  if (!parsed || !isRecord(parsed.stats) || !isRecord(parsed.stats.evals)) return null;
  for (const evalResult of Object.values(parsed.stats.evals)) {
    if (!isRecord(evalResult)) continue;
    const rewardStats = isRecord(evalResult.reward_stats) ? evalResult.reward_stats : null;
    const rewards =
      rewardStats && isRecord(rewardStats.reward) ? Object.values(rewardStats.reward) : [];
    for (const trialNames of rewards) {
      const trialName = firstString(trialNames);
      if (trialName) return trialName;
    }
  }
  return null;
}

async function readTrialException(resultPath: string): Promise<string | null> {
  const parsed = await readOptionalJson(resultPath);
  if (!parsed) return null;
  const exceptionInfo = isRecord(parsed.exception_info) ? parsed.exception_info : null;
  if (!exceptionInfo) return null;
  const type =
    typeof exceptionInfo.exception_type === 'string'
      ? exceptionInfo.exception_type
      : 'PierTrialError';
  const message =
    typeof exceptionInfo.exception_message === 'string' ? exceptionInfo.exception_message : '';
  return message ? `${type}: ${message}` : type;
}

function isBudgetExhaustedTrialException(message: string): boolean {
  return (
    /^RuntimeError: Maka host cell exceeded \d+(?:\.\d+)?s$/.test(message) ||
    /^AgentTimeoutError: Agent execution timed out after \d+(?:\.\d+)? seconds$/.test(message)
  );
}

function providerTelemetryArtifactRefs(
  telemetry: readonly ProviderRequestTelemetry[],
  providerTelemetryPath: string,
): { providerTelemetryPath: string } | undefined {
  return telemetry.length > 0 ? { providerTelemetryPath } : undefined;
}

function withProviderTelemetryArtifact(
  error: unknown,
  telemetry: readonly ProviderRequestTelemetry[],
  providerTelemetryPath: string,
): unknown {
  const artifactRefs = providerTelemetryArtifactRefs(telemetry, providerTelemetryPath);
  if (
    !(error instanceof PierInfraError) ||
    !artifactRefs ||
    error.artifactRefs?.providerTelemetryPath
  ) {
    return error;
  }
  const enriched = new PierInfraError(error.message, error.detail, error.kind, artifactRefs);
  enriched.stack = error.stack;
  return enriched;
}

function mergeAgentEnv(
  base: Record<string, string> | undefined,
  attempt: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !attempt) return undefined;
  return { ...(base ?? {}), ...(attempt ?? {}) };
}

function assertNoProviderSecretsInAgentEnv(agentEnv: Record<string, string> | undefined): void {
  const forbidden = Object.keys(agentEnv ?? {}).filter((key) => isSensitiveEnvName(key));
  if (forbidden.length > 0) {
    throw new Error(`agentEnv must not contain provider secrets: ${forbidden.sort().join(', ')}`);
  }
}

const defaultPierProcessRunner: PierProcessRunner = async (request) => {
  try {
    const { stdout, stderr } = await execFileAsync(request.pierBin, [...request.args], {
      cwd: request.cwd,
      maxBuffer: 64 * 1024 * 1024,
      ...(request.timeoutMs !== undefined
        ? { timeout: request.timeoutMs, killSignal: 'SIGKILL' as const }
        : {}),
      ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const exitCode =
      typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
    return {
      exitCode,
      stdout: String((error as { stdout?: unknown }).stdout ?? ''),
      stderr: String((error as { stderr?: unknown }).stderr ?? '') || errorText(error),
      timedOut: isExecFileTimeout(error),
      ...(typeof (error as { signal?: unknown }).signal === 'string'
        ? { signal: (error as { signal: string }).signal }
        : {}),
    };
  }
};

function isExecFileTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { killed?: unknown; signal?: unknown };
  return record.killed === true && record.signal === 'SIGKILL';
}

function isBudgetExhaustedError(error: unknown): error is FixedPromptBudgetExhaustedErrorType {
  return (
    error instanceof FixedPromptBudgetExhaustedError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'FixedPromptBudgetExhaustedError')
  );
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readOptionalJson(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readOptionalText(path);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === 'string');
    return first ?? null;
  }
  return null;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function tail(text: string, lines = 20): string {
  return text.split('\n').slice(-lines).join('\n');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
