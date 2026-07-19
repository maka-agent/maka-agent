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
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BENCHMARK_BASE_SYSTEM_PROMPT } from '@maka/headless';
import { discoverCachedHarborTasks, resolveFixedPromptRunRoot } from '#fixed-prompt-task-source';
import {
  buildPromptAbRunManifest,
  ensurePromptAbRunManifest,
  filterPromptAbCandidateTasksByMetadata,
  limitPromptAbCandidateTasks,
  renderPromptAbComparisonMarkdown,
  runPromptAbComparison,
} from '#prompt-ab-run';
import { envRatio, envPositiveInt } from '#headless-run-env';
import { createHarborTaskRunner } from '#harbor-task-runner';

const DEEPSEEK_V4_FLASH_PRICING = {
  inputUsdPer1M: 0.145,
  outputUsdPer1M: 0.29,
  cacheReadUsdPer1M: 0.0029,
  cacheWriteUsdPer1M: 0,
  source: 'deepseek-v4-flash',
};

const execFile = promisify(execFileCallback);

function envPath(name, fallback) {
  const raw = process.env[name];
  const value = raw && raw.length > 0 ? raw : fallback;
  if (!value) throw new Error(`${name} is required`);
  return value.startsWith('~') ? join(homedir(), value.slice(1)) : resolve(value);
}

const envPosInt = (name, fallback) => envPositiveInt(name, process.env[name], fallback);
const envRatioValue = (name, fallback) => envRatio(name, process.env[name], fallback);

function rejectUnsupportedProviderEnv(env) {
  const raw = env.MAKA_PROMPT_AB_PROVIDER;
  if (raw && raw.length > 0 && raw !== 'deepseek') {
    throw new Error(
      'MAKA_PROMPT_AB_PROVIDER is not supported by this DeepSeek-only prompt A/B runner; use MAKA_PROMPT_AB_BASE_URL only for DeepSeek endpoint overrides.',
    );
  }
}

function envIds(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function promptIdFromPath(path) {
  return basename(path).replace(/\.[^.]+$/, '');
}

function selectTasksByIds(allTasks, ids) {
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) throw new Error(`duplicate task id(s): ${duplicates.join(', ')}`);
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(', ')}`);
  return ids.map((id) => byId.get(id));
}

function hashSystemPrompt(systemPrompt) {
  return `sha256:${createHash('sha256').update(systemPrompt).digest('hex')}`;
}

function hashBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashPayload(payload) {
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function gitOutput(repoPath, args) {
  const { stdout } = await execFile('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

function isSha256Fingerprint(value) {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

async function toolOutput(command, args) {
  const { stdout, stderr } = await execFile(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return `${stdout}${stderr}`.trim();
}

async function buildInstalledDependencyFingerprint(repoPath) {
  const packageLockPath = join(repoPath, 'package-lock.json');
  const installedLockPath = join(repoPath, 'node_modules/.package-lock.json');
  let packageLock;
  let installedLock;
  try {
    [packageLock, installedLock] = await Promise.all([
      readFile(packageLockPath),
      readFile(installedLockPath),
    ]);
  } catch (error) {
    throw new Error(
      `prompt A/B toolchain fingerprint requires ${packageLockPath} and ${installedLockPath}. Run npm install in MAKA_PROMPT_AB_MAKA_REPO, or set MAKA_PROMPT_AB_TOOLCHAIN_FINGERPRINT to an explicit sha256:<64 lowercase hex> dependency snapshot. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    packageLockPath: resolve(packageLockPath),
    packageLockHash: hashBytes(packageLock),
    installedPackageLockPath: resolve(installedLockPath),
    installedPackageLockHash: hashBytes(installedLock),
  };
}

export async function buildToolchainFingerprint(
  explicitToolchainFingerprint,
  readToolOutput = toolOutput,
  repoPath = resolve(fileURLToPath(new URL('../../..', import.meta.url))),
) {
  if (explicitToolchainFingerprint && explicitToolchainFingerprint.trim().length > 0) {
    const value = explicitToolchainFingerprint.trim();
    if (!isSha256Fingerprint(value)) {
      throw new Error(
        'MAKA_PROMPT_AB_TOOLCHAIN_FINGERPRINT must be a sha256:<64 lowercase hex> content fingerprint',
      );
    }
    return value;
  }
  let harborVersion;
  try {
    harborVersion = await readToolOutput('harbor', ['--version']);
  } catch (error) {
    harborVersion = `unavailable:${error instanceof Error ? error.message : String(error)}`;
  }
  return hashPayload({
    kind: 'prompt-ab-toolchain',
    node: process.version,
    harborVersion,
    dependencyInstallFingerprint: await buildInstalledDependencyFingerprint(repoPath),
  });
}

export async function buildSubjectFingerprint(
  repoPath,
  explicitSubjectFingerprint,
  readGitOutput = gitOutput,
) {
  if (explicitSubjectFingerprint && explicitSubjectFingerprint.trim().length > 0) {
    const value = explicitSubjectFingerprint.trim();
    if (!isSha256Fingerprint(value)) {
      throw new Error(
        'MAKA_PROMPT_AB_EXPLICIT_SUBJECT_FINGERPRINT must be a sha256:<64 lowercase hex> content fingerprint',
      );
    }
    return hashPayload({
      kind: 'prompt-ab-subject',
      explicitSubjectFingerprint: value,
    });
  }
  let gitRoot;
  let head;
  let status;
  try {
    [gitRoot, head, status] = await Promise.all([
      readGitOutput(repoPath, ['rev-parse', '--show-toplevel']),
      readGitOutput(repoPath, ['rev-parse', 'HEAD']),
      readGitOutput(repoPath, ['status', '--porcelain=v1', '--untracked-files=normal']),
    ]);
  } catch (error) {
    throw new Error(
      `MAKA_PROMPT_AB_MAKA_REPO must be a git checkout or MAKA_PROMPT_AB_EXPLICIT_SUBJECT_FINGERPRINT must be set: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (status.length > 0) {
    throw new Error(
      `MAKA_PROMPT_AB_MAKA_REPO must be clean for resume-safe prompt A/B runs. Commit/stash the changes, or set MAKA_PROMPT_AB_EXPLICIT_SUBJECT_FINGERPRINT to an explicit content fingerprint. Dirty git status:\n${status}`,
    );
  }
  return hashPayload({
    kind: 'prompt-ab-subject',
    path: resolve(repoPath),
    gitRoot: resolve(gitRoot),
    head,
    dirty: false,
    statusHash: hashPayload({ status }),
    runtimeArtifactFingerprint: await buildRuntimeArtifactFingerprint(gitRoot),
  });
}

async function buildRuntimeArtifactFingerprint(repoRoot) {
  const artifactRoots = [
    'packages/headless/dist',
    'packages/core/dist',
    'packages/runtime/dist',
    'packages/storage/dist',
  ];
  return hashPayload({
    kind: 'prompt-ab-runtime-artifacts',
    artifacts: await Promise.all(
      artifactRoots.map(async (artifactPath) => ({
        path: artifactPath,
        entries: await hashOptionalDirectory(join(repoRoot, artifactPath)),
      })),
    ),
  });
}

export async function buildTaskSourceFingerprint(tasksRoot, tasks) {
  const taskEntries = [];
  for (const task of tasks) {
    taskEntries.push({
      id: task.id,
      path: resolve(task.path),
      entries: await hashTaskDirectory(task.path),
    });
  }
  return hashPayload({
    kind: 'prompt-ab-task-source',
    tasksRoot: resolve(tasksRoot),
    tasks: taskEntries,
  });
}

async function hashTaskDirectory(taskPath) {
  const root = resolve(taskPath);
  return await hashDirectory(root);
}

async function hashOptionalDirectory(path) {
  try {
    return await hashDirectory(resolve(path));
  } catch (error) {
    if (isNotFound(error)) return [{ path: '.', type: 'missing' }];
    throw error;
  }
}

async function hashDirectory(root) {
  const entries = [];
  await walkTaskDirectory(root, root, entries);
  return entries;
}

async function walkTaskDirectory(root, dir, entries) {
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const path = join(dir, child.name);
    const stats = await lstat(path);
    const entryPath = relative(root, path).split('\\').join('/');
    if (child.isDirectory()) {
      entries.push({ path: entryPath, type: 'directory' });
      await walkTaskDirectory(root, path, entries);
    } else if (child.isSymbolicLink()) {
      throw new Error(
        `task source symlink is not supported in prompt A/B fingerprints: ${entryPath} -> ${await readlink(path)}`,
      );
    } else if (child.isFile()) {
      entries.push({
        path: entryPath,
        type: 'file',
        executable: (stats.mode & 0o111) !== 0,
        hash: hashBytes(await readFile(path)),
      });
    } else {
      entries.push({ path: entryPath, type: 'other' });
    }
  }
}

function isNotFound(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
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
  const controllerDir = join(runRoot, 'controller');
  const jobsDir = join(runRoot, 'jobs');
  const promptsDir = join(runRoot, 'prompts');
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

  const baselinePrompt = `${BENCHMARK_BASE_SYSTEM_PROMPT}\n`;
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
      toolOutput,
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

  await mkdir(controllerDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });
  const baselinePromptPath = join(promptsDir, 'maka-baseline.md');
  const candidatePromptPath = join(promptsDir, `candidate-${basename(candidatePromptSourcePath)}`);
  await writeFile(baselinePromptPath, baselinePrompt, 'utf8');
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
    resumeFingerprint: runManifest.fingerprint,
    budgetMs: taskBudgetSec * 1000,
    nonInferiorityMargin,
    harborRunner,
  });

  const output = {
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
  };
  const resultPath = join(runRoot, 'prompt-ab-result.json');
  const reportPath = join(runRoot, 'prompt-ab-report.md');
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await writeFile(
    reportPath,
    `${renderMetadataFilterMarkdown(metadataFilter)}${renderCandidateLimitMarkdown(candidateTaskLimit)}${renderPromptAbRunManifestMarkdown(runManifest)}${renderPromptAbComparisonMarkdown(summary)}`,
    'utf8',
  );

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
