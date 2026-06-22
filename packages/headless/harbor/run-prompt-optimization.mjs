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
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BENCHMARK_BASE_SYSTEM_PROMPT,
  DEEPSEEK_V4_FLASH_PRICING,
  buildRewardHackVerifierPatterns,
  discoverCachedHarborTasks,
  partitionPromptTasks,
  renderPromptStructuralSmokeMarkdown,
  runPromptOptimizationRun,
} from '@maka/headless';

const execFileAsync = promisify(execFile);

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

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

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

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const makaRepoPath = process.env.MAKA_PROMPT_MAKA_REPO
    ? resolve(process.env.MAKA_PROMPT_MAKA_REPO)
    : repoRoot;

  const outDir = envPath('MAKA_PROMPT_OUT_DIR');
  const keyFile = envPath('MAKA_PROMPT_KEY_FILE', join(homedir(), '.local/maka-eval/secrets/deepseek-key'));
  const tasksRoot = envPath('MAKA_PROMPT_TASKS_ROOT', join(homedir(), '.cache/harbor/tasks'));
  const model = process.env.MAKA_PROMPT_MODEL || 'deepseek/deepseek-v4-flash';
  const provider = process.env.MAKA_PROMPT_PROVIDER || 'deepseek';
  const baseUrl = process.env.MAKA_PROMPT_BASE_URL || 'https://api.deepseek.com';
  const rounds = envInt('MAKA_PROMPT_ROUNDS', 10);
  const baselineRuns = envInt('MAKA_PROMPT_BASELINE_RUNS', 3);
  const heldInCount = envInt('MAKA_PROMPT_HELD_IN', 60);
  const heldOutCount = envInt('MAKA_PROMPT_HELD_OUT', 20);
  const runId = process.env.MAKA_PROMPT_RUN_ID || `prompt-opt-${Date.now()}`;
  const costCeilingUsd = process.env.MAKA_PROMPT_COST_CEILING ? Number(process.env.MAKA_PROMPT_COST_CEILING) : undefined;
  const maxConcurrency = process.env.MAKA_PROMPT_MAX_CONCURRENCY ? Number(process.env.MAKA_PROMPT_MAX_CONCURRENCY) : undefined;
  const minStableHeldInTasks = envInt('MAKA_PROMPT_MIN_STABLE_HELD_IN', 1);
  const minStableHeldOutTasks = envInt('MAKA_PROMPT_MIN_STABLE_HELD_OUT', 1);
  const maxInfraFailureRate = process.env.MAKA_PROMPT_MAX_INFRA_FAILURE_RATE
    ? Number(process.env.MAKA_PROMPT_MAX_INFRA_FAILURE_RATE)
    : undefined;

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
  const missingPatterns = [...heldInTasks, ...heldOutTasks].filter((t) => (rewardHackVerifierPatternsByTaskId[t.id] ?? []).length === 0);
  if (missingPatterns.length > 0) {
    console.warn(`WARNING: ${missingPatterns.length} task(s) have no canary verifier pattern; those rounds will quarantine.`);
  }

  // Prompt repo: program.md + system_prompt.md committed; agent-cwd/ is the empty
  // isolation root; controller artifacts live OUTSIDE it.
  const promptRepoDir = join(outDir, 'prompt-repo');
  const agentCwdPath = join(promptRepoDir, 'agent-cwd');
  const controllerDir = join(outDir, 'controller');
  const jobsDir = join(outDir, 'jobs');
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
    rewardHackVerifierPatternsByTaskId,
    minStableHeldInTasks,
    minStableHeldOutTasks,
    ...(costCeilingUsd !== undefined ? { costCeilingUsd } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(maxInfraFailureRate !== undefined ? { maxInfraFailureRate } : {}),
  });

  const resultPath = join(outDir, 'prompt-optimization-result.json');
  const smokePath = join(outDir, 'structural-smoke.md');
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
