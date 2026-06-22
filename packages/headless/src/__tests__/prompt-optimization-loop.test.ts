import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { hashSystemPrompt, type HarborTaskRunInput, type HarborTaskRunOutput } from '../fixed-prompt-controller.js';
import { createCliPromptCandidateGit, type MetaAgent } from '../prompt-candidate-loop.js';
import { runPromptOptimizationLoop, type PromptOptimizationLoopInput } from '../prompt-optimization-loop.js';
import type { Config } from '../contracts.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

const execFileAsync = promisify(execFile);

const CONFIG: Config = { id: 'cfg', backend: 'fake', llmConnectionSlug: 'deepseek' };
const COST_PER_TASK = 0.02;

describe('runPromptOptimizationLoop', () => {
  test('keeps an improving candidate, discards a regressing one, and reports a passing smoke', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      // baseline held-in 0.5; round-0 jumps to 1.0 (KEEP); round-1 collapses to
      // 0.0 (DISCARD). Held-out stays flat at 0.5 so it never gates.
      const rewardFor = (roundId: string, taskId: string): number => {
        const index = taskIndex(taskId);
        if (taskId.startsWith('hout-')) return index < 4 ? 1 : 0;
        if (roundId.startsWith('baseline-')) return index < 10 ? 1 : 0;
        return roundId === 'round-0' ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.equal(result.decisions.length, 2);
      assert.equal(result.decisions[0]?.decision, 'keep');
      assert.equal(result.decisions[0]?.reason, 'held_in_improved');
      assert.equal(result.decisions[1]?.decision, 'discard');
      assert.equal(result.decisions[1]?.reason, 'held_in_regressed');
      assert.equal(result.keptCount, 1);
      assert.equal(result.stopReason, 'rounds_complete');

      // The kept lineage is round-0's candidate; round-1 was rolled back so HEAD
      // and the prompt return to the kept state.
      assert.equal(result.lastKeptCommitSha, result.decisions[0]?.candidateCommitSha);
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      assert.equal(head, result.lastKeptCommitSha);
      assert.equal(await readFile(harness.systemPromptPath, 'utf8'), 'candidate prompt round-0\n');

      assert.equal(result.smoke.status, 'pass');
      assert.deepEqual(result.smoke.decisions, { keep: 1, discard: 1 });
      assert.equal(result.smoke.observedRounds, 2);
      assert.equal(result.smoke.quarantineCount, 0);
      assert.equal(result.smoke.taskEvents.infraFailed, 0);
      assert.equal(result.smoke.taskEvents.plumbingFailed, 0);
    });
  });

  test('discards every candidate when no change beats the noise band, leaving the original prompt', async () => {
    await withHarness(async (harness) => {
      const originalHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      const heldInTasks = makeTasks('hin', 2);
      const heldOutTasks = makeTasks('hout', 1);
      // Flat pass rates every round: held-in stays at 0.5, well within the wide
      // noise band of a two-task partition, so no candidate is ever kept.
      const rewardFor = (_roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        return taskIndex(taskId) === 0 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 2,
        baselineRuns: 2,
      });

      assert.equal(result.keptCount, 0);
      assert.deepEqual(result.decisions.map((decision) => decision.decision), ['discard', 'discard']);
      assert.equal(result.lastKeptCommitSha, originalHead);
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: harness.repoDir })).stdout.trim();
      assert.equal(head, originalHead);
      assert.equal(await readFile(harness.systemPromptPath, 'utf8'), 'original prompt\n');
      // Zero keeps is a passing structural smoke for v1.
      assert.equal(result.smoke.status, 'pass');
      assert.deepEqual(result.smoke.decisions, { keep: 0, discard: 2 });
    });
  });

  test('refuses to run when the held-out TSV would be visible inside the agent cwd', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => 1,
          rounds: 1,
          baselineRuns: 1,
          // Place the held-out TSV inside the agent cwd; the driver must auto-isolate
          // it and the candidate round must reject before exposing held-out results.
          heldOutResultsTsvPath: join(harness.agentCwdPath, 'held-out.tsv'),
        }),
        /controller-only artifacts must stay outside agent cwd/,
      );
    });
  });

  test('stops the loop once the cumulative cost ceiling is reached', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 20);
      const heldOutTasks = makeTasks('hout', 8);
      const rewardFor = (_roundId: string, taskId: string): number => (
        taskIndex(taskId) < (taskId.startsWith('hout-') ? 4 : 10) ? 1 : 0
      );
      // baseline (2 sweeps) costs 2 * 28 * 0.02 = 1.12; round-0 adds 0.56 -> 1.68,
      // tripping a 1.5 ceiling before round-1 runs.
      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        rounds: 3,
        baselineRuns: 2,
        costCeilingUsd: 1.5,
      });

      assert.equal(result.stopReason, 'cost_ceiling_exceeded');
      assert.equal(result.decisions.length, 1);
      assert.ok(result.totalCostUsd >= 1.5);
    });
  });

  test('drops a held-in task that never completes in baseline and calibrates on the rest', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 3);
      const heldOutTasks = makeTasks('hout', 2);
      // hin-2 never completes in any sweep; every other task always does.
      const shouldFail = (_roundId: string, taskId: string): boolean => taskId === 'hin-2';
      const rewardFor = (_roundId: string, taskId: string): number => {
        if (taskId.startsWith('hout-')) return 1;
        return taskIndex(taskId) === 0 ? 1 : 0;
      };

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        shouldFail,
        rounds: 1,
        baselineRuns: 2,
      });

      // The unstable task is dropped; the run still calibrates and finishes.
      assert.deepEqual(result.droppedHeldInTaskIds, ['hin-2']);
      assert.deepEqual(result.droppedHeldOutTaskIds, []);
      assert.equal(result.baseline.heldIn.taskCount, 2);
      assert.equal(result.stopReason, 'rounds_complete');
      assert.equal(result.decisions.length, 1);
      assert.equal(result.smoke.status, 'pass');

      // The dropped task is never swept in the candidate round: only the two
      // stable held-in tasks appear under round-0.
      const wal = await readFile(harness.resultsJsonlPath, 'utf8');
      const roundHeldInTaskIds = wal.trim().split('\n')
        .map((line) => JSON.parse(line) as { roundId?: string; type?: string; taskId?: string })
        .filter((event) => event.roundId === 'round-0' && event.type === 'task_completed' && (event.taskId ?? '').startsWith('hin-'))
        .map((event) => event.taskId);
      assert.deepEqual([...new Set(roundHeldInTaskIds)].sort(), ['hin-0', 'hin-1']);
    });
  });

  test('aborts when no held-in task completes across baseline sweeps', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 2),
          heldOutTasks: makeTasks('hout', 1),
          rewardFor: () => 1,
          shouldFail: (_roundId, taskId) => taskId.startsWith('hin-'),
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in stable task count 0 is below the minimum 1/,
      );
    });
  });

  test('drops a held-in task slower than the duration cap from calibration and rounds', async () => {
    await withHarness(async (harness) => {
      const heldInTasks = makeTasks('hin', 3);
      const heldOutTasks = makeTasks('hout', 2);
      // hin-1 is pathologically slow in baseline; the cap drops it.
      const durationMsFor = (_roundId: string, taskId: string): number => (taskId === 'hin-1' ? 9_000 : 10);
      const rewardFor = (_roundId: string, taskId: string): number => (taskId.startsWith('hout-') ? 1 : taskIndex(taskId) === 0 ? 1 : 0);

      const result = await runLoop(harness, {
        heldInTasks,
        heldOutTasks,
        rewardFor,
        durationMsFor,
        maxStableTaskDurationMs: 1_000,
        rounds: 1,
        baselineRuns: 2,
      });

      assert.deepEqual(result.droppedHeldInTaskIds, ['hin-1']);
      assert.equal(result.baseline.heldIn.taskCount, 2);
      assert.equal(result.stopReason, 'rounds_complete');
      assert.equal(result.smoke.status, 'pass');
    });
  });

  test('aborts when too few held-in tasks survive the minimum-stable floor', async () => {
    await withHarness(async (harness) => {
      await assert.rejects(
        runLoop(harness, {
          heldInTasks: makeTasks('hin', 4),
          heldOutTasks: makeTasks('hout', 2),
          rewardFor: () => 1,
          // Only hin-0 survives; the floor of 3 is not met, so the run fails loud
          // rather than calibrating on an unrepresentative single task.
          shouldFail: (_roundId, taskId) => taskId.startsWith('hin-') && taskId !== 'hin-0',
          minStableHeldInTasks: 3,
          rounds: 1,
          baselineRuns: 1,
        }),
        /held-in stable task count 1 is below the minimum 3 \(4 configured, 3 dropped/,
      );
    });
  });
});

interface Harness {
  repoDir: string;
  controllerDir: string;
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;
  resultsJsonlPath: string;
  heldInResultsTsvPath: string;
  heldOutResultsTsvPath: string;
  eventsDir: string;
  originalCommitSha: string;
}

interface RunLoopOptions {
  heldInTasks: readonly { id: string; path: string }[];
  heldOutTasks: readonly { id: string; path: string }[];
  rewardFor: (roundId: string, taskId: string) => number;
  rounds: number;
  baselineRuns: number;
  costCeilingUsd?: number;
  heldOutResultsTsvPath?: string;
  minStableHeldInTasks?: number;
  maxStableTaskDurationMs?: number;
  /** When it returns true, the runner emits a non-completed (unscored) cell for
   * that task — used to exercise the baseline stability filter. */
  shouldFail?: (roundId: string, taskId: string) => boolean;
  /** Per-task baseline duration (ms); defaults to 10. Exercises the too-slow cap. */
  durationMsFor?: (roundId: string, taskId: string) => number;
}

async function runLoop(harness: Harness, options: RunLoopOptions) {
  const nextId = idFactory();
  let clock = 0;
  const rewardHackVerifierPatternsByTaskId = Object.fromEntries(
    options.heldInTasks.map((task) => [task.id, ['ZZZ_NO_VERIFIER_MATCH']]),
  );
  const input: PromptOptimizationLoopInput = {
    runId: 'run-1',
    rounds: options.rounds,
    baselineRuns: options.baselineRuns,
    agentCwdPath: harness.agentCwdPath,
    programPath: harness.programPath,
    systemPromptPath: harness.systemPromptPath,
    resultsJsonlPath: harness.resultsJsonlPath,
    heldInResultsTsvPath: harness.heldInResultsTsvPath,
    heldOutResultsTsvPath: options.heldOutResultsTsvPath ?? harness.heldOutResultsTsvPath,
    heldInTasks: options.heldInTasks,
    heldOutTasks: options.heldOutTasks,
    config: CONFIG,
    harborRunner: fakeHarborRunner(harness.eventsDir, options.rewardFor, options.shouldFail, options.durationMsFor),
    metaAgent: fakeMetaAgent(),
    git: createCliPromptCandidateGit({ cwd: harness.repoDir, systemPromptPath: harness.systemPromptPath }),
    originalCommitSha: harness.originalCommitSha,
    rewardHackVerifierPatternsByTaskId,
    ...(options.costCeilingUsd !== undefined ? { costCeilingUsd: options.costCeilingUsd } : {}),
    ...(options.minStableHeldInTasks !== undefined ? { minStableHeldInTasks: options.minStableHeldInTasks } : {}),
    ...(options.maxStableTaskDurationMs !== undefined ? { maxStableTaskDurationMs: options.maxStableTaskDurationMs } : {}),
    now: () => (clock += 1),
    newId: nextId,
  };
  return runPromptOptimizationLoop(input);
}

/** A meta-agent that proposes a unique, valid prompt per round (no model). */
function fakeMetaAgent(): MetaAgent {
  return async (promptInput) => ({
    systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
    summary: `tuned for ${promptInput.roundId}`,
  });
}

/** A Harbor runner that fabricates a completed, correctly-hashed cell per task
 * and writes a model-visible runtime-events file the digest/scan can read. */
function fakeHarborRunner(
  eventsDir: string,
  rewardFor: (roundId: string, taskId: string) => number,
  shouldFail?: (roundId: string, taskId: string) => boolean,
  durationMsFor?: (roundId: string, taskId: string) => number,
): (input: HarborTaskRunInput) => Promise<HarborTaskRunOutput> {
  return async ({ roundId, task, systemPrompt }) => {
    const runtimeEventsPath = join(eventsDir, `${roundId}__${task.id}.jsonl`);
    await writeFile(runtimeEventsPath, `${JSON.stringify(modelVisibleEvent())}\n`, 'utf8');
    // A non-completed cell with a correct hash and real (non-zero) cost: scored
    // is false, so the controller records it as an unscored task_completed — not
    // a plumbing failure — which the stability filter drops.
    const failed = shouldFail?.(roundId, task.id) ?? false;
    return {
      harbor: { reward: failed ? 0 : rewardFor(roundId, task.id) },
      cell: {
        schemaVersion: 1,
        status: failed ? 'failed' : 'completed',
        runtimeEventsPath,
        promptHash: hashSystemPrompt(systemPrompt),
        tokenSummary: tokenSummary({ input: 1, output: 2, reasoning: 0, total: 3, costUsd: COST_PER_TASK }),
        toolSummary: {
          providerVisibleToolCount: 1,
          actualToolCalls: 1,
          actualToolNames: ['Bash'],
          actualToolCallCounts: { Bash: 1 },
        },
        steps: 1,
        durationMs: durationMsFor?.(roundId, task.id) ?? 10,
        startedAt: 0,
        finishedAt: 10,
        runtimeRefs: {
          invocationId: `inv-${roundId}-${task.id}`,
          sessionId: `session-${task.id}`,
          runId: 'run-1',
          turnId: `turn-${roundId}`,
        },
      },
    };
  };
}

function modelVisibleEvent(): unknown {
  return {
    id: 'call-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: 'call-1', name: 'Bash', args: { command: 'echo done' } },
  };
}

function makeTasks(prefix: string, count: number): { id: string; path: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    path: `/tasks/${prefix}-${index}`,
  }));
}

function taskIndex(taskId: string): number {
  return Number(taskId.slice(taskId.lastIndexOf('-') + 1));
}

function idFactory(): () => string {
  let counter = 0;
  return () => `id-${(counter += 1)}`;
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-prompt-loop-'));
  try {
    const repoDir = join(root, 'repo');
    const controllerDir = join(root, 'controller');
    const agentCwdPath = join(repoDir, 'agent-cwd');
    const eventsDir = join(controllerDir, 'events');
    await mkdir(repoDir, { recursive: true });
    await mkdir(controllerDir, { recursive: true });
    await mkdir(agentCwdPath, { recursive: true });
    await mkdir(eventsDir, { recursive: true });

    const programPath = join(repoDir, 'program.md');
    const systemPromptPath = join(repoDir, 'system_prompt.md');
    await writeFile(programPath, 'Improve the prompt conservatively.\n', 'utf8');
    await writeFile(systemPromptPath, 'original prompt\n', 'utf8');

    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    await execFileAsync('git', ['add', 'program.md', 'system_prompt.md'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
    const originalCommitSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

    await fn({
      repoDir,
      controllerDir,
      agentCwdPath,
      programPath,
      systemPromptPath,
      resultsJsonlPath: join(controllerDir, 'results.jsonl'),
      heldInResultsTsvPath: join(controllerDir, 'held-in.tsv'),
      heldOutResultsTsvPath: join(controllerDir, 'held-out.tsv'),
      eventsDir,
      originalCommitSha,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
