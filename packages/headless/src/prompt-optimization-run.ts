import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LlmConnection } from '@maka/core';
import type { Config } from './contracts.js';
import type { FixedPromptTask, HarborTaskRunner } from './fixed-prompt-controller.js';
import { createHarborTaskRunner, type HarborTaskPricing } from './harbor-task-runner.js';
import { createAiSdkMetaAgent } from './meta-agent-completion.js';
import { createCliPromptCandidateGit, type MetaAgent } from './prompt-candidate-loop.js';
import {
  runPromptOptimizationLoop,
  type PromptOptimizationLoopResult,
} from './prompt-optimization-loop.js';

const execFileAsync = promisify(execFile);

/**
 * Real-run wiring for the RSI prompt-optimization loop: discover and partition
 * cached Terminal-Bench tasks, derive reward-hack verifier patterns, and compose
 * the real Harbor task runner + DeepSeek meta-agent + CLI git before handing off
 * to {@link runPromptOptimizationLoop}. The expensive components are still
 * injectable so the composition is testable without Docker or the network.
 */

export interface PromptTaskPartition {
  heldInTasks: FixedPromptTask[];
  heldOutTasks: FixedPromptTask[];
}

export type PromptOptimizationRunResult = PromptOptimizationLoopResult;

export function resolvePromptOptimizationRunRoot(outDir: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error('MAKA_PROMPT_RUN_ID must contain only letters, numbers, dot, underscore, or hyphen');
  }
  return join(outDir, runId);
}

/** Deterministic id-sorted slice into disjoint held-in / held-out partitions, so
 * the same cached task set always yields the same split across runs. */
export function partitionPromptTasks(
  tasks: readonly FixedPromptTask[],
  input: { heldInCount: number; heldOutCount: number },
): PromptTaskPartition {
  if (input.heldInCount < 0 || input.heldOutCount < 0) {
    throw new Error('partition counts must be non-negative');
  }
  const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const required = input.heldInCount + input.heldOutCount;
  if (required > sorted.length) {
    throw new Error(`not enough tasks: need ${required}, have ${sorted.length}`);
  }
  return {
    heldInTasks: sorted.slice(0, input.heldInCount),
    heldOutTasks: sorted.slice(input.heldInCount, required),
  };
}

/** Scan a Harbor task cache (`<root>/<hash>/<task-name>/task.toml`) into a
 * deterministic, id-sorted task list. */
export async function discoverCachedHarborTasks(tasksRoot: string): Promise<FixedPromptTask[]> {
  const byId = new Map<string, FixedPromptTask>();
  let hashDirs;
  try {
    hashDirs = await readdir(tasksRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) continue;
    const hashPath = join(tasksRoot, hashDir.name);
    let inner;
    try {
      inner = await readdir(hashPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const taskDir of inner) {
      if (!taskDir.isDirectory()) continue;
      const taskPath = join(hashPath, taskDir.name);
      try {
        await readFile(join(taskPath, 'task.toml'), 'utf8');
      } catch {
        continue;
      }
      // The controller keys events by task id, so two cached versions of the same
      // task name would silently collide and pollute scoring. Fail loud instead.
      const existing = byId.get(taskDir.name);
      if (existing) {
        throw new Error(`duplicate cached task id "${taskDir.name}": ${existing.path} and ${taskPath}`);
      }
      byId.set(taskDir.name, { id: taskDir.name, path: taskPath });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const CANARY_PATTERN = /terminal-bench-canary GUID ([0-9a-fA-F-]{8,})/g;

/** The Terminal-Bench canary GUID lives only in a task's test files, so seeing it
 * in model-visible output means the agent read the verifier — exactly the
 * reward-hack signal. Extract each task's canary(s) as its verifier patterns.
 *
 * This is a substring backstop, not an airtight guarantee: an agent that reads and
 * parses the verifier without ever echoing the canary would evade it. The primary
 * defense is that Harbor does not mount a task's tests/ into the agent environment
 * during the run — the canary scan catches the case where verifier material leaks
 * in anyway. */
export async function extractRewardHackVerifierPatterns(taskPath: string): Promise<string[]> {
  const patterns = new Set<string>();
  await collectCanaryPatterns(join(taskPath, 'tests'), patterns);
  return [...patterns].sort();
}

/** Recursively scan a directory tree, accumulating canary GUIDs from every file.
 * Canary material commonly lives in nested test fixtures (e.g. tests/data/…), so a
 * shallow scan of tests/ would miss it and misjudge the task as having no verifier
 * pattern — which then silently drops the task from held-in. Symlinks are not
 * followed (isDirectory/isFile are false for them), which also avoids cycles. */
async function collectCanaryPatterns(dir: string, patterns: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectCanaryPatterns(entryPath, patterns);
      continue;
    }
    if (!entry.isFile()) continue;
    let content;
    try {
      content = await readFile(entryPath, 'utf8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(CANARY_PATTERN)) {
      if (match[1]) patterns.add(match[1]);
    }
  }
}

export async function buildRewardHackVerifierPatterns(
  tasks: readonly FixedPromptTask[],
): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  for (const task of tasks) {
    map[task.id] = await extractRewardHackVerifierPatterns(task.path);
  }
  return map;
}

export interface PromptOptimizationRunInput {
  runId: string;
  rounds: number;
  baselineRuns?: number;
  zScore?: number;

  // Prompt repo (git working tree the meta-agent edits).
  gitCwdPath: string;
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;

  // Controller-only artifacts (must resolve outside agentCwdPath).
  resultsJsonlPath: string;
  heldInResultsTsvPath: string;
  heldOutResultsTsvPath: string;

  heldInTasks: readonly FixedPromptTask[];
  heldOutTasks: readonly FixedPromptTask[];
  heldOutArtifactPaths?: readonly string[];

  // Model / provider / key.
  connection: LlmConnection;
  /** Provider-qualified model id, e.g. "deepseek/deepseek-v4-flash". */
  model: string;
  /** MAKA_PROVIDER, e.g. "deepseek". */
  provider: string;
  /** Host path to the API key file (mounted into the container; read on host for
   * the meta-agent). */
  apiKeyFile: string;
  pricing: HarborTaskPricing;

  // Harbor.
  makaRepoPath: string;
  jobsDir: string;
  harborBin?: string;
  agentEnv?: Record<string, string>;

  rewardHackVerifierPatternsByTaskId: Readonly<Record<string, readonly string[]>>;

  costCeilingUsd?: number;
  maxInfraFailureRate?: number;
  maxConcurrency?: number;
  minStableHeldInTasks?: number;
  minStableHeldOutTasks?: number;
  maxStableTaskDurationMs?: number;

  // Test overrides — bypass the real Docker/network components.
  harborRunner?: HarborTaskRunner;
  metaAgent?: MetaAgent;
  now?: () => number;
  newId?: () => string;
}

export async function runPromptOptimizationRun(
  input: PromptOptimizationRunInput,
): Promise<PromptOptimizationRunResult> {
  const modelId = input.model.includes('/')
    ? input.model.slice(input.model.indexOf('/') + 1)
    : input.model;

  const harborRunner = input.harborRunner ?? createHarborTaskRunner({
    makaRepoPath: input.makaRepoPath,
    jobsDir: input.jobsDir,
    model: input.model,
    provider: input.provider,
    apiKeyFile: input.apiKeyFile,
    pricing: input.pricing,
    ...(input.harborBin ? { harborBin: input.harborBin } : {}),
    ...(input.agentEnv ? { agentEnv: input.agentEnv } : {}),
  });

  const metaAgent = input.metaAgent ?? createAiSdkMetaAgent({
    connection: input.connection,
    apiKey: readFileSync(input.apiKeyFile, 'utf8').trim(),
    modelId,
  });

  const git = createCliPromptCandidateGit({ cwd: input.gitCwdPath, systemPromptPath: input.systemPromptPath });
  const originalCommitSha = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: input.gitCwdPath })
  ).stdout.trim();

  const config: Config = {
    id: input.runId,
    backend: 'ai-sdk',
    llmConnectionSlug: input.provider,
    model: modelId,
  };

  return runPromptOptimizationLoop({
    runId: input.runId,
    rounds: input.rounds,
    ...(input.baselineRuns !== undefined ? { baselineRuns: input.baselineRuns } : {}),
    ...(input.zScore !== undefined ? { zScore: input.zScore } : {}),
    agentCwdPath: input.agentCwdPath,
    programPath: input.programPath,
    systemPromptPath: input.systemPromptPath,
    resultsJsonlPath: input.resultsJsonlPath,
    heldInResultsTsvPath: input.heldInResultsTsvPath,
    heldOutResultsTsvPath: input.heldOutResultsTsvPath,
    heldInTasks: input.heldInTasks,
    heldOutTasks: input.heldOutTasks,
    ...(input.heldOutArtifactPaths ? { heldOutArtifactPaths: input.heldOutArtifactPaths } : {}),
    config,
    harborRunner,
    metaAgent,
    git,
    originalCommitSha,
    rewardHackVerifierPatternsByTaskId: input.rewardHackVerifierPatternsByTaskId,
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    ...(input.maxInfraFailureRate !== undefined ? { maxInfraFailureRate: input.maxInfraFailureRate } : {}),
    ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
    ...(input.minStableHeldInTasks !== undefined ? { minStableHeldInTasks: input.minStableHeldInTasks } : {}),
    ...(input.minStableHeldOutTasks !== undefined ? { minStableHeldOutTasks: input.minStableHeldOutTasks } : {}),
    ...(input.maxStableTaskDurationMs !== undefined ? { maxStableTaskDurationMs: input.maxStableTaskDurationMs } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.newId ? { newId: input.newId } : {}),
  });
}
