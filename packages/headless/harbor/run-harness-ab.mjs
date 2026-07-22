#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureAbRunManifest, readAbRunManifest } from '#ab-manifest';
import {
  discoverCachedHarborTasks,
  fingerprintFixedPromptTaskTree,
  resolveFixedPromptRunRoot,
} from '#fixed-prompt-task-source';
import { createHarborTaskRunner } from '#harbor-task-runner';
import {
  buildHarnessOracleExecutionPolicyFingerprint,
  HARBOR_ORACLE_DOCKER_PLATFORM,
} from '#harness-oracle-policy';
import {
  buildHarnessOracleAuditTasks,
  loadHarnessOracleRegistrySnapshot,
  resolveHarnessOracleAnnotations,
} from '#harness-oracle-registry';
import {
  OPENCODE_TOOLCHAIN_FINGERPRINT,
  OPENCODE_TOOLCHAIN_SPEC,
  prepareOpenCodeToolchain,
} from '#opencode-toolchain';
import {
  KIMI_CODE_TOOLCHAIN_FINGERPRINT,
  KIMI_CODE_TOOLCHAIN_SPEC,
  prepareKimiCodeToolchain,
} from '#kimi-code-toolchain';
import {
  CODEX_TOOLCHAIN_FINGERPRINT,
  CODEX_TOOLCHAIN_SPEC,
  prepareCodexToolchain,
} from '#codex-toolchain';
import { createCodexOAuthHarnessCredentialBinding } from '#codex-oauth-harness';
import {
  assertTerminalBench21TaskSet,
  assertTerminalBench21TaskTreeFingerprint,
  buildHarnessAbResumeFingerprint,
  buildHarnessAbRunManifest,
  HARNESS_MAKA_CONTEXT_BUDGET,
  TERMINAL_BENCH_2_1_REVISION,
  TERMINAL_BENCH_2_1_TASK_IDS,
} from '#harness-ab-manifest';
import { runHarnessAbComparisonUnlocked, withHarnessAbRunLock } from '#harness-ab-run';
import { DEFAULT_HEADLESS_SYSTEM_PROMPT } from '@maka/headless';
import { thinkingVariantsForModel } from '@maka/core/model-thinking';
import {
  assertHarnessAbReportCompleted,
  buildHarnessAbReport,
  renderHarnessAbReportCsv,
  renderHarnessAbReportMarkdown,
} from '#harness-ab-report';
import { envPath as parseEnvPath } from '#headless-run-env';
import { buildSubjectFingerprint, buildToolchainFingerprint } from '#experiment-fingerprint';
import { runExperiment } from '#experiment-engine';

const execFileAsync = promisify(execFile);

const EXPECTED_SOURCE_TASKS = TERMINAL_BENCH_2_1_TASK_IDS.length;
export const DEFAULT_HARNESS_AB_RUN_ID = 'k3-maka-vs-kimi-code-tbench-2.1-full-v2';
const CANARY_TASKS = 5;
const PROVIDER = 'kimi-coding-plan';
const MODEL = 'k3';
const REASONING_EFFORT = 'max';
const BASE_URL = 'https://api.kimi.com/coding/v1';
const ORDER_SEED = 'terminal-bench-2.1:k3:harness-comparison:v1';
const MAX_PAIR_CONCURRENCY = 4;
const DEFAULT_PAIR_CONCURRENCY = 1;
const DEFAULT_ARM_EXECUTION = 'sequential';
const BILLING_MODE = 'account-plan';
const PRICING = {
  currency: 'USD',
  unit: 'per_1m_tokens',
  input: 0,
  cachedInput: 0,
  output: 0,
  source: 'kimi-coding-plan-account-plan',
};
const HARBOR_SETUP_TEARDOWN_GRACE_SEC = 15 * 60;
const ORACLE_EVIDENCE_RESOLUTION_TIMEOUT_MS = 15_000;
const BACKGROUND_RUN_ENV = 'MAKA_HARNESS_AB_BACKGROUND_RUN';
const BACKGROUND_STARTED_AT_ENV = 'MAKA_HARNESS_AB_DETACHED_STARTED_AT';
const BACKGROUND_JOURNAL_FILENAME = 'background-run.json';
const BACKGROUND_LOG_FILENAME = 'background-run.log';

export const HARNESS_COMPETITOR_PROFILES = Object.freeze({
  'kimi-code': Object.freeze({
    id: 'kimi-code',
    version: KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.version,
    toolchainFingerprint: KIMI_CODE_TOOLCHAIN_FINGERPRINT,
    config: Object.freeze({
      adapter: 'kimi_code_agent:MakaKimiCodeAgent',
      outputFormat: 'stream-json',
      permissions: 'prompt-auto',
      attemptPolicy: 'single',
      billingMode: BILLING_MODE,
    }),
  }),
  opencode: Object.freeze({
    id: 'opencode',
    version: OPENCODE_TOOLCHAIN_SPEC.opencode.version,
    toolchainFingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT,
    config: Object.freeze({
      adapter: 'opencode_agent:MakaOpenCodeAgent',
      variant: REASONING_EFFORT,
      pure: true,
      permissions: 'auto',
      attemptPolicy: 'single',
      billingMode: BILLING_MODE,
    }),
  }),
  codex: Object.freeze({
    id: 'codex',
    version: CODEX_TOOLCHAIN_SPEC.codex.version,
    toolchainFingerprint: CODEX_TOOLCHAIN_FINGERPRINT,
    runtime: Object.freeze({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      billingMode: 'account-plan',
      pricing: Object.freeze({
        currency: 'USD',
        unit: 'per_1m_tokens',
        input: 0,
        cachedInput: 0,
        output: 0,
        source: 'openai-codex-chatgpt-account-plan',
      }),
    }),
    config: Object.freeze({
      adapter: 'codex_agent:MakaCodexAgent',
      transport: 'responses-http',
      permissions: 'container-full-access',
      attemptPolicy: 'single',
      billingMode: 'account-plan',
    }),
  }),
});

export function resolveHarnessCompetitorProfile(raw = 'kimi-code') {
  const profile = HARNESS_COMPETITOR_PROFILES[raw];
  if (!profile) {
    throw new Error(
      `MAKA_HARNESS_AB_COMPETITOR must be one of: ${Object.keys(HARNESS_COMPETITOR_PROFILES).join(', ')}`,
    );
  }
  return profile;
}

export function resolveHarnessRuntimeProfile(competitorProfile) {
  return (
    competitorProfile.runtime ?? {
      provider: PROVIDER,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      baseUrl: BASE_URL,
      billingMode: BILLING_MODE,
      pricing: PRICING,
    }
  );
}

export function buildHarnessExecutionProfile(competitorProfile) {
  const runtime = resolveHarnessRuntimeProfile(competitorProfile);
  if (
    !thinkingVariantsForModel(runtime.provider, runtime.model).includes(runtime.reasoningEffort)
  ) {
    throw new Error(
      `${runtime.provider}/${runtime.model} does not support reasoning effort ${runtime.reasoningEffort}`,
    );
  }
  return {
    modelSpec: `${runtime.provider}/${runtime.model}`,
    provider: runtime.provider,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    baseUrl: runtime.baseUrl,
    billingMode: runtime.billingMode,
    pricing: {
      inputUsdPer1M: runtime.pricing.input,
      cacheReadUsdPer1M: runtime.pricing.cachedInput,
      outputUsdPer1M: runtime.pricing.output,
      source: runtime.pricing.source,
    },
  };
}

export async function resolveHarnessRuntimeCredentials(input) {
  if (input.competitorProfile.id !== 'codex') {
    return {
      apiKeyFile: envPathFrom(
        input.env,
        'MAKA_HARNESS_AB_KEY_FILE',
        join(homedir(), '.maka/secrets/kimi-coding-plan.key'),
      ),
    };
  }
  const credentialsRoot = envPathFrom(
    input.env,
    'MAKA_HARNESS_AB_WORKSPACE_ROOT',
    defaultMakaWorkspaceRoot(),
  );
  const createCredentialBinding =
    input.createCodexOAuthCredentialBinding ?? createCodexOAuthHarnessCredentialBinding;
  return createCredentialBinding({
    credentialsRoot,
    connectionSlug: input.env.MAKA_HARNESS_AB_OAUTH_CONNECTION_SLUG || 'codex-subscription',
  });
}

export function resolveHarnessAbRunId(
  competitorProfile,
  explicitRunId,
  isolatedTaskId,
  explicitTaskIds,
) {
  if (isolatedTaskId?.trim() && !explicitRunId?.trim()) {
    throw new Error('MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_ID');
  }
  if (explicitTaskIds?.trim() && !explicitRunId?.trim()) {
    throw new Error('MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_IDS');
  }
  const runtime = resolveHarnessRuntimeProfile(competitorProfile);
  return (
    explicitRunId ||
    (competitorProfile.id === 'kimi-code'
      ? DEFAULT_HARNESS_AB_RUN_ID
      : `${runtime.model}-maka-vs-${competitorProfile.id}${runtime.provider === 'openai-codex' ? '-oauth' : ''}-tbench-2.1-full-v1`)
  );
}

export function resolveHarnessCompetitorToolchainPath(runRoot, competitorProfile) {
  const fingerprintPrefix = competitorProfile.toolchainFingerprint.slice(
    'sha256:'.length,
    'sha256:'.length + 12,
  );
  return join(
    runRoot,
    'toolchains',
    `${competitorProfile.id}-${competitorProfile.version}-${fingerprintPrefix}-linux-x64`,
  );
}

export function resolveHarnessCompetitorToolchain(runRoot, competitorProfile, env = process.env) {
  if (competitorProfile.id === 'kimi-code') {
    return {
      path: env.MAKA_HARNESS_AB_KIMI_CODE_TOOLCHAIN
        ? resolve(env.MAKA_HARNESS_AB_KIMI_CODE_TOOLCHAIN)
        : resolveHarnessCompetitorToolchainPath(runRoot, competitorProfile),
      prepare: prepareKimiCodeToolchain,
    };
  }
  if (competitorProfile.id === 'opencode') {
    return {
      path: env.MAKA_HARNESS_AB_OPENCODE_TOOLCHAIN
        ? resolve(env.MAKA_HARNESS_AB_OPENCODE_TOOLCHAIN)
        : resolveHarnessCompetitorToolchainPath(runRoot, competitorProfile),
      prepare: prepareOpenCodeToolchain,
    };
  }
  if (competitorProfile.id === 'codex') {
    return {
      path: env.MAKA_HARNESS_AB_CODEX_TOOLCHAIN
        ? resolve(env.MAKA_HARNESS_AB_CODEX_TOOLCHAIN)
        : resolveHarnessCompetitorToolchainPath(runRoot, competitorProfile),
      prepare: prepareCodexToolchain,
    };
  }
  throw new Error(`unsupported harness competitor: ${competitorProfile.id}`);
}

const envPath = (name, fallback) => parseEnvPath(name, process.env[name], fallback);
const envPathFrom = (env, name, fallback) => parseEnvPath(name, env[name], fallback);

function defaultMakaWorkspaceRoot() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Maka', 'workspaces', 'default');
  }
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Maka',
      'workspaces',
      'default',
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'Maka',
    'workspaces',
    'default',
  );
}

function runLimit(raw) {
  const parsed = Number(raw ?? CANARY_TASKS);
  if (parsed !== CANARY_TASKS && parsed !== EXPECTED_SOURCE_TASKS) {
    throw new Error(`MAKA_HARNESS_AB_LIMIT must be ${CANARY_TASKS} or ${EXPECTED_SOURCE_TASKS}`);
  }
  return parsed;
}

function runPairConcurrency(raw) {
  const parsed = Number(raw ?? DEFAULT_PAIR_CONCURRENCY);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAIR_CONCURRENCY) {
    throw new Error(
      `MAKA_HARNESS_AB_PAIR_CONCURRENCY must be an integer between 1 and ${MAX_PAIR_CONCURRENCY}`,
    );
  }
  return parsed;
}

function runArmExecution(raw) {
  const parsed = raw?.trim() || DEFAULT_ARM_EXECUTION;
  if (parsed !== 'sequential' && parsed !== 'parallel') {
    throw new Error('MAKA_HARNESS_AB_ARM_EXECUTION must be sequential or parallel');
  }
  return parsed;
}

export function resolveHarnessAbExecutionPolicy(rawPairConcurrency, rawArmExecution, taskCount) {
  if (!Number.isSafeInteger(taskCount) || taskCount < 1) {
    throw new Error('harness A/B execution policy requires at least one task');
  }
  return {
    pairConcurrency: Math.min(runPairConcurrency(rawPairConcurrency), taskCount),
    armExecution: runArmExecution(rawArmExecution),
  };
}

export function resolveHarnessAbTaskSelection(rawTaskId, rawLimit, rawTaskIds) {
  const taskId = rawTaskId?.trim();
  const explicitTaskIds = rawTaskIds
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawTaskIds !== undefined && explicitTaskIds?.length === 0) {
    throw new Error('MAKA_HARNESS_AB_TASK_IDS must contain at least one task id');
  }
  if (taskId && explicitTaskIds?.length) {
    throw new Error('MAKA_HARNESS_AB_TASK_ID and MAKA_HARNESS_AB_TASK_IDS are mutually exclusive');
  }
  if (explicitTaskIds?.length) {
    const uniqueTaskIds = [...new Set(explicitTaskIds)];
    if (uniqueTaskIds.length !== explicitTaskIds.length) {
      throw new Error('MAKA_HARNESS_AB_TASK_IDS must not contain duplicate task ids');
    }
    const invalidTaskIds = uniqueTaskIds.filter(
      (selectedTaskId) => !TERMINAL_BENCH_2_1_TASK_IDS.includes(selectedTaskId),
    );
    if (invalidTaskIds.length > 0) {
      throw new Error(
        `MAKA_HARNESS_AB_TASK_IDS contains unknown Terminal-Bench 2.1 tasks: ${invalidTaskIds.join(', ')}`,
      );
    }
    return {
      taskIds: uniqueTaskIds,
      limit: uniqueTaskIds.length,
    };
  }
  if (!taskId) {
    return {
      taskIds: TERMINAL_BENCH_2_1_TASK_IDS,
      limit: runLimit(rawLimit),
    };
  }
  if (!TERMINAL_BENCH_2_1_TASK_IDS.includes(taskId)) {
    throw new Error('MAKA_HARNESS_AB_TASK_ID must name a Terminal-Bench 2.1 task');
  }
  return { taskIds: [taskId], limit: 1 };
}

export function harnessMakaContextBudgetEnv() {
  return {
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: String(
      HARNESS_MAKA_CONTEXT_BUDGET.activeToolResultPrune.maxCurrentResultEstimatedTokens,
    ),
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: String(
      HARNESS_MAKA_CONTEXT_BUDGET.activeToolResultPrune.minStepNumber,
    ),
    MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: String(
      HARNESS_MAKA_CONTEXT_BUDGET.staleToolResultPrune.maxResultEstimatedTokens,
    ),
    MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL: String(
      HARNESS_MAKA_CONTEXT_BUDGET.staleToolResultPrune.minRecentTurnsFull,
    ),
    MAKA_CONTEXT_SEMANTIC_COMPACT: 'off',
  };
}

export function buildHarnessAbManifest({
  subjectFingerprint,
  taskSourceFingerprint,
  toolchainFingerprint,
  taskIds = TERMINAL_BENCH_2_1_TASK_IDS,
  competitorProfile = resolveHarnessCompetitorProfile(),
  pairConcurrency = Math.min(DEFAULT_PAIR_CONCURRENCY, taskIds.length),
  armExecution = DEFAULT_ARM_EXECUTION,
  oracleEvidence,
  credentialIdentity,
}) {
  const runtime = resolveHarnessRuntimeProfile(competitorProfile);
  const execution = buildHarnessExecutionProfile(competitorProfile);
  return buildHarnessAbRunManifest({
    benchmark: {
      dataset: 'terminal-bench',
      version: '2.1',
      revision: TERMINAL_BENCH_2_1_REVISION,
      timeoutPolicy: 'task-native',
      timeoutMultiplier: 1,
      outerTimeoutGraceSec: HARBOR_SETUP_TEARDOWN_GRACE_SEC,
    },
    taskIds,
    orderSeed:
      execution.model === MODEL
        ? ORDER_SEED
        : `terminal-bench-2.1:${execution.model}:harness-comparison:v1`,
    pilotTaskCount: Math.min(CANARY_TASKS, taskIds.length),
    model: {
      provider: execution.provider,
      id: execution.model,
      reasoningEffort: execution.reasoningEffort,
      ...(credentialIdentity ? { credentialIdentity } : {}),
    },
    pricing: runtime.pricing,
    arms: [
      {
        id: 'maka',
        version: subjectFingerprint,
        config: {
          adapter: 'maka_agent:MakaAgent',
          externalSystemPrompt: 'empty',
          reasoningEffort: execution.reasoningEffort,
          continuation: false,
          attemptPolicy: 'single',
          billingMode: runtime.billingMode,
          contextBudget: HARNESS_MAKA_CONTEXT_BUDGET,
        },
      },
      {
        id: competitorProfile.id,
        version: competitorProfile.version,
        config: {
          ...competitorProfile.config,
          externalSystemPrompt: 'empty',
          profile: competitorProfile.id,
        },
      },
    ],
    taskBudgetSec: null,
    harborTimeoutMs: null,
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
    pairConcurrency,
    armExecution,
    ...(oracleEvidence ? { oracleEvidence } : {}),
  });
}

export async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_HARNESS_AB_MAKA_REPO
    ? resolve(process.env.MAKA_HARNESS_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath('MAKA_HARNESS_AB_OUT_DIR');
  const tasksRoot = envPath('MAKA_HARNESS_AB_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  const competitorProfile = resolveHarnessCompetitorProfile(
    process.env.MAKA_HARNESS_AB_COMPETITOR || 'kimi-code',
  );
  const runId = resolveHarnessAbRunId(
    competitorProfile,
    process.env.MAKA_HARNESS_AB_RUN_ID,
    process.env.MAKA_HARNESS_AB_TASK_ID,
    process.env.MAKA_HARNESS_AB_TASK_IDS,
  );
  const selection = resolveHarnessAbTaskSelection(
    process.env.MAKA_HARNESS_AB_TASK_ID,
    process.env.MAKA_HARNESS_AB_LIMIT,
    process.env.MAKA_HARNESS_AB_TASK_IDS,
  );
  const executionPolicy = resolveHarnessAbExecutionPolicy(
    process.env.MAKA_HARNESS_AB_PAIR_CONCURRENCY,
    process.env.MAKA_HARNESS_AB_ARM_EXECUTION,
    selection.taskIds.length,
  );
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_HARNESS_AB_RUN_ID');
  await withHarnessAbRunLock(runRoot, async () => {
    const journal = backgroundJournal(runRoot);
    if (journal) await writeBackgroundJournal(journal.path, { ...journal.base, status: 'running' });
    let exitCode = 0;
    try {
      await runLocked({
        repoRoot,
        makaRepoPath,
        tasksRoot,
        runId,
        selection,
        executionPolicy,
        runRoot,
        competitorProfile,
      });
    } catch (error) {
      exitCode = 1;
      throw error;
    } finally {
      if (journal) {
        await writeBackgroundJournal(journal.path, {
          ...journal.base,
          status: exitCode === 0 ? 'completed' : 'failed',
          finishedAt: new Date().toISOString(),
          exitCode,
        });
      }
    }
  });
}

async function runLocked({
  repoRoot,
  makaRepoPath,
  tasksRoot,
  runId,
  selection,
  executionPolicy,
  runRoot,
  competitorProfile,
}) {
  const allTasks = await discoverCachedHarborTasks(tasksRoot);
  assertTerminalBench21TaskSet(allTasks.map((task) => task.id));
  const taskSourceFingerprint = await fingerprintFixedPromptTaskTree(allTasks);
  assertTerminalBench21TaskTreeFingerprint(taskSourceFingerprint);

  if (process.env.MAKA_HARNESS_AB_DRY_RUN === '1') {
    console.log(
      `dry-run: frozen ${EXPECTED_SOURCE_TASKS}-task source will run ${selection.limit} paired Pass@1 cells; Oracle evidence is advisory`,
    );
    return;
  }

  const subjectFingerprint = await buildSubjectFingerprint(
    makaRepoPath,
    process.env.MAKA_HARNESS_AB_EXPLICIT_SUBJECT_FINGERPRINT,
    undefined,
    'MAKA_HARNESS_AB',
  );
  const hostToolchainFingerprint = await buildToolchainFingerprint(
    process.env.MAKA_HARNESS_AB_TOOLCHAIN_FINGERPRINT,
    undefined,
    makaRepoPath,
    'MAKA_HARNESS_AB',
  );
  const [verifierImplementationSource, composeImplementationSource] = await Promise.all([
    readFile(join(makaRepoPath, 'packages/headless/harbor/maka_verifier.py')),
    readFile(join(makaRepoPath, 'packages/headless/harbor/docker-compose-linux-amd64.yaml')),
  ]);
  const executionPolicyFingerprint = buildHarnessOracleExecutionPolicyFingerprint({
    verifierImplementationSource,
    composeImplementationSource,
  });

  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const manifestPath = join(runRoot, 'harness-ab-manifest.json');
  const oracleEvidence = await resolveHarnessOracleEvidenceForRun(manifestPath, () =>
    resolveAdvisoryOracleEvidence({
      allTasks,
      executionPolicyFingerprint,
    }),
  );
  for (const warning of oracleEvidence.warnings) console.warn(`warning: ${warning}`);

  const credentials = await resolveHarnessRuntimeCredentials({
    competitorProfile,
    env: process.env,
  });

  const toolchainFingerprint = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        hostToolchainFingerprint,
        competitor: competitorProfile.id,
        competitorToolchainFingerprint: competitorProfile.toolchainFingerprint,
      }),
    )
    .digest('hex')}`;
  const manifest = buildHarnessAbManifest({
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
    taskIds: selection.taskIds,
    pairConcurrency: executionPolicy.pairConcurrency,
    armExecution: executionPolicy.armExecution,
    oracleEvidence,
    competitorProfile,
    credentialIdentity: credentials.credentialIdentity,
  });
  await ensureAbRunManifest(manifestPath, manifest);
  const evaluationTasks = manifest.evaluationTaskIds
    .slice(0, selection.limit)
    .map((taskId) => tasksById.get(taskId));
  if (evaluationTasks.some((task) => !task))
    throw new Error('manifest contains a task absent from the frozen task source');

  const competitorToolchain = resolveHarnessCompetitorToolchain(runRoot, competitorProfile);
  await competitorToolchain.prepare(competitorToolchain.path);

  const execution = buildHarnessExecutionProfile(competitorProfile);
  if (
    credentials.apiKeyFile &&
    (await readFile(credentials.apiKeyFile, 'utf8')).trim().length === 0
  )
    throw new Error('harness credential is empty');
  const systemPromptPath = join(runRoot, 'prompts', 'default-system-prompt.txt');
  const evaluatedTaskIds = new Set(evaluationTasks.map((task) => task.id));

  const report = await runExperiment({
    runRoot,
    prompts: () => [{ path: systemPromptPath, content: DEFAULT_HEADLESS_SYSTEM_PROMPT }],
    run: async ({ jobsDir, resultsJsonlPath }) => {
      const runnerOptions = {
        makaRepoPath,
        jobsDir,
        model: execution.modelSpec,
        provider: execution.provider,
        reasoningEffort: execution.reasoningEffort,
        ...credentials,
        pricing: execution.pricing,
        agentEnv: { MAKA_BASE_URL: execution.baseUrl },
        timeoutMultiplier: 1,
        dockerPlatform: 'linux/amd64',
      };
      const makaContextBudgetEnv = harnessMakaContextBudgetEnv();
      const config = (id) => ({
        id: `harness-ab-${id}`,
        backend: 'ai-sdk',
        llmConnectionSlug: execution.provider,
        model: execution.model,
        thinkingLevel: execution.reasoningEffort,
      });
      const summary = await runHarnessAbComparisonUnlocked({
        runId,
        runRoot,
        resultsJsonlPath,
        systemPromptPath,
        resumeFingerprint: buildHarnessAbResumeFingerprint(manifest),
        evaluationTasks,
        arms: [
          {
            id: 'maka',
            config: config('maka'),
            expectedPricingProfile: execution.pricing.source,
            billingMode: execution.billingMode,
            harborRunner: createHarborTaskRunner({
              ...runnerOptions,
              agent: 'maka',
              agentEnv: { ...runnerOptions.agentEnv, ...makaContextBudgetEnv },
            }),
          },
          {
            id: competitorProfile.id,
            config: config(competitorProfile.id),
            expectedPricingProfile: execution.pricing.source,
            billingMode: execution.billingMode,
            harborRunner: createHarborTaskRunner({
              ...runnerOptions,
              agent: competitorProfile.id,
              agentVersion: competitorProfile.version,
              ...(competitorProfile.id === 'kimi-code'
                ? { kimiCodeToolchainPath: competitorToolchain.path }
                : competitorProfile.id === 'opencode'
                  ? { opencodeToolchainPath: competitorToolchain.path }
                  : { codexToolchainPath: competitorToolchain.path }),
            }),
          },
        ],
        pairConcurrency: manifest.maxConcurrency,
        armExecution: manifest.metadata.execution.armExecution,
      });
      return buildHarnessAbReport(
        summary,
        {
          ...(oracleEvidence.resolvedSnapshotFingerprint
            ? { snapshotFingerprint: oracleEvidence.resolvedSnapshotFingerprint }
            : {}),
          annotations: oracleEvidence.annotations.filter((annotation) =>
            evaluatedTaskIds.has(annotation.taskId),
          ),
          warnings: oracleEvidence.warnings,
        },
        execution.billingMode,
      );
    },
    artifacts: (report) => [
      {
        path: join(runRoot, 'harness-ab-report.json'),
        content: `${JSON.stringify(report, null, 2)}\n`,
      },
      { path: join(runRoot, 'harness-ab-report.csv'), content: renderHarnessAbReportCsv(report) },
      {
        path: join(runRoot, 'harness-ab-report.md'),
        content: renderHarnessAbReportMarkdown(report),
      },
    ],
  });
  assertHarnessAbReportCompleted(report);
  console.log(
    `${report.runStatus}: ${report.coverage.attemptedCells}/${report.coverage.scheduledCells} cells attempted; ${report.effectiveness.pairedEvaluated} paired Pass@1 outcomes -> ${runRoot}`,
  );
}

export async function resolveAdvisoryOracleEvidence({
  allTasks,
  executionPolicyFingerprint,
  registryUrl = process.env.MAKA_HARNESS_AB_ORACLE_REGISTRY_URL?.trim(),
  expectedSnapshotFingerprint = process.env.MAKA_HARNESS_AB_ORACLE_REGISTRY_FINGERPRINT?.trim(),
  loadSnapshot = loadHarnessOracleRegistrySnapshot,
  buildAuditTasks = buildHarnessOracleAuditTasks,
  resolveBaseImageDigest = resolveHarnessOracleBaseImageDigest,
  resolutionTimeoutMs = ORACLE_EVIDENCE_RESOLUTION_TIMEOUT_MS,
}) {
  const warnings = [];
  let snapshot = null;
  let annotations;
  if (registryUrl && expectedSnapshotFingerprint) {
    const controller = new AbortController();
    let timeout;
    try {
      const resolution = (async () => {
        snapshot = await loadSnapshot({
          url: registryUrl,
          expectedFingerprint: expectedSnapshotFingerprint,
          signal: controller.signal,
        });
        const digestCache = new Map();
        const auditTasks = await buildAuditTasks({
          tasks: allTasks,
          executionPolicyFingerprint,
          environment: 'docker',
          platform: HARBOR_ORACLE_DOCKER_PLATFORM,
          resolveBaseImageDigest: (reference, platform) =>
            resolveBaseImageDigest(reference, platform, digestCache, controller.signal),
        });
        return resolveHarnessOracleAnnotations(auditTasks, snapshot);
      })();
      annotations = await Promise.race([
        resolution,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Oracle evidence resolution timed out'));
          }, resolutionTimeoutMs);
        }),
      ]);
    } catch {
      snapshot = null;
      warnings.push('Oracle registry could not be resolved; A/B continues without it');
    } finally {
      clearTimeout(timeout);
    }
  } else {
    warnings.push(
      'Oracle registry URL and fingerprint are not both configured; A/B continues without it',
    );
  }
  annotations ??= allTasks.map((task) => ({ taskId: task.id, state: 'missing' }));
  return {
    ...(registryUrl ? { registryUrl } : {}),
    ...(expectedSnapshotFingerprint ? { expectedSnapshotFingerprint } : {}),
    ...(snapshot ? { resolvedSnapshotFingerprint: snapshot.fingerprint } : {}),
    annotations,
    warnings,
  };
}

export async function resolveHarnessOracleEvidenceForRun(manifestPath, resolveEvidence) {
  const stored = await readAbRunManifest(manifestPath);
  if (stored?.experimentKind === 'harness' && stored.metadata?.oracleEvidence) {
    return stored.metadata.oracleEvidence;
  }
  return resolveEvidence();
}

export async function resolveHarnessOracleBaseImageDigest(
  reference,
  platform,
  cache = new Map(),
  signal,
) {
  const key = `${platform}:${reference}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      execFileAsync(
        'docker',
        ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'],
        { signal },
      ).then(({ stdout }) => resolvedImageDigestFromInspect(stdout, platform)),
    );
  }
  return cache.get(key);
}

export function resolvedImageDigestFromInspect(raw, platform) {
  const value = JSON.parse(raw);
  const [os, architecture] = platform.split('/');
  const selected = Array.isArray(value.manifests)
    ? value.manifests.find(
        (manifest) =>
          manifest?.platform?.os === os && manifest?.platform?.architecture === architecture,
      )?.digest
    : value.digest;
  if (typeof selected !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(selected)) {
    throw new Error(`Docker image manifest has no ${platform} digest`);
  }
  return selected;
}

function backgroundJournal(runRoot) {
  if (process.env[BACKGROUND_RUN_ENV] !== '1') return null;
  const logPath = join(runRoot, BACKGROUND_LOG_FILENAME);
  return {
    path: join(runRoot, BACKGROUND_JOURNAL_FILENAME),
    base: {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: process.env[BACKGROUND_STARTED_AT_ENV] || new Date().toISOString(),
      logPath,
    },
  };
}

async function writeBackgroundJournal(path, value) {
  const pendingPath = `${path}.${process.pid}.tmp`;
  await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(pendingPath, path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
