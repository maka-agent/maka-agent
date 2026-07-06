import type {
  AbAttemptRef,
  AbComparisonSummary,
  AbContinuationSummary,
  AbContextBudgetSummary,
  AbDecision,
  AbPairInvestigationRef,
  AbTaskToolSummary,
  AbTokenCostSummary,
} from './ab-types.js';

export function renderAbComparisonMarkdown(summary: AbComparisonSummary): string {
  const contextBudgetLine = renderContextBudgetLine(summary);
  const activePruneSubsetLine = renderActivePruneSubsetLine(summary);
  const contextBudgetPolicyLine = renderContextBudgetPolicyLine(summary);
  const continuationLine = renderContinuationLine(summary);
  const taskToolLine = renderTaskToolLine(summary);
  const investigationRefLines = renderInvestigationRefLines(summary);
  const lines = [
    '# A/B Comparison',
    '',
    `- Baseline A: ${summary.baselineArmId}`,
    `- Candidate B: ${summary.candidateArmId}`,
    `- Evaluation tasks: ${summary.taskCount}`,
    `- Reps: ${summary.reps}`,
    `- Decision: ${decisionLabel(summary.decision)} (${summary.reason})`,
    `- Budget: ${summary.budgetMs !== undefined ? `${Math.round(summary.budgetMs / 1000)}s task budget` : 'not recorded'}`,
    `- Non-inferiority margin: ${rate(summary.nonInferiorityMargin)}`,
    `- Non-inferiority lower bound: ${rate(summary.nonInferiority.lowerBound)} (${rate(summary.nonInferiority.confidenceLevel)} one-sided confidence, ${summary.nonInferiority.method})`,
    `- Evaluation pass rate: A=${summary.baseline.passed}/${summary.baseline.valid} = ${rate(summary.baseline.passRate)}, B=${summary.candidate.passed}/${summary.candidate.valid} = ${rate(summary.candidate.passRate)}`,
    `- Evaluation pass-rate delta: B-A=${rate(summary.passRateDelta)}`,
    `- Task-level delta: mean=${rate(summary.taskLevel.meanPassRateDelta)}, median=${rate(summary.taskLevel.medianPassRateDelta)}, wins=${summary.taskLevel.wins}, losses=${summary.taskLevel.losses}, ties=${summary.taskLevel.ties}, sign_test_p=${rate(summary.taskLevel.signTestPValue)}, missing=${summary.taskLevel.missingTaskIds.length}`,
    `- Attempt-pair auxiliary: wins=${summary.pairedAttempts.wins}, losses=${summary.pairedAttempts.losses}, ties=${summary.pairedAttempts.ties}, missing=${summary.pairedAttempts.missingPairIds.length}`,
    `- Token/cost: A ${renderTokenCost(summary.baseline.tokenCostSummary)}, B ${renderTokenCost(summary.candidate.tokenCostSummary)}`,
    `- Budget outcomes: A timed_out=${summary.baseline.budgetExhausted}, B timed_out=${summary.candidate.budgetExhausted}`,
    `- Infra outcomes: A infra_failed=${summary.baseline.infraFailed}, B infra_failed=${summary.candidate.infraFailed}; A plumbing_failed=${summary.baseline.plumbingFailed}, B plumbing_failed=${summary.candidate.plumbingFailed}`,
    ...(contextBudgetPolicyLine ? [contextBudgetPolicyLine] : []),
    ...(continuationLine ? [continuationLine] : []),
    ...(taskToolLine ? [taskToolLine] : []),
    ...(contextBudgetLine ? [contextBudgetLine] : []),
    ...(activePruneSubsetLine ? [activePruneSubsetLine] : []),
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
  if (investigationRefLines.length > 0) {
    lines.push(...investigationRefLines);
  }
  return `${lines.join('\n')}\n`;
}

function renderTokenCost(summary: AbTokenCostSummary): string {
  return `input=${summary.input} cache_hit=${summary.cacheHitInput} cache_miss=${summary.cacheMissInput} cache_write=${summary.cacheWriteInput} output=${summary.output} total=${summary.total} cost_usd=${summary.costUsd} mean_duration_ms=${summary.meanDurationMs ?? 'null'}`;
}

function renderInvestigationRefLines(summary: AbComparisonSummary): string[] {
  const lines: string[] = [];
  if (summary.investigationRefs.activatedAttempts.length > 0) {
    lines.push('## Activated Attempts', '', ...summary.investigationRefs.activatedAttempts.map((ref) => `- ${renderAttemptRef(ref)}`), '');
  }
  if (summary.investigationRefs.candidateLosses.length > 0) {
    lines.push('## B Loss Refs', '', ...summary.investigationRefs.candidateLosses.map((ref) => `- ${renderPairRef(ref)}`), '');
  }
  if (summary.investigationRefs.budgetDiscordantPairs.length > 0) {
    lines.push('## Budget Discordant Refs', '', ...summary.investigationRefs.budgetDiscordantPairs.map((ref) => `- ${renderPairRef(ref)}`), '');
  }
  if (summary.investigationRefs.infraOrPlumbingDiscordantPairs.length > 0) {
    lines.push('## Infra Or Plumbing Discordant Refs', '', ...summary.investigationRefs.infraOrPlumbingDiscordantPairs.map((ref) => `- ${renderPairRef(ref)}`), '');
  }
  return lines;
}

function renderPairRef(ref: AbPairInvestigationRef): string {
  return `${ref.pairId}: A=${ref.baseline ? renderAttemptRef(ref.baseline) : 'missing'}; B=${ref.candidate ? renderAttemptRef(ref.candidate) : 'missing'}`;
}

function renderAttemptRef(ref: AbAttemptRef): string {
  return `${ref.arm} task=${ref.taskId} rep=${ref.rep} id=${ref.attemptId} round=${ref.roundId}${ref.runtimeEventsPath ? ` runtime=${ref.runtimeEventsPath}` : ''}${ref.traceEventsPath ? ` trace=${ref.traceEventsPath}` : ''}${ref.runtimeEventsUnavailableReason ? ` runtime_unavailable=${ref.runtimeEventsUnavailableReason}` : ''}`;
}

function renderContextBudgetPolicyLine(summary: AbComparisonSummary): string | undefined {
  if (!summary.baseline.contextBudgetPolicy && !summary.candidate.contextBudgetPolicy) return undefined;
  const baseline = summary.baseline.contextBudgetPolicy;
  const candidate = summary.candidate.contextBudgetPolicy;
  return `- Context budget policy: A enabled=${baseline?.enabledAttempts ?? 0}/${baseline?.attempts ?? 0} snapshots=${JSON.stringify(baseline?.snapshots ?? [])}, B enabled=${candidate?.enabledAttempts ?? 0}/${candidate?.attempts ?? 0} snapshots=${JSON.stringify(candidate?.snapshots ?? [])}`;
}

function renderContinuationLine(summary: AbComparisonSummary): string | undefined {
  if (!summary.baseline.continuation && !summary.candidate.continuation) return undefined;
  return `- Continuation: A ${renderContinuationMetrics(continuationOrZero(summary.baseline.continuation))}, B ${renderContinuationMetrics(continuationOrZero(summary.candidate.continuation))}`;
}

function renderContinuationMetrics(summary: AbContinuationSummary): string {
  return [
    `enabled=${summary.enabledAttempts}/${summary.attempts}`,
    `wall_timeout=${summary.wallTimeoutMs !== null ? `${summary.wallTimeoutMs}ms` : 'null'}`,
    `turns=${summary.turnsUsed}`,
    `continued=${summary.continuedTurns}`,
    `step_cap_hits=${summary.stepCapHits}`,
    `per_turn_step_cap_hits=${JSON.stringify(summary.perTurnStepCapHits)}`,
    `cap_exhausted=${summary.capExhaustedAttempts}`,
    `runtime_steps=${summary.totalRuntimeSteps}`,
    `max_turns=${summary.maxTurns ?? 'null'}`,
    `max_total_steps=${summary.maxTotalRuntimeSteps ?? 'null'}`,
  ].join(' ');
}

function renderTaskToolLine(summary: AbComparisonSummary): string | undefined {
  if (!summary.baseline.taskTools && !summary.candidate.taskTools) return undefined;
  return `- Task tools: A ${renderTaskToolMetrics(taskToolsOrZero(summary.baseline.taskTools))}, B ${renderTaskToolMetrics(taskToolsOrZero(summary.candidate.taskTools))}`;
}

function renderTaskToolMetrics(summary: AbTaskToolSummary): string {
  return [
    `activated=${summary.activatedAttempts}/${summary.attempts}`,
    `todo_write=${summary.todoWriteCalls}`,
  ].join(' ');
}

function taskToolsOrZero(summary: AbTaskToolSummary | undefined): AbTaskToolSummary {
  return summary ?? {
    attempts: 0,
    activatedAttempts: 0,
    activatedAttemptIds: [],
    todoWriteCalls: 0,
  };
}

function continuationOrZero(summary: AbContinuationSummary | undefined): AbContinuationSummary {
  return summary ?? {
    attempts: 0,
    enabledAttempts: 0,
    wallTimeoutMs: null,
    turnsUsed: 0,
    continuedTurns: 0,
    stepCapHits: 0,
    perTurnStepCapHits: [],
    capExhaustedAttempts: 0,
    totalRuntimeSteps: 0,
    maxTurns: null,
    maxTotalRuntimeSteps: null,
  };
}

function decisionLabel(decision: AbDecision): string {
  switch (decision) {
    case 'non_inferior':
      return 'B non-inferior';
    case 'inferior':
      return 'B inferior';
    case 'inconclusive':
      return 'inconclusive';
  }
}

function rate(value: number | null): string {
  if (value === null) return 'null';
  return String(Math.round(value * 10_000) / 10_000);
}

function renderContextBudgetLine(summary: AbComparisonSummary): string | undefined {
  if (!summary.baseline.contextBudget && !summary.candidate.contextBudget) return undefined;
  const baseline = contextBudgetOrZero(summary.baseline.contextBudget);
  const candidate = contextBudgetOrZero(summary.candidate.contextBudget);
  return `- Context budget: A ${renderContextBudgetMetrics(baseline)}, B ${renderContextBudgetMetrics(candidate)}`;
}

function renderActivePruneSubsetLine(summary: AbComparisonSummary): string | undefined {
  if (!summary.baseline.activePruneSubset && !summary.candidate.activePruneSubset) return undefined;
  const baseline = activePruneSubsetOrZero(summary.baseline.activePruneSubset);
  const candidate = activePruneSubsetOrZero(summary.candidate.activePruneSubset);
  return `- Active prune subset: A ${renderActivePruneSubsetMetrics(baseline)}, B ${renderActivePruneSubsetMetrics(candidate)}`;
}

function renderContextBudgetMetrics(summary: AbContextBudgetSummary): string {
  return [
    `activated=${summary.activatedAttempts}/${summary.diagnosticAttempts}`,
    `stale_pruned=${summary.prunedToolResults}`,
    `active_pruned=${summary.activePrunedToolResults}`,
    `active_tokens_saved=${summary.activeEstimatedTokensSaved}`,
    `active_archive_failures=${summary.activeArchiveFailures}`,
    `archive_placeholders=${summary.archivePlaceholders}`,
    `archive_placeholder_reasons=${renderCountRecord(summary.archivePlaceholderReasonCounts)}`,
    `archive_write_failures=${summary.archiveWriteFailures}`,
    `retrieved=${summary.retrievedArchiveToolResults}`,
    `retrieved_tokens=${summary.retrievedArchiveEstimatedTokens}`,
    `retrieval_skipped=${summary.archiveRetrievalSkipped}`,
    `retrieval_skipped_reasons=${renderCountRecord(summary.archiveRetrievalSkippedReasonCounts)}`,
    `retrieval_failures=${summary.archiveRetrievalFailures}`,
    `retrieval_failure_reasons=${renderCountRecord(summary.archiveRetrievalFailureReasonCounts)}`,
  ].join(' ');
}

function renderCountRecord(record: Record<string, number>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))));
}

function renderActivePruneSubsetMetrics(summary: NonNullable<AbComparisonSummary['candidate']['activePruneSubset']>): string {
  const contextBudget = contextBudgetOrZero(summary.contextBudget);
  return [
    `tasks=${summary.taskCount}`,
    `attempts=${summary.attempts}`,
    `observed=${summary.observed}`,
    `missing=${summary.missing}`,
    `coverage=${rate(summary.coverageRate)}`,
    `pass_rate=${rate(summary.passRate)}`,
    `passed=${summary.passed}/${summary.valid}`,
    `completed=${summary.completed}`,
    `timed_out=${summary.budgetExhausted}`,
    `infra_failed=${summary.infraFailed}`,
    `plumbing_failed=${summary.plumbingFailed}`,
    renderTokenCost(summary.tokenCostSummary),
    renderContextBudgetMetrics(contextBudget),
  ].join(' ');
}

function contextBudgetOrZero(summary: AbContextBudgetSummary | undefined): AbContextBudgetSummary {
  return summary ?? {
    diagnosticAttempts: 0,
    activatedAttempts: 0,
    activatedAttemptIds: [],
    diagnosticEvents: 0,
    prunedToolResults: 0,
    activePrunedToolResults: 0,
    activeEstimatedTokensSaved: 0,
    activeArchiveFailures: 0,
    archivePlaceholders: 0,
    archivePlaceholderReasonCounts: {},
    archiveWriteFailures: 0,
    retrievedArchiveToolResults: 0,
    retrievedArchiveEstimatedTokens: 0,
    archiveRetrievalSkipped: 0,
    archiveRetrievalSkippedReasonCounts: {},
    archiveRetrievalFailures: 0,
    archiveRetrievalFailureReasonCounts: {},
  };
}

function activePruneSubsetOrZero(
  summary: AbComparisonSummary['candidate']['activePruneSubset'] | undefined,
): NonNullable<AbComparisonSummary['candidate']['activePruneSubset']> {
  return summary ?? {
    taskCount: 0,
    attempts: 0,
    observed: 0,
    valid: 0,
    passed: 0,
    passRate: null,
    completed: 0,
    budgetExhausted: 0,
    infraFailed: 0,
    plumbingFailed: 0,
    missing: 0,
    coverageRate: 1,
    totalCostUsd: 0,
    meanDurationMs: null,
    tokenCostSummary: {
      input: 0,
      cachedInput: 0,
      cacheHitInput: 0,
      cacheMissInput: 0,
      cacheWriteInput: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      costUsd: 0,
      meanDurationMs: null,
    },
    contextBudget: contextBudgetOrZero(undefined),
  };
}
