import type { Config } from './contracts.js';
import {
  runFixedPromptController,
  type FixedPromptTask,
  type FixedPromptTaskWalEvent,
  type HarborTaskRunner,
} from './fixed-prompt-controller.js';
import { assertPositiveInt } from './numeric-guards.js';

export interface PromptAbConcurrencyCalibrationPlanInput {
  tasks: readonly FixedPromptTask[];
  taskDurationsMs?: Readonly<Record<string, number>>;
  samplesPerBucket?: number;
  concurrencyLevels?: readonly number[];
  repsPerLevel?: number;
}

export interface PromptAbConcurrencyCalibrationTrial {
  concurrency: number;
  rep: number;
  task: FixedPromptTask;
}

export interface PromptAbConcurrencyCalibrationPlan {
  sampleTasks: FixedPromptTask[];
  concurrencyLevels: number[];
  repsPerLevel: number;
  trials: PromptAbConcurrencyCalibrationTrial[];
}

export interface RunPromptAbConcurrencyCalibrationInput extends PromptAbConcurrencyCalibrationPlanInput {
  runId: string;
  config: Config;
  systemPromptPath: string;
  resultsJsonlPath: string;
  maxInfraFailureRate?: number;
  harborRunner: HarborTaskRunner;
  now?: () => number;
  newId?: () => string;
}

export interface PromptAbConcurrencyLevelSummary {
  concurrency: number;
  attempts: number;
  completed: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  totalCostUsd: number;
  meanDurationMs: number | null;
  maxDurationMs: number | null;
}

export interface PromptAbConcurrencyCalibrationResult {
  runId: string;
  sampleTaskIds: string[];
  levels: PromptAbConcurrencyLevelSummary[];
  recommendedConcurrency: number;
}

export interface SummarizePromptAbComparisonInput {
  runId: string;
  roundId: string;
  baselinePromptId: string;
  candidatePromptId: string;
  evaluationTaskIds: readonly string[];
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  budgetMs?: number;
}

export interface RunPromptAbComparisonInput {
  runId: string;
  config: Config;
  baselinePromptPath: string;
  candidatePromptPath: string;
  candidatePromptId?: string;
  resultsJsonlPath: string;
  evaluationTasks: readonly FixedPromptTask[];
  reps?: number;
  maxConcurrency?: number;
  budgetMs?: number;
  harborRunner: HarborTaskRunner;
  now?: () => number;
  newId?: () => string;
}

export type PromptAbDecision =
  | 'candidate_better'
  | 'baseline_better'
  | 'inconclusive';

export interface PromptAbArmSummary {
  attempts: number;
  observed: number;
  valid: number;
  passed: number;
  passRate: number | null;
  completed: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  missing: number;
  coverageRate: number;
  totalCostUsd: number;
  meanDurationMs: number | null;
}

export interface PromptAbTaskArmSummary {
  observed: number;
  valid: number;
  passed: number;
  passRate: number | null;
  completed: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  missing: number;
}

export interface PromptAbTaskComparison {
  taskId: string;
  baseline: PromptAbTaskArmSummary;
  candidate: PromptAbTaskArmSummary;
  passRateDelta: number | null;
  outcome: 'candidate_win' | 'baseline_win' | 'tie' | 'missing';
}

export interface PromptAbTaskLevelSummary {
  comparableTasks: number;
  wins: number;
  losses: number;
  ties: number;
  signTestNonTieTasks: number;
  signTestPValue: number | null;
  missingTaskIds: string[];
  meanPassRateDelta: number | null;
  medianPassRateDelta: number | null;
  tasks: PromptAbTaskComparison[];
}

export interface PromptAbAttemptPairSummary {
  pairs: number;
  observedPairs: number;
  wins: number;
  losses: number;
  ties: number;
  missingPairIds: string[];
  budgetDiscordantPairIds: string[];
  infraOrPlumbingDiscordantPairIds: string[];
}

export interface PromptAbComparisonSummary {
  runId: string;
  roundId: string;
  baselinePromptId: string;
  candidatePromptId: string;
  taskCount: number;
  reps: number;
  budgetMs?: number;
  decision: PromptAbDecision;
  reason: string;
  baseline: PromptAbArmSummary;
  candidate: PromptAbArmSummary;
  taskLevel: PromptAbTaskLevelSummary;
  pairedAttempts: PromptAbAttemptPairSummary;
}

export interface PromptAbMetadataFilterInput {
  tasks: readonly FixedPromptTask[];
  maxExpertTimeEstimateMin?: number;
}

export interface PromptAbMetadataFilterResult {
  maxExpertTimeEstimateMin: number;
  candidateTaskCount: number;
  selectedTaskIds: string[];
  selectedTasks: FixedPromptTask[];
  rejected: {
    longExpertEstimateTaskIds: string[];
    missingExpertEstimateTaskIds: string[];
  };
}

export interface PromptAbCandidateTaskLimitResult {
  limit: number | null;
  inputTaskCount: number;
  selectedTaskIds: string[];
  selectedTasks: FixedPromptTask[];
  truncatedTaskIds: string[];
}

export interface RunPromptAbTaskQualificationInput {
  runId: string;
  config: Config;
  baselinePromptPath: string;
  resultsJsonlPath: string;
  candidateTasks: readonly FixedPromptTask[];
  reps?: number;
  targetTaskCount?: number;
  minPasses?: number;
  maxPasses?: number;
  maxConcurrency?: number;
  harborRunner: HarborTaskRunner;
  now?: () => number;
  newId?: () => string;
}

export interface PromptAbQualifiedTaskSummary {
  taskId: string;
  passed: number;
  valid: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  missing: number;
  classification: 'medium' | 'easy' | 'hard' | 'invalid';
}

export interface PromptAbTaskQualificationResult {
  runId: string;
  reps: number;
  targetTaskCount: number;
  candidateTaskCount: number;
  selectedTaskIds: string[];
  selectedTasks: FixedPromptTask[];
  shortage: number;
  tasks: PromptAbQualifiedTaskSummary[];
  rejected: {
    easyTaskIds: string[];
    hardTaskIds: string[];
    infraOrInvalidTaskIds: string[];
    overflowTaskIds: string[];
  };
  runs: FixedPromptTaskWalEvent[][];
}

export function planPromptAbConcurrencyCalibration(
  input: PromptAbConcurrencyCalibrationPlanInput,
): PromptAbConcurrencyCalibrationPlan {
  const samplesPerBucket = input.samplesPerBucket ?? 2;
  const repsPerLevel = input.repsPerLevel ?? 1;
  assertPositiveInt('samplesPerBucket', samplesPerBucket);
  assertPositiveInt('repsPerLevel', repsPerLevel);
  const concurrencyLevels = [...(input.concurrencyLevels ?? [1, 2, 4, 8, 12, 16])];
  for (const level of concurrencyLevels) assertPositiveInt('concurrencyLevel', level);

  const sampleTasks = representativeTasks(input.tasks, input.taskDurationsMs ?? {}, samplesPerBucket);
  const trials: PromptAbConcurrencyCalibrationTrial[] = [];
  for (const concurrency of concurrencyLevels) {
    for (let rep = 0; rep < repsPerLevel; rep += 1) {
      for (const task of sampleTasks) {
        trials.push({ concurrency, rep, task });
      }
    }
  }

  return { sampleTasks, concurrencyLevels, repsPerLevel, trials };
}

export function filterPromptAbCandidateTasksByMetadata(
  input: PromptAbMetadataFilterInput,
): PromptAbMetadataFilterResult {
  const maxExpertTimeEstimateMin = input.maxExpertTimeEstimateMin ?? 30;
  if (!Number.isFinite(maxExpertTimeEstimateMin) || maxExpertTimeEstimateMin <= 0) {
    throw new Error(`maxExpertTimeEstimateMin must be positive (got ${String(maxExpertTimeEstimateMin)})`);
  }
  const selectedTasks: FixedPromptTask[] = [];
  const longExpertEstimateTaskIds: string[] = [];
  const missingExpertEstimateTaskIds: string[] = [];
  for (const task of input.tasks) {
    const expertTimeEstimateMin = task.metadata?.expertTimeEstimateMin;
    if (expertTimeEstimateMin === undefined) {
      missingExpertEstimateTaskIds.push(task.id);
    } else if (expertTimeEstimateMin > maxExpertTimeEstimateMin) {
      longExpertEstimateTaskIds.push(task.id);
    } else {
      selectedTasks.push(task);
    }
  }
  return {
    maxExpertTimeEstimateMin,
    candidateTaskCount: input.tasks.length,
    selectedTaskIds: selectedTasks.map((task) => task.id),
    selectedTasks,
    rejected: {
      longExpertEstimateTaskIds,
      missingExpertEstimateTaskIds,
    },
  };
}

export function limitPromptAbCandidateTasks(
  tasks: readonly FixedPromptTask[],
  limit: number | undefined,
): PromptAbCandidateTaskLimitResult {
  const selectedTasks = limit === undefined ? [...tasks] : tasks.slice(0, limit);
  return {
    limit: limit ?? null,
    inputTaskCount: tasks.length,
    selectedTaskIds: selectedTasks.map((task) => task.id),
    selectedTasks,
    truncatedTaskIds: tasks.slice(selectedTasks.length).map((task) => task.id),
  };
}

export async function runPromptAbConcurrencyCalibration(
  input: RunPromptAbConcurrencyCalibrationInput,
): Promise<PromptAbConcurrencyCalibrationResult> {
  const maxInfraFailureRate = input.maxInfraFailureRate ?? 0;
  assertZeroToOne('maxInfraFailureRate', maxInfraFailureRate);
  const plan = planPromptAbConcurrencyCalibration(input);
  const levels: PromptAbConcurrencyLevelSummary[] = [];

  for (const concurrency of plan.concurrencyLevels) {
    const events: FixedPromptTaskWalEvent[] = [];
    for (let rep = 0; rep < plan.repsPerLevel; rep += 1) {
      const roundId = calibrationRoundId(concurrency, rep);
      const result = await runFixedPromptController({
        runId: input.runId,
        roundId,
        config: input.config,
        systemPromptPath: input.systemPromptPath,
        resultsJsonlPath: input.resultsJsonlPath,
        resultsTsvPath: `${input.resultsJsonlPath}.${roundId}.tsv`,
        tasks: plan.sampleTasks,
        maxConcurrency: concurrency,
        harborRunner: input.harborRunner,
        ...(input.now ? { now: input.now } : {}),
        ...(input.newId ? { newId: input.newId } : {}),
      });
      events.push(...result.events);
    }
    levels.push(summarizeConcurrencyLevel(concurrency, events));
  }

  const passing = levels.filter((level) => level.attempts > 0 && level.infraFailed / level.attempts <= maxInfraFailureRate);
  const recommendedConcurrency = passing.at(-1)?.concurrency ?? plan.concurrencyLevels[0] ?? 1;
  return {
    runId: input.runId,
    sampleTaskIds: plan.sampleTasks.map((task) => task.id),
    levels,
    recommendedConcurrency,
  };
}

export async function runPromptAbTaskQualification(
  input: RunPromptAbTaskQualificationInput,
): Promise<PromptAbTaskQualificationResult> {
  const reps = input.reps ?? 3;
  const targetTaskCount = input.targetTaskCount ?? 30;
  const minPasses = input.minPasses ?? 1;
  const maxPasses = input.maxPasses ?? reps - 1;
  assertPositiveInt('reps', reps);
  assertPositiveInt('targetTaskCount', targetTaskCount);
  assertPositiveInt('minPasses', minPasses);
  assertPositiveInt('maxPasses', maxPasses);
  if (minPasses > maxPasses) throw new Error('minPasses must be <= maxPasses');
  if (input.maxConcurrency !== undefined) assertPositiveInt('maxConcurrency', input.maxConcurrency);

  const runs: FixedPromptTaskWalEvent[][] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const roundId = `ab-qualification-r${rep}`;
    const result = await runFixedPromptController({
      runId: input.runId,
      roundId,
      config: input.config,
      systemPromptPath: input.baselinePromptPath,
      resultsJsonlPath: input.resultsJsonlPath,
      resultsTsvPath: `${input.resultsJsonlPath}.${roundId}.tsv`,
      tasks: input.candidateTasks,
      harborRunner: input.harborRunner,
      ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.newId ? { newId: input.newId } : {}),
    });
    runs.push(result.events);
  }

  const summaries = input.candidateTasks.map((task) => {
    const arm = summarizeTaskArm(task.id, runs, reps);
    return {
      taskId: task.id,
      passed: arm.passed,
      valid: arm.valid,
      budgetExhausted: arm.budgetExhausted,
      infraFailed: arm.infraFailed,
      plumbingFailed: arm.plumbingFailed,
      missing: arm.missing,
      classification: classifyQualificationTask(arm, reps, minPasses, maxPasses),
    };
  });
  const mediumTaskIds = summaries
    .filter((summary) => summary.classification === 'medium')
    .map((summary) => summary.taskId);
  const selectedTaskIds = mediumTaskIds.slice(0, targetTaskCount);
  const selected = new Set(selectedTaskIds);
  const byId = new Map(input.candidateTasks.map((task) => [task.id, task]));
  return {
    runId: input.runId,
    reps,
    targetTaskCount,
    candidateTaskCount: input.candidateTasks.length,
    selectedTaskIds,
    selectedTasks: selectedTaskIds.map((taskId) => byId.get(taskId)).filter((task): task is FixedPromptTask => task !== undefined),
    shortage: Math.max(0, targetTaskCount - selectedTaskIds.length),
    tasks: summaries,
    rejected: {
      easyTaskIds: summaries.filter((summary) => summary.classification === 'easy').map((summary) => summary.taskId),
      hardTaskIds: summaries.filter((summary) => summary.classification === 'hard').map((summary) => summary.taskId),
      infraOrInvalidTaskIds: summaries.filter((summary) => summary.classification === 'invalid').map((summary) => summary.taskId),
      overflowTaskIds: mediumTaskIds.filter((taskId) => !selected.has(taskId)),
    },
    runs,
  };
}

export function summarizePromptAbComparison(input: SummarizePromptAbComparisonInput): PromptAbComparisonSummary {
  assertSameRunCount(input.baselineRuns, input.candidateRuns);
  const reps = input.baselineRuns.length;
  const taskIds = [...input.evaluationTaskIds];
  const baseline = summarizeArm(input.baselineRuns, taskIds, reps);
  const candidate = summarizeArm(input.candidateRuns, taskIds, reps);
  const taskLevel = summarizeTasks(input.baselineRuns, input.candidateRuns, taskIds, reps);
  const pairedAttempts = summarizeAttemptPairs(input.baselineRuns, input.candidateRuns, taskIds);
  const { decision, reason } = decide(taskLevel, baseline, candidate, pairedAttempts);

  return {
    runId: input.runId,
    roundId: input.roundId,
    baselinePromptId: input.baselinePromptId,
    candidatePromptId: input.candidatePromptId,
    taskCount: taskIds.length,
    reps,
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    decision,
    reason,
    baseline,
    candidate,
    taskLevel,
    pairedAttempts,
  };
}

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

export function renderPromptAbComparisonMarkdown(summary: PromptAbComparisonSummary): string {
  const lines = [
    '# Prompt A/B Comparison',
    '',
    `- Baseline A: ${summary.baselinePromptId}`,
    `- Candidate B: ${summary.candidatePromptId}`,
    `- Evaluation tasks: ${summary.taskCount}`,
    `- Reps: ${summary.reps}`,
    `- Decision: ${decisionLabel(summary.decision)} (${summary.reason})`,
    `- Budget: ${summary.budgetMs !== undefined ? `${Math.round(summary.budgetMs / 1000)}s task budget` : 'not recorded'}`,
    `- Evaluation pass rate: A=${summary.baseline.passed}/${summary.baseline.valid} = ${rate(summary.baseline.passRate)}, B=${summary.candidate.passed}/${summary.candidate.valid} = ${rate(summary.candidate.passRate)}`,
    `- Task-level delta: mean=${rate(summary.taskLevel.meanPassRateDelta)}, median=${rate(summary.taskLevel.medianPassRateDelta)}, wins=${summary.taskLevel.wins}, losses=${summary.taskLevel.losses}, ties=${summary.taskLevel.ties}, sign_test_p=${rate(summary.taskLevel.signTestPValue)}, missing=${summary.taskLevel.missingTaskIds.length}`,
    `- Attempt-pair auxiliary: wins=${summary.pairedAttempts.wins}, losses=${summary.pairedAttempts.losses}, ties=${summary.pairedAttempts.ties}, missing=${summary.pairedAttempts.missingPairIds.length}`,
    `- Budget outcomes: A timed_out=${summary.baseline.budgetExhausted}, B timed_out=${summary.candidate.budgetExhausted}`,
    `- Infra outcomes: A infra_failed=${summary.baseline.infraFailed}, B infra_failed=${summary.candidate.infraFailed}; A plumbing_failed=${summary.baseline.plumbingFailed}, B plumbing_failed=${summary.candidate.plumbingFailed}`,
    '',
    '## Limitation',
    '',
    'This result is scoped to the recorded task budget. Timeouts are budget outcomes, not infrastructure failures; improvements that only appear with longer trajectories require a separate long-task sensitivity slice.',
    '',
  ];
  if (summary.taskLevel.missingTaskIds.length > 0) {
    lines.push('## Missing Tasks', '', ...summary.taskLevel.missingTaskIds.map((taskId) => `- ${taskId}`), '');
  }
  const losses = summary.taskLevel.tasks.filter((task) => task.outcome === 'baseline_win');
  if (losses.length > 0) {
    lines.push('## B Losses', '', ...losses.map((task) => `- ${task.taskId}: delta=${rate(task.passRateDelta)}`), '');
  }
  return `${lines.join('\n')}\n`;
}

function representativeTasks(
  tasks: readonly FixedPromptTask[],
  taskDurationsMs: Readonly<Record<string, number>>,
  samplesPerBucket: number,
): FixedPromptTask[] {
  const sorted = [...tasks].sort((a, b) => {
    const durationDelta = durationFor(a, taskDurationsMs) - durationFor(b, taskDurationsMs);
    return durationDelta === 0 ? a.id.localeCompare(b.id) : durationDelta;
  });
  const buckets: FixedPromptTask[][] = [[], [], []];
  sorted.forEach((task, index) => {
    const bucket = Math.min(2, Math.floor(index * 3 / Math.max(1, sorted.length)));
    buckets[bucket]!.push(task);
  });

  const selected = new Map<string, FixedPromptTask>();
  for (const bucket of buckets) {
    for (const task of bucket.slice(0, samplesPerBucket)) {
      selected.set(task.id, task);
    }
  }
  return [...selected.values()];
}

function durationFor(task: FixedPromptTask, taskDurationsMs: Readonly<Record<string, number>>): number {
  const duration = taskDurationsMs[task.id];
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
    ? duration
    : Number.MAX_SAFE_INTEGER;
}

function calibrationRoundId(concurrency: number, rep: number): string {
  return `calibration-c${concurrency}-r${rep}`;
}

function summarizeConcurrencyLevel(
  concurrency: number,
  events: readonly FixedPromptTaskWalEvent[],
): PromptAbConcurrencyLevelSummary {
  const timed = events.filter((event) => event.type !== 'task_infra_failed' && event.type !== 'task_budget_exhausted');
  const durations = timed.map((event) => event.durationMs);
  return {
    concurrency,
    attempts: events.length,
    completed: events.filter((event) => event.type === 'task_completed').length,
    budgetExhausted: events.filter((event) => event.type === 'task_budget_exhausted').length,
    infraFailed: events.filter((event) => event.type === 'task_infra_failed').length,
    plumbingFailed: events.filter((event) => event.type === 'task_plumbing_failed').length,
    totalCostUsd: sum(timed.map((event) => event.tokenSummary.costUsd)),
    meanDurationMs: durations.length > 0 ? sum(durations) / durations.length : null,
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : null,
  };
}

function summarizeArm(
  runs: readonly (readonly FixedPromptTaskWalEvent[])[],
  taskIds: readonly string[],
  reps: number,
): PromptAbArmSummary {
  const attempts = taskIds.length * reps;
  const events = taskIds.flatMap((taskId) => runs.map((run) => run.find((event) => event.taskId === taskId)));
  const observed = events.filter((event): event is FixedPromptTaskWalEvent => event !== undefined);
  const valid = observed.filter(isValidBudgetedOutcome);
  const passed = valid.filter((event) => event.passed).length;
  const durations = valid
    .filter((event) => event.type !== 'task_budget_exhausted')
    .map((event) => event.durationMs);
  return {
    attempts,
    observed: observed.length,
    valid: valid.length,
    passed,
    passRate: valid.length > 0 ? passed / valid.length : null,
    completed: observed.filter((event) => event.type === 'task_completed').length,
    budgetExhausted: observed.filter((event) => event.type === 'task_budget_exhausted').length,
    infraFailed: observed.filter((event) => event.type === 'task_infra_failed').length,
    plumbingFailed: observed.filter((event) => event.type === 'task_plumbing_failed').length,
    missing: attempts - observed.length,
    coverageRate: attempts > 0 ? valid.length / attempts : 1,
    totalCostUsd: sum(valid.filter((event) => event.type !== 'task_budget_exhausted').map((event) => event.tokenSummary.costUsd)),
    meanDurationMs: durations.length > 0 ? sum(durations) / durations.length : null,
  };
}

function summarizeTasks(
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  taskIds: readonly string[],
  reps: number,
): PromptAbTaskLevelSummary {
  const tasks = taskIds.map((taskId) => summarizeTask(taskId, baselineRuns, candidateRuns, reps));
  const comparable = tasks.filter((task) => task.passRateDelta !== null);
  const deltas = comparable.map((task) => task.passRateDelta as number);
  const wins = comparable.filter((task) => task.outcome === 'candidate_win').length;
  const losses = comparable.filter((task) => task.outcome === 'baseline_win').length;
  const ties = comparable.filter((task) => task.outcome === 'tie').length;
  const signTestNonTieTasks = wins + losses;
  return {
    comparableTasks: comparable.length,
    wins,
    losses,
    ties,
    signTestNonTieTasks,
    signTestPValue: signTestNonTieTasks > 0 ? exactTwoSidedSignTestPValue(signTestNonTieTasks, Math.max(wins, losses)) : null,
    missingTaskIds: tasks.filter((task) => task.outcome === 'missing').map((task) => task.taskId),
    meanPassRateDelta: deltas.length > 0 ? sum(deltas) / deltas.length : null,
    medianPassRateDelta: median(deltas),
    tasks,
  };
}

function summarizeTask(
  taskId: string,
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  reps: number,
): PromptAbTaskComparison {
  const baseline = summarizeTaskArm(taskId, baselineRuns, reps);
  const candidate = summarizeTaskArm(taskId, candidateRuns, reps);
  const passRateDelta = baseline.passRate !== null && candidate.passRate !== null
    ? candidate.passRate - baseline.passRate
    : null;
  let outcome: PromptAbTaskComparison['outcome'] = 'missing';
  if (passRateDelta !== null) {
    outcome = passRateDelta > 0 ? 'candidate_win' : passRateDelta < 0 ? 'baseline_win' : 'tie';
  }
  return { taskId, baseline, candidate, passRateDelta, outcome };
}

function summarizeTaskArm(
  taskId: string,
  runs: readonly (readonly FixedPromptTaskWalEvent[])[],
  reps: number,
): PromptAbTaskArmSummary {
  const observed = runs
    .map((run) => run.find((event) => event.taskId === taskId))
    .filter((event): event is FixedPromptTaskWalEvent => event !== undefined);
  const valid = observed.filter(isValidBudgetedOutcome);
  const passed = valid.filter((event) => event.passed).length;
  return {
    observed: observed.length,
    valid: valid.length,
    passed,
    passRate: valid.length > 0 ? passed / valid.length : null,
    completed: observed.filter((event) => event.type === 'task_completed').length,
    budgetExhausted: observed.filter((event) => event.type === 'task_budget_exhausted').length,
    infraFailed: observed.filter((event) => event.type === 'task_infra_failed').length,
    plumbingFailed: observed.filter((event) => event.type === 'task_plumbing_failed').length,
    missing: reps - observed.length,
  };
}

function classifyQualificationTask(
  arm: PromptAbTaskArmSummary,
  reps: number,
  minPasses: number,
  maxPasses: number,
): PromptAbQualifiedTaskSummary['classification'] {
  if (
    arm.valid !== reps
    || arm.budgetExhausted > 0
    || arm.infraFailed > 0
    || arm.plumbingFailed > 0
    || arm.missing > 0
  ) {
    return 'invalid';
  }
  if (arm.passed >= minPasses && arm.passed <= maxPasses) return 'medium';
  if (arm.passed === 0) return 'hard';
  if (arm.passed === reps) return 'easy';
  return 'invalid';
}

function summarizeAttemptPairs(
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[],
  taskIds: readonly string[],
): PromptAbAttemptPairSummary {
  const missingPairIds: string[] = [];
  const budgetDiscordantPairIds: string[] = [];
  const infraOrPlumbingDiscordantPairIds: string[] = [];
  let observedPairs = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (let rep = 0; rep < baselineRuns.length; rep += 1) {
    const baselineByTask = new Map((baselineRuns[rep] ?? []).map((event) => [event.taskId, event]));
    const candidateByTask = new Map((candidateRuns[rep] ?? []).map((event) => [event.taskId, event]));
    for (const taskId of taskIds) {
      const pairId = `${taskId}#r${rep}`;
      const baseline = baselineByTask.get(taskId);
      const candidate = candidateByTask.get(taskId);
      if (!baseline || !candidate) {
        missingPairIds.push(pairId);
        continue;
      }
      if (isBudgetExhaustedOutcome(baseline) !== isBudgetExhaustedOutcome(candidate)) {
        budgetDiscordantPairIds.push(pairId);
      }
      if (isInfraOrPlumbingOutcome(baseline) !== isInfraOrPlumbingOutcome(candidate)) {
        infraOrPlumbingDiscordantPairIds.push(pairId);
      }
      if (!isValidBudgetedOutcome(baseline) || !isValidBudgetedOutcome(candidate)) {
        missingPairIds.push(pairId);
        continue;
      }
      observedPairs += 1;
      if (candidate.passed === baseline.passed) {
        ties += 1;
      } else if (candidate.passed) {
        wins += 1;
      } else {
        losses += 1;
      }
    }
  }
  return {
    pairs: taskIds.length * baselineRuns.length,
    observedPairs,
    wins,
    losses,
    ties,
    missingPairIds,
    budgetDiscordantPairIds,
    infraOrPlumbingDiscordantPairIds,
  };
}

function decide(
  taskLevel: PromptAbTaskLevelSummary,
  baseline: PromptAbArmSummary,
  candidate: PromptAbArmSummary,
  pairedAttempts: PromptAbAttemptPairSummary,
): { decision: PromptAbDecision; reason: string } {
  const coverage = Math.min(baseline.coverageRate, candidate.coverageRate);
  if (coverage < 0.9) return { decision: 'inconclusive', reason: 'low_effective_coverage' };
  if (pairedAttempts.budgetDiscordantPairIds.length > 0) {
    return { decision: 'inconclusive', reason: 'asymmetric_budget_exhaustion' };
  }
  if (pairedAttempts.infraOrPlumbingDiscordantPairIds.length > 0) {
    return { decision: 'inconclusive', reason: 'asymmetric_infra_or_plumbing' };
  }
  const meanDelta = taskLevel.meanPassRateDelta ?? 0;
  if (taskLevel.signTestPValue === null || taskLevel.signTestPValue > 0.05) {
    return { decision: 'inconclusive', reason: 'sign_test_not_significant' };
  }
  if (taskLevel.wins > taskLevel.losses && meanDelta > 0) {
    return { decision: 'candidate_better', reason: 'task_level_sign_test_p<=0.05' };
  }
  if (taskLevel.losses > taskLevel.wins && meanDelta < 0) {
    return { decision: 'baseline_better', reason: 'task_level_sign_test_p<=0.05' };
  }
  return { decision: 'inconclusive', reason: 'sign_test_direction_mismatch' };
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

function isValidBudgetedOutcome(
  event: FixedPromptTaskWalEvent,
): event is Extract<FixedPromptTaskWalEvent, { type: 'task_completed' | 'task_budget_exhausted' }> {
  return event.type === 'task_completed' || event.type === 'task_budget_exhausted';
}

function isBudgetExhaustedOutcome(event: FixedPromptTaskWalEvent): boolean {
  return event.type === 'task_budget_exhausted';
}

function isInfraOrPlumbingOutcome(event: FixedPromptTaskWalEvent): boolean {
  return event.type === 'task_infra_failed' || event.type === 'task_plumbing_failed';
}

function decisionLabel(decision: PromptAbDecision): string {
  switch (decision) {
    case 'candidate_better':
      return 'B better';
    case 'baseline_better':
      return 'A better';
    case 'inconclusive':
      return 'inconclusive';
  }
}

function rate(value: number | null): string {
  if (value === null) return 'null';
  return String(Math.round(value * 10_000) / 10_000);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function exactTwoSidedSignTestPValue(nonTieTasks: number, majorityWins: number): number {
  if (nonTieTasks <= 0) return 1;
  const minorityWins = Math.min(majorityWins, nonTieTasks - majorityWins);
  let tail = 0;
  for (let wins = 0; wins <= minorityWins; wins += 1) {
    tail += binomialProbability(nonTieTasks, wins, 0.5);
  }
  return Math.min(1, tail * 2);
}

function binomialProbability(n: number, k: number, p: number): number {
  let combinations = 1;
  for (let i = 1; i <= k; i += 1) {
    combinations *= (n - k + i) / i;
  }
  return combinations * p ** k * (1 - p) ** (n - k);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function assertZeroToOne(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number in [0, 1] (got ${String(value)})`);
  }
  return value;
}

function assertSameRunCount(
  baselineRuns: readonly unknown[],
  candidateRuns: readonly unknown[],
): void {
  if (baselineRuns.length !== candidateRuns.length) {
    throw new Error('baseline and candidate runs must have the same rep count');
  }
}
