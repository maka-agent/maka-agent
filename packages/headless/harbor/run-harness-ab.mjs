#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  assertTerminalBench21TaskSet,
  assertTerminalBench21TaskTreeFingerprint,
  buildHarnessAbResumeFingerprint,
  buildHarnessAbRunManifest,
  HARNESS_MAKA_CONTEXT_BUDGET,
  TERMINAL_BENCH_2_1_REVISION,
  TERMINAL_BENCH_2_1_TASK_IDS,
} from '#harness-ab-manifest';
import { runHarnessAbComparisonUnlocked, withHarnessAbRunLock } from '#harness-ab-run';
import {
  assertHarnessAbReportCompleted,
  buildHarnessAbReport,
  renderHarnessAbReportCsv,
  renderHarnessAbReportMarkdown,
} from '#harness-ab-report';
import { buildSubjectFingerprint, buildToolchainFingerprint } from './run-prompt-ab.mjs';

const execFileAsync = promisify(execFile);

const EXPECTED_SOURCE_TASKS = TERMINAL_BENCH_2_1_TASK_IDS.length;
export const DEFAULT_HARNESS_AB_RUN_ID = 'k3-maka-vs-kimi-code-tbench-2.1-full-v2';
const CANARY_TASKS = 5;
const PROVIDER = 'kimi-coding-plan';
const MODEL = 'k3';
const MODEL_SPEC = `${PROVIDER}/${MODEL}`;
const REASONING_EFFORT = 'max';
const BASE_URL = 'https://api.kimi.com/coding/v1';
const ORDER_SEED = 'terminal-bench-2.1:k3:harness-comparison:v1';
const PAIR_CONCURRENCY = 4;
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

export function resolveHarnessAbRunId(competitorProfile, explicitRunId, isolatedTaskId) {
  if (isolatedTaskId?.trim() && !explicitRunId?.trim()) {
    throw new Error('MAKA_HARNESS_AB_RUN_ID is required with MAKA_HARNESS_AB_TASK_ID');
  }
  return (
    explicitRunId ||
    (competitorProfile.id === 'kimi-code'
      ? DEFAULT_HARNESS_AB_RUN_ID
      : `k3-maka-vs-${competitorProfile.id}-tbench-2.1-full-v1`)
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

function envPath(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`${name} is required`);
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw);
}

function runLimit(raw) {
  const parsed = Number(raw ?? CANARY_TASKS);
  if (parsed !== CANARY_TASKS && parsed !== EXPECTED_SOURCE_TASKS) {
    throw new Error(`MAKA_HARNESS_AB_LIMIT must be ${CANARY_TASKS} or ${EXPECTED_SOURCE_TASKS}`);
  }
  return parsed;
}

function runPairConcurrency(raw) {
  const parsed = Number(raw ?? PAIR_CONCURRENCY);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > PAIR_CONCURRENCY) {
    throw new Error(
      `MAKA_HARNESS_AB_PAIR_CONCURRENCY must be an integer between 1 and ${PAIR_CONCURRENCY}`,
    );
  }
  return parsed;
}

export function resolveHarnessAbTaskSelection(rawTaskId, rawLimit, rawPairConcurrency) {
  const pairConcurrency = runPairConcurrency(rawPairConcurrency);
  const taskId = rawTaskId?.trim();
  if (!taskId) {
    return {
      taskIds: TERMINAL_BENCH_2_1_TASK_IDS,
      limit: runLimit(rawLimit),
      pairConcurrency,
    };
  }
  if (!TERMINAL_BENCH_2_1_TASK_IDS.includes(taskId)) {
    throw new Error('MAKA_HARNESS_AB_TASK_ID must name a Terminal-Bench 2.1 task');
  }
  return { taskIds: [taskId], limit: 1, pairConcurrency: 1 };
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
  pairConcurrency = Math.min(PAIR_CONCURRENCY, taskIds.length),
  oracleEvidence,
  competitorProfile = resolveHarnessCompetitorProfile(),
}) {
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
    orderSeed: ORDER_SEED,
    pilotTaskCount: Math.min(CANARY_TASKS, taskIds.length),
    model: { provider: PROVIDER, id: MODEL, reasoningEffort: REASONING_EFFORT },
    pricing: PRICING,
    arms: [
      {
        id: 'maka',
        version: subjectFingerprint,
        config: {
          adapter: 'maka_agent:MakaAgent',
          externalSystemPrompt: 'empty',
          reasoningEffort: REASONING_EFFORT,
          continuation: false,
          attemptPolicy: 'single',
          billingMode: BILLING_MODE,
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
  );
  const selection = resolveHarnessAbTaskSelection(
    process.env.MAKA_HARNESS_AB_TASK_ID,
    process.env.MAKA_HARNESS_AB_LIMIT,
    process.env.MAKA_HARNESS_AB_PAIR_CONCURRENCY,
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
  );
  const hostToolchainFingerprint = await buildToolchainFingerprint(
    process.env.MAKA_HARNESS_AB_TOOLCHAIN_FINGERPRINT,
    undefined,
    makaRepoPath,
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
    pairConcurrency: selection.pairConcurrency,
    oracleEvidence,
    competitorProfile,
  });
  await ensureAbRunManifest(manifestPath, manifest);
  const evaluationTasks = manifest.evaluationTaskIds
    .slice(0, selection.limit)
    .map((taskId) => tasksById.get(taskId));
  if (evaluationTasks.some((task) => !task))
    throw new Error('manifest contains a task absent from the frozen task source');

  const competitorToolchain =
    competitorProfile.id === 'kimi-code'
      ? {
          path: process.env.MAKA_HARNESS_AB_KIMI_CODE_TOOLCHAIN
            ? resolve(process.env.MAKA_HARNESS_AB_KIMI_CODE_TOOLCHAIN)
            : resolveHarnessCompetitorToolchainPath(runRoot, competitorProfile),
          prepare: prepareKimiCodeToolchain,
        }
      : {
          path: process.env.MAKA_HARNESS_AB_OPENCODE_TOOLCHAIN
            ? resolve(process.env.MAKA_HARNESS_AB_OPENCODE_TOOLCHAIN)
            : resolveHarnessCompetitorToolchainPath(runRoot, competitorProfile),
          prepare: prepareOpenCodeToolchain,
        };
  await competitorToolchain.prepare(competitorToolchain.path);

  const keyFile = envPath(
    'MAKA_HARNESS_AB_KEY_FILE',
    join(homedir(), '.maka/secrets/kimi-coding-plan.key'),
  );
  if ((await readFile(keyFile, 'utf8')).trim().length === 0)
    throw new Error('MAKA_HARNESS_AB_KEY_FILE is empty');
  const controllerDir = join(runRoot, 'controller');
  const promptsDir = join(runRoot, 'prompts');
  const jobsDir = join(runRoot, 'jobs');
  await mkdir(controllerDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  const systemPromptPath = join(promptsDir, 'empty-system-prompt.txt');
  await writeFile(systemPromptPath, '', 'utf8');
  const pricing = {
    inputUsdPer1M: PRICING.input,
    cacheReadUsdPer1M: PRICING.cachedInput,
    outputUsdPer1M: PRICING.output,
    source: PRICING.source,
  };
  const runnerOptions = {
    makaRepoPath,
    jobsDir,
    model: MODEL_SPEC,
    provider: PROVIDER,
    reasoningEffort: REASONING_EFFORT,
    apiKeyFile: keyFile,
    apiKeyEnvName: 'ANTHROPIC_API_KEY',
    pricing,
    agentEnv: { MAKA_BASE_URL: BASE_URL },
    timeoutMultiplier: 1,
    dockerPlatform: 'linux/amd64',
  };
  const makaContextBudgetEnv = harnessMakaContextBudgetEnv();
  const config = (id) => ({
    id: `harness-ab-${id}`,
    backend: 'ai-sdk',
    llmConnectionSlug: PROVIDER,
    model: MODEL,
    thinkingLevel: REASONING_EFFORT,
  });
  const summary = await runHarnessAbComparisonUnlocked({
    runId,
    runRoot,
    resultsJsonlPath: join(controllerDir, 'results.jsonl'),
    systemPromptPath,
    resumeFingerprint: buildHarnessAbResumeFingerprint(manifest),
    evaluationTasks,
    arms: [
      {
        id: 'maka',
        config: config('maka'),
        expectedPricingProfile: PRICING.source,
        billingMode: BILLING_MODE,
        harborRunner: createHarborTaskRunner({
          ...runnerOptions,
          agent: 'maka',
          agentEnv: { ...runnerOptions.agentEnv, ...makaContextBudgetEnv },
        }),
      },
      {
        id: competitorProfile.id,
        config: config(competitorProfile.id),
        expectedPricingProfile: PRICING.source,
        billingMode: BILLING_MODE,
        harborRunner: createHarborTaskRunner({
          ...runnerOptions,
          agent: competitorProfile.id,
          agentVersion: competitorProfile.version,
          ...(competitorProfile.id === 'kimi-code'
            ? { kimiCodeToolchainPath: competitorToolchain.path }
            : { opencodeToolchainPath: competitorToolchain.path }),
        }),
      },
    ],
    pairConcurrency: selection.pairConcurrency,
  });
  const evaluatedTaskIds = new Set(evaluationTasks.map((task) => task.id));
  const report = buildHarnessAbReport(
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
    BILLING_MODE,
  );
  await writeFile(
    join(runRoot, 'harness-ab-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(runRoot, 'harness-ab-report.csv'), renderHarnessAbReportCsv(report), 'utf8');
  await writeFile(
    join(runRoot, 'harness-ab-report.md'),
    renderHarnessAbReportMarkdown(report),
    'utf8',
  );
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
