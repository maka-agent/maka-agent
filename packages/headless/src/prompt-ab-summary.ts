import type { FixedPromptTaskWalEvent } from './fixed-prompt-controller.js';
import type {
  PromptAbArmSummary,
  PromptAbAttemptPairSummary,
  PromptAbComparisonSummary,
  PromptAbDecision,
  PromptAbTaskArmSummary,
  PromptAbTaskComparison,
  PromptAbTaskLevelSummary,
  SummarizePromptAbComparisonInput,
} from './prompt-ab-types.js';

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

function assertSameRunCount(
  baselineRuns: readonly unknown[],
  candidateRuns: readonly unknown[],
): void {
  if (baselineRuns.length !== candidateRuns.length) {
    throw new Error('baseline and candidate runs must have the same rep count');
  }
}
