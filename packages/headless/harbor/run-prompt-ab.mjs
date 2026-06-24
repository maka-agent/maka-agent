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
  resolvePromptOptimizationRunRoot,
} from '#prompt-optimization-run';
import {
  filterPromptAbCandidateTasksByMetadata,
  renderPromptAbComparisonMarkdown,
  runPromptAbComparison,
  runPromptAbConcurrencyCalibration,
  runPromptAbTaskQualification,
} from '#prompt-ab-run';
import {
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

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

function envIds(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function promptIdFromPath(path) {
  return basename(path).replace(/\.[^.]+$/, '');
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
  const candidatePromptId = process.env.MAKA_PROMPT_AB_CANDIDATE_ID || promptIdFromPath(candidatePromptSourcePath);
  const runRoot = resolvePromptOptimizationRunRoot(outDir, runId);
  const controllerDir = join(runRoot, 'controller');
  const jobsDir = join(runRoot, 'jobs');
  const promptsDir = join(runRoot, 'prompts');
  const provider = process.env.MAKA_PROMPT_AB_PROVIDER || 'deepseek';
  const baseUrl = process.env.MAKA_PROMPT_AB_BASE_URL || 'https://api.deepseek.com';
  const model = 'deepseek/deepseek-v4-flash';
  const candidateLimit = envPosInt('MAKA_PROMPT_AB_CANDIDATE_LIMIT', 60);
  const maxExpertTimeEstimateMin = envPosInt('MAKA_PROMPT_AB_MAX_EXPERT_MIN', 30);
  const targetEvaluationTaskCount = envPosInt('MAKA_PROMPT_AB_EVALUATION_TASKS', undefined);
  const useQualification = envBool('MAKA_PROMPT_AB_USE_QUALIFICATION', false);
  const qualificationReps = envPosInt('MAKA_PROMPT_AB_QUALIFICATION_REPS', 3);
  const reps = envPosInt('MAKA_PROMPT_AB_REPS', 3);
  const calibrationSamplesPerBucket = envPosInt('MAKA_PROMPT_AB_CALIBRATION_SAMPLES_PER_BUCKET', 1);
  const calibrationReps = envPosInt('MAKA_PROMPT_AB_CALIBRATION_REPS', 1);
  const calibrationLevels = envLevels('MAKA_PROMPT_AB_CALIBRATION_LEVELS', [1, 2, 4, 8]);
  const maxInfraFailureRate = envZeroToOne('MAKA_PROMPT_AB_MAX_INFRA_FAILURE_RATE', 0);
  const explicitMaxConcurrency = envPosInt('MAKA_PROMPT_AB_MAX_CONCURRENCY', undefined);
  const taskBudgetSec = envPosInt('MAKA_PROMPT_AB_TASK_BUDGET_SEC', 30 * 60);
  const harborTimeoutMs = envPosInt('MAKA_PROMPT_AB_HARBOR_TIMEOUT_MS', (taskBudgetSec + 300) * 1000);

  await readFile(keyFile, 'utf8');
  const candidatePrompt = await readFile(candidatePromptSourcePath, 'utf8');
  const allTasks = await discoverCachedHarborTasks(tasksRoot);
  console.log(`Discovered ${allTasks.length} cached tasks under ${tasksRoot}`);

  const evaluationIds = envIds('MAKA_PROMPT_AB_EVALUATION_IDS');
  const candidateIds = envIds('MAKA_PROMPT_AB_CANDIDATE_IDS');
  const discoveredCandidateTasks = candidateIds
    ? selectTasksByIds(allTasks, candidateIds)
    : allTasks;
  let metadataFilter = null;
  let candidateTasks = discoveredCandidateTasks.slice(0, candidateLimit);
  if (!evaluationIds) {
    metadataFilter = filterPromptAbCandidateTasksByMetadata({
      tasks: discoveredCandidateTasks,
      maxExpertTimeEstimateMin,
    });
    candidateTasks = metadataFilter.selectedTasks.slice(0, candidateLimit);
  }
  if (!evaluationIds && candidateTasks.length === 0) {
    throw new Error('no candidate tasks available for prompt A/B');
  }

  let evaluationTasks;
  let qualification = null;
  if (evaluationIds) {
    evaluationTasks = selectTasksByIds(allTasks, evaluationIds);
  } else {
    evaluationTasks = [];
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
    agentEnv: { DEEPSEEK_BASE_URL: baseUrl, MAKA_CELL_TIMEOUT_SEC: String(taskBudgetSec) },
    ...(harborTimeoutMs !== undefined ? { harborTimeoutMs } : {}),
  });
  const resultsJsonlPath = join(controllerDir, 'results.jsonl');
  const taskDurationsMs = await readTaskDurationsMs(taskDurationsPath);

  let calibration = null;
  let maxConcurrency;
  if (explicitMaxConcurrency !== undefined) {
    maxConcurrency = explicitMaxConcurrency;
    console.log(`Skipping calibration because MAKA_PROMPT_AB_MAX_CONCURRENCY=${explicitMaxConcurrency} is set`);
  } else {
    console.log(`Calibration: levels [${calibrationLevels.join(', ')}], samples_per_bucket ${calibrationSamplesPerBucket}, reps ${calibrationReps}`);
    calibration = await runPromptAbConcurrencyCalibration({
      runId,
      config,
      systemPromptPath: baselinePromptPath,
      resultsJsonlPath,
      tasks: evaluationTasks.length > 0 ? evaluationTasks : candidateTasks,
      taskDurationsMs,
      samplesPerBucket: calibrationSamplesPerBucket,
      concurrencyLevels: calibrationLevels,
      repsPerLevel: calibrationReps,
      maxInfraFailureRate,
      harborRunner,
    });
    maxConcurrency = calibration.recommendedConcurrency;
    console.log(`Recommended concurrency: ${calibration.recommendedConcurrency}; using ${maxConcurrency}`);
  }

  if (!evaluationIds && useQualification) {
    const qualificationTargetTaskCount = targetEvaluationTaskCount ?? 30;
    console.log(`Qualification: ${candidateTasks.length} candidate tasks, target ${qualificationTargetTaskCount}, reps ${qualificationReps}`);
    qualification = await runPromptAbTaskQualification({
      runId,
      config,
      baselinePromptPath,
      resultsJsonlPath,
      candidateTasks,
      reps: qualificationReps,
      targetTaskCount: qualificationTargetTaskCount,
      maxConcurrency,
      harborRunner,
    });
    evaluationTasks = qualification.selectedTasks;
    console.log(`Qualified evaluation tasks: ${evaluationTasks.length}/${qualificationTargetTaskCount}`);
    if (qualification.shortage > 0) {
      console.log(`Qualification shortage: ${qualification.shortage}; not filling with easy tasks`);
    }
  } else if (!evaluationIds) {
    evaluationTasks = targetEvaluationTaskCount !== undefined
      ? candidateTasks.slice(0, targetEvaluationTaskCount)
      : candidateTasks;
    console.log(`Direct evaluation tasks: ${evaluationTasks.length}/${candidateTasks.length} metadata-filtered candidates`);
  }

  if (evaluationTasks.length === 0) {
    throw new Error('no evaluation tasks available for prompt A/B');
  }

  const summary = await runPromptAbComparison({
    runId,
    config,
    baselinePromptPath,
    candidatePromptPath,
    candidatePromptId,
    resultsJsonlPath,
    evaluationTasks,
    reps,
    maxConcurrency,
    budgetMs: taskBudgetSec * 1000,
    harborRunner,
  });

  const output = {
    schemaVersion: 'maka.prompt_ab.v1',
    runId,
    candidatePromptSourcePath,
    taskDurationsPath,
    taskBudgetSec,
    harborTimeoutMs,
    useQualification,
    targetEvaluationTaskCount: targetEvaluationTaskCount ?? null,
    metadataFilter,
    calibration,
    qualification,
    summary,
  };
  const resultPath = join(runRoot, 'prompt-ab-result.json');
  const reportPath = join(runRoot, 'prompt-ab-report.md');
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await writeFile(reportPath, `${renderMetadataFilterMarkdown(metadataFilter)}${renderQualificationMarkdown(qualification)}${renderPromptAbComparisonMarkdown(summary)}`, 'utf8');

  console.log('---');
  console.log(`decision: ${summary.decision} (${summary.reason})`);
  console.log(`task-level: wins=${summary.taskLevel.wins}, losses=${summary.taskLevel.losses}, ties=${summary.taskLevel.ties}`);
  console.log(`result -> ${resultPath}`);
  console.log(`report -> ${reportPath}`);
}

function renderMetadataFilterMarkdown(metadataFilter) {
  if (!metadataFilter) {
    return [
      '# Prompt A/B Metadata Filter',
      '',
      '- Mode: explicit evaluation task IDs; metadata prefilter skipped',
      '',
    ].join('\n');
  }
  return [
    '# Prompt A/B Metadata Filter',
    '',
    `- Candidate tasks before metadata filter: ${metadataFilter.candidateTaskCount}`,
    `- Max expert estimate: ${metadataFilter.maxExpertTimeEstimateMin} minutes`,
    `- Candidate tasks after metadata filter: ${metadataFilter.selectedTaskIds.length}`,
    `- Rejected long expert estimate: ${metadataFilter.rejected.longExpertEstimateTaskIds.length}`,
    `- Rejected missing expert estimate: ${metadataFilter.rejected.missingExpertEstimateTaskIds.length}`,
    '',
  ].join('\n');
}

function renderQualificationMarkdown(qualification) {
  if (!qualification) {
    return [
      '# Prompt A/B Qualification',
      '',
      '- Mode: skipped; using explicit IDs or direct metadata-filtered evaluation tasks',
      '',
    ].join('\n');
  }
  return [
    '# Prompt A/B Qualification',
    '',
    `- Candidate tasks: ${qualification.candidateTaskCount}`,
    `- Qualification reps: ${qualification.reps}`,
    `- Target evaluation tasks: ${qualification.targetTaskCount}`,
    `- Selected evaluation tasks: ${qualification.selectedTaskIds.length}`,
    `- Shortage: ${qualification.shortage}`,
    `- Rejected easy A=3/${qualification.reps}: ${qualification.rejected.easyTaskIds.length}`,
    `- Rejected hard A=0/${qualification.reps}: ${qualification.rejected.hardTaskIds.length}`,
    `- Rejected infra/plumbing/timeout/missing: ${qualification.rejected.infraOrInvalidTaskIds.length}`,
    `- Overflow medium tasks: ${qualification.rejected.overflowTaskIds.length}`,
    '',
    '## Selected Tasks',
    '',
    ...qualification.selectedTaskIds.map((taskId) => `- ${taskId}`),
    '',
  ].join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
