import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  type FixedPromptTaskWalEvent,
  type PromptCandidateRationale,
} from '../fixed-prompt-controller.js';
import {
  buildRsiControllerAttribution,
  projectRsiPromptAttribution,
} from '../rsi-controller-attribution.js';
import type { RsiRoundAnalysis } from '../rsi-round-analysis.js';
import type { PromptAcceptanceResult } from '../prompt-acceptance-policy.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

describe('RSI controller attribution', () => {
  test('treats a direct signal reference as authoritative without a coarse fallback', () => {
    const analysis: RsiRoundAnalysis = {
      heldInTaskSetHash: 'sha256:held-in',
      transitionVsLastKept: [],
      transitionVsPreviousCandidate: [],
      coverageRegressionTaskIds: ['task-a'],
      errorClassDistribution: [],
      toolFailureClusters: [],
      signals: [{ id: 'rsi-sig:coverage', kind: 'coverage_regression', taskIds: ['task-a'] }],
    };

    const attribution = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-1',
      candidateCommitSha: 'candidate-sha',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: {
        editedSurface: 'system_prompt',
        evidenceRefs: ['rsi-sig:coverage'],
        hypothesis: 'restore coverage for the unstable held-in task',
        targetedFix: 'make the required artifact explicit',
        predictedFixes: ['task-a'],
        riskTasks: [],
      },
      analysis,
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [completed({ taskId: 'task-a', passed: false })],
      candidateEvents: [completed({ taskId: 'task-a', passed: true })],
      decision: acceptanceResult({ decision: 'keep', reason: 'held_in_improved' }),
    });

    assert.equal(attribution.rootCauseSignalMatch, 'matched');
  });

  test('compares candidate rationale predictions to held-in outcomes', () => {
    const rationale: PromptCandidateRationale = {
      editedSurface: 'system_prompt',
      failurePattern: 'coverage_regression',
      evidenceRefs: ['rsi-sig:coverage'],
      hypothesis: 'restore coverage for the unstable held-in task',
      targetedFix: 'keep artifact creation requirements explicit',
      predictedFixes: ['task-a', 'task-b'],
      riskTasks: ['task-c'],
    };
    const analysis: RsiRoundAnalysis = {
      heldInTaskSetHash: 'sha256:held-in',
      transitionVsLastKept: [
        { taskId: 'task-a', from: 'fail', to: 'pass' },
        { taskId: 'task-b', from: 'pass', to: 'unscored' },
        { taskId: 'task-c', from: 'pass', to: 'fail' },
        { taskId: 'task-d', from: 'fail', to: 'pass' },
      ],
      transitionVsPreviousCandidate: [],
      coverageRegressionTaskIds: ['task-b'],
      errorClassDistribution: [{ errorClass: 'max_tokens', count: 1 }],
      toolFailureClusters: [],
      signals: [{ id: 'rsi-sig:coverage', kind: 'coverage_regression', taskIds: ['task-b'] }],
    };

    const attribution = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-0',
      candidateCommitSha: 'commit-1',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: rationale,
      analysis,
      heldInTaskIds: ['task-a', 'task-b', 'task-c', 'task-d'],
      lastKeptEvents: [
        completed({ taskId: 'task-a', passed: false }),
        completed({ taskId: 'task-b', passed: true }),
        completed({ taskId: 'task-c', passed: true }),
        completed({ taskId: 'task-d', passed: false }),
      ],
      candidateEvents: [
        completed({ taskId: 'task-a', passed: true }),
        completed({ taskId: 'task-b', passed: false, scored: false, errorClass: 'max_tokens' }),
        completed({ taskId: 'task-c', passed: false }),
        completed({ taskId: 'task-d', passed: true }),
        completed({ taskId: 'held-out-secret', passed: false }),
      ],
      decision: acceptanceResult({ reason: 'coverage_regressed', decision: 'discard' }),
    });

    assert.deepEqual(attribution.predictedFixes, [
      { taskId: 'task-a', outcome: 'improved' },
      { taskId: 'task-b', outcome: 'unscored' },
    ]);
    assert.deepEqual(attribution.riskTasks, [{ taskId: 'task-c', outcome: 'regressed' }]);
    assert.deepEqual(attribution.unexpectedHeldInFlips, [
      { taskId: 'task-d', from: 'fail', to: 'pass' },
    ]);
    assert.deepEqual(attribution.evidenceRefs, ['rsi-sig:coverage']);
    assert.equal(attribution.rootCauseSignalMatch, 'matched');
    assert.equal(JSON.stringify(attribution).includes('held-out-secret'), false);
  });

  test('projects prompt attribution without controller decision reasons', () => {
    const attribution = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-0',
      candidateCommitSha: 'commit-1',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: {
        editedSurface: 'system_prompt',
        failurePattern: 'other',
        evidenceRefs: [],
        hypothesis: 'unknown held-in behavior changed',
        targetedFix: 'make prompt wording simpler',
        predictedFixes: [],
        riskTasks: [],
      },
      analysis: {
        heldInTaskSetHash: 'sha256:held-in',
        transitionVsLastKept: [],
        transitionVsPreviousCandidate: [],
        coverageRegressionTaskIds: [],
        errorClassDistribution: [],
        toolFailureClusters: [],
        signals: [],
      },
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [completed({ taskId: 'task-a', passed: true })],
      candidateEvents: [completed({ taskId: 'task-a', passed: true })],
      decision: acceptanceResult({ decision: 'discard', reason: 'held_out_regressed' }),
    });

    const promptAttribution = projectRsiPromptAttribution(attribution);

    assert.equal('candidateCommitSha' in promptAttribution, false);
    assert.equal('decisionReason' in promptAttribution, false);
    assert.deepEqual(promptAttribution.predictedFixes, []);
    assert.deepEqual(promptAttribution.riskTasks, []);
    assert.deepEqual(promptAttribution.unexpectedHeldInFlips, []);
    assert.equal(promptAttribution.rootCauseSignalMatch, 'unknown');
    assert.equal(JSON.stringify(promptAttribution).includes('held_out_regressed'), false);
    assert.equal(JSON.stringify(promptAttribution).includes('coverage_regressed'), false);
  });

  test('keeps root cause match unknown when the rationale cites no evidence refs', () => {
    const attribution = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-0',
      candidateCommitSha: 'commit-1',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: {
        editedSurface: 'system_prompt',
        failurePattern: 'coverage_regression',
        evidenceRefs: [],
        hypothesis: 'coverage fell after the previous prompt change',
        targetedFix: 'make prompt wording simpler',
        predictedFixes: [],
        riskTasks: [],
      },
      analysis: {
        heldInTaskSetHash: 'sha256:held-in',
        transitionVsLastKept: [],
        transitionVsPreviousCandidate: [],
        coverageRegressionTaskIds: ['task-a'],
        errorClassDistribution: [],
        toolFailureClusters: [],
        signals: [{ id: 'rsi-sig:coverage', kind: 'coverage_regression', taskIds: ['task-a'] }],
      },
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [completed({ taskId: 'task-a', passed: true })],
      candidateEvents: [completed({ taskId: 'task-a', passed: false, scored: false })],
      decision: acceptanceResult({ decision: 'discard', reason: 'coverage_regressed' }),
    });

    assert.equal(attribution.rootCauseSignalMatch, 'unknown');
  });

  test('matches root cause only against cited analysis signals', () => {
    const analysis: RsiRoundAnalysis = {
      heldInTaskSetHash: 'sha256:held-in',
      transitionVsLastKept: [],
      transitionVsPreviousCandidate: [],
      coverageRegressionTaskIds: ['task-a'],
      errorClassDistribution: [],
      toolFailureClusters: [],
      signals: [
        { id: 'rsi-sig:coverage', kind: 'coverage_regression', taskIds: ['task-a'] },
        {
          id: 'rsi-sig:tool',
          kind: 'tool_failure_cluster',
          taskIds: ['task-b'],
          cluster: { name: 'shell', count: 1, taskIds: ['task-b'] },
        },
      ],
    };

    const matched = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-0',
      candidateCommitSha: 'commit-1',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: {
        editedSurface: 'system_prompt',
        failurePattern: 'coverage_regression',
        evidenceRefs: ['rsi-sig:coverage'],
        hypothesis: 'coverage fell after the previous prompt change',
        targetedFix: 'restore the missing artifact instruction',
        predictedFixes: [],
        riskTasks: [],
      },
      analysis,
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [completed({ taskId: 'task-a', passed: true })],
      candidateEvents: [completed({ taskId: 'task-a', passed: false, scored: false })],
      decision: acceptanceResult({ decision: 'discard', reason: 'coverage_regressed' }),
    });

    const contradicted = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-0',
      candidateCommitSha: 'commit-1',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: {
        editedSurface: 'system_prompt',
        failurePattern: 'coverage_regression',
        evidenceRefs: ['rsi-sig:tool'],
        hypothesis: 'coverage fell after the previous prompt change',
        targetedFix: 'restore the missing artifact instruction',
        predictedFixes: [],
        riskTasks: [],
      },
      analysis,
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [completed({ taskId: 'task-a', passed: true })],
      candidateEvents: [completed({ taskId: 'task-a', passed: false, scored: false })],
      decision: acceptanceResult({ decision: 'discard', reason: 'coverage_regressed' }),
    });

    assert.equal(matched.rootCauseSignalMatch, 'matched');
    assert.equal(contradicted.rootCauseSignalMatch, 'contradicted');
  });

  test('matches runtime error root cause against cited error-class signals', () => {
    const analysis: RsiRoundAnalysis = {
      heldInTaskSetHash: 'sha256:held-in',
      transitionVsLastKept: [],
      transitionVsPreviousCandidate: [],
      coverageRegressionTaskIds: [],
      errorClassDistribution: [{ errorClass: 'runtime_error', count: 1 }],
      toolFailureClusters: [],
      signals: [
        {
          id: 'rsi-sig:runtime',
          kind: 'error_class',
          taskIds: ['task-a'],
          errorClass: 'runtime_error',
          count: 1,
        },
        {
          id: 'rsi-sig:max-tokens',
          kind: 'error_class',
          taskIds: ['task-b'],
          errorClass: 'max_tokens',
          count: 1,
        },
      ],
    };

    const matched = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-0',
      candidateCommitSha: 'commit-1',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: {
        editedSurface: 'system_prompt',
        failurePattern: 'runtime_error',
        evidenceRefs: ['rsi-sig:runtime'],
        hypothesis: 'runtime errors block held-in progress',
        targetedFix: 'make execution constraints explicit',
        predictedFixes: [],
        riskTasks: [],
      },
      analysis,
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [completed({ taskId: 'task-a', passed: true })],
      candidateEvents: [
        completed({ taskId: 'task-a', passed: false, errorClass: 'runtime_error' }),
      ],
      decision: acceptanceResult({ decision: 'discard', reason: 'coverage_regressed' }),
    });

    const contradicted = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-0',
      candidateCommitSha: 'commit-1',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: {
        editedSurface: 'system_prompt',
        failurePattern: 'runtime_error',
        evidenceRefs: ['rsi-sig:max-tokens'],
        hypothesis: 'runtime errors block held-in progress',
        targetedFix: 'make execution constraints explicit',
        predictedFixes: [],
        riskTasks: [],
      },
      analysis,
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [completed({ taskId: 'task-a', passed: true })],
      candidateEvents: [
        completed({ taskId: 'task-a', passed: false, errorClass: 'runtime_error' }),
      ],
      decision: acceptanceResult({ decision: 'discard', reason: 'coverage_regressed' }),
    });

    assert.equal(matched.rootCauseSignalMatch, 'matched');
    assert.equal(contradicted.rootCauseSignalMatch, 'contradicted');
  });

  test('matches root cause against prompt-time analysis when post-eval signals disappear', () => {
    const attribution = buildRsiControllerAttribution({
      runId: 'run-1',
      roundId: 'round-0',
      candidateCommitSha: 'commit-1',
      candidateRationaleHash: 'sha256:rationale',
      candidateRationale: {
        editedSurface: 'system_prompt',
        failurePattern: 'coverage_regression',
        evidenceRefs: ['rsi-sig:coverage'],
        hypothesis: 'coverage fell before this candidate',
        targetedFix: 'restore the missing completion requirement',
        predictedFixes: ['task-a'],
        riskTasks: [],
      },
      promptTimeAnalysis: {
        heldInTaskSetHash: 'sha256:held-in-before',
        transitionVsLastKept: [],
        transitionVsPreviousCandidate: [],
        coverageRegressionTaskIds: ['task-a'],
        errorClassDistribution: [],
        toolFailureClusters: [],
        signals: [{ id: 'rsi-sig:coverage', kind: 'coverage_regression', taskIds: ['task-a'] }],
      },
      analysis: {
        heldInTaskSetHash: 'sha256:held-in-after',
        transitionVsLastKept: [{ taskId: 'task-a', from: 'fail', to: 'pass' }],
        transitionVsPreviousCandidate: [],
        coverageRegressionTaskIds: [],
        errorClassDistribution: [],
        toolFailureClusters: [],
        signals: [],
      },
      heldInTaskIds: ['task-a'],
      lastKeptEvents: [completed({ taskId: 'task-a', passed: false })],
      candidateEvents: [completed({ taskId: 'task-a', passed: true })],
      decision: acceptanceResult({ decision: 'keep', reason: 'held_in_improved' }),
    });

    assert.equal(attribution.heldInTaskSetHash, 'sha256:held-in-after');
    assert.deepEqual(attribution.predictedFixes, [{ taskId: 'task-a', outcome: 'improved' }]);
    assert.equal(attribution.rootCauseSignalMatch, 'matched');
  });
});

function completed(input: {
  taskId: string;
  passed: boolean;
  scored?: boolean;
  errorClass?: string;
}): FixedPromptTaskWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_completed',
    id: `${input.taskId}-event`,
    ts: 1,
    runId: 'run-1',
    roundId: 'round-1',
    taskId: input.taskId,
    status: input.passed ? 'completed' : 'failed',
    passed: input.passed,
    scored: input.scored ?? true,
    eligible: true,
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    promptHash: 'sha256:prompt',
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd: 0.01 }),
    steps: 1,
    durationMs: 10,
    runtimeEventsPath: '/tmp/runtime-events.jsonl',
    harbor: { reward: input.passed ? 1 : 0 },
  };
}

function acceptanceResult(input: {
  decision: 'keep' | 'discard';
  reason: PromptAcceptanceResult['reason'];
}): PromptAcceptanceResult {
  return {
    runId: 'run-1',
    roundId: 'round-0',
    decision: input.decision,
    reason: input.reason,
    candidateCommitSha: 'commit-1',
    previousLastKeptCommitSha: 'commit-0',
    lastKeptCommitSha: input.decision === 'keep' ? 'commit-1' : 'commit-0',
    previousHeldInReferencePassEligibleRate: 0.5,
    heldInReferencePassEligibleRate: 0.5,
    originalCommitSha: 'commit-0',
    originalHeldOutPassEligibleRate: 0.5,
    heldInPassRateNoiseBand: 0.1,
    heldOutPassRateNoiseBand: 0.1,
    rewardHackScan: { decision: 'clean' },
    metrics: {
      original: { heldOut: partitionSummary() },
      lastKept: { heldIn: partitionSummary() },
      candidate: { heldIn: partitionSummary(), heldOut: partitionSummary() },
    },
  };
}

function partitionSummary(): PromptAcceptanceResult['metrics']['candidate']['heldIn'] {
  return {
    taskCount: 0,
    observed: 0,
    eligible: 0,
    scored: 0,
    passed: 0,
    passEligibleRate: null,
    coverageRate: null,
    unscoredTaskIds: [],
    infraFailedTaskIds: [],
    plumbingFailedTaskIds: [],
    missingTaskIds: [],
  };
}
