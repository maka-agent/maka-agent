import type { AbComparisonSummary, AbTokenCostSummary } from './ab-types.js';

export interface HarnessAbArmEffectiveness {
  armId: string;
  passed: number;
  evaluated: number;
  passRate: number | null;
}

export interface HarnessAbArmEconomy {
  armId: string;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  apiEquivalentCostUsd: number;
  tokensPerMetered: number | null;
  costPerMeteredUsd: number | null;
  costPerPassUsd: number | null;
}

export interface HarnessAbReport {
  schemaVersion: 'maka.harness_ab.report.v1';
  runId: string;
  runStatus: 'completed' | 'incomplete' | 'stopped';
  stopReason?: NonNullable<AbComparisonSummary['stopReason']>;
  taskCount: number;
  completeness: {
    baselineObserved: number;
    candidateObserved: number;
    expectedPerArm: number;
    excludedPairs: number;
    missingPairs: number;
  };
  effectiveness: {
    metric: 'pass@1';
    pairedEvaluated: number;
    baseline: HarnessAbArmEffectiveness;
    candidate: HarnessAbArmEffectiveness;
    candidateMinusBaseline: number | null;
    candidateWins: number;
    baselineWins: number;
    ties: number;
  };
  economy: {
    basis: 'cache-aware-api-equivalent-usd';
    pairedMetered: number;
    missingUsagePairs: number;
    baseline: HarnessAbArmEconomy;
    candidate: HarnessAbArmEconomy;
  };
}

export function buildHarnessAbReport(summary: AbComparisonSummary): HarnessAbReport {
  const runStatus = summary.stopReason
    ? 'stopped'
    : summary.pairedAttempts.missingPairIds.length === 0
        && summary.pairedAttempts.missingUsagePairIds.length === 0
        && summary.pairedAttempts.excludedPairIds.length === 0
      ? 'completed'
      : 'incomplete';
  return {
    schemaVersion: 'maka.harness_ab.report.v1',
    runId: summary.runId,
    runStatus,
    ...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
    taskCount: summary.taskCount,
    completeness: {
      baselineObserved: summary.baseline.observed,
      candidateObserved: summary.candidate.observed,
      expectedPerArm: summary.baseline.attempts,
      excludedPairs: summary.pairedAttempts.excludedPairIds.length,
      missingPairs: summary.pairedAttempts.missingPairIds.length,
    },
    effectiveness: {
      metric: 'pass@1',
      pairedEvaluated: summary.pairedAttempts.evaluatedPairs,
      baseline: pairedArmEffectiveness(
        summary.baselineArmId,
        summary.pairedAttempts.baselinePassed,
        summary.pairedAttempts.evaluatedPairs,
      ),
      candidate: pairedArmEffectiveness(
        summary.candidateArmId,
        summary.pairedAttempts.candidatePassed,
        summary.pairedAttempts.evaluatedPairs,
      ),
      candidateMinusBaseline: summary.passRateDelta,
      candidateWins: summary.pairedAttempts.wins,
      baselineWins: summary.pairedAttempts.losses,
      ties: summary.pairedAttempts.ties,
    },
    economy: {
      basis: 'cache-aware-api-equivalent-usd',
      pairedMetered: summary.pairedAttempts.fullyMeteredPairs,
      missingUsagePairs: summary.pairedAttempts.missingUsagePairIds.length,
      baseline: armEconomy(
        summary.baselineArmId,
        summary.pairedAttempts.baselineTokenCostSummary,
        summary.pairedAttempts.fullyMeteredPairs,
        summary.pairedAttempts.baselineMeteredPassed,
      ),
      candidate: armEconomy(
        summary.candidateArmId,
        summary.pairedAttempts.candidateTokenCostSummary,
        summary.pairedAttempts.fullyMeteredPairs,
        summary.pairedAttempts.candidateMeteredPassed,
      ),
    },
  };
}

export function renderHarnessAbReportCsv(report: HarnessAbReport): string {
  const baselineEffectiveness = report.effectiveness.baseline;
  const candidateEffectiveness = report.effectiveness.candidate;
  const baselineEconomy = report.economy.baseline;
  const candidateEconomy = report.economy.candidate;
  const rows: Array<[string, string, string, number | null, string, number | null, number | null]> = [
    ['effectiveness', 'pass_rate', baselineEffectiveness.armId, baselineEffectiveness.passRate, candidateEffectiveness.armId, candidateEffectiveness.passRate, report.effectiveness.candidateMinusBaseline],
    ['effectiveness', 'passed', baselineEffectiveness.armId, baselineEffectiveness.passed, candidateEffectiveness.armId, candidateEffectiveness.passed, candidateEffectiveness.passed - baselineEffectiveness.passed],
    ['economy', 'input_tokens', baselineEconomy.armId, baselineEconomy.inputTokens, candidateEconomy.armId, candidateEconomy.inputTokens, candidateEconomy.inputTokens - baselineEconomy.inputTokens],
    ['economy', 'cached_input_tokens', baselineEconomy.armId, baselineEconomy.cachedInputTokens, candidateEconomy.armId, candidateEconomy.cachedInputTokens, candidateEconomy.cachedInputTokens - baselineEconomy.cachedInputTokens],
    ['economy', 'uncached_input_tokens', baselineEconomy.armId, baselineEconomy.uncachedInputTokens, candidateEconomy.armId, candidateEconomy.uncachedInputTokens, candidateEconomy.uncachedInputTokens - baselineEconomy.uncachedInputTokens],
    ['economy', 'output_tokens', baselineEconomy.armId, baselineEconomy.outputTokens, candidateEconomy.armId, candidateEconomy.outputTokens, candidateEconomy.outputTokens - baselineEconomy.outputTokens],
    ['economy', 'total_tokens', baselineEconomy.armId, baselineEconomy.totalTokens, candidateEconomy.armId, candidateEconomy.totalTokens, candidateEconomy.totalTokens - baselineEconomy.totalTokens],
    ['economy', 'api_equivalent_cost_usd', baselineEconomy.armId, baselineEconomy.apiEquivalentCostUsd, candidateEconomy.armId, candidateEconomy.apiEquivalentCostUsd, candidateEconomy.apiEquivalentCostUsd - baselineEconomy.apiEquivalentCostUsd],
    ['economy', 'tokens_per_metered', baselineEconomy.armId, baselineEconomy.tokensPerMetered, candidateEconomy.armId, candidateEconomy.tokensPerMetered, nullableDelta(candidateEconomy.tokensPerMetered, baselineEconomy.tokensPerMetered)],
    ['economy', 'cost_per_metered_usd', baselineEconomy.armId, baselineEconomy.costPerMeteredUsd, candidateEconomy.armId, candidateEconomy.costPerMeteredUsd, nullableDelta(candidateEconomy.costPerMeteredUsd, baselineEconomy.costPerMeteredUsd)],
    ['economy', 'cost_per_pass_usd', baselineEconomy.armId, baselineEconomy.costPerPassUsd, candidateEconomy.armId, candidateEconomy.costPerPassUsd, nullableDelta(candidateEconomy.costPerPassUsd, baselineEconomy.costPerPassUsd)],
  ];
  return [
    'run_status,stop_reason,paired_expected,paired_evaluated,excluded_pairs,missing_pairs,paired_metered,missing_usage_pairs,axis,metric,baseline_arm,baseline_value,candidate_arm,candidate_value,candidate_minus_baseline',
    ...rows.map((row) => [
      report.runStatus,
      report.stopReason ?? '',
      report.completeness.expectedPerArm,
      report.effectiveness.pairedEvaluated,
      report.completeness.excludedPairs,
      report.completeness.missingPairs,
      report.economy.pairedMetered,
      report.economy.missingUsagePairs,
      ...row,
    ].map(csvCell).join(',')),
  ].join('\n') + '\n';
}

export function renderHarnessAbReportMarkdown(report: HarnessAbReport): string {
  const { baseline: baselineEffectiveness, candidate: candidateEffectiveness } = report.effectiveness;
  const { baseline: baselineEconomy, candidate: candidateEconomy } = report.economy;
  return [
    '# Maka vs OpenCode — GLM-5.2 Harness Comparison',
    '',
    `Status: ${report.runStatus}${report.stopReason ? ` (${report.stopReason})` : ''}.`,
    '',
    `Run: ${report.runId}; tasks: ${report.taskCount}; paired evaluated: ${report.effectiveness.pairedEvaluated}; excluded: ${report.completeness.excludedPairs}; missing: ${report.completeness.missingPairs}.`,
    `Economy coverage: fully metered pairs: ${report.economy.pairedMetered}; missing usage: ${report.economy.missingUsagePairs}.`,
    '',
    '## Effectiveness',
    '',
    '| Metric | ' + baselineEffectiveness.armId + ' | ' + candidateEffectiveness.armId + ' | Candidate − baseline |',
    '| --- | ---: | ---: | ---: |',
    `| Pass@1 | ${rate(baselineEffectiveness.passRate)} (${baselineEffectiveness.passed}/${baselineEffectiveness.evaluated}) | ${rate(candidateEffectiveness.passRate)} (${candidateEffectiveness.passed}/${candidateEffectiveness.evaluated}) | ${rate(report.effectiveness.candidateMinusBaseline)} |`,
    `| Paired outcomes | — | wins ${report.effectiveness.candidateWins}, losses ${report.effectiveness.baselineWins}, ties ${report.effectiveness.ties} | — |`,
    '',
    '## Economy',
    '',
    '| Metric | ' + baselineEconomy.armId + ' | ' + candidateEconomy.armId + ' |',
    '| --- | ---: | ---: |',
    `| Total tokens | ${baselineEconomy.totalTokens} | ${candidateEconomy.totalTokens} |`,
    `| Cached input tokens | ${baselineEconomy.cachedInputTokens} | ${candidateEconomy.cachedInputTokens} |`,
    `| Uncached input tokens | ${baselineEconomy.uncachedInputTokens} | ${candidateEconomy.uncachedInputTokens} |`,
    `| Output tokens | ${baselineEconomy.outputTokens} | ${candidateEconomy.outputTokens} |`,
    `| API-equivalent cost (USD) | ${baselineEconomy.apiEquivalentCostUsd} | ${candidateEconomy.apiEquivalentCostUsd} |`,
    `| Cost per fully metered task (USD) | ${value(baselineEconomy.costPerMeteredUsd)} | ${value(candidateEconomy.costPerMeteredUsd)} |`,
    `| Cost per pass (USD) | ${value(baselineEconomy.costPerPassUsd)} | ${value(candidateEconomy.costPerPassUsd)} |`,
    '',
    '## Interpretation boundary',
    '',
    'No composite score: effectiveness and economy are reported as separate axes. Cost is a cache-aware API-equivalent estimate from the frozen public price snapshot, not the fixed-plan bill.',
    '',
  ].join('\n');
}

export function assertHarnessAbReportCompleted(report: HarnessAbReport): void {
  if (report.runStatus === 'stopped') {
    throw new Error(`harness A/B stopped: ${report.stopReason ?? 'unknown_reason'}`);
  }
  if (report.runStatus === 'incomplete') {
    if (report.economy.missingUsagePairs > 0) {
      throw new Error(
        `harness A/B incomplete: missing usage for ${report.economy.missingUsagePairs} pair(s)`,
      );
    }
    throw new Error(
      `harness A/B incomplete: ${report.effectiveness.pairedEvaluated}/${report.completeness.expectedPerArm} paired attempts evaluated (${report.completeness.excludedPairs} excluded, ${report.completeness.missingPairs} missing)`,
    );
  }
}

function pairedArmEffectiveness(
  armId: string,
  passed: number,
  evaluated: number,
): HarnessAbArmEffectiveness {
  return { armId, passed, evaluated, passRate: divide(passed, evaluated) };
}

function armEconomy(
  armId: string,
  tokens: AbTokenCostSummary,
  evaluated: number,
  passed: number,
): HarnessAbArmEconomy {
  return {
    armId,
    inputTokens: tokens.input,
    cachedInputTokens: tokens.cacheHitInput,
    uncachedInputTokens: tokens.cacheMissInput,
    outputTokens: tokens.output,
    totalTokens: tokens.total,
    apiEquivalentCostUsd: tokens.costUsd,
    tokensPerMetered: divide(tokens.total, evaluated),
    costPerMeteredUsd: divide(tokens.costUsd, evaluated),
    costPerPassUsd: divide(tokens.costUsd, passed),
  };
}

function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function nullableDelta(candidate: number | null, baseline: number | null): number | null {
  return candidate === null || baseline === null ? null : candidate - baseline;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rate(input: number | null): string {
  return input === null ? 'n/a' : `${Math.round(input * 10_000) / 100}%`;
}

function value(input: number | null): string {
  return input === null ? 'n/a' : String(input);
}
