import type {
  AbArmSpec,
  AbComparisonSummary,
  RunAbComparisonInput,
} from './ab-types.js';
import type {
  FixedPromptTask,
  FixedPromptTaskWalEvent,
} from './fixed-prompt-controller.js';
import { assertPositiveInt } from './numeric-guards.js';
import { summarizeAbComparison } from './ab-summary.js';

export async function runAbComparison(input: RunAbComparisonInput): Promise<AbComparisonSummary> {
  assertUniqueArmRoundIdSuffixes(input.arms);
  const reps = input.reps ?? 3;
  assertPositiveInt('reps', reps);
  const maxConcurrency = input.maxConcurrency !== undefined ? assertPositiveInt('maxConcurrency', input.maxConcurrency) : 1;
  const baselineRuns: FixedPromptTaskWalEvent[][] = Array.from({ length: reps }, () => []);
  const candidateRuns: FixedPromptTaskWalEvent[][] = Array.from({ length: reps }, () => []);
  const pairs: { rep: number; taskIndex: number; task: FixedPromptTask }[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    input.evaluationTasks.forEach((task, taskIndex) => pairs.push({ rep, taskIndex, task }));
  }

  let nextPairIndex = 0;
  const active = new Map<number, Promise<{
    pairIndex: number;
    rep: number;
    baseline: FixedPromptTaskWalEvent;
    candidate: FixedPromptTaskWalEvent;
  }>>();
  const launchReadyPairs = () => {
    while (active.size < maxConcurrency && nextPairIndex < pairs.length) {
      const pairIndex = nextPairIndex;
      const pair = pairs[nextPairIndex++]!;
      active.set(pairIndex, runComparisonPair(input, pair).then((result) => ({ pairIndex, ...result })));
    }
  };

  launchReadyPairs();
  while (active.size > 0) {
    const result = await Promise.race(active.values());
    active.delete(result.pairIndex);
    baselineRuns[result.rep]!.push(result.baseline);
    candidateRuns[result.rep]!.push(result.candidate);
    launchReadyPairs();
  }
  const taskOrder = new Map(input.evaluationTasks.map((task, index) => [task.id, index]));
  for (const run of [...baselineRuns, ...candidateRuns]) {
    run.sort((a, b) => (taskOrder.get(a.taskId) ?? 0) - (taskOrder.get(b.taskId) ?? 0));
  }

  return summarizeAbComparison({
    runId: input.runId,
    roundId: 'ab-summary',
    baselineArmId: input.arms[0].id,
    candidateArmId: input.arms[1].id,
    evaluationTaskIds: input.evaluationTasks.map((task) => task.id),
    baselineRuns,
    candidateRuns,
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
  });
}

async function runComparisonPair(
  input: RunAbComparisonInput,
  pair: { rep: number; taskIndex: number; task: FixedPromptTask },
): Promise<{ rep: number; baseline: FixedPromptTaskWalEvent; candidate: FixedPromptTaskWalEvent }> {
  let baseline: FixedPromptTaskWalEvent | undefined;
  let candidate: FixedPromptTaskWalEvent | undefined;
  const runBaseline = async () => {
    baseline = await runComparisonTaskArm(input, input.arms[0], pair);
  };
  const runCandidate = async () => {
    candidate = await runComparisonTaskArm(input, input.arms[1], pair);
  };
  if ((pair.rep + pair.taskIndex) % 2 === 0) {
    await runBaseline();
    await runCandidate();
  } else {
    await runCandidate();
    await runBaseline();
  }
  if (!baseline || !candidate) throw new Error(`A/B pair did not produce both arms for ${pair.task.id} rep ${pair.rep}`);
  return { rep: pair.rep, baseline, candidate };
}

async function runComparisonTaskArm(
  input: RunAbComparisonInput,
  arm: AbArmSpec,
  pair: { rep: number; task: FixedPromptTask },
): Promise<FixedPromptTaskWalEvent> {
  const roundId = `ab-${roundIdArmSuffix(arm.id)}-r${pair.rep}-${roundIdTaskSuffix(pair.task.id)}`;
  const event = await input.runArm({
    runId: input.runId,
    roundId,
    arm,
    task: pair.task,
    rep: pair.rep,
  });
  if (event.taskId !== pair.task.id) throw new Error(`A/B arm ${roundId} produced event for ${event.taskId}, expected ${pair.task.id}`);
  return event;
}

function roundIdArmSuffix(armId: string): string {
  return armId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'arm';
}

function assertUniqueArmRoundIdSuffixes(arms: readonly AbArmSpec[]): void {
  const suffixes = new Map<string, string>();
  for (const arm of arms) {
    const suffix = roundIdArmSuffix(arm.id);
    const existingArmId = suffixes.get(suffix);
    if (existingArmId !== undefined) {
      throw new Error(`A/B arm ids must produce unique round id suffixes: ${JSON.stringify(existingArmId)} and ${JSON.stringify(arm.id)} both map to ${JSON.stringify(suffix)}`);
    }
    suffixes.set(suffix, arm.id);
  }
}

function roundIdTaskSuffix(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}
