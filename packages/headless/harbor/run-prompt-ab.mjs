#!/usr/bin/env node
// Real A/B runner for comparing Maka's benchmark baseline prompt against a
// fixed external prompt (default target: opencode default.txt) over cached
// Terminal-Bench tasks via Harbor + DeepSeek.
//
// Usage:
//   MAKA_PROMPT_AB_OUT_DIR=/tmp/maka-ab \
//   MAKA_PROMPT_AB_CANDIDATE_PROMPT_PATH=/path/to/opencode/default.txt \
//   MAKA_PROMPT_AB_KEY_FILE=~/.local/maka-eval/secrets/deepseek-key \
//   node packages/headless/harbor/run-prompt-ab.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_BASE_SYSTEM_PROMPT } from '@maka/headless';
import {
  discoverCachedHarborTasks,
  partitionPromptTasks,
  resolvePromptOptimizationRunRoot,
} from '#prompt-optimization-run';
import {
  renderPromptAbComparisonMarkdown,
  runPromptAbComparison,
  runPromptAbConcurrencyCalibration,
} from '#prompt-ab-run';
import {
  envNonNegativeInt,
  envPositiveInt,
} from '#prompt-optimization-env';
import { createHarborTaskRunner } from '#harbor-task-runner';

const DEEPSEEK_V4_FLASH_PRICING = {
  inputUsdPer1M: 0.145,
  outputUsdPer1M: 0.29,
  cacheReadUsdPer1M: 0.0029,
  cacheWriteUsdPer1M: 0,
  source: 'deepseek-v4-flash',
};

function envPath(name, fallback) {
  const raw = process.env[name];
  const value = raw && raw.length > 0 ? raw : fallback;
  if (!value) throw new Error(`${name} is required`);
  return value.startsWith('~') ? join(homedir(), value.slice(1)) : resolve(value);
}

const envInt = (name, fallback) => envNonNegativeInt(name, process.env[name], fallback);
const envPosInt = (name, fallback) => envPositiveInt(name, process.env[name], fallback);

function envZeroToOne(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number in [0, 1]`);
  }
  return value;
}

function envIds(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function envLevels(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const levels = raw.split(',').map((s) => Number(s.trim())).filter((value) => !Number.isNaN(value));
  if (levels.length === 0) throw new Error(`${name} must contain at least one concurrency level`);
  return levels;
}

function selectTasksByIds(allTasks, ids) {
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) throw new Error(`duplicate task id(s): ${duplicates.join(', ')}`);
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(', ')}`);
  return ids.map((id) => byId.get(id));
}

async function readTaskDurationsMs(path) {
  if (!path) return {};
  const text = await readFile(path, 'utf8');
  const durations = {};
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'task_completed' || typeof event.taskId !== 'string') continue;
    if (typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs)) continue;
    durations[event.taskId] = Math.max(durations[event.taskId] ?? 0, event.durationMs);
  }
  return durations;
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_PROMPT_AB_MAKA_REPO
    ? resolve(process.env.MAKA_PROMPT_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath('MAKA_PROMPT_AB_OUT_DIR');
  const keyFile = envPath('MAKA_PROMPT_AB_KEY_FILE', join(homedir(), '.local/maka-eval/secrets/deepseek-key'));
  const tasksRoot = envPath('MAKA_PROMPT_AB_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  const candidatePromptSourcePath = envPath('MAKA_PROMPT_AB_CANDIDATE_PROMPT_PATH');
  const taskDurationsPath = process.env.MAKA_PROMPT_AB_TASK_DURATIONS_JSONL
    ? envPath('MAKA_PROMPT_AB_TASK_DURATIONS_JSONL')
    : undefined;
  const runId = process.env.MAKA_PROMPT_AB_RUN_ID || `prompt-ab-${Date.now()}`;
  const runRoot = resolvePromptOptimizationRunRoot(outDir, runId);
  const controllerDir = join(runRoot, 'controller');
  const jobsDir = join(runRoot, 'jobs');
  const promptsDir = join(runRoot, 'prompts');
  const provider = process.env.MAKA_PROMPT_AB_PROVIDER || 'deepseek';
  const baseUrl = process.env.MAKA_PROMPT_AB_BASE_URL || 'https://api.deepseek.com';
  const model = 'deepseek/deepseek-v4-flash';
  const heldInCount = envInt('MAKA_PROMPT_AB_HELD_IN', 20);
  const heldOutCount = envInt('MAKA_PROMPT_AB_HELD_OUT', 10);
  const reps = envPosInt('MAKA_PROMPT_AB_REPS', 3);
  const calibrationSamplesPerBucket = envPosInt('MAKA_PROMPT_AB_CALIBRATION_SAMPLES_PER_BUCKET', 1);
  const calibrationReps = envPosInt('MAKA_PROMPT_AB_CALIBRATION_REPS', 1);
  const calibrationLevels = envLevels('MAKA_PROMPT_AB_CALIBRATION_LEVELS', [1, 2, 4, 8, 12, 16]);
  const maxInfraFailureRate = envZeroToOne('MAKA_PROMPT_AB_MAX_INFRA_FAILURE_RATE', 0);
  const explicitMaxConcurrency = envPosInt('MAKA_PROMPT_AB_MAX_CONCURRENCY', undefined);
  const harborTimeoutMs = envPosInt('MAKA_PROMPT_AB_HARBOR_TIMEOUT_MS', undefined);
  const heldInPassRateNoiseBand = envZeroToOne('MAKA_PROMPT_AB_HELD_IN_NOISE_BAND', undefined);
  const heldOutPassRateNoiseBand = envZeroToOne('MAKA_PROMPT_AB_HELD_OUT_NOISE_BAND', undefined);

  await readFile(keyFile, 'utf8');
  const candidatePrompt = await readFile(candidatePromptSourcePath, 'utf8');
  const allTasks = await discoverCachedHarborTasks(tasksRoot);
  console.log(`Discovered ${allTasks.length} cached tasks under ${tasksRoot}`);

  const heldInIds = envIds('MAKA_PROMPT_AB_HELD_IN_IDS');
  const heldOutIds = envIds('MAKA_PROMPT_AB_HELD_OUT_IDS');
  let heldInTasks;
  let heldOutTasks;
  if (heldInIds || heldOutIds) {
    if (!heldInIds || !heldOutIds) {
      throw new Error('MAKA_PROMPT_AB_HELD_IN_IDS and MAKA_PROMPT_AB_HELD_OUT_IDS must be set together');
    }
    const overlap = heldInIds.filter((id) => heldOutIds.includes(id));
    if (overlap.length > 0) throw new Error(`held-in and held-out overlap: ${overlap.join(', ')}`);
    heldInTasks = selectTasksByIds(allTasks, heldInIds);
    heldOutTasks = selectTasksByIds(allTasks, heldOutIds);
  } else {
    ({ heldInTasks, heldOutTasks } = partitionPromptTasks(allTasks, { heldInCount, heldOutCount }));
  }

  await mkdir(controllerDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });
  const baselinePromptPath = join(promptsDir, 'maka-baseline.md');
  const candidatePromptPath = join(promptsDir, `candidate-${basename(candidatePromptSourcePath)}`);
  await writeFile(baselinePromptPath, `${BENCHMARK_BASE_SYSTEM_PROMPT}\n`, 'utf8');
  await writeFile(candidatePromptPath, candidatePrompt, 'utf8');

  const config = {
    id: 'prompt-ab',
    backend: 'harbor',
    llmConnectionSlug: provider,
    model,
  };
  const harborRunner = createHarborTaskRunner({
    makaRepoPath,
    jobsDir,
    model,
    provider,
    apiKeyFile: keyFile,
    pricing: DEEPSEEK_V4_FLASH_PRICING,
    agentEnv: { DEEPSEEK_BASE_URL: baseUrl },
    ...(harborTimeoutMs !== undefined ? { harborTimeoutMs } : {}),
  });
  const resultsJsonlPath = join(controllerDir, 'results.jsonl');
  const taskDurationsMs = await readTaskDurationsMs(taskDurationsPath);

  console.log(`Calibration: levels [${calibrationLevels.join(', ')}], samples_per_bucket ${calibrationSamplesPerBucket}, reps ${calibrationReps}`);
  const calibration = await runPromptAbConcurrencyCalibration({
    runId,
    config,
    systemPromptPath: baselinePromptPath,
    resultsJsonlPath,
    tasks: [...heldInTasks, ...heldOutTasks],
    taskDurationsMs,
    samplesPerBucket: calibrationSamplesPerBucket,
    concurrencyLevels: calibrationLevels,
    repsPerLevel: calibrationReps,
    maxInfraFailureRate,
    harborRunner,
  });
  const maxConcurrency = explicitMaxConcurrency ?? calibration.recommendedConcurrency;
  console.log(`Recommended concurrency: ${calibration.recommendedConcurrency}; using ${maxConcurrency}`);

  const summary = await runPromptAbComparison({
    runId,
    config,
    baselinePromptPath,
    candidatePromptPath,
    resultsJsonlPath,
    heldInTasks,
    heldOutTasks,
    reps,
    maxConcurrency,
    ...(heldInPassRateNoiseBand !== undefined ? { heldInPassRateNoiseBand } : {}),
    ...(heldOutPassRateNoiseBand !== undefined ? { heldOutPassRateNoiseBand } : {}),
    harborRunner,
  });

  const output = {
    schemaVersion: 'maka.prompt_ab.v1',
    runId,
    candidatePromptSourcePath,
    taskDurationsPath,
    calibration,
    summary,
  };
  const resultPath = join(runRoot, 'prompt-ab-result.json');
  const reportPath = join(runRoot, 'prompt-ab-report.md');
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await writeFile(reportPath, renderPromptAbComparisonMarkdown(summary), 'utf8');

  console.log('---');
  console.log(`decision: ${summary.acceptance.decision} (${summary.acceptance.reason})`);
  console.log(`paired overall: wins=${summary.paired.overall.wins}, losses=${summary.paired.overall.losses}, ties=${summary.paired.overall.ties}`);
  console.log(`result -> ${resultPath}`);
  console.log(`report -> ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
