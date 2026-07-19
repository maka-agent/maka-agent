import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderPromptAbComparisonMarkdown, summarizePromptAbComparison } from '../prompt-ab-run.js';
import { completed } from './helpers/ab-summary-fixtures.js';

describe('summarizePromptAbComparison', () => {
  test('adapts prompt ids onto the generic A/B summary', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate-v2',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[completed('t1', false)]],
      candidateRuns: [[completed('t1', true)]],
    });

    assert.equal(result.baselineArmId, 'maka-baseline');
    assert.equal(result.candidateArmId, 'candidate-v2');
    assert.equal(result.baselinePromptId, 'maka-baseline');
    assert.equal(result.candidatePromptId, 'candidate-v2');
    assert.equal(result.taskLevel.wins, 1);
  });
});

describe('renderPromptAbComparisonMarkdown', () => {
  test('uses prompt report labeling while keeping generic A/B content', () => {
    const result = summarizePromptAbComparison({
      runId: 'ab-run',
      roundId: 'ab-summary',
      baselinePromptId: 'maka-baseline',
      candidatePromptId: 'candidate-v2',
      evaluationTaskIds: ['t1'],
      baselineRuns: [[completed('t1', false)]],
      candidateRuns: [[completed('t1', true)]],
    });

    const markdown = renderPromptAbComparisonMarkdown(result);

    assert.match(markdown, /^# Prompt A\/B Comparison/m);
    assert.match(markdown, /Baseline A: maka-baseline/);
    assert.match(markdown, /Candidate B: candidate-v2/);
    assert.doesNotMatch(markdown, /^# A\/B Comparison/m);
  });
});
