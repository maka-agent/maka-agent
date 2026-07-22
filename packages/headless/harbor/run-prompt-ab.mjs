#!/usr/bin/env node
// Real A/B runner for comparing Maka's benchmark baseline prompt against a
// fixed candidate prompt over cached Terminal-Bench tasks via Harbor + DeepSeek.
//
// Usage:
//   MAKA_PROMPT_AB_OUT_DIR=/tmp/maka-ab \
//   MAKA_PROMPT_AB_CANDIDATE_PROMPT_PATH=/path/to/candidate-prompt.txt \
//   MAKA_PROMPT_AB_KEY_FILE=~/.local/maka-eval/secrets/deepseek-key \
//   node packages/headless/harbor/run-prompt-ab.mjs

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HEADLESS_SYSTEM_PROMPT } from '@maka/headless';
import { runExperiment } from '#experiment-engine';
import {
  discoverCachedHarborTasks,
  resolveFixedPromptRunRoot,
  selectTasksByIds,
} from '#fixed-prompt-task-source';
import {
  buildPromptAbRunManifest,
  ensurePromptAbRunManifest,
  filterPromptAbCandidateTasksByMetadata,
  limitPromptAbCandidateTasks,
  renderPromptAbComparisonMarkdown,
  runPromptAbComparison,
} from '#prompt-ab-run';
import {
  envIds as parseEnvIds,
  envPath as parseEnvPath,
  envPositiveInt,
  envRatio,
} from '#headless-run-env';
import { createHarborTaskRunner } from '#harbor-task-runner';
import {
  buildSubjectFingerprint,
  buildTaskSourceFingerprint,
  buildToolchainFingerprint,
} from '#experiment-fingerprint';
import { DEEPSEEK_V4_FLASH_PRICING } from '#deepseek-pricing';

const envPath = (name, fallback) => parseEnvPath(name, process.env[name], fallback);
const envPosInt = (name, fallback) => envPositiveInt(name, process.env[name], fallback);
const envRatioValue = (name, fallback) => envRatio(name, process.env[name], fallback);
const envIds = (name) => parseEnvIds(process.env[name]);

function rejectUnsupportedProviderEnv(env) {
  const raw = env.MAKA_PROMPT_AB_PROVIDER;
  if (raw && raw.length > 0 && raw !== 'deepseek') {
    throw new Error(
      'MAKA_PROMPT_AB_PROVIDER is not supported by this DeepSeek-only prompt A/B runner; use MAKA_PROMPT_AB_BASE_URL only for DeepSeek endpoint overrides.',
    );
  }
}

function promptIdFromPath(path) {
  return basename(path).replace(/\.[^.]+$/, '');
}

function hashSystemPrompt(systemPrompt) {
  return `sha256:${createHash('sha256').update(systemPrompt).digest('hex')}`;
}

async function main() {
  rejectUnsupportedProviderEnv(process.env);
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_PROMPT_AB_MAKA_REPO
    ? resolve(process.env.MAKA_PROMPT_AB_MAKA_REPO)
    : repoRoot;
  const outDir = envPath('MAKA_PROMPT_AB_OUT_DIR');
  const keyFile = envPath(
    'MAKA_PROMPT_AB_KEY_FILE',
    join(homedir(), '.local/maka-eval/secrets/deepseek-key'),
  );
  const tasksRoot = envPath('MAKA_PROMPT_AB_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  const candidatePromptSourcePath = envPath('MAKA_PROMPT_AB_CANDIDATE_PROMPT_PATH');
  const subjectFingerprintOverride = process.env.MAKA_PROMPT_AB_EXPLICIT_SUBJECT_FINGERPRINT;
  const runId = process.env.MAKA_PROMPT_AB_RUN_ID || `prompt-ab-${Date.now()}`;
  const candidatePromptId =
    process.env.MAKA_PROMPT_AB_CANDIDATE_ID || promptIdFromPath(candidatePromptSourcePath);
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_PROMPT_AB_RUN_ID');
  const promptsDir = join(runRoot, 'prompts');
  const baselinePromptPath = join(promptsDir, 'maka-baseline.md');
  const candidatePromptPath = join(promptsDir, `candidate-${basename(candidatePromptSourcePath)}`);
  const provider = 'deepseek';
  const baseUrl = process.env.MAKA_PROMPT_AB_BASE_URL || 'https://api.deepseek.com';
  const model = 'deepseek/deepseek-v4-flash';
  const candidateLimit = envPosInt('MAKA_PROMPT_AB_CANDIDATE_LIMIT', undefined);
  const maxExpertTimeEstimateMin = envPosInt('MAKA_PROMPT_AB_MAX_EXPERT_MIN', 30);
  const targetEvaluationTaskCount = envPosInt('MAKA_PROMPT_AB_EVALUATION_TASKS', undefined);
  const reps = envPosInt('MAKA_PROMPT_AB_REPS', 3);
  const maxConcurrency = envPosInt('MAKA_PROMPT_AB_MAX_CONCURRENCY', 4);
  const taskBudgetSec = envPosInt('MAKA_PROMPT_AB_TASK_BUDGET_SEC', 30 * 60);
  const harborTimeoutMs = envPosInt(
    'MAKA_PROMPT_AB_HARBOR_TIMEOUT_MS',
    (taskBudgetSec + 300) * 1000,
  );
  const nonInferiorityMargin = envRatioValue('MAKA_PROMPT_AB_NON_INFERIORITY_MARGIN', 0.1);

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
  let candidateTaskLimit = null;
  let candidateTasks = discoveredCandidateTasks;
  if (!evaluationIds) {
    metadataFilter = filterPromptAbCandidateTasksByMetadata({
      tasks: discoveredCandidateTasks,
      maxExpertTimeEstimateMin,
    });
    candidateTaskLimit = limitPromptAbCandidateTasks(metadataFilter.selectedTasks, candidateLimit);
    candidateTasks = candidateTaskLimit.selectedTasks;
  }
  if (!evaluationIds && candidateTasks.length === 0) {
    throw new Error('no candidate tasks available for prompt A/B');
  }

  let evaluationTasks;
  if (evaluationIds) {
    evaluationTasks = selectTasksByIds(allTasks, evaluationIds);
  } else {
    evaluationTasks =
      targetEvaluationTaskCount !== undefined
        ? candidateTasks.slice(0, targetEvaluationTaskCount)
        : candidateTasks;
    console.log(
      `Direct evaluation tasks: ${evaluationTasks.length}/${candidateTasks.length} metadata-filtered candidates`,
    );
  }

  if (evaluationTasks.length === 0) {
    throw new Error('no evaluation tasks available for prompt A/B');
  }

  const baselinePrompt = DEFAULT_HEADLESS_SYSTEM_PROMPT;
  const runManifest = buildPromptAbRunManifest({
    baselinePromptHash: hashSystemPrompt(baselinePrompt),
    candidatePromptHash: hashSystemPrompt(candidatePrompt),
    provider,
    baseUrl,
    model,
    taskBudgetSec,
    harborTimeoutMs,
    subjectFingerprint: await buildSubjectFingerprint(makaRepoPath, subjectFingerprintOverride),
    taskSourceFingerprint: await buildTaskSourceFingerprint(tasksRoot, evaluationTasks),
    toolchainFingerprint: await buildToolchainFingerprint(
      process.env.MAKA_PROMPT_AB_TOOLCHAIN_FINGERPRINT,
      undefined,
      makaRepoPath,
    ),
    evaluationTaskIds: evaluationTasks.map((task) => task.id),
    reps,
    candidateLimit: candidateTaskLimit?.limit ?? null,
    maxConcurrency,
    selectionMode: evaluationIds ? 'explicit' : 'metadata',
    candidateTaskIds: evaluationIds ? undefined : candidateTasks.map((task) => task.id),
    maxExpertTimeEstimateMin: evaluationIds ? null : maxExpertTimeEstimateMin,
    targetEvaluationTaskCount: targetEvaluationTaskCount ?? null,
    nonInferiorityMargin,
  });
  await ensurePromptAbRunManifest(join(runRoot, 'prompt-ab-manifest.json'), runManifest);

  const config = {
    id: 'prompt-ab',
    backend: 'harbor',
    llmConnectionSlug: provider,
    model,
  };
  const resultPath = join(runRoot, 'prompt-ab-result.json');
  const reportPath = join(runRoot, 'prompt-ab-report.md');

  const summary = await runExperiment({
    runRoot,
    prompts: () => [
      { path: baselinePromptPath, content: baselinePrompt },
      { path: candidatePromptPath, content: candidatePrompt },
    ],
    run: ({ jobsDir, resultsJsonlPath }) => {
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
      return runPromptAbComparison({
        runId,
        config,
        baselinePromptPath,
        candidatePromptPath,
        candidatePromptId,
        resultsJsonlPath,
        evaluationTasks,
        reps,
        maxConcurrency,
        resumeFingerprint: runManifest.fingerprint,
        budgetMs: taskBudgetSec * 1000,
        nonInferiorityMargin,
        harborRunner,
      });
    },
    artifacts: (summary) => [
      {
        path: resultPath,
        content: `${JSON.stringify(
          {
            schemaVersion: 'maka.prompt_ab.v2',
            runId,
            candidatePromptSourcePath,
            maxConcurrency,
            taskBudgetSec,
            harborTimeoutMs,
            targetEvaluationTaskCount: targetEvaluationTaskCount ?? null,
            runManifest,
            metadataFilter,
            candidateTaskLimit,
            summary,
          },
          null,
          2,
        )}\n`,
      },
      {
        path: reportPath,
        content: `${renderMetadataFilterMarkdown(metadataFilter)}${renderCandidateLimitMarkdown(candidateTaskLimit)}${renderPromptAbRunManifestMarkdown(runManifest)}${renderPromptAbComparisonMarkdown(summary)}`,
      },
    ],
  });

  console.log('---');
  console.log(`decision: ${summary.decision} (${summary.reason})`);
  console.log(
    `task-level: wins=${summary.taskLevel.wins}, losses=${summary.taskLevel.losses}, ties=${summary.taskLevel.ties}`,
  );
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

function renderCandidateLimitMarkdown(candidateTaskLimit) {
  if (!candidateTaskLimit) {
    return [
      '# Prompt A/B Candidate Limit',
      '',
      '- Mode: skipped; explicit evaluation task IDs were used',
      '',
    ].join('\n');
  }
  return [
    '# Prompt A/B Candidate Limit',
    '',
    `- Limit: ${candidateTaskLimit.limit ?? 'none'}`,
    `- Candidate tasks before limit: ${candidateTaskLimit.inputTaskCount}`,
    `- Candidate tasks after limit: ${candidateTaskLimit.selectedTaskIds.length}`,
    `- Truncated tasks: ${candidateTaskLimit.truncatedTaskIds.length}`,
    '',
  ].join('\n');
}

function renderPromptAbRunManifestMarkdown(manifest) {
  return [
    '# Prompt A/B Run Manifest',
    '',
    `- Fingerprint: ${manifest.fingerprint}`,
    `- Subject fingerprint: ${manifest.subjectFingerprint}`,
    `- Task source fingerprint: ${manifest.taskSourceFingerprint}`,
    `- Toolchain fingerprint: ${manifest.toolchainFingerprint}`,
    `- Selection mode: ${manifest.selectionMode}`,
    `- Max concurrency: ${manifest.maxConcurrency}`,
    `- Reps: ${manifest.reps}`,
    `- Evaluation tasks: ${manifest.evaluationTaskIds.length}`,
    `- Task budget: ${manifest.taskBudgetSec}s`,
    `- Harbor timeout: ${manifest.harborTimeoutMs}ms`,
    `- Non-inferiority margin: ${manifest.nonInferiorityMargin}`,
    '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
