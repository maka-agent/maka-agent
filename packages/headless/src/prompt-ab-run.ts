import {
  runFixedPromptController,
  type FixedPromptTask,
  type FixedPromptTaskWalEvent,
} from './fixed-prompt-controller.js';
import { assertPositiveInt } from './numeric-guards.js';
import { summarizePromptAbComparison } from './prompt-ab-summary.js';
import type {
  PromptAbComparisonSummary,
  RunPromptAbComparisonInput,
} from './prompt-ab-types.js';

export type * from './prompt-ab-types.js';
export {
  buildPromptAbRunManifest,
  ensurePromptAbRunManifest,
} from './prompt-ab-manifest.js';
export {
  renderPromptAbComparisonMarkdown,
} from './prompt-ab-render.js';
export {
  filterPromptAbCandidateTasksByMetadata,
  limitPromptAbCandidateTasks,
} from './prompt-ab-selection.js';
export {
  summarizePromptAbComparison,
} from './prompt-ab-summary.js';

export async function runPromptAbComparison(input: RunPromptAbComparisonInput): Promise<PromptAbComparisonSummary> {
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

  return summarizePromptAbComparison({
    runId: input.runId,
    roundId: 'ab-summary',
    baselinePromptId: 'maka-baseline',
    candidatePromptId: input.candidatePromptId ?? 'candidate',
    evaluationTaskIds: input.evaluationTasks.map((task) => task.id),
    baselineRuns,
    candidateRuns,
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
  });
}

async function runComparisonPair(
  input: RunPromptAbComparisonInput,
  pair: { rep: number; taskIndex: number; task: FixedPromptTask },
): Promise<{ rep: number; baseline: FixedPromptTaskWalEvent; candidate: FixedPromptTaskWalEvent }> {
  let baseline: FixedPromptTaskWalEvent | undefined;
  let candidate: FixedPromptTaskWalEvent | undefined;
  const runBaseline = async () => {
    baseline = await runComparisonTaskArm({
      input,
      task: pair.task,
      promptPath: input.baselinePromptPath,
      promptLabel: 'baseline',
      rep: pair.rep,
    });
  };
  const runCandidate = async () => {
    candidate = await runComparisonTaskArm({
      input,
      task: pair.task,
      promptPath: input.candidatePromptPath,
      promptLabel: 'candidate',
      rep: pair.rep,
    });
  };
  if ((pair.rep + pair.taskIndex) % 2 === 0) {
    await runBaseline();
    await runCandidate();
  } else {
    await runCandidate();
    await runBaseline();
  }
  if (!baseline || !candidate) throw new Error(`prompt A/B pair did not produce both arms for ${pair.task.id} rep ${pair.rep}`);
  return { rep: pair.rep, baseline, candidate };
}

async function runComparisonTaskArm(input: {
  input: RunPromptAbComparisonInput;
  task: FixedPromptTask;
  promptPath: string;
  promptLabel: string;
  rep: number;
}): Promise<FixedPromptTaskWalEvent> {
  const roundId = `ab-${input.promptLabel}-r${input.rep}-${roundIdTaskSuffix(input.task.id)}`;
  const result = await runFixedPromptController({
    runId: input.input.runId,
    roundId,
    config: input.input.config,
    systemPromptPath: input.promptPath,
    resultsJsonlPath: input.input.resultsJsonlPath,
    resultsTsvPath: `${input.input.resultsJsonlPath}.${roundId}.tsv`,
    tasks: [input.task],
    ...(input.input.resumeFingerprint ? { resumeFingerprint: input.input.resumeFingerprint } : {}),
    harborRunner: input.input.harborRunner,
    ...(input.input.now ? { now: input.input.now } : {}),
    ...(input.input.newId ? { newId: input.input.newId } : {}),
  });
  const event = result.events.find((candidate) => candidate.taskId === input.task.id);
  if (!event) throw new Error(`prompt A/B arm ${roundId} produced no event for ${input.task.id}`);
  return event;
}

function roundIdTaskSuffix(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}
