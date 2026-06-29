#!/usr/bin/env node
// Runnable entry for a real RSI prompt-optimization run over cached Terminal-Bench
// tasks via Harbor + DeepSeek. All wiring lives in @maka/headless
// (runPromptOptimizationRun); this script only resolves config, builds the prompt
// repo, and persists the result. Secrets travel as a FILE PATH only — never argv.
//
// Usage (cheap smoke):
//   MAKA_PROMPT_OUT_DIR=/tmp/rsi-smoke \
//   MAKA_PROMPT_KEY_FILE=~/.local/maka-eval/secrets/deepseek-key \
//   MAKA_PROMPT_HELD_IN=1 MAKA_PROMPT_HELD_OUT=1 \
//   MAKA_PROMPT_ROUNDS=1 MAKA_PROMPT_BASELINE_RUNS=1 \
//   node packages/headless/harbor/run-prompt-optimization.mjs
//
// Full run: drop the count/round overrides (defaults 60/20, 3 baseline, 10 rounds).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BENCHMARK_BASE_SYSTEM_PROMPT,
} from '@maka/headless';
import {
  discoverCachedHarborTasks,
  resolveFixedPromptRunRoot,
} from '#fixed-prompt-task-source';
import {
  buildRewardHackVerifierPatterns,
  partitionPromptTasks,
  runPromptOptimizationRun,
} from '#prompt-optimization-run';
import { renderPromptStructuralSmokeMarkdown } from '#prompt-structural-smoke';
import {
  envFinitePositiveNumber,
  envNonNegativeInt,
  envPositiveInt,
  envRatio,
  resolveMinStable,
  smokeExitCode,
} from '#headless-run-env';
import { ensureAbRunManifest } from '#ab-manifest';

const execFileAsync = promisify(execFile);

// DeepSeek per-1M USD pricing (0.145 USD/CNY). "input" is the cache-miss rate;
// cache writes carry no separate charge, so cacheWriteUsdPer1M is 0. Vendor
// pricing lives here in the runner, not in @maka/headless: it is run config, not
// part of the package's generic public API.
const DEEPSEEK_V4_FLASH_PRICING = {
  inputUsdPer1M: 0.145,
  outputUsdPer1M: 0.29,
  cacheReadUsdPer1M: 0.0029,
  cacheWriteUsdPer1M: 0,
  source: 'deepseek-v4-flash',
};

// This object is plain JS (no HarborTaskPricing type-check) and is no longer
// pinned by a unit test, so a mistyped field name would leave a rate `undefined`
// and the runner would silently emit wrong/zero costUsd. Fail loud at startup —
// before any Docker time — if a canonical rate field is missing or not a finite,
// non-negative number. The field-name -> MAKA_TRIAL_* forwarding contract is
// covered in harbor-task-runner.test.ts.
for (const field of ['inputUsdPer1M', 'outputUsdPer1M', 'cacheReadUsdPer1M', 'cacheWriteUsdPer1M']) {
  const rate = DEEPSEEK_V4_FLASH_PRICING[field];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
    throw new Error(`DEEPSEEK_V4_FLASH_PRICING.${field} must be a finite, non-negative number (got ${JSON.stringify(rate)})`);
  }
}

const PROGRAM = `You are improving ONE system prompt for autonomous Terminal-Bench coding agents.
Given the current prompt, the latest held-in results, and recent failure digests,
propose a single, conservative improvement that should raise the held-in pass rate
without overfitting. Do not reference specific task ids or expected outputs. Reply
with exactly one JSON object {"systemPrompt": "...", "summary": "..."}.
`;

function envPath(name, fallback) {
  const raw = process.env[name];
  const value = raw && raw.length > 0 ? raw : fallback;
  if (!value) throw new Error(`${name} is required`);
  return value.startsWith('~') ? join(homedir(), value.slice(1)) : resolve(value);
}

// Thin env-bound wrappers over the validated parsers in @maka/headless. Each
// FAILS LOUD on an illegal value rather than letting NaN slip through a later
// `!== undefined` check and silently disable a guard.
const envInt = (name, fallback) => envNonNegativeInt(name, process.env[name], fallback);
const envPosInt = (name, fallback) => envPositiveInt(name, process.env[name], fallback);
const envNum = (name, fallback) => envFinitePositiveNumber(name, process.env[name], fallback);
const envRatioOf = (name, fallback) => envRatio(name, process.env[name], fallback);
const envBool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
    case 'disabled':
      return false;
    default:
      throw new Error(`${name} must be a boolean, got ${JSON.stringify(raw)}`);
  }
};

// Comma-separated explicit task ids (controlled smokes). Empty -> undefined.
function envIds(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

// Pick tasks by explicit id, preserving the requested order; throw on a
// duplicate (would double-weight a task) or any unknown id.
function selectTasksByIds(allTasks, ids) {
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) throw new Error(`duplicate task id(s): ${duplicates.join(', ')}`);
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(', ')}`);
  return ids.map((id) => byId.get(id));
}

async function git(cwd, ...args) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
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

function buildPromptOptimizationRunManifest(input) {
  const manifestWithoutFingerprint = {
    schemaVersion: 'maka.prompt_optimization.run_manifest.v1',
    runId: input.runId,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    rounds: input.rounds,
    baselineRuns: input.baselineRuns,
    costCeilingUsd: input.costCeilingUsd,
    maxConcurrency: input.maxConcurrency ?? null,
    maxInfraFailureRate: input.maxInfraFailureRate ?? null,
    maxStableTaskDurationMs: input.maxStableTaskDurationMs ?? null,
    minStableRatio: input.minStableRatio,
    minStableHeldInTasks: input.minStableHeldInTasks,
    minStableHeldOutTasks: input.minStableHeldOutTasks,
    runtimeProfile: input.runtimeProfile,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    heldInTaskIds: input.heldInTasks.map((task) => task.id),
    heldOutTaskIds: input.heldOutTasks.map((task) => task.id),
    droppedHeldInNoPatternTaskIds: input.heldInNoPattern.map((task) => task.id),
    heldOutNoPatternTaskIds: input.heldOutNoPattern.map((task) => task.id),
  };
  return {
    ...manifestWithoutFingerprint,
    fingerprint: hashPayload(manifestWithoutFingerprint),
  };
}

async function buildSubjectFingerprint(repoPath) {
  const [gitRoot, head, status] = await Promise.all([
    gitOutput(repoPath, 'rev-parse', '--show-toplevel'),
    gitOutput(repoPath, 'rev-parse', 'HEAD'),
    gitOutput(repoPath, 'status', '--porcelain=v1', '--untracked-files=normal'),
  ]);
  return hashPayload({
    kind: 'prompt-optimization-subject',
    repoPath: resolve(repoPath),
    gitRoot: resolve(gitRoot),
    head,
    dirty: status.length > 0,
    statusHash: hashPayload({ status }),
  });
}

async function buildToolchainFingerprint(repoRoot) {
  return hashPayload({
    kind: 'prompt-optimization-toolchain',
    node: process.version,
    packageLockHash: await hashOptionalFile(join(repoRoot, 'package-lock.json')),
    headlessPackageHash: await hashOptionalFile(join(repoRoot, 'packages/headless/package.json')),
  });
}

function buildTaskSourceFingerprint(tasksRoot, heldInTasks, heldOutTasks) {
  const taskPayload = (task) => ({
    id: task.id,
    path: resolve(task.path),
    metadata: task.metadata ?? null,
  });
  return hashPayload({
    kind: 'prompt-optimization-task-source',
    tasksRoot: resolve(tasksRoot),
    heldInTasks: heldInTasks.map(taskPayload),
    heldOutTasks: heldOutTasks.map(taskPayload),
  });
}

async function hashOptionalFile(path) {
  try {
    return hashPayload({ bytes: await readFile(path, 'utf8') });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensurePromptOptimizationRunManifest(path, manifest, runRoot) {
  if (!(await pathExists(path))) {
    const legacyArtifacts = [
      join(runRoot, 'controller', 'results.jsonl'),
      join(runRoot, 'prompt-repo'),
    ];
    const existing = [];
    for (const artifactPath of legacyArtifacts) {
      if (await pathExists(artifactPath)) existing.push(artifactPath);
    }
    if (existing.length > 0) {
      throw new Error(
        `prompt optimization run root already has artifacts but no prompt-optimization-manifest.json: ${existing.join(', ')}. Use a new MAKA_PROMPT_RUN_ID or move the legacy artifacts aside.`,
      );
    }
  }
  try {
    return await ensureAbRunManifest(path, manifest);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('A/B run manifest does not match existing run id:')) {
      throw new Error(error.message.replace(
        'A/B run manifest does not match existing run id:',
        'prompt optimization run manifest does not match existing run id:',
      ));
    }
    throw error;
  }
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_PROMPT_MAKA_REPO
    ? resolve(process.env.MAKA_PROMPT_MAKA_REPO)
    : repoRoot;

  const outDir = envPath('MAKA_PROMPT_OUT_DIR');
  const keyFile = envPath('MAKA_PROMPT_KEY_FILE', join(homedir(), '.local/maka-eval/secrets/deepseek-key'));
  const tasksRoot = envPath('MAKA_PROMPT_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  // Model is pinned, not env-overridable: the RSI loop is contractually a
  // deepseek-v4-flash run, and DEEPSEEK_V4_FLASH_PRICING below is tied to it.
  // Allowing an override would let cost/smoke accounting silently use the wrong
  // rates. Provider/baseUrl stay overridable — those don't change the pricing.
  const model = 'deepseek/deepseek-v4-flash';
  const provider = process.env.MAKA_PROMPT_PROVIDER || 'deepseek';
  const baseUrl = process.env.MAKA_PROMPT_BASE_URL || 'https://api.deepseek.com';
  // Rounds must be >= 1: a 0-round run is baseline-only and would trivially pass
  // the structural smoke (minimumRounds 0), contradicting the unattended >=1-round
  // validation this runner exists to perform.
  const rounds = envPosInt('MAKA_PROMPT_ROUNDS', 10);
  const baselineRuns = envInt('MAKA_PROMPT_BASELINE_RUNS', 3);
  const heldInCount = envInt('MAKA_PROMPT_HELD_IN', 60);
  const heldOutCount = envInt('MAKA_PROMPT_HELD_OUT', 20);
  const runId = process.env.MAKA_PROMPT_RUN_ID || `prompt-opt-${Date.now()}`;
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_PROMPT_RUN_ID');
  // Default to a $30 ceiling: an unattended full run with no cost guard at all
  // is the worse failure mode than stopping early. An explicit value overrides.
  // This is a round/sweep-boundary ceiling, not a hard mid-task cap: the loop
  // checks the budget before each baseline sweep and before the held-out sweep,
  // so a single in-flight sweep can still complete past the ceiling before the
  // loop stops. It bounds overshoot to one sweep, it does not abort tasks.
  const costCeilingUsd = envNum('MAKA_PROMPT_COST_CEILING', 30);
  const maxConcurrency = envPosInt('MAKA_PROMPT_MAX_CONCURRENCY', undefined);
  const maxInfraFailureRate = envRatioOf('MAKA_PROMPT_MAX_INFRA_FAILURE_RATE', undefined);
  const maxStableTaskDurationMs = envNum('MAKA_PROMPT_MAX_STABLE_TASK_MS', undefined);
  const taskBudgetSec = envPosInt('MAKA_PROMPT_TASK_BUDGET_SEC', 30 * 60);
  const harborTimeoutMs = envPosInt('MAKA_PROMPT_HARBOR_TIMEOUT_MS', (taskBudgetSec + 300) * 1000);
  const commandTimeoutMs = envPosInt('MAKA_CELL_COMMAND_TIMEOUT_MS', 300_000);
  const continuationEnabled = envBool('MAKA_HARBOR_CONTINUATION', true);
  const continuationMaxTurns = envPosInt('MAKA_HARBOR_CONTINUATION_MAX_TURNS', 3);
  const continuationMaxTotalRuntimeSteps = envPosInt(
    'MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS',
    continuationMaxTurns * 50,
  );
  const runtimeProfile = {
    taskBudgetSec,
    harborTimeoutMs,
    commandTimeoutMs,
    runtimeEnvKeys: [
      'MAKA_CELL_TIMEOUT_SEC',
      'MAKA_CELL_COMMAND_TIMEOUT_MS',
      'MAKA_HARBOR_CONTINUATION',
      'MAKA_HARBOR_CONTINUATION_MAX_TURNS',
      'MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS',
    ],
    continuation: {
      enabled: continuationEnabled,
      maxTurns: continuationMaxTurns,
      maxTotalRuntimeSteps: continuationMaxTotalRuntimeSteps,
    },
  };
  // Min-stable floors scale with the actual post-drop partition sizes; resolved
  // below once the no-canary drop has settled heldInTasks/heldOutTasks.
  const minStableRatio = envRatioOf('MAKA_PROMPT_MIN_STABLE_RATIO', 0.5);

  // Verify the key file exists before spending Docker time (never print it).
  await readFile(keyFile, 'utf8');

  const allTasks = await discoverCachedHarborTasks(tasksRoot);
  console.log(`Discovered ${allTasks.length} cached tasks under ${tasksRoot}`);
  const heldInIds = envIds('MAKA_PROMPT_HELD_IN_IDS');
  const heldOutIds = envIds('MAKA_PROMPT_HELD_OUT_IDS');
  let heldInTasks;
  let heldOutTasks;
  if (heldInIds || heldOutIds) {
    if (!heldInIds || !heldOutIds) {
      throw new Error('MAKA_PROMPT_HELD_IN_IDS and MAKA_PROMPT_HELD_OUT_IDS must be set together');
    }
    const overlap = heldInIds.filter((id) => heldOutIds.includes(id));
    if (overlap.length > 0) throw new Error(`held-in and held-out overlap: ${overlap.join(', ')}`);
    heldInTasks = selectTasksByIds(allTasks, heldInIds);
    heldOutTasks = selectTasksByIds(allTasks, heldOutIds);
    console.log(`Selected by id: held-in [${heldInIds.join(', ')}], held-out [${heldOutIds.join(', ')}]`);
  } else {
    ({ heldInTasks, heldOutTasks } = partitionPromptTasks(allTasks, { heldInCount, heldOutCount }));
    console.log(`Partitioned: ${heldInTasks.length} held-in, ${heldOutTasks.length} held-out`);
  }

  const rewardHackVerifierPatternsByTaskId = await buildRewardHackVerifierPatterns([...heldInTasks, ...heldOutTasks]);
  // A held-in task with no canary verifier pattern cannot be scanned for
  // reward-hacking, so the controller quarantines every round it completes in —
  // which would fail the structural smoke. An unverifiable task does not belong
  // in the partition the meta-agent optimizes, so drop it from held-in. Held-out
  // is not reward-hack-scanned, so it keeps such tasks. If the caller pinned
  // held-in ids explicitly, fail loud rather than silently change their set.
  const hasPattern = (t) => (rewardHackVerifierPatternsByTaskId[t.id] ?? []).length > 0;
  const heldInNoPattern = heldInTasks.filter((t) => !hasPattern(t));
  if (heldInNoPattern.length > 0) {
    const ids = heldInNoPattern.map((t) => t.id).join(', ');
    if (heldInIds) {
      throw new Error(`held-in task(s) have no canary verifier pattern (would quarantine every round): ${ids}`);
    }
    heldInTasks = heldInTasks.filter(hasPattern);
    console.warn(`Dropped ${heldInNoPattern.length} held-in task(s) with no canary verifier pattern: ${ids}`);
  }
  const heldOutNoPattern = heldOutTasks.filter((t) => !hasPattern(t));
  if (heldOutNoPattern.length > 0) {
    console.warn(`Note: ${heldOutNoPattern.length} held-out task(s) have no canary pattern (held-out is not reward-hack-scanned): ${heldOutNoPattern.map((t) => t.id).join(', ')}`);
  }
  console.log(`Reward-hack patterns: ${heldInTasks.length} held-in all covered, ${heldOutTasks.length} held-out`);

  // Resolve the min-stable floors against the FINAL (post-drop) partition sizes.
  // An explicit MAKA_PROMPT_MIN_STABLE_* wins (cheap smokes pin "1"); otherwise
  // the floor scales with the partition — ceil(size * ratio), at least 1 — so a
  // sample shrunk by unstable-task drops fails loud instead of a flat default of
  // 1 letting a near-empty stable set still produce a "valid" conclusion.
  const minStableHeldInTasks = resolveMinStable(
    'MAKA_PROMPT_MIN_STABLE_HELD_IN', heldInTasks.length, process.env.MAKA_PROMPT_MIN_STABLE_HELD_IN, minStableRatio);
  const minStableHeldOutTasks = resolveMinStable(
    'MAKA_PROMPT_MIN_STABLE_HELD_OUT', heldOutTasks.length, process.env.MAKA_PROMPT_MIN_STABLE_HELD_OUT, minStableRatio);
  console.log(`Min-stable floors: held-in ${minStableHeldInTasks}/${heldInTasks.length}, held-out ${minStableHeldOutTasks}/${heldOutTasks.length}`);

  const manifestPath = join(runRoot, 'prompt-optimization-manifest.json');
  const runManifest = await ensurePromptOptimizationRunManifest(
    manifestPath,
    buildPromptOptimizationRunManifest({
      runId,
      provider,
      baseUrl,
      model,
      rounds,
      baselineRuns,
      costCeilingUsd,
      maxConcurrency,
      maxInfraFailureRate,
      maxStableTaskDurationMs,
      minStableRatio,
      minStableHeldInTasks,
      minStableHeldOutTasks,
      runtimeProfile,
      subjectFingerprint: await buildSubjectFingerprint(makaRepoPath),
      taskSourceFingerprint: buildTaskSourceFingerprint(tasksRoot, heldInTasks, heldOutTasks),
      toolchainFingerprint: await buildToolchainFingerprint(repoRoot),
      heldInTasks,
      heldOutTasks,
      heldInNoPattern,
      heldOutNoPattern,
    }),
    runRoot,
  );
  console.log(`Run manifest: ${runManifest.fingerprint}`);
  console.log(`Runtime profile: taskBudget=${taskBudgetSec}s, harborTimeout=${harborTimeoutMs}ms, commandTimeout=${commandTimeoutMs}ms, continuation=${continuationEnabled ? 'on' : 'off'} (${continuationMaxTurns} turn(s))`);

  // Prompt repo: program.md + system_prompt.md committed; agent-cwd/ is the empty
  // isolation root; controller artifacts live OUTSIDE it.
  const promptRepoDir = join(runRoot, 'prompt-repo');
  const agentCwdPath = join(promptRepoDir, 'agent-cwd');
  const controllerDir = join(runRoot, 'controller');
  const jobsDir = join(runRoot, 'jobs');
  await mkdir(agentCwdPath, { recursive: true });
  await mkdir(controllerDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  const programPath = join(promptRepoDir, 'program.md');
  const systemPromptPath = join(promptRepoDir, 'system_prompt.md');
  await writeFile(programPath, PROGRAM, 'utf8');
  await writeFile(systemPromptPath, `${BENCHMARK_BASE_SYSTEM_PROMPT}\n`, 'utf8');
  await git(promptRepoDir, 'init', '-q');
  await git(promptRepoDir, 'config', 'user.email', 'rsi@maka.local');
  await git(promptRepoDir, 'config', 'user.name', 'RSI Loop');
  await git(promptRepoDir, 'add', 'program.md', 'system_prompt.md');
  await git(promptRepoDir, 'commit', '-q', '-m', 'seed prompt');

  const connection = {
    slug: provider,
    name: provider,
    providerType: provider,
    baseUrl,
    defaultModel: model.includes('/') ? model.slice(model.indexOf('/') + 1) : model,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };

  console.log(`Starting run ${runId}: ${rounds} round(s), ${baselineRuns} baseline sweep(s), model ${model}`);
  const result = await runPromptOptimizationRun({
    runId,
    rounds,
    baselineRuns,
    gitCwdPath: promptRepoDir,
    agentCwdPath,
    programPath,
    systemPromptPath,
    resultsJsonlPath: join(controllerDir, 'results.jsonl'),
    heldInResultsTsvPath: join(controllerDir, 'held-in.tsv'),
    heldOutResultsTsvPath: join(controllerDir, 'held-out.tsv'),
    heldInTasks,
    heldOutTasks,
    connection,
    model,
    provider,
    apiKeyFile: keyFile,
    pricing: DEEPSEEK_V4_FLASH_PRICING,
    makaRepoPath,
    jobsDir,
    agentEnv: { DEEPSEEK_BASE_URL: baseUrl },
    harborTimeoutMs,
    resumeFingerprint: runManifest.fingerprint,
    runtimeProfile,
    rewardHackVerifierPatternsByTaskId,
    minStableHeldInTasks,
    minStableHeldOutTasks,
    costCeilingUsd,
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(maxInfraFailureRate !== undefined ? { maxInfraFailureRate } : {}),
    ...(maxStableTaskDurationMs !== undefined ? { maxStableTaskDurationMs } : {}),
  });

  const resultPath = join(runRoot, 'prompt-optimization-result.json');
  const smokePath = join(runRoot, 'structural-smoke.md');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(smokePath, renderPromptStructuralSmokeMarkdown(result.smoke), 'utf8');

  console.log('---');
  console.log(`stopReason: ${result.stopReason}`);
  if (result.droppedHeldInTaskIds.length > 0 || result.droppedHeldOutTaskIds.length > 0) {
    console.log(`dropped (unstable in baseline): held-in [${result.droppedHeldInTaskIds.join(', ')}], held-out [${result.droppedHeldOutTaskIds.join(', ')}]`);
  }
  console.log(`decisions: ${result.decisions.length} (kept ${result.keptCount})`);
  console.log(`totalCostUsd: ${result.totalCostUsd.toFixed(4)}`);
  console.log(`smoke: ${result.smoke.status} (rounds ${result.smoke.observedRounds}/${result.smoke.minimumRounds})`);
  console.log(`result -> ${resultPath}`);
  console.log(`smoke  -> ${smokePath}`);
  if (result.smoke.status !== 'pass') {
    console.log(`smoke failures: ${result.smoke.failures.join(', ')}`);
  }
  // A non-pass smoke must surface as a non-zero exit so CI and shell callers
  // don't treat a structurally-broken run as success.
  process.exitCode = smokeExitCode(result.smoke.status);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
