import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { hashSystemPrompt, type HarborTaskRunInput, type HarborTaskRunOutput } from '../../fixed-prompt-controller.js';
import { createCliPromptCandidateGit, type MetaAgent, type MetaAgentPromptInput } from '../../prompt-candidate-loop.js';
import { runPromptOptimizationLoop, type PromptOptimizationLoopInput } from '../../prompt-optimization-loop.js';
import type { Config } from '../../contracts.js';
import { tokenSummary } from './cell-output-fixtures.js';

export type { MetaAgentPromptInput } from '../../prompt-candidate-loop.js';

export const execFileAsync = promisify(execFile);

const CONFIG: Config = { id: 'cfg', backend: 'fake', llmConnectionSlug: 'deepseek' };
const COST_PER_TASK = 0.02;

export interface Harness {
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

export interface RunLoopOptions {
  runId?: string;
  heldInTasks: readonly { id: string; path: string }[];
  heldOutTasks: readonly { id: string; path: string }[];
  rewardFor: (roundId: string, taskId: string) => number;
  rounds: number;
  baselineRuns: number;
  zScore?: number;
  costCeilingUsd?: number;
  maxInfraFailureRate?: number;
  heldOutResultsTsvPath?: string;
  minStableHeldInTasks?: number;
  maxStableTaskDurationMs?: number;
  /** When it returns true, the runner emits a non-completed (unscored) cell for
   * that task — used to exercise the baseline stability filter. */
  shouldFail?: (roundId: string, taskId: string) => boolean;
  shouldThrowInfra?: (roundId: string, taskId: string) => boolean;
  /** Per-task baseline duration (ms); defaults to 10. Exercises the too-slow cap. */
  durationMsFor?: (roundId: string, taskId: string) => number;
  verifierFailureSummaryFor?: (roundId: string, taskId: string) => string | undefined;
  onTaskRun?: (roundId: string, taskId: string) => void;
  metaAgent?: MetaAgent;
  resumeFingerprint?: string | null;
  rewardHackVerifierPatternsByTaskId?: Readonly<Record<string, readonly string[]>>;
  runtimeEventCommandFor?: (roundId: string, taskId: string) => string | undefined;
}

export async function runLoop(harness: Harness, options: RunLoopOptions) {
  const nextId = idFactory();
  let clock = 0;
  const rewardHackVerifierPatternsByTaskId = Object.fromEntries(
    options.heldInTasks.map((task) => [task.id, ['ZZZ_NO_VERIFIER_MATCH']]),
  );
  const input: PromptOptimizationLoopInput = {
    runId: options.runId ?? 'run-1',
    rounds: options.rounds,
    baselineRuns: options.baselineRuns,
    ...(options.zScore !== undefined ? { zScore: options.zScore } : {}),
    agentCwdPath: harness.agentCwdPath,
    programPath: harness.programPath,
    systemPromptPath: harness.systemPromptPath,
    resultsJsonlPath: harness.resultsJsonlPath,
    heldInResultsTsvPath: harness.heldInResultsTsvPath,
    heldOutResultsTsvPath: options.heldOutResultsTsvPath ?? harness.heldOutResultsTsvPath,
    heldInTasks: options.heldInTasks,
    heldOutTasks: options.heldOutTasks,
    config: CONFIG,
    harborRunner: fakeHarborRunner(
      harness.eventsDir,
      options.rewardFor,
      options.shouldFail,
      options.shouldThrowInfra,
      options.durationMsFor,
      options.verifierFailureSummaryFor,
      options.onTaskRun,
      options.runtimeEventCommandFor,
    ),
    metaAgent: options.metaAgent ?? fakeMetaAgent(),
    git: createCliPromptCandidateGit({ cwd: harness.repoDir, systemPromptPath: harness.systemPromptPath }),
    rewardHackVerifierPatternsByTaskId: options.rewardHackVerifierPatternsByTaskId
      ?? rewardHackVerifierPatternsByTaskId,
    ...(options.resumeFingerprint !== null ? { resumeFingerprint: options.resumeFingerprint ?? 'fingerprint-test' } : {}),
    ...(options.costCeilingUsd !== undefined ? { costCeilingUsd: options.costCeilingUsd } : {}),
    ...(options.maxInfraFailureRate !== undefined ? { maxInfraFailureRate: options.maxInfraFailureRate } : {}),
    ...(options.minStableHeldInTasks !== undefined ? { minStableHeldInTasks: options.minStableHeldInTasks } : {}),
    ...(options.maxStableTaskDurationMs !== undefined ? { maxStableTaskDurationMs: options.maxStableTaskDurationMs } : {}),
    now: () => (clock += 1),
    newId: nextId,
  };
  return runPromptOptimizationLoop(input);
}

/** A meta-agent that proposes a unique, valid prompt per round (no model). */
export function fakeMetaAgent(): MetaAgent {
  return async (promptInput) => {
    const evidenceRefs = evidenceRefsFor(promptInput);
    return {
      systemPrompt: `candidate prompt ${promptInput.roundId}\n`,
      summary: `tuned for ${promptInput.roundId}`,
      candidateRationale: {
        editedSurface: 'system_prompt',
        evidenceRefs,
        hypothesis: 'stable held-in coverage can improve with a clearer prompt',
        targetedFix: 'make the success criteria explicit without adding task-specific answers',
        predictedFixes: [],
        riskTasks: [],
        ...(evidenceRefs.length === 0 ? { failurePattern: 'coverage_regression' as const } : {}),
      },
    };
  };
}

export function evidenceRefsFor(promptInput: MetaAgentPromptInput): string[] {
  const signal = promptInput.rsiAnalysis?.signals.find((item) => item.kind === 'coverage_regression')
    ?? promptInput.rsiAnalysis?.signals[0];
  return signal ? [signal.id] : [];
}

/** A Harbor runner that fabricates a completed, correctly-hashed cell per task
 * and writes a model-visible runtime-events file the digest/scan can read. */
function fakeHarborRunner(
  eventsDir: string,
  rewardFor: (roundId: string, taskId: string) => number,
  shouldFail?: (roundId: string, taskId: string) => boolean,
  shouldThrowInfra?: (roundId: string, taskId: string) => boolean,
  durationMsFor?: (roundId: string, taskId: string) => number,
  verifierFailureSummaryFor?: (roundId: string, taskId: string) => string | undefined,
  onTaskRun?: (roundId: string, taskId: string) => void,
  runtimeEventCommandFor?: (roundId: string, taskId: string) => string | undefined,
): (input: HarborTaskRunInput) => Promise<HarborTaskRunOutput> {
  return async ({ roundId, task, systemPrompt }) => {
    onTaskRun?.(roundId, task.id);
    if (shouldThrowInfra?.(roundId, task.id)) {
      throw new Error(`container crashed for ${roundId}/${task.id}`);
    }
    const runtimeEventsPath = join(eventsDir, `${roundId}__${task.id}.jsonl`);
    await writeFile(
      runtimeEventsPath,
      `${JSON.stringify(modelVisibleEvent(runtimeEventCommandFor?.(roundId, task.id) ?? 'echo done'))}\n`,
      'utf8',
    );
    // A non-completed cell with a correct hash and real (non-zero) cost: scored
    // is false, so the controller records it as an unscored task_completed — not
    // a plumbing failure — which the stability filter drops.
    const failed = shouldFail?.(roundId, task.id) ?? false;
    const verifierFailureSummary = verifierFailureSummaryFor?.(roundId, task.id);
    return {
      harbor: {
        reward: failed ? 0 : rewardFor(roundId, task.id),
        ...(verifierFailureSummary ? { verifierFailureSummary } : {}),
      },
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

function modelVisibleEvent(command: string): unknown {
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
    content: { kind: 'function_call', id: 'call-1', name: 'Bash', args: { command } },
  };
}

export function makeTasks(prefix: string, count: number): { id: string; path: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    path: `/tasks/${prefix}-${index}`,
  }));
}

export function taskIndex(taskId: string): number {
  return Number(taskId.slice(taskId.lastIndexOf('-') + 1));
}

function idFactory(): () => string {
  let counter = 0;
  return () => `id-${(counter += 1)}`;
}

export async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
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
