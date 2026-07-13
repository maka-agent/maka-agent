import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { summarizeAbComparison } from '../ab-summary.js';
import {
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
    assert.match(csv, /^axis,metric,baseline_arm,baseline_value,candidate_arm,candidate_value,candidate_minus_baseline\n/);
    assert.match(csv, /effectiveness,pass_rate,maka,1,opencode,0.5,-0.5/);
    assert.match(csv, /economy,total_tokens,maka,240,opencode,360,120/);

    const markdown = renderHarnessAbReportMarkdown(report);
    assert.match(markdown, /# Maka vs OpenCode — GLM-5\.2 Harness Comparison/);
    assert.match(markdown, /Pass@1/);
    assert.match(markdown, /API-equivalent cost/);
    assert.match(markdown, /No composite score/);
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
