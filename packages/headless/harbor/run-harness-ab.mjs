#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  TERMINAL_BENCH_2_1_REVISION,
  TERMINAL_BENCH_2_1_TASK_IDS,
} from '#harness-ab-manifest';
import { runHarnessAbComparison } from '#harness-ab-run';
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
const PILOT_TASKS = 40;
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

function envPath(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`${name} is required`);
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw);
}

function runLimit(raw) {
  const parsed = Number(raw ?? PILOT_TASKS);
  if (parsed !== PILOT_TASKS && parsed !== EXPECTED_TASKS) {
    throw new Error(`MAKA_HARNESS_AB_LIMIT must be ${PILOT_TASKS} or ${EXPECTED_TASKS}`);
  }
  return parsed;
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_HARNESS_AB_MAKA_REPO
    ? resolve(process.env.MAKA_HARNESS_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath('MAKA_HARNESS_AB_OUT_DIR');
  const tasksRoot = envPath('MAKA_HARNESS_AB_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  const runId = process.env.MAKA_HARNESS_AB_RUN_ID || 'glm-5.2-maka-vs-opencode-tbench-2.1';
  const limit = runLimit(process.env.MAKA_HARNESS_AB_LIMIT);
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_HARNESS_AB_RUN_ID');
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
  const config = (id) => ({
    id: `harness-ab-${id}`,
    backend: 'ai-sdk',
    llmConnectionSlug: PROVIDER,
    model: MODEL,
    thinkingLevel: REASONING_EFFORT,
  });
  const summary = await runHarnessAbComparison({
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
        harborRunner: createHarborTaskRunner({ ...runnerOptions, agent: 'maka' }),
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
