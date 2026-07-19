import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import {
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
  type ProviderType,
} from '@maka/core/llm-connections';
import { fetchGitHubCopilotModels, isSupportedGitHubCopilotAccountToken } from '@maka/runtime';
import {
  validateHarborCellExecutionIdentity,
  validateHarborCellOutput,
  validateHarborCellTokenSummary,
  type HarborCellExecutionIdentity,
  type HarborCellOutput,
} from './cell-output.js';
import {
  FixedPromptBudgetExhaustedError,
  type FixedPromptBudgetExhaustedError as FixedPromptBudgetExhaustedErrorType,
  HarborTaskRunInput,
  HarborTaskRunOutput,
  HarborTaskRunner,
  type HarborVerifierAttempt,
  type HarborVerifierOutcome,
} from './fixed-prompt-controller.js';
import {
  HARBOR_ORACLE_EXECUTION_POLICY,
  HARBOR_ORACLE_MAX_ATTEMPTS,
  resolveHarnessOracleWatchdogTimeoutMs,
  type HarnessOracleTaskResult,
} from './harness-oracle-policy.js';
import {
  summarizeProviderTelemetry,
  startProviderAuthProxy,
  type ProviderRequestTelemetry,
  type ProviderTokenUsage,
  type ProviderUsageProtocol,
} from './provider-auth-proxy.js';
import {
  providerBaseUrlFromEnv,
  providerCredentialEnv,
  requireProviderCredentialEnv,
} from './provider-env.js';
import { lenientPositiveIntEnv } from './headless-run-env.js';
import {
  OPENCODE_TOOLCHAIN_CONTAINER_PATH,
  OPENCODE_TOOLCHAIN_FINGERPRINT,
  OPENCODE_TOOLCHAIN_SPEC,
} from './opencode-toolchain.js';
import {
  KIMI_CODE_TOOLCHAIN_CONTAINER_PATH,
  KIMI_CODE_TOOLCHAIN_FINGERPRINT,
  KIMI_CODE_TOOLCHAIN_SPEC,
} from './kimi-code-toolchain.js';

const execFileAsync = promisify(execFile);

const CONTAINER_MAKA_REPO = '/opt/maka-agent';
const TRIAL_CELL_OUTPUT = 'agent/maka-cell-output.json';
const TRIAL_EXECUTION_IDENTITY = 'agent/maka-cell-execution-identity.json';
const TRIAL_USAGE_CHECKPOINT = 'agent/maka-cell-usage-checkpoint.json';
const TRIAL_RUNTIME_EVENTS = 'agent/runtime-events.jsonl';
const TRIAL_REWARD = 'verifier/reward.txt';
const TRIAL_VERIFIER_STDOUT = 'verifier/test-stdout.txt';
const TRIAL_VERIFIER_OUTCOME = 'verifier/maka-verifier-outcome.json';
const TRIAL_RESULT = 'result.json';
const TRIAL_TRACE_EVENTS_ROOT = 'agent/maka-storage/sessions';
const PROVIDER_REQUEST_TELEMETRY = 'provider-request-telemetry.json';

/** A Harbor-side failure (build/docker/timeout/missing artifact) — NOT a benchmark
 * result. The controller turns a thrown error into an infra_failed event so it is
 * excluded from scoring instead of polluting the KEEP/DISCARD decision as reward 0. */
export class HarborInfraError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly kind: 'infra_failed' | 'timed_out' = 'infra_failed',
    readonly artifactRefs?: { providerTelemetryPath?: string },
  ) {
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

export type HarborBillingMode = 'metered' | 'account-plan';

export interface HarborTaskRunnerOptions {
  /** Host path to the maka repo, mounted read-only at /opt/maka-agent. */
  makaRepoPath: string;
  /** Harbor adapter under test (default: Maka). */
  agent?: 'maka' | 'opencode' | 'kimi-code';
  /** Version passed to Harbor's installed-agent adapter. */
  agentVersion?: string;
  /** Prepared OpenCode toolchain mounted read-only into task containers. */
  opencodeToolchainPath?: string;
  /** Prepared Kimi Code toolchain mounted read-only into task containers. */
  kimiCodeToolchainPath?: string;
  /** Explicit Docker target platform shared by comparison arms. */
  dockerPlatform?: 'linux/amd64';
  /** Base directory under which each task gets an isolated per-task job dir. */
  jobsDir: string;
  /** MAKA_MODEL, e.g. "deepseek/deepseek-v4-flash". */
  model: string;
  /** MAKA_PROVIDER, e.g. "deepseek". */
  provider?: string;
  reasoningEffort?: 'high' | 'max';
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
  /** Injectable only for deterministic GitHub Copilot account-discovery tests. */
  copilotFetch?: typeof fetch;
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
const HARBOR_SETUP_TEARDOWN_GRACE_MS = 15 * 60_000;
export interface HarborRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string;
}

export type HarborProcessRunner = (request: HarborRunRequest) => Promise<HarborRunResult>;

export interface HarborOracleQualifierOptions {
  makaRepoPath: string;
  jobsDir: string;
  harborBin?: string;
  runHarbor?: HarborProcessRunner;
}

export type HarborOracleQualifier = (
  task: HarborTaskRunInput['task'],
) => Promise<HarnessOracleTaskResult>;

const EXPERIMENT_IDENTITY_ENV_KEYS = new Set([
  'MAKA_BACKEND',
  'MAKA_MODEL',
  'MAKA_PROVIDER',
  'MAKA_LLM_CONNECTION_SLUG',
  'MAKA_REASONING_EFFORT',
  'MAKA_OPENCODE_VARIANT',
  'MAKA_SYSTEM_PROMPT',
  'MAKA_TRIAL_INPUT_USD_PER_1M',
  'MAKA_TRIAL_OUTPUT_USD_PER_1M',
  'MAKA_TRIAL_CACHE_READ_USD_PER_1M',
  'MAKA_TRIAL_CACHE_WRITE_USD_PER_1M',
  'MAKA_TRIAL_PRICING_SOURCE',
]);

export function createHarborTaskRunner(options: HarborTaskRunnerOptions): HarborTaskRunner {
  const runHarbor = options.runHarbor ?? defaultHarborProcessRunner;
  const harborBin = options.harborBin ?? 'harbor';
  // The bare local adapter import paths resolve only when the adapter
  // directory is on harbor's PYTHONPATH; harbor is a uv-installed tool, so its cwd
  // is not enough. Prepend it (keeping any inherited PYTHONPATH).
  const harborAdapterDir = join(options.makaRepoPath, 'packages', 'headless', 'harbor');
  const pythonPath = [harborAdapterDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter);

  const runner: HarborTaskRunner = async (
    input: HarborTaskRunInput,
  ): Promise<HarborTaskRunOutput> => {
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
    const hasHostProviderRuntime =
      runnerOptions.apiKeyFile !== undefined ||
      githubCopilotAccountTokenFromEnv(runnerOptions.provider, runnerOptions.agentEnv) !==
        undefined ||
      (!usesHostProviderProxy(runnerOptions.agent) &&
        !providerRequiresSecret(runnerOptions.provider));
    const configPath = join(jobsDir, 'job-config.json');
    const { agentEnv: _attemptAgentEnv, ...inputWithoutAttemptEnv } = input;
    const config = buildHarborJobConfig(inputWithoutAttemptEnv, {
      ...runnerOptions,
      jobsDir,
      jobName,
      ...(hasHostProviderRuntime
        ? { agentEnv: taskAgentEnvWithoutProviderSecrets(runnerOptions) }
        : {}),
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const args = ['run', '--config', configPath, '--yes'];
    let result: HarborRunResult;
    let providerUsage: ProviderTokenUsage | null = null;
    let providerTelemetry: ProviderRequestTelemetry[] = [];
    const providerTelemetryPath = join(jobsDir, PROVIDER_REQUEST_TELEMETRY);
    try {
      const providerRuntime = await hostSideProviderRuntime(runnerOptions);
      try {
        result = await runHarbor({
          harborBin,
          configPath,
          jobName,
          jobsDir,
          args,
          cwd: options.makaRepoPath,
          timeoutMs: resolveHarborTimeoutMs(runnerOptions, input),
          env: { PYTHONPATH: pythonPath, ...(providerRuntime?.env ?? {}) },
        });
      } finally {
        await providerRuntime?.close?.();
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
      throw new HarborInfraError(
        `harbor run failed to launch for task ${input.task.id}`,
        errorText(error),
        'infra_failed',
        providerTelemetryArtifactRefs(providerTelemetry, providerTelemetryPath),
      );
    }
    try {
      if (result.timedOut) {
        throw new HarborInfraError(
          `harbor run timed out for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }
      let trialDir: string;
      try {
        trialDir = await findTrialDir(jobDir, basename(input.task.path));
      } catch (error) {
        if (result.exitCode === 0) throw error;
        throw new HarborInfraError(
          `harbor run exited ${result.exitCode} for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }
      const cellOutputPath = join(trialDir, TRIAL_CELL_OUTPUT);
      const rewardPath = join(trialDir, TRIAL_REWARD);
      const resultPath = join(trialDir, TRIAL_RESULT);
      const hostEventsPath = join(trialDir, TRIAL_RUNTIME_EVENTS);

      const trialException = await readTrialException(resultPath);
      let completeTimedOutTrial = false;
      if (trialException && isBudgetExhaustedTrialException(trialException)) {
        const [rewardArtifact, verifierArtifact, cellArtifact] = await Promise.all([
          readOptionalText(rewardPath),
          readOptionalText(join(trialDir, TRIAL_VERIFIER_OUTCOME)),
          readOptionalText(cellOutputPath),
        ]);
        if (rewardArtifact === null || verifierArtifact === null || cellArtifact === null) {
          const artifactRefs = await readTimedOutTrialArtifacts(
            trialDir,
            input.task.id,
            runnerOptions.agent,
          );
          throw new FixedPromptBudgetExhaustedError(
            `agent budget exhausted for task ${input.task.id}`,
            trialException,
            artifactRefs || providerTelemetry.length > 0
              ? {
                  ...(artifactRefs ?? {}),
                  ...(providerTelemetry.length > 0 ? { providerTelemetryPath } : {}),
                }
              : undefined,
          );
        }
        completeTimedOutTrial = true;
      }
      if (result.exitCode !== 0 && !completeTimedOutTrial) {
        throw new HarborInfraError(
          `harbor run exited ${result.exitCode} for task ${input.task.id}`,
          tail(result.stderr || result.stdout),
        );
      }
      const reward = await readReward(rewardPath, resultPath, input.task.id);
      const rawCell = await readCellOutput(cellOutputPath, input.task.id);
      const cell =
        rawCell.tokenSummary || !providerUsage || !runnerOptions.pricing
          ? rawCell
          : {
              ...rawCell,
              tokenSummary: providerTokenSummary(providerUsage, runnerOptions.pricing),
            };
      const verifierStdout = await readOptionalText(join(trialDir, TRIAL_VERIFIER_STDOUT));
      const verifier = await readVerifierOutcome(
        join(trialDir, TRIAL_VERIFIER_OUTCOME),
        input.task.id,
      );
      if (!verifier) {
        throw new HarborInfraError(
          `custom verifier produced no structured verifier outcome for task ${input.task.id}`,
        );
      }
      assertVerifierRewardAgreement(verifier, reward, input.task.id);
      const verifierFailureSummary =
        verifier?.outcome === 'candidate_timeout'
          ? 'candidate_timeout'
          : reward <= 0
            ? summarizeVerifierFailure(verifierStdout)
            : undefined;

      return {
        harbor: {
          reward,
          ...(verifierFailureSummary ? { verifierFailureSummary } : {}),
          ...(verifier ? { verifier } : {}),
        },
        // Override the container-local runtimeEventsPath with the host path so the
        // controller's reward-hack scan and structural smoke can read raw events.
        cell: {
          ...cell,
          ...(providerTelemetry.length > 0 ? { providerTelemetryPath } : {}),
          runtimeEventsPath: hostEventsPath,
          traceEventsPath: hostTraceEventsPath(runnerOptions.agent, trialDir, cell, hostEventsPath),
        },
      };
    } catch (error) {
      throw withProviderTelemetryArtifact(error, providerTelemetry, providerTelemetryPath);
    }
  };
  return runner;
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
    !(error instanceof HarborInfraError) ||
    !artifactRefs ||
    error.artifactRefs?.providerTelemetryPath
  ) {
    return error;
  }
  const enriched = new HarborInfraError(error.message, error.detail, error.kind, artifactRefs);
  enriched.stack = error.stack;
  return enriched;
}

export function createHarborOracleQualifier(
  options: HarborOracleQualifierOptions,
): HarborOracleQualifier {
  const runHarbor = options.runHarbor ?? defaultHarborProcessRunner;
  const harborBin = options.harborBin ?? 'harbor';
  const harborAdapterDir = join(options.makaRepoPath, 'packages', 'headless', 'harbor');
  const pythonPath = [harborAdapterDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter);
  return async (task) => {
    const jobsDir = join(options.jobsDir, sanitize(task.id));
    const jobName = 'qualification';
    const jobDir = join(jobsDir, jobName);
    await rm(jobsDir, { recursive: true, force: true });
    await mkdir(jobsDir, { recursive: true });
    const verifier = verifierPolicy(task);
    const configPath = join(jobsDir, 'job-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          job_name: jobName,
          jobs_dir: jobsDir,
          n_attempts: HARBOR_ORACLE_EXECUTION_POLICY.job.attempts,
          n_concurrent_trials: HARBOR_ORACLE_EXECUTION_POLICY.job.concurrentTrials,
          timeout_multiplier: HARBOR_ORACLE_EXECUTION_POLICY.job.timeoutMultiplier,
          quiet: true,
          environment: {
            type: HARBOR_ORACLE_EXECUTION_POLICY.environment.type,
            force_build: HARBOR_ORACLE_EXECUTION_POLICY.environment.forceBuild,
            delete: HARBOR_ORACLE_EXECUTION_POLICY.environment.delete,
            extra_docker_compose: [
              join(
                options.makaRepoPath,
                'packages/headless/harbor',
                HARBOR_ORACLE_EXECUTION_POLICY.environment.composeFile,
              ),
            ],
          },
          verifier: harborVerifierConfig(verifier),
          metrics: [{ type: 'mean', kwargs: {} }],
          agents: [
            {
              name: HARBOR_ORACLE_EXECUTION_POLICY.job.agent,
              ...(task.metadata?.agentTimeoutSec !== undefined
                ? { max_timeout_sec: task.metadata.agentTimeoutSec }
                : {}),
            },
          ],
          datasets: [],
          tasks: [{ path: task.path, overwrite: false }],
          artifacts: [],
          extra_instruction_paths: [],
          plugins: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const result = await runHarbor({
      harborBin,
      configPath,
      jobName,
      jobsDir,
      args: ['run', '--config', configPath, '--yes'],
      cwd: options.makaRepoPath,
      timeoutMs: resolveHarnessOracleWatchdogTimeoutMs({
        agentTimeoutSec: task.metadata?.agentTimeoutSec ?? 0,
        verifierTimeoutSec: verifier.outerTimeoutSec,
      }),
      env: { PYTHONPATH: pythonPath },
    });
    if (result.timedOut) {
      throw new HarborInfraError(
        `Harbor Oracle qualification timed out for task ${task.id}`,
        tail(result.stderr || result.stdout),
        'timed_out',
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Harbor Oracle qualification exited ${result.exitCode} for task ${task.id}: ${tail(result.stderr || result.stdout)}`,
      );
    }
    const trialDir = await findTrialDir(jobDir, basename(task.path));
    const outcome = await readVerifierOutcome(join(trialDir, TRIAL_VERIFIER_OUTCOME), task.id);
    if (!outcome)
      throw new HarborInfraError(
        `Oracle qualification produced no structured verifier outcome for task ${task.id}`,
      );
    const reward = await readReward(
      join(trialDir, TRIAL_REWARD),
      join(trialDir, TRIAL_RESULT),
      task.id,
    );
    assertVerifierRewardAgreement(outcome, reward, task.id, 'Oracle qualification ');
    return { outcome: outcome.outcome, reward, attempts: outcome.attempts.length };
  };
}

function assertVerifierRewardAgreement(
  outcome: HarborVerifierOutcome,
  reward: number,
  taskId: string,
  prefix = '',
): void {
  if ((outcome.outcome === 'passed') !== reward > 0) {
    throw new HarborInfraError(
      `${prefix}reward disagrees with verifier outcome for task ${taskId}`,
    );
  }
}

function resolveHarborTimeoutMs(
  options: HarborTaskRunnerOptions,
  input: HarborTaskRunInput,
): number {
  if (options.harborTimeoutMs !== undefined) return options.harborTimeoutMs;
  return resolveNativeHarborTimeoutMs(options, input.task);
}

function resolveNativeHarborTimeoutMs(
  options: Pick<HarborTaskRunnerOptions, 'timeoutMultiplier'>,
  task: HarborTaskRunInput['task'],
): number {
  const agentSec = task.metadata?.agentTimeoutSec ?? 0;
  const verifierSec = verifierPolicy(task).outerTimeoutSec;
  const nativePhasesMs = (agentSec + verifierSec) * (options.timeoutMultiplier ?? 1) * 1_000;
  return Math.max(DEFAULT_HARBOR_TIMEOUT_MS, nativePhasesMs + HARBOR_SETUP_TEARDOWN_GRACE_MS);
}

async function readOptionalCellOutput(
  cellOutputPath: string,
  taskId: string,
): Promise<HarborCellOutput | null> {
  try {
    return await readCellOutput(cellOutputPath, taskId);
  } catch {
    return null;
  }
}

function hostTraceEventsPath(
  agent: HarborTaskRunnerOptions['agent'],
  trialDir: string,
  cell: HarborCellOutput,
  hostEventsPath: string,
): string {
  if (agent === 'opencode' || agent === 'kimi-code') return hostEventsPath;
  return join(
    trialDir,
    TRIAL_TRACE_EVENTS_ROOT,
    cell.runtimeRefs.sessionId,
    'runs',
    cell.runtimeRefs.runId,
    'events.jsonl',
  );
}

function cellArtifactRefs(
  cell: HarborCellOutput,
  hostEventsPath: string,
  trialDir: string,
  agent: HarborTaskRunnerOptions['agent'],
) {
  const traceEventsPath = hostTraceEventsPath(agent, trialDir, cell, hostEventsPath);
  return {
    runtimeEventsPath: hostEventsPath,
    traceEventsPath,
    ...(cell.tokenSummary ? { tokenSummary: cell.tokenSummary } : {}),
    cellOutput: { ...cell, runtimeEventsPath: hostEventsPath, traceEventsPath },
  };
}

async function readTimedOutTrialArtifacts(
  trialDir: string,
  taskId: string,
  agent: HarborTaskRunnerOptions['agent'],
) {
  const cell = await readOptionalCellOutput(join(trialDir, TRIAL_CELL_OUTPUT), taskId);
  if (cell) return cellArtifactRefs(cell, join(trialDir, TRIAL_RUNTIME_EVENTS), trialDir, agent);
  const [executionIdentity, tokenSummary] = await Promise.all([
    readOptionalExecutionIdentity(join(trialDir, TRIAL_EXECUTION_IDENTITY)),
    readOptionalTokenSummary(join(trialDir, TRIAL_USAGE_CHECKPOINT)),
  ]);
  return executionIdentity || tokenSummary
    ? {
        ...(executionIdentity ? { executionIdentity } : {}),
        ...(tokenSummary ? { tokenSummary } : {}),
      }
    : null;
}

async function readOptionalExecutionIdentity(
  path: string,
): Promise<HarborCellExecutionIdentity | null> {
  try {
    return validateHarborCellExecutionIdentity(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

async function readOptionalTokenSummary(path: string) {
  try {
    return validateHarborCellTokenSummary(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readVerifierOutcome(
  path: string,
  taskId: string,
): Promise<HarborVerifierOutcome | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw new HarborInfraError(
      `failed to read verifier outcome for task ${taskId}`,
      errorText(error),
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new HarborInfraError(
      `verifier outcome is not valid JSON for task ${taskId}`,
      errorText(error),
    );
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new HarborInfraError(`verifier outcome is malformed for task ${taskId}`);
  }
  const outcome = value.outcome;
  if (outcome === 'infra_failed') {
    throw new HarborInfraError(`verifier infrastructure failed for task ${taskId}`);
  }
  if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'candidate_timeout') {
    throw new HarborInfraError(`verifier outcome is malformed for task ${taskId}`);
  }
  if (!Array.isArray(value.attempts) || value.attempts.length < 1 || value.attempts.length > 2) {
    throw new HarborInfraError(`verifier outcome attempts are malformed for task ${taskId}`);
  }
  const attempts = value.attempts.map((attempt, index) =>
    validateVerifierAttempt(attempt, index + 1, taskId),
  );
  const last = attempts.at(-1)!;
  const priorAttemptsAreRetryable = attempts
    .slice(0, -1)
    .every(
      (attempt) =>
        attempt.classification === 'infra_setup_failed' ||
        attempt.classification === 'infra_failed',
    );
  if (
    !priorAttemptsAreRetryable ||
    (outcome === 'passed' && (last.classification !== 'passed' || (last.reward ?? 0) <= 0)) ||
    (outcome === 'failed' && (last.classification !== 'failed' || last.reward !== 0)) ||
    (outcome === 'candidate_timeout' && last.classification !== 'timeout')
  ) {
    throw new HarborInfraError(`verifier outcome disagrees with its attempts for task ${taskId}`);
  }
  return { outcome, attempts };
}

function validateVerifierAttempt(
  value: unknown,
  expectedAttempt: number,
  taskId: string,
): HarborVerifierAttempt {
  if (!isRecord(value) || value.attempt !== expectedAttempt) {
    throw new HarborInfraError(`verifier attempt is malformed for task ${taskId}`);
  }
  const classification = value.classification;
  if (
    classification !== 'passed' &&
    classification !== 'failed' &&
    classification !== 'timeout' &&
    classification !== 'infra_setup_failed' &&
    classification !== 'infra_failed'
  ) {
    throw new HarborInfraError(`verifier attempt classification is malformed for task ${taskId}`);
  }
  if (
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  ) {
    throw new HarborInfraError(`verifier attempt duration is malformed for task ${taskId}`);
  }
  if (
    value.reward !== undefined &&
    (typeof value.reward !== 'number' || !Number.isFinite(value.reward))
  ) {
    throw new HarborInfraError(`verifier attempt reward is malformed for task ${taskId}`);
  }
  return {
    attempt: expectedAttempt,
    classification,
    durationMs: value.durationMs,
    ...(typeof value.reward === 'number' ? { reward: value.reward } : {}),
  };
}

function summarizeVerifierFailure(text: string | null): string | undefined {
  if (!text) return undefined;
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
  if (
    normalized.includes("module 'numpy' has no attribute 'int'") ||
    normalized.includes('module "numpy" has no attribute "int"')
  ) {
    parts.push('python_numpy_removed_alias_np.int');
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function integerAssertionOffByOne(text: string): boolean {
  const match = text.match(/assert\s+['"](\d+)['"]\s+in\s+['"](\d+)['"]/);
  if (!match) return false;
  const expected = Number(match[1]);
  const actual = Number(match[2]);
  return (
    Number.isSafeInteger(expected) &&
    Number.isSafeInteger(actual) &&
    Math.abs(expected - actual) === 1
  );
}

function finalStateTextMismatch(text: string): boolean {
  return /\bExpected\s+['"][^'"\n]{1,200}['"]/i.test(text) && /\bGot:\s+['"]/i.test(text);
}

function structuredOutputValuesMismatch(normalizedText: string): boolean {
  return normalizedText.includes('only found') && normalizedText.includes('expected values');
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
  assertNoExperimentIdentityOverrides(attemptAgentEnv);
  const provider = options.provider ?? 'deepseek';
  const makaModel = modelIdForProvider(options.model, provider);
  const adapter = options.agent ?? 'maka';
  const agentModel = adapter === 'opencode' ? modelForOpenCode(options.model, provider) : makaModel;
  if (adapter === 'opencode' && !options.opencodeToolchainPath) {
    throw new Error('opencodeToolchainPath is required for the OpenCode adapter');
  }
  if (adapter === 'opencode' && options.agentVersion !== OPENCODE_TOOLCHAIN_SPEC.opencode.version) {
    throw new Error(
      `OpenCode adapter version must match toolchain version ${OPENCODE_TOOLCHAIN_SPEC.opencode.version}`,
    );
  }
  if (adapter === 'kimi-code' && !options.kimiCodeToolchainPath) {
    throw new Error('kimiCodeToolchainPath is required for the Kimi Code adapter');
  }
  if (
    adapter === 'kimi-code' &&
    options.agentVersion !== KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.version
  ) {
    throw new Error(
      `Kimi Code adapter version must match toolchain version ${KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.version}`,
    );
  }
  const mounts: Array<Record<string, unknown>> = [
    { type: 'bind', source: options.makaRepoPath, target: CONTAINER_MAKA_REPO, read_only: true },
    ...(adapter === 'opencode'
      ? [
          {
            type: 'bind',
            source: options.opencodeToolchainPath!,
            target: OPENCODE_TOOLCHAIN_CONTAINER_PATH,
            read_only: true,
          },
        ]
      : adapter === 'kimi-code'
        ? [
            {
              type: 'bind',
              source: options.kimiCodeToolchainPath!,
              target: KIMI_CODE_TOOLCHAIN_CONTAINER_PATH,
              read_only: true,
            },
          ]
        : []),
  ];

  const agentEnv: Record<string, string> = {
    MAKA_BACKEND: 'ai-sdk',
    MAKA_MODEL: makaModel,
    MAKA_PROVIDER: provider,
    MAKA_LLM_CONNECTION_SLUG: provider,
    // Verbatim — the controller hashes exactly these bytes and verifies the round-trip.
    MAKA_SYSTEM_PROMPT: input.systemPrompt,
  };
  if (options.reasoningEffort) {
    agentEnv.MAKA_REASONING_EFFORT = options.reasoningEffort;
    if (adapter === 'opencode') agentEnv.MAKA_OPENCODE_VARIANT = options.reasoningEffort;
  }
  if (adapter === 'opencode') {
    agentEnv.MAKA_OPENCODE_TOOLCHAIN_FINGERPRINT = OPENCODE_TOOLCHAIN_FINGERPRINT;
  }
  if (adapter === 'kimi-code') {
    agentEnv.MAKA_KIMI_CODE_TOOLCHAIN_FINGERPRINT = KIMI_CODE_TOOLCHAIN_FINGERPRINT;
  }

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
  // Lenient by shared contract with the Python adapter: a malformed value must
  // fall back (metadata, then the adapter's default) rather than fail the run.
  const cellTimeoutSec =
    lenientPositiveIntEnv(agentEnv.MAKA_CELL_TIMEOUT_SEC) ?? input.task.metadata?.agentTimeoutSec;
  if (cellTimeoutSec !== undefined) agentEnv.MAKA_CELL_TIMEOUT_SEC = String(cellTimeoutSec);
  const verifier = verifierPolicy(input.task);

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
      ...(options.dockerPlatform === 'linux/amd64'
        ? {
            extra_docker_compose: [
              join(
                options.makaRepoPath,
                'packages/headless/harbor/docker-compose-linux-amd64.yaml',
              ),
            ],
          }
        : {}),
    },
    verifier: harborVerifierConfig(verifier),
    metrics: [{ type: 'mean', kwargs: {} }],
    agents: [
      {
        ...(adapter === 'maka' ? { name: adapter } : {}),
        import_path:
          adapter === 'opencode'
            ? 'opencode_agent:MakaOpenCodeAgent'
            : adapter === 'kimi-code'
              ? 'kimi_code_agent:MakaKimiCodeAgent'
              : 'maka_agent:MakaAgent',
        model_name: agentModel,
        kwargs:
          adapter === 'maka'
            ? { backend: 'ai-sdk' }
            : options.agentVersion
              ? { version: options.agentVersion }
              : {},
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

function harborVerifierConfig(verifier: ReturnType<typeof verifierPolicy>) {
  return {
    env: {},
    disable: false,
    import_path: HARBOR_ORACLE_EXECUTION_POLICY.verifier.importPath,
    kwargs: {
      attempt_timeout_sec: verifier.attemptTimeoutSec,
      max_attempts: HARBOR_ORACLE_MAX_ATTEMPTS,
    },
    override_timeout_sec: verifier.outerTimeoutSec,
  };
}

function verifierPolicy(task: HarborTaskRunInput['task']): {
  attemptTimeoutSec: number;
  outerTimeoutSec: number;
} {
  const attemptTimeoutSec =
    task.metadata?.verifierTimeoutSec ??
    HARBOR_ORACLE_EXECUTION_POLICY.verifier.defaultAttemptTimeoutSec;
  return {
    attemptTimeoutSec,
    outerTimeoutSec:
      attemptTimeoutSec * HARBOR_ORACLE_MAX_ATTEMPTS +
      HARBOR_ORACLE_EXECUTION_POLICY.verifier.retryGraceSec,
  };
}

async function hostSideProviderRuntime(options: HarborTaskRunnerOptions): Promise<{
  env: Record<string, string>;
  usage?: () => ProviderTokenUsage | null;
  telemetry?: () => ProviderRequestTelemetry[];
  close?: () => Promise<void>;
} | null> {
  const provider = options.provider ?? 'deepseek';
  if (usesHostProviderProxy(options.agent) && provider === 'github-copilot') {
    const adapter = options.agent === 'kimi-code' ? 'Kimi Code' : 'OpenCode';
    throw new Error(
      `GitHub Copilot Harbor runs use the Maka host agent; the ${adapter} Harbor adapter does not support this provider`,
    );
  }
  const githubToken =
    provider === 'github-copilot'
      ? options.apiKeyFile
        ? (await readFile(options.apiKeyFile, 'utf8')).trim()
        : githubCopilotAccountTokenFromEnv(provider, options.agentEnv)
      : undefined;
  if (!options.apiKeyFile && !githubToken && providerRequiresSecret(provider)) return null;
  const providerEnv = providerCredentialEnv(provider);
  const [primaryBaseUrl] = providerEnv?.baseUrls ?? [];
  const configuredBaseUrl =
    (primaryBaseUrl ? options.agentEnv?.[primaryBaseUrl] : undefined) ??
    options.agentEnv?.MAKA_BASE_URL ??
    providerBaseUrlFromEnv(provider, options.agentEnv ?? {});
  const copilotCredential = githubToken
    ? await resolveGitHubCopilotHostCredential(
        githubToken,
        modelIdForProvider(options.model, provider),
        configuredBaseUrl ?? PROVIDER_DEFAULTS['github-copilot'].baseUrl,
        options.copilotFetch,
      )
    : undefined;
  const baseUrl = copilotCredential?.baseUrl ?? configuredBaseUrl;
  if (usesHostProviderProxy(options.agent)) {
    const apiKeyFile = options.apiKeyFile;
    if (!apiKeyFile) return null;
    if (!baseUrl) throw new Error(`${options.agent} provider ${provider} requires a base URL`);
    const proxy = await startProviderAuthProxy({
      upstreamBaseUrl: baseUrl,
      apiKeyFile,
      authMode: options.agent === 'kimi-code' ? 'bearer' : providerProxyAuthMode(provider),
      usageProtocol: providerProxyUsageProtocol(options.agent, provider),
    });
    return {
      env: {
        MAKA_PROVIDER_PROXY_URL: proxy.baseUrl,
        MAKA_PROVIDER_PROXY_TOKEN: proxy.token,
      },
      usage: proxy.usage,
      telemetry: proxy.telemetry,
      close: proxy.close,
    };
  }
  const apiKeyEnvName = copilotCredential
    ? 'COPILOT_GITHUB_TOKEN'
    : options.apiKeyFile
      ? normalizeRawKeyEnvName(
          options.apiKeyEnvName ?? requireProviderCredentialEnv(provider).apiKeys[0]!,
        )
      : undefined;
  return {
    env: {
      MAKA_HOST_REPO_ROOT: options.makaRepoPath,
      ...(copilotCredential
        ? { MAKA_HOST_API_KEY: copilotCredential.accessToken }
        : options.apiKeyFile
          ? { MAKA_HOST_API_KEY_FILE: options.apiKeyFile }
          : {}),
      ...(apiKeyEnvName ? { MAKA_HOST_API_KEY_ENV_NAME: apiKeyEnvName } : {}),
      ...(!options.apiKeyFile && !copilotCredential ? { MAKA_HOST_NO_AUTH: 'true' } : {}),
      ...(baseUrl ? { MAKA_HOST_BASE_URL: baseUrl } : {}),
      ...(copilotCredential ? { MAKA_HOST_MODEL_API_PROTOCOL: copilotCredential.apiProtocol } : {}),
    },
  };
}

function usesHostProviderProxy(agent: HarborTaskRunnerOptions['agent']): boolean {
  return agent === 'opencode' || agent === 'kimi-code';
}

function providerTokenSummary(
  usage: ProviderTokenUsage,
  pricing: HarborTaskPricing,
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
  agent: HarborTaskRunnerOptions['agent'],
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

async function resolveGitHubCopilotHostCredential(
  githubToken: string,
  modelId: string,
  baseUrl: string,
  fetchFn?: typeof fetch,
): Promise<{
  accessToken: string;
  baseUrl: string;
  apiProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
}> {
  if (!isSupportedGitHubCopilotAccountToken(githubToken)) {
    throw new Error(
      'GitHub Copilot requires a GitHub OAuth, GitHub App user, or fine-grained account token; classic PATs are not accepted',
    );
  }
  const models = await fetchGitHubCopilotModels(baseUrl, githubToken, fetchFn);
  const model = models.find(({ id }) => id === modelId);
  if (!model?.apiProtocol)
    throw new Error(`GitHub Copilot account does not expose model ${modelId}`);
  return { accessToken: githubToken, baseUrl, apiProtocol: model.apiProtocol };
}

function githubCopilotAccountTokenFromEnv(
  provider: string | undefined,
  agentEnv: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (provider !== 'github-copilot') return undefined;
  for (const name of providerCredentialEnv(provider)?.apiKeys ?? []) {
    const value = agentEnv?.[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function taskAgentEnvWithoutProviderSecrets(
  options: HarborTaskRunnerOptions,
): Record<string, string> {
  const providerEnv = providerCredentialEnv(options.provider ?? 'deepseek');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.agentEnv ?? {})) {
    if (
      providerEnv?.apiKeys.includes(key) ||
      key === providerEnv?.apiKeyFile ||
      providerEnv?.baseUrls.includes(key)
    )
      continue;
    if (key === 'MAKA_BASE_URL') continue;
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

function assertNoExperimentIdentityOverrides(agentEnv: Record<string, string> | undefined): void {
  const forbidden = Object.keys(agentEnv ?? {}).filter((key) =>
    EXPERIMENT_IDENTITY_ENV_KEYS.has(key),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `agentEnv must not override experiment identity: ${forbidden.sort().join(', ')}`,
    );
  }
}

function normalizeRawKeyEnvName(name: string): string {
  return name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
}

function providerRequiresSecret(provider: string | undefined): boolean {
  const providerType = (provider ?? 'deepseek') as ProviderType;
  const definition = PROVIDER_DEFAULTS[providerType];
  if (!definition) throw new Error(`unsupported MAKA_PROVIDER: ${provider ?? ''}`);
  return providerAuthRequiresSecret(providerType);
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
  const match =
    dirs.find((name) => name === taskName || name.startsWith(`${taskName}__`)) ?? dirs[0];
  if (!match) {
    throw new HarborInfraError(
      `harbor produced no trial directory under ${jobDir} for task ${taskName}`,
    );
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
    const rewards =
      rewardStats && isRecord(rewardStats.reward) ? Object.values(rewardStats.reward) : [];
    for (const trialNames of rewards) {
      const trialName = firstString(trialNames);
      if (trialName) return trialName;
    }
    const exceptionStats = isRecord(evalResult.exception_stats)
      ? Object.values(evalResult.exception_stats)
      : [];
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
      throw new HarborInfraError(
        `Harbor trial failed before verifier reward for task ${taskId}: ${trialException}`,
        errorText(error),
      );
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
  const type =
    typeof exceptionInfo.exception_type === 'string'
      ? exceptionInfo.exception_type
      : 'HarborTrialError';
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

async function readCellOutput(cellOutputPath: string, taskId: string): Promise<HarborCellOutput> {
  let raw: string;
  try {
    raw = await readFile(cellOutputPath, 'utf8');
  } catch (error) {
    throw new HarborInfraError(
      `maka cell did not write output for task ${taskId}`,
      errorText(error),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HarborInfraError(
      `maka cell output is not valid JSON for task ${taskId}`,
      errorText(error),
    );
  }
  try {
    return validateHarborCellOutput(parsed);
  } catch (error) {
    throw new HarborInfraError(
      `maka cell output is malformed for task ${taskId}`,
      errorText(error),
    );
  }
}

const defaultHarborProcessRunner: HarborProcessRunner = async (request) => {
  try {
    const { stdout, stderr } = await execFileAsync(request.harborBin, [...request.args], {
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

function modelForOpenCode(model: string, provider: string): string {
  return model.includes('/') ? model : `${provider}/${model}`;
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
