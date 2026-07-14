#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAbRunManifest } from '#ab-manifest';
import {
  discoverCachedHarborTasks,
  fingerprintFixedPromptTaskTree,
  resolveFixedPromptRunRoot,
} from '#fixed-prompt-task-source';
import { createHarborTaskRunner } from '#harbor-task-runner';
import {
  assertTerminalBench21TaskSet,
  assertTerminalBench21TaskTreeFingerprint,
  buildHarnessAbRunManifest,
  HARNESS_MAKA_CONTEXT_BUDGET,
  TERMINAL_BENCH_2_1_REVISION,
  TERMINAL_BENCH_2_1_TASK_IDS,
} from '#harness-ab-manifest';
import {
  runHarnessAbComparisonUnlocked,
  withHarnessAbRunLock,
} from '#harness-ab-run';
import {
  assertHarnessAbReportCompleted,
  buildHarnessAbReport,
  renderHarnessAbReportCsv,
  renderHarnessAbReportMarkdown,
} from '#harness-ab-report';
import {
  buildSubjectFingerprint,
  buildToolchainFingerprint,
} from './run-prompt-ab.mjs';

const EXPECTED_TASKS = TERMINAL_BENCH_2_1_TASK_IDS.length;
export const DEFAULT_HARNESS_AB_RUN_ID = 'glm-5.2-maka-vs-opencode-tbench-2.1';
const CANARY_TASKS = 2;
const PILOT_TASKS = 30;
const PROVIDER = 'zai-coding-plan';
const MODEL = 'glm-5.2';
const MODEL_SPEC = `${PROVIDER}/${MODEL}`;
const REASONING_EFFORT = 'max';
const OPENCODE_VERSION = '1.17.18';
const BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const ORDER_SEED = 'terminal-bench-2.1:glm-5.2:maka-vs-opencode:v1';
const PRICING = {
  currency: 'USD',
  unit: 'per_1m_tokens',
  input: 1.4,
  cachedInput: 0.26,
  output: 4.4,
  source: 'z.ai-public-2026-07-13',
};
const HARBOR_SETUP_TEARDOWN_GRACE_SEC = 15 * 60;
const BACKGROUND_RUN_ENV = 'MAKA_HARNESS_AB_BACKGROUND_RUN';
const BACKGROUND_STARTED_AT_ENV = 'MAKA_HARNESS_AB_DETACHED_STARTED_AT';
const BACKGROUND_JOURNAL_FILENAME = 'background-run.json';
const BACKGROUND_LOG_FILENAME = 'background-run.log';

function envPath(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`${name} is required`);
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw);
}

function runLimit(raw) {
  const parsed = Number(raw ?? PILOT_TASKS);
  if (parsed !== CANARY_TASKS && parsed !== PILOT_TASKS && parsed !== EXPECTED_TASKS) {
    throw new Error(`MAKA_HARNESS_AB_LIMIT must be ${CANARY_TASKS}, ${PILOT_TASKS}, or ${EXPECTED_TASKS}`);
  }
  return parsed;
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

export async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_HARNESS_AB_MAKA_REPO
    ? resolve(process.env.MAKA_HARNESS_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath('MAKA_HARNESS_AB_OUT_DIR');
  const tasksRoot = envPath('MAKA_HARNESS_AB_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  const runId = process.env.MAKA_HARNESS_AB_RUN_ID || DEFAULT_HARNESS_AB_RUN_ID;
  const limit = runLimit(process.env.MAKA_HARNESS_AB_LIMIT);
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_HARNESS_AB_RUN_ID');
  await withHarnessAbRunLock(runRoot, async () => {
    const journal = backgroundJournal(runRoot);
    if (journal) await writeBackgroundJournal(journal.path, { ...journal.base, status: 'running' });
    let exitCode = 0;
    try {
      await runLocked({ repoRoot, makaRepoPath, tasksRoot, runId, limit, runRoot });
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

async function runLocked({ repoRoot, makaRepoPath, tasksRoot, runId, limit, runRoot }) {
  const allTasks = await discoverCachedHarborTasks(tasksRoot);
  assertTerminalBench21TaskSet(allTasks.map((task) => task.id));
  const taskSourceFingerprint = await fingerprintFixedPromptTaskTree(allTasks);
  assertTerminalBench21TaskTreeFingerprint(taskSourceFingerprint);

  const subjectFingerprint = await buildSubjectFingerprint(
    makaRepoPath,
    process.env.MAKA_HARNESS_AB_EXPLICIT_SUBJECT_FINGERPRINT,
  );
  const toolchainFingerprint = await buildToolchainFingerprint(
    process.env.MAKA_HARNESS_AB_TOOLCHAIN_FINGERPRINT,
    undefined,
    makaRepoPath,
  );
  const manifest = buildHarnessAbRunManifest({
    benchmark: {
      dataset: 'terminal-bench',
      version: '2.1',
      revision: TERMINAL_BENCH_2_1_REVISION,
      timeoutPolicy: 'task-native',
      timeoutMultiplier: 1,
      outerTimeoutGraceSec: HARBOR_SETUP_TEARDOWN_GRACE_SEC,
    },
    taskIds: TERMINAL_BENCH_2_1_TASK_IDS,
    orderSeed: ORDER_SEED,
    pilotTaskCount: PILOT_TASKS,
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
          contextBudget: HARNESS_MAKA_CONTEXT_BUDGET,
        },
      },
      {
        id: 'opencode',
        version: OPENCODE_VERSION,
        config: {
          adapter: 'opencode_agent:MakaOpenCodeAgent',
          externalSystemPrompt: 'empty',
          variant: REASONING_EFFORT,
          pure: true,
          permissions: 'auto',
          attemptPolicy: 'single',
        },
      },
    ],
    taskBudgetSec: null,
    harborTimeoutMs: null,
    subjectFingerprint,
    taskSourceFingerprint,
    toolchainFingerprint,
  });
  const manifestPath = join(runRoot, 'harness-ab-manifest.json');
  await ensureAbRunManifest(manifestPath, manifest);
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const evaluationTasks = manifest.evaluationTaskIds.slice(0, limit).map((taskId) => tasksById.get(taskId));
  if (evaluationTasks.some((task) => !task)) throw new Error('manifest contains a task absent from the frozen task source');

  if (process.env.MAKA_HARNESS_AB_DRY_RUN === '1') {
    console.log(`dry-run: ${limit}/${EXPECTED_TASKS} paired Pass@1 cells planned -> ${manifestPath}`);
    return;
  }

  const keyFile = envPath('MAKA_HARNESS_AB_KEY_FILE', join(repoRoot, '.local-secrets/zai-key'));
  if ((await readFile(keyFile, 'utf8')).trim().length === 0) throw new Error('MAKA_HARNESS_AB_KEY_FILE is empty');
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
    apiKeyEnvName: 'ZAI_API_KEY',
    pricing,
    agentEnv: { ZAI_BASE_URL: BASE_URL },
    timeoutMultiplier: 1,
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
    resumeFingerprint: manifest.fingerprint,
    evaluationTasks,
    arms: [
      {
        id: 'maka',
        config: config('maka'),
        expectedPricingProfile: PRICING.source,
        harborRunner: createHarborTaskRunner({
          ...runnerOptions,
          agent: 'maka',
          agentEnv: { ...runnerOptions.agentEnv, ...makaContextBudgetEnv },
        }),
      },
      {
        id: 'opencode',
        config: config('opencode'),
        expectedPricingProfile: PRICING.source,
        harborRunner: createHarborTaskRunner({
          ...runnerOptions,
          agent: 'opencode',
          agentVersion: OPENCODE_VERSION,
        }),
      },
    ],
  });
  const report = buildHarnessAbReport(summary);
  await writeFile(join(runRoot, 'harness-ab-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(runRoot, 'harness-ab-report.csv'), renderHarnessAbReportCsv(report), 'utf8');
  await writeFile(join(runRoot, 'harness-ab-report.md'), renderHarnessAbReportMarkdown(report), 'utf8');
  assertHarnessAbReportCompleted(report);
  console.log(`completed: ${report.effectiveness.pairedEvaluated}/${report.completeness.expectedPerArm} paired Pass@1 cells -> ${runRoot}`);
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
  await writeFile(pendingPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(pendingPath, path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
