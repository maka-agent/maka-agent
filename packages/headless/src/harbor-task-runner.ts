import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { validateHarborCellOutput, type HarborCellOutput } from './cell-output.js';
import {
  FixedPromptBudgetExhaustedError,
  type FixedPromptBudgetExhaustedError as FixedPromptBudgetExhaustedErrorType,
  HarborTaskRunInput,
  HarborTaskRunOutput,
  HarborTaskRunner,
} from './fixed-prompt-controller.js';

const execFileAsync = promisify(execFile);

const CONTAINER_MAKA_REPO = '/opt/maka-agent';
const TRIAL_CELL_OUTPUT = 'agent/maka-cell-output.json';
const TRIAL_RUNTIME_EVENTS = 'agent/runtime-events.jsonl';
const TRIAL_REWARD = 'verifier/reward.txt';
const TRIAL_VERIFIER_STDOUT = 'verifier/test-stdout.txt';
const TRIAL_RESULT = 'result.json';
const TRIAL_TRACE_EVENTS_ROOT = 'agent/maka-storage/sessions';

/** A Harbor-side failure (build/docker/timeout/missing artifact) — NOT a benchmark
 * result. The controller turns a thrown error into an infra_failed event so it is
 * excluded from scoring instead of polluting the KEEP/DISCARD decision as reward 0. */
export class HarborInfraError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'HarborInfraError';
  }
}

export interface HarborTaskPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
  source?: string;
}

export interface HarborTaskRunnerOptions {
  /** Host path to the maka repo, mounted read-only at /opt/maka-agent. */
  makaRepoPath: string;
  /** Base directory under which each task gets an isolated per-task job dir. */
  jobsDir: string;
  /** MAKA_MODEL, e.g. "deepseek/deepseek-v4-flash". */
  model: string;
  /** MAKA_PROVIDER, e.g. "deepseek". */
  provider?: string;
  /** Host path to an API key file. The key stays in the Harbor control process;
   * the task container receives no provider key env, key-file path, or secret mount. */
  apiKeyFile?: string;
  /** Raw API-key env var the host-side cell uses (default derived from provider).
   * A legacy *_API_KEY_FILE name is normalized to its raw *_API_KEY companion. */
  apiKeyEnvName?: string;
  /** Per-1M USD pricing forwarded as MAKA_TRIAL_* so the cell emits real costUsd. */
  pricing?: HarborTaskPricing;
  /** Extra agent env merged last (e.g. DEEPSEEK_BASE_URL). */
  agentEnv?: Record<string, string>;
  harborBin?: string;
  /** Harbor environment type (default "docker"). */
  environment?: string;
  timeoutMultiplier?: number;
  /** Wall-clock ceiling for a single `harbor run`; a hung Docker/Harbor would
   * otherwise stall the unattended loop forever. Defaults to 45 minutes. */
  harborTimeoutMs?: number;
  /** Injectable Harbor process runner (default: execFile the harbor binary). */
  runHarbor?: HarborProcessRunner;
  now?: () => number;
}

export interface HarborRunRequest {
  harborBin: string;
  configPath: string;
  jobName: string;
  jobsDir: string;
  args: readonly string[];
  cwd: string;
  /** Wall-clock ceiling in ms; the default runner kills harbor past this. */
  timeoutMs?: number;
  /** Env overlaid onto the harbor process (e.g. PYTHONPATH for the adapter). */
  env?: Record<string, string>;
}

const DEFAULT_HARBOR_TIMEOUT_MS = 45 * 60_000;

export interface HarborRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string;
}

export type HarborProcessRunner = (request: HarborRunRequest) => Promise<HarborRunResult>;

const PROVIDER_SECRET_ENV: Record<string, { key: string; file: string; baseUrl: string }> = {
  deepseek: { key: 'DEEPSEEK_API_KEY', file: 'DEEPSEEK_API_KEY_FILE', baseUrl: 'DEEPSEEK_BASE_URL' },
  openai: { key: 'OPENAI_API_KEY', file: 'OPENAI_API_KEY_FILE', baseUrl: 'OPENAI_BASE_URL' },
  'openai-compatible': { key: 'OPENAI_API_KEY', file: 'OPENAI_API_KEY_FILE', baseUrl: 'OPENAI_BASE_URL' },
  moonshot: { key: 'MOONSHOT_API_KEY', file: 'MOONSHOT_API_KEY_FILE', baseUrl: 'MOONSHOT_BASE_URL' },
  google: { key: 'GOOGLE_API_KEY', file: 'GOOGLE_API_KEY_FILE', baseUrl: 'GOOGLE_BASE_URL' },
  anthropic: { key: 'ANTHROPIC_API_KEY', file: 'ANTHROPIC_API_KEY_FILE', baseUrl: 'ANTHROPIC_BASE_URL' },
};

export function createHarborTaskRunner(options: HarborTaskRunnerOptions): HarborTaskRunner {
  const runHarbor = options.runHarbor ?? defaultHarborProcessRunner;
  const harborBin = options.harborBin ?? 'harbor';
  // The bare `maka_agent:MakaAgent` import path resolves only when the adapter
  // directory is on harbor's PYTHONPATH; harbor is a uv-installed tool, so its cwd
  // is not enough. Prepend it (keeping any inherited PYTHONPATH).
  const harborAdapterDir = join(options.makaRepoPath, 'packages', 'headless', 'harbor');
  const pythonPath = [harborAdapterDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter);

  return async (input: HarborTaskRunInput): Promise<HarborTaskRunOutput> => {
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

    const runnerOptions = {
      ...options,
      agentEnv: mergeAgentEnv(options.agentEnv, input.agentEnv),
    };
    assertNoProviderSecretsInAgentEnv(runnerOptions.agentEnv);
    const hostProviderEnv = hostSideProviderEnv(runnerOptions);
    const configPath = join(jobsDir, 'job-config.json');
    const { agentEnv: _attemptAgentEnv, ...inputWithoutAttemptEnv } = input;
    const config = buildHarborJobConfig(inputWithoutAttemptEnv, {
      ...runnerOptions,
      jobsDir,
      jobName,
      ...(hostProviderEnv ? { agentEnv: taskAgentEnvWithoutProviderSecrets(runnerOptions) } : {}),
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const args = ['run', '--config', configPath, '--yes'];
    let result: HarborRunResult;
    try {
      result = await runHarbor({
        harborBin,
        configPath,
        jobName,
        jobsDir,
        args,
        cwd: options.makaRepoPath,
        timeoutMs: options.harborTimeoutMs ?? DEFAULT_HARBOR_TIMEOUT_MS,
        env: { PYTHONPATH: pythonPath, ...(hostProviderEnv ?? {}) },
      });
    } catch (error) {
      if (isBudgetExhaustedError(error)) throw error;
      throw new HarborInfraError(`harbor run failed to launch for task ${input.task.id}`, errorText(error));
    }
    if (result.timedOut) {
      throw new FixedPromptBudgetExhaustedError(
        `harbor run timed out for task ${input.task.id}`,
        tail(result.stderr || result.stdout),
      );
    }
    if (result.exitCode !== 0) {
      throw new HarborInfraError(
        `harbor run exited ${result.exitCode} for task ${input.task.id}`,
        tail(result.stderr || result.stdout),
      );
    }

    const trialDir = await findTrialDir(jobDir, basename(input.task.path));
    const cellOutputPath = join(trialDir, TRIAL_CELL_OUTPUT);
    const rewardPath = join(trialDir, TRIAL_REWARD);
    const resultPath = join(trialDir, TRIAL_RESULT);
    const hostEventsPath = join(trialDir, TRIAL_RUNTIME_EVENTS);

    const trialException = await readTrialException(resultPath);
    if (trialException && isBudgetExhaustedTrialException(trialException)) {
      throw new FixedPromptBudgetExhaustedError(
        `agent budget exhausted for task ${input.task.id}`,
        trialException,
      );
    }
    const reward = await readReward(rewardPath, resultPath, input.task.id);
    const cell = await readCellOutput(cellOutputPath, input.task.id);
    const verifierStdout = await readOptionalText(join(trialDir, TRIAL_VERIFIER_STDOUT));
    const verifierSetupErrorClass = reward <= 0 && isVerifierDependencySetupFailure(verifierStdout)
      ? 'infra_failed'
      : undefined;
    const verifierFailureSummary = reward <= 0 ? summarizeVerifierFailure(verifierStdout) : undefined;

    return {
      harbor: {
        reward,
        ...(verifierFailureSummary ? { verifierFailureSummary } : {}),
      },
      // Override the container-local runtimeEventsPath with the host path so the
      // controller's reward-hack scan and structural smoke can read raw events.
      cell: {
        ...cell,
        ...(verifierSetupErrorClass && !cell.errorClass ? { errorClass: verifierSetupErrorClass } : {}),
        runtimeEventsPath: hostEventsPath,
        traceEventsPath: join(
          trialDir,
          TRIAL_TRACE_EVENTS_ROOT,
          cell.runtimeRefs.sessionId,
          'runs',
          cell.runtimeRefs.runId,
          'events.jsonl',
        ),
      },
    };
  };
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function isVerifierDependencySetupFailure(text: string | null): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return normalized.includes('unable to fetch some archives')
    || normalized.includes('failed to fetch')
    || normalized.includes('bad gateway')
    || normalized.includes('curl: command not found')
    || normalized.includes('uvx: command not found')
    || normalized.includes('/root/.local/bin/env: no such file or directory');
}

function summarizeVerifierFailure(text: string | null): string | undefined {
  if (!text) return undefined;
  if (isVerifierDependencySetupFailure(text)) return 'verifier_dependency_setup_failed';
  const normalized = text.toLowerCase();
  const parts: string[] = [];
  if (normalized.includes('assertionerror') || normalized.includes('assert ')) {
    parts.push('output_assertion_failed');
  }
  if (integerAssertionOffByOne(text)) {
    parts.push('integer_output_off_by_one');
  }
  if (finalStateTextMismatch(text)) {
    parts.push('final_state_expected_text_mismatch');
  }
  if (structuredOutputValuesMismatch(normalized)) {
    parts.push('structured_output_values_mismatch');
  }
  if (normalized.includes("module 'numpy' has no attribute 'int'") || normalized.includes('module "numpy" has no attribute "int"')) {
    parts.push('python_numpy_removed_alias_np.int');
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function integerAssertionOffByOne(text: string): boolean {
  const match = text.match(/assert\s+['"](\d+)['"]\s+in\s+['"](\d+)['"]/);
  if (!match) return false;
  const expected = Number(match[1]);
  const actual = Number(match[2]);
  return Number.isSafeInteger(expected) && Number.isSafeInteger(actual) && Math.abs(expected - actual) === 1;
}

function finalStateTextMismatch(text: string): boolean {
  return /\bExpected\s+['"][^'"\n]{1,200}['"]/i.test(text)
    && /\bGot:\s+['"]/i.test(text);
}

function structuredOutputValuesMismatch(normalizedText: string): boolean {
  return normalizedText.includes('only found')
    && normalizedText.includes('expected values');
}

function mergeAgentEnv(
  base: Record<string, string> | undefined,
  attempt: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !attempt) return undefined;
  return { ...(base ?? {}), ...(attempt ?? {}) };
}

export function buildHarborJobConfig(
  input: HarborTaskRunInput,
  options: HarborTaskRunnerOptions & { jobsDir: string; jobName: string },
): Record<string, unknown> {
  const attemptAgentEnv = mergeAgentEnv(options.agentEnv, input.agentEnv);
  assertNoProviderSecretsInAgentEnv(attemptAgentEnv);
  const provider = options.provider ?? 'deepseek';
  const model = modelIdForProvider(options.model, provider);
  const mounts: Array<Record<string, unknown>> = [
    { type: 'bind', source: options.makaRepoPath, target: CONTAINER_MAKA_REPO, read_only: true },
  ];

  const agentEnv: Record<string, string> = {
    MAKA_BACKEND: 'ai-sdk',
    MAKA_MODEL: model,
    MAKA_PROVIDER: provider,
    // Verbatim — the controller hashes exactly these bytes and verifies the round-trip.
    MAKA_SYSTEM_PROMPT: input.systemPrompt,
  };

  if (options.pricing) {
    agentEnv.MAKA_TRIAL_INPUT_USD_PER_1M = String(options.pricing.inputUsdPer1M);
    agentEnv.MAKA_TRIAL_OUTPUT_USD_PER_1M = String(options.pricing.outputUsdPer1M);
    if (options.pricing.cacheReadUsdPer1M !== undefined) {
      agentEnv.MAKA_TRIAL_CACHE_READ_USD_PER_1M = String(options.pricing.cacheReadUsdPer1M);
    }
    if (options.pricing.cacheWriteUsdPer1M !== undefined) {
      agentEnv.MAKA_TRIAL_CACHE_WRITE_USD_PER_1M = String(options.pricing.cacheWriteUsdPer1M);
    }
    if (options.pricing.source) {
      agentEnv.MAKA_TRIAL_PRICING_SOURCE = options.pricing.source;
    }
  }

  Object.assign(agentEnv, attemptAgentEnv ?? {});
  const cellTimeoutSec = positiveIntEnv(agentEnv.MAKA_CELL_TIMEOUT_SEC);

  return {
    job_name: options.jobName,
    jobs_dir: options.jobsDir,
    n_attempts: 1,
    n_concurrent_trials: 1,
    timeout_multiplier: options.timeoutMultiplier ?? 1.0,
    quiet: true,
    environment: {
      type: options.environment ?? 'docker',
      force_build: false,
      delete: true,
      mounts,
    },
    verifier: { env: {}, disable: false },
    metrics: [{ type: 'mean', kwargs: {} }],
    agents: [
      {
        name: 'maka',
        import_path: 'maka_agent:MakaAgent',
        model_name: model,
        kwargs: { backend: 'ai-sdk' },
        env: agentEnv,
        ...(cellTimeoutSec !== undefined ? { max_timeout_sec: cellTimeoutSec } : {}),
      },
    ],
    datasets: [],
    tasks: [{ path: input.task.path, overwrite: false }],
    artifacts: [],
    extra_instruction_paths: [],
    plugins: [],
  };
}

function positiveIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function providerSecretEnv(provider: string): { key: string; file: string; baseUrl: string } {
  return PROVIDER_SECRET_ENV[provider] ?? PROVIDER_SECRET_ENV.openai!;
}

function hostSideProviderEnv(options: HarborTaskRunnerOptions): Record<string, string> | null {
  if (!options.apiKeyFile) return null;
  const provider = options.provider ?? 'deepseek';
  const providerEnv = providerSecretEnv(provider);
  const baseUrl = options.agentEnv?.[providerEnv.baseUrl] ?? options.agentEnv?.MAKA_BASE_URL ?? options.agentEnv?.OPENAI_BASE_URL;
  return {
    MAKA_HOST_REPO_ROOT: options.makaRepoPath,
    MAKA_HOST_API_KEY_FILE: options.apiKeyFile,
    MAKA_HOST_API_KEY_ENV_NAME: normalizeRawKeyEnvName(options.apiKeyEnvName ?? providerEnv.key),
    ...(baseUrl ? { MAKA_HOST_BASE_URL: baseUrl } : {}),
  };
}

function taskAgentEnvWithoutProviderSecrets(options: HarborTaskRunnerOptions): Record<string, string> {
  const providerEnv = providerSecretEnv(options.provider ?? 'deepseek');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.agentEnv ?? {})) {
    if (key === providerEnv.key || key === providerEnv.file || key === providerEnv.baseUrl) continue;
    if (/_API_KEY(_FILE)?$/.test(key)) continue;
    result[key] = value;
  }
  return result;
}

function assertNoProviderSecretsInAgentEnv(agentEnv: Record<string, string> | undefined): void {
  const forbidden = Object.keys(agentEnv ?? {}).filter((key) => /_API_KEY(_FILE)?$/.test(key));
  if (forbidden.length > 0) {
    throw new Error(`agentEnv must not contain provider secrets: ${forbidden.sort().join(', ')}`);
  }
}

function normalizeRawKeyEnvName(name: string): string {
  return name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
}

async function findTrialDir(jobDir: string, taskName: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(jobDir, { withFileTypes: true });
  } catch (error) {
    throw new HarborInfraError(`harbor produced no job output at ${jobDir}`, errorText(error));
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const resultTrialName = await readResultTrialName(join(jobDir, 'result.json'));
  if (resultTrialName && dirs.includes(resultTrialName)) {
    return join(jobDir, resultTrialName);
  }
  const match = dirs.find((name) => name === taskName || name.startsWith(`${taskName}__`)) ?? dirs[0];
  if (!match) {
    throw new HarborInfraError(`harbor produced no trial directory under ${jobDir} for task ${taskName}`);
  }
  return join(jobDir, match);
}

async function readResultTrialName(resultPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.stats) || !isRecord(parsed.stats.evals)) return null;
  for (const evalResult of Object.values(parsed.stats.evals)) {
    if (!isRecord(evalResult)) continue;
    const rewardStats = isRecord(evalResult.reward_stats) ? evalResult.reward_stats : null;
    const rewards = rewardStats && isRecord(rewardStats.reward) ? Object.values(rewardStats.reward) : [];
    for (const trialNames of rewards) {
      const trialName = firstString(trialNames);
      if (trialName) return trialName;
    }
    const exceptionStats = isRecord(evalResult.exception_stats) ? Object.values(evalResult.exception_stats) : [];
    for (const trialNames of exceptionStats) {
      const trialName = firstString(trialNames);
      if (trialName) return trialName;
    }
  }
  return null;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === 'string');
    return first ?? null;
  }
  return null;
}

async function readReward(rewardPath: string, resultPath: string, taskId: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(rewardPath, 'utf8');
  } catch (error) {
    const trialException = await readTrialException(resultPath);
    if (trialException) {
      if (isBudgetExhaustedTrialException(trialException)) {
        throw new FixedPromptBudgetExhaustedError(
          `host cell budget exhausted for task ${taskId}`,
          trialException,
        );
      }
      throw new HarborInfraError(`Harbor trial failed before verifier reward for task ${taskId}: ${trialException}`, errorText(error));
    }
    throw new HarborInfraError(`missing verifier reward for task ${taskId}`, errorText(error));
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new HarborInfraError(`empty verifier reward for task ${taskId}`);
  }
  const reward = Number(trimmed);
  if (!Number.isFinite(reward)) {
    throw new HarborInfraError(`non-numeric verifier reward for task ${taskId}: ${trimmed}`);
  }
  return reward;
}

async function readTrialException(resultPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const exceptionInfo = isRecord(parsed.exception_info) ? parsed.exception_info : null;
  if (!exceptionInfo) return null;
  const type = typeof exceptionInfo.exception_type === 'string' ? exceptionInfo.exception_type : 'HarborTrialError';
  const message = typeof exceptionInfo.exception_message === 'string' ? exceptionInfo.exception_message : '';
  return message ? `${type}: ${message}` : type;
}

function isBudgetExhaustedTrialException(message: string): boolean {
  return /^RuntimeError: Maka host cell exceeded \d+(?:\.\d+)?s$/.test(message)
    || /^AgentTimeoutError: Agent execution timed out after \d+(?:\.\d+)? seconds$/.test(message);
}

async function readCellOutput(cellOutputPath: string, taskId: string): Promise<HarborCellOutput> {
  let raw: string;
  try {
    raw = await readFile(cellOutputPath, 'utf8');
  } catch (error) {
    throw new HarborInfraError(`maka cell did not write output for task ${taskId}`, errorText(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HarborInfraError(`maka cell output is not valid JSON for task ${taskId}`, errorText(error));
  }
  try {
    return validateHarborCellOutput(parsed);
  } catch (error) {
    throw new HarborInfraError(`maka cell output is malformed for task ${taskId}`, errorText(error));
  }
}

const defaultHarborProcessRunner: HarborProcessRunner = async (request) => {
  try {
    const { stdout, stderr } = await execFileAsync(request.harborBin, [...request.args], {
      cwd: request.cwd,
      maxBuffer: 64 * 1024 * 1024,
      ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
      ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const exitCode = typeof (error as { code?: unknown }).code === 'number'
      ? (error as { code: number }).code
      : 1;
    return {
      exitCode,
      stdout: String((error as { stdout?: unknown }).stdout ?? ''),
      stderr: String((error as { stderr?: unknown }).stderr ?? '') || errorText(error),
      timedOut: isExecFileTimeout(error),
      ...(typeof (error as { signal?: unknown }).signal === 'string' ? { signal: (error as { signal: string }).signal } : {}),
    };
  }
};

function isExecFileTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { killed?: unknown; signal?: unknown };
  return record.killed === true && record.signal === 'SIGKILL';
}

function isBudgetExhaustedError(error: unknown): error is FixedPromptBudgetExhaustedErrorType {
  return error instanceof FixedPromptBudgetExhaustedError
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'FixedPromptBudgetExhaustedError');
}

/** Strip a model's own provider prefix so the native provider receives a bare id
 * ("deepseek/deepseek-v4-flash" + provider "deepseek" -> "deepseek-v4-flash"). A
 * gateway provider keeps the slash because the prefix does not match the provider
 * ("openai-compatible" routing "anthropic/claude-sonnet-4-5"). The cell's
 * parseModelSpec preserves whatever it receives when a provider is set, so the
 * stripping must happen here. */
export function modelIdForProvider(model: string, provider: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
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
