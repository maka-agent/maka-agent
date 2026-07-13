import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { summarizeAbComparison } from '../ab-summary.js';
import type { FixedPromptTaskInfraFailedEvent } from '../fixed-prompt-controller.js';
import {
  assertHarnessAbReportCompleted,
  buildHarnessAbReport,
  renderHarnessAbReportCsv,
  renderHarnessAbReportMarkdown,
} from '../harness-ab-report.js';
import { completed, withUsage } from './helpers/ab-summary-fixtures.js';

describe('harness A/B report', () => {
  test('keeps effectiveness and economy as separate reproducible axes', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [[
        usage('a', true, 100, 40, 20, 0.00018),
        usage('b', true, 100, 40, 20, 0.00018),
      ]],
      candidateRuns: [[
        usage('a', true, 150, 20, 30, 0.00032),
        usage('b', false, 150, 20, 30, 0.00032),
      ]],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(report.schemaVersion, 'maka.harness_ab.report.v1');
    assert.deepEqual(report.effectiveness, {
      metric: 'pass@1',
      pairedEvaluated: 2,
      baseline: { armId: 'maka', passed: 2, evaluated: 2, passRate: 1 },
      candidate: { armId: 'opencode', passed: 1, evaluated: 2, passRate: 0.5 },
      candidateMinusBaseline: -0.5,
      candidateWins: 0,
      baselineWins: 1,
      ties: 1,
    });
    assert.equal(report.economy.baseline.totalTokens, 240);
    assert.equal(report.economy.candidate.totalTokens, 360);
    assert.equal(report.economy.baseline.apiEquivalentCostUsd, 0.00036);
    assert.equal(report.economy.candidate.apiEquivalentCostUsd, 0.00064);
    assert.equal(report.economy.baseline.costPerPassUsd, 0.00018);
    assert.equal(report.economy.candidate.costPerPassUsd, 0.00064);
    assert.equal('score' in report, false);

    const csv = renderHarnessAbReportCsv(report);
    assert.match(csv, /^run_status,stop_reason,paired_expected,paired_evaluated,excluded_pairs,missing_pairs,axis,metric,baseline_arm,baseline_value,candidate_arm,candidate_value,candidate_minus_baseline\n/);
    assert.match(csv, /completed,,2,2,0,0,effectiveness,pass_rate,maka,1,opencode,0.5,-0.5/);
    assert.match(csv, /completed,,2,2,0,0,economy,total_tokens,maka,240,opencode,360,120/);

    const markdown = renderHarnessAbReportMarkdown(report);
    assert.match(markdown, /# Maka vs OpenCode — GLM-5\.2 Harness Comparison/);
    assert.match(markdown, /Pass@1/);
    assert.match(markdown, /API-equivalent cost/);
    assert.match(markdown, /No composite score/);
  });

  test('reports effectiveness only over pairs evaluated by both harnesses', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [[completed('a', true), completed('b', true)]],
      candidateRuns: [[completed('a', false), providerBilling('b')]],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(report.runStatus, 'incomplete');
    assert.throws(
      () => assertHarnessAbReportCompleted(report),
      /harness A\/B incomplete: 1\/2 paired attempts evaluated \(1 excluded, 0 missing\)/,
    );
    assert.deepEqual(report.effectiveness.baseline, {
      armId: 'maka',
      passed: 1,
      evaluated: 1,
      passRate: 1,
    });
    assert.deepEqual(report.effectiveness.candidate, {
      armId: 'opencode',
      passed: 0,
      evaluated: 1,
      passRate: 0,
    });
    assert.equal(report.effectiveness.candidateMinusBaseline, -1);
  });

  test('reports economy over the same evaluated pairs as effectiveness', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a', 'b'],
      baselineRuns: [[
        usage('a', true, 100, 0, 0, 0.1),
        usage('b', true, 900, 0, 0, 0.9),
      ]],
      candidateRuns: [[
        usage('a', true, 100, 0, 0, 0.1),
        providerBilling('b'),
      ]],
    });

    const report = buildHarnessAbReport(summary);

    assert.equal(report.effectiveness.pairedEvaluated, 1);
    assert.equal(report.economy.baseline.totalTokens, 100);
    assert.equal(report.economy.candidate.totalTokens, 100);
    assert.equal(report.economy.baseline.tokensPerEvaluated, 100);
    assert.equal(report.economy.candidate.tokensPerEvaluated, 100);
  });

  test('preserves an early stop in every report format and rejects completion', () => {
    const summary = summarizeAbComparison({
      runId: 'glm-harness-ab',
      roundId: 'ab-summary',
      baselineArmId: 'maka',
      candidateArmId: 'opencode',
      evaluationTaskIds: ['a'],
      baselineRuns: [[completed('a', true)]],
      candidateRuns: [[providerBilling('a')]],
    });
    const report = buildHarnessAbReport({
      ...summary,
      stopReason: 'systemic_provider_failure',
    });

    assert.equal(report.runStatus, 'stopped');
    assert.equal(report.stopReason, 'systemic_provider_failure');
    assert.match(renderHarnessAbReportCsv(report), /^run_status,stop_reason,paired_expected,paired_evaluated,excluded_pairs,missing_pairs,axis,metric,/);
    assert.match(renderHarnessAbReportCsv(report), /stopped,systemic_provider_failure,1,0,1,0,effectiveness,pass_rate/);
    assert.match(renderHarnessAbReportMarkdown(report), /Status: stopped \(systemic_provider_failure\)\./);
    assert.throws(
      () => assertHarnessAbReportCompleted(report),
      /harness A\/B stopped: systemic_provider_failure/,
    );
  });
});

function usage(
  taskId: string,
  passed: boolean,
  input: number,
  cacheHitInput: number,
  output: number,
  costUsd: number,
) {
  return withUsage(completed(taskId, passed), {
    input,
    cacheHitInput,
    cacheMissInput: input - cacheHitInput,
    cacheWriteInput: 0,
    output,
    reasoning: 0,
    total: input + output,
    costUsd,
    durationMs: 100,
  });
}

function providerBilling(taskId: string): FixedPromptTaskInfraFailedEvent {
  return {
    schemaVersion: 1,
    type: 'task_infra_failed',
    id: `event-${taskId}`,
    ts: 0,
    runId: 'glm-harness-ab',
    roundId: 'round',
    taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'provider_billing',
    error: 'provider billing failure',
  };
}
