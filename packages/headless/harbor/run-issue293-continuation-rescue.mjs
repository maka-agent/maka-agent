#!/usr/bin/env node
// Rerun Issue 293 tool-step-cap failures with Harbor continuation enabled.
//
// Defaults keep artifacts inside the repo-local, git-excluded maka-eval tree:
//
//   node packages/headless/harbor/run-issue293-continuation-rescue.mjs
//
// Useful overrides:
//   MAKA_RUNTIME_POLICY_AB_EVALUATION_IDS=task-a,task-b
//   MAKA_RUNTIME_POLICY_AB_MAX_CONCURRENCY=16
//   MAKA_RUNTIME_POLICY_AB_RUN_ID=issue293-continuation-rescue-001
//   MAKA_RUNTIME_POLICY_AB_DRY_RUN=1

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BENCHMARK_BASE_SYSTEM_PROMPT } from '@maka/headless';
import {
  discoverCachedHarborTasks,
  resolveFixedPromptRunRoot,
} from '#fixed-prompt-task-source';
import {
  buildRuntimePolicyAbRunManifest,
  renderRuntimePolicyAbComparisonMarkdown,
  runRuntimePolicyAbComparison,
} from '#runtime-policy-ab-run';
import {
  envPositiveInt,
  envRatio,
} from '#headless-run-env';
import { createHarborTaskRunner } from '#harbor-task-runner';
import {
  buildSubjectFingerprint,
  buildTaskSourceFingerprint,
  buildToolchainFingerprint,
} from './run-prompt-ab.mjs';

const DEEPSEEK_V4_FLASH_PRICING = {
  inputUsdPer1M: 0.145,
  outputUsdPer1M: 0.29,
  cacheReadUsdPer1M: 0.0029,
  cacheWriteUsdPer1M: 0,
  source: 'deepseek-v4-flash',
};

const execFile = promisify(execFileCallback);
const STEP_CAP_ERROR_CLASSES = new Set(['incomplete_tool_calls', 'tool_step_cap_reached']);

function envPath(name, fallback) {
  const raw = process.env[name];
  const value = raw && raw.length > 0 ? raw : fallback;
  if (!value) throw new Error(`${name} is required`);
  return value.startsWith('~') ? join(homedir(), value.slice(1)) : resolve(value);
}

const envPosInt = (name, fallback) => envPositiveInt(name, process.env[name], fallback);
const envRatioValue = (name, fallback) => envRatio(name, process.env[name], fallback);

function envIds(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function envBoolean(name) {
  const raw = process.env[name];
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function hashSystemPrompt(systemPrompt) {
  return `sha256:${createHash('sha256').update(systemPrompt).digest('hex')}`;
}

function selectTasksByIds(allTasks, ids) {
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) throw new Error(`duplicate task id(s): ${duplicates.join(', ')}`);
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(', ')}`);
  return ids.map((id) => byId.get(id));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonl(path) {
  const raw = await readFile(path, 'utf8');
  return raw.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function readPriorRunRows(runRoot, runId) {
  const candidates = [
    join(runRoot, runId, 'controller', 'results.jsonl'),
    join(runRoot, runId, 'runtime-policy-ab-results.jsonl'),
  ];
  const errors = [];
  for (const path of candidates) {
    try {
      return await readJsonl(path);
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join('\n'));
}

async function discoverStepCapTaskIds(summaryPath, runRoot) {
  const summary = await readJson(summaryPath);
  const runIds = Object.values(summary.buckets ?? {})
    .map((bucket) => bucket?.runId)
    .filter((runId) => typeof runId === 'string' && runId.length > 0);
  const taskIds = new Set();
  for (const runId of runIds) {
    let rows;
    try {
      rows = await readPriorRunRows(runRoot, runId);
    } catch (error) {
      throw new Error(`failed to read prior result rows for ${runId}:\n${error instanceof Error ? error.message : String(error)}`);
    }
    for (const row of rows) {
      if (row?.type === 'task_completed' && STEP_CAP_ERROR_CLASSES.has(row.errorClass)) {
        taskIds.add(row.taskId);
      }
    }
  }
  return [...taskIds].sort((a, b) => a.localeCompare(b));
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_RUNTIME_POLICY_AB_MAKA_REPO
    ? resolve(process.env.MAKA_RUNTIME_POLICY_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath(
    'MAKA_RUNTIME_POLICY_AB_OUT_DIR',
    join(repoRoot, 'maka-eval', 'runs', 'issue293-prune-ab'),
  );
  const runId = process.env.MAKA_RUNTIME_POLICY_AB_RUN_ID || `issue293-continuation-rescue-${Date.now()}`;
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_RUNTIME_POLICY_AB_RUN_ID');
  const controllerDir = join(runRoot, 'controller');
  const jobsDir = join(runRoot, 'jobs');
  const promptsDir = join(runRoot, 'prompts');
  const keyFile = envPath(
    'MAKA_RUNTIME_POLICY_AB_KEY_FILE',
    join(repoRoot, 'maka-eval', 'secrets', 'deepseek-key'),
  );
  const tasksRoot = envPath('MAKA_RUNTIME_POLICY_AB_TASKS_ROOT', join(homedir(), '.cache', 'harbor', 'tasks'));
  const priorSummaryPath = envPath(
    'MAKA_RUNTIME_POLICY_AB_PRIOR_SUMMARY',
    join(outDir, 'issue293-active-prune-bucket-summary-final.json'),
  );
  const provider = 'deepseek';
  const baseUrl = process.env.MAKA_RUNTIME_POLICY_AB_BASE_URL || 'https://api.deepseek.com';
  const model = 'deepseek/deepseek-v4-flash';
  const reps = envPosInt('MAKA_RUNTIME_POLICY_AB_REPS', 1);
  const maxConcurrency = envPosInt('MAKA_RUNTIME_POLICY_AB_MAX_CONCURRENCY', 16);
  const taskBudgetSec = envPosInt('MAKA_RUNTIME_POLICY_AB_TASK_BUDGET_SEC', 30 * 60);
  const harborTimeoutMs = envPosInt('MAKA_RUNTIME_POLICY_AB_HARBOR_TIMEOUT_MS', (taskBudgetSec + 300) * 1000);
  const nonInferiorityMargin = envRatioValue('MAKA_RUNTIME_POLICY_AB_NON_INFERIORITY_MARGIN', 0.10);
  const subjectFingerprintOverride = process.env.MAKA_RUNTIME_POLICY_AB_EXPLICIT_SUBJECT_FINGERPRINT;
  const dryRun = envBoolean('MAKA_RUNTIME_POLICY_AB_DRY_RUN');

  await readFile(keyFile, 'utf8');
  const allTasks = await discoverCachedHarborTasks(tasksRoot);
  console.log(`Discovered ${allTasks.length} cached tasks under ${tasksRoot}`);

  const explicitIds = envIds('MAKA_RUNTIME_POLICY_AB_EVALUATION_IDS');
  const evaluationIds = explicitIds ?? await discoverStepCapTaskIds(priorSummaryPath, outDir);
  if (evaluationIds.length === 0) throw new Error('no tool-step-cap tasks found for continuation rescue');
  const evaluationTasks = selectTasksByIds(allTasks, evaluationIds);
  console.log(`Continuation rescue tasks: ${evaluationTasks.length}`);

  const systemPrompt = `${BENCHMARK_BASE_SYSTEM_PROMPT}\n`;
  const sharedAgentEnv = {
    MAKA_HARBOR_CONTINUATION: 'on',
    MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
  };
  const arms = [
    { id: 'context-budget-off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
    {
      id: 'active-prune-2048',
      contextEnv: {
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2048',
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '1',
        MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
        MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: 'history_search_gated',
      },
    },
  ];
  const runManifest = buildRuntimePolicyAbRunManifest({
    arms,
    sharedAgentEnv,
    promptHash: hashSystemPrompt(systemPrompt),
    provider,
    baseUrl,
    model,
    taskBudgetSec,
    harborTimeoutMs,
    subjectFingerprint: await buildSubjectFingerprint(makaRepoPath, subjectFingerprintOverride),
    taskSourceFingerprint: await buildTaskSourceFingerprint(tasksRoot, evaluationTasks),
    toolchainFingerprint: await buildToolchainFingerprint(process.env.MAKA_RUNTIME_POLICY_AB_TOOLCHAIN_FINGERPRINT, toolOutput, makaRepoPath),
    evaluationTaskIds: evaluationTasks.map((task) => task.id),
    reps,
    candidateLimit: null,
    maxConcurrency,
    selectionMode: explicitIds ? 'explicit' : 'metadata',
    targetEvaluationTaskCount: evaluationTasks.length,
    nonInferiorityMargin,
  });

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      runId,
      runRoot,
      outDir,
      priorSummaryPath,
      tasks: evaluationTasks.length,
      evaluationTaskIds: evaluationTasks.map((task) => task.id),
      maxConcurrency,
      taskBudgetSec,
      harborTimeoutMs,
      sharedAgentEnv,
      arms,
      manifestFingerprint: runManifest.fingerprint,
    }, null, 2));
    return;
  }

  await mkdir(controllerDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });
  const systemPromptPath = join(promptsDir, 'maka-baseline.md');
  await writeFile(systemPromptPath, systemPrompt, 'utf8');
  await writeFile(join(runRoot, 'runtime-policy-ab-manifest.json'), `${JSON.stringify(runManifest, null, 2)}\n`, 'utf8');
  await writeFile(join(runRoot, 'selected-task-ids.txt'), `${evaluationTasks.map((task) => task.id).join('\n')}\n`, 'utf8');

  const config = {
    id: 'issue293-continuation-rescue',
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

  const summary = await runRuntimePolicyAbComparison({
    runId,
    config,
    systemPromptPath,
    resultsJsonlPath: join(controllerDir, 'results.jsonl'),
    evaluationTasks,
    arms,
    sharedAgentEnv,
    reps,
    maxConcurrency,
    resumeFingerprint: runManifest.fingerprint,
    budgetMs: taskBudgetSec * 1000,
    nonInferiorityMargin,
    harborRunner,
  });

  await writeFile(join(runRoot, 'runtime-policy-ab-result.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(join(runRoot, 'runtime-policy-ab-report.md'), renderRuntimePolicyAbComparisonMarkdown(summary), 'utf8');
  console.log(JSON.stringify({
    runId,
    runRoot,
    tasks: evaluationTasks.length,
    baselineArmId: summary.baselineArmId,
    candidateArmId: summary.candidateArmId,
    baselinePassed: summary.baseline.passed,
    candidatePassed: summary.candidate.passed,
  }, null, 2));
}

async function toolOutput(command, args) {
  const { stdout, stderr } = await execFile(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return `${stdout}${stderr}`.trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
