import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  FixedPromptWalEvent,
  PromptCandidateRationale,
  PromptCandidateRewardHackScan,
} from '../fixed-prompt-controller.js';
import {
  promptStructuralSmokeReport,
  renderPromptStructuralSmokeMarkdown,
} from '../prompt-structural-smoke.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

describe('prompt structural smoke report', () => {
  test('passes after ten unattended discard decisions under budget', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'pass');
    assert.equal(report.observedRounds, 10);
    assert.equal(report.decisions.keep, 0);
    assert.equal(report.decisions.discard, 10);
    assert.equal(report.totalCostUsd, 1);
    assert.deepEqual(report.failures, []);

    const markdown = renderPromptStructuralSmokeMarkdown(report);
    assert.match(markdown, /# Prompt Structural Smoke/);
    assert.match(markdown, /- status: pass/);
    assert.match(markdown, /- rounds: 10 \/ 10/);
    assert.match(markdown, /- cost_usd: 1 \/ 30/);
  });

  test('fails when structural smoke evidence is incomplete or unsafe', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 8; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 4));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      );
    }
    events.push(committedEvent('round-9'));
    events.push(completedEvent('round-9', 'task-9', 4));
    events.push(
      decisionEvent('round-9', 'discard', 'reward_hack_quarantined', 'run-1', {
        decision: 'quarantine',
        reason: 'verifier_pattern',
      }),
    );
    events.push(plumbingFailedEvent('round-9', 'task-9'));

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, [
      'minimum_rounds_not_met',
      'cost_ceiling_exceeded',
      'plumbing_failures_present',
      'reward_hack_quarantine_present',
    ]);
    assert.equal(report.observedRounds, 9);
    assert.equal(report.totalCostUsd, 37);

    const markdown = renderPromptStructuralSmokeMarkdown(report);
    assert.match(markdown, /## failures/);
    assert.match(markdown, /- cost_ceiling_exceeded/);
  });

  test('fails when task cost reaches the configured ceiling exactly', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 1,
    });

    assert.equal(report.totalCostUsd, 1);
    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['cost_ceiling_exceeded']);
  });

  test('includes budget-exhausted task cost in the structural ceiling', () => {
    const report = promptStructuralSmokeReport({
      events: [budgetExhaustedEvent('round-1', 'task-1', 0.42)],
      minimumRounds: 0,
      costCeilingUsd: 0.4,
    });

    assert.equal(report.totalCostUsd, 0.42);
    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['cost_ceiling_exceeded']);
  });

  test('fails when decision rounds have no task evidence', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      events.push(
        decisionEvent(`round-${index}`, 'discard', 'held_in_within_noise', 'run-1', {
          decision: 'clean',
        }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.roundsWithoutTaskEvidence, [
      'round-1',
      'round-2',
      'round-3',
      'round-4',
      'round-5',
      'round-6',
      'round-7',
      'round-8',
      'round-9',
      'round-10',
    ]);
    assert.deepEqual(report.failures, ['task_evidence_missing']);
  });

  test('fails when decision rounds have only infra failures', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(
        decisionEvent(roundId, 'discard', 'coverage_regressed', 'run-1', { decision: 'clean' }),
      );
      events.push(infraFailedEvent(roundId, `task-${index}`));
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.roundsWithoutTaskEvidence, [
      'round-1',
      'round-2',
      'round-3',
      'round-4',
      'round-5',
      'round-6',
      'round-7',
      'round-8',
      'round-9',
      'round-10',
    ]);
    assert.deepEqual(report.failures, ['task_evidence_missing']);
  });

  test('fails when task evidence belongs to a different run', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId, 'run-current'));
      events.push(completedEvent(roundId, `task-${index}`, 0.1, 'run-old'));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-current', {
          decision: 'clean',
        }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.roundsWithoutTaskEvidence, [
      'round-1',
      'round-2',
      'round-3',
      'round-4',
      'round-5',
      'round-6',
      'round-7',
      'round-8',
      'round-9',
      'round-10',
    ]);
    assert.deepEqual(report.failures, ['task_evidence_missing']);
  });

  test('fails when decision rounds span multiple runs', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId, 'run-a'));
      events.push(completedEvent(roundId, `task-${index}`, 0.1, 'run-a'));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-a', { decision: 'clean' }),
      );
    }
    for (let index = 6; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId, 'run-b'));
      events.push(completedEvent(roundId, `task-${index}`, 0.1, 'run-b'));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-b', { decision: 'clean' }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['multiple_runs_present']);
  });

  test('passes when decision rounds have no reward-hack scan evidence', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise'));
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'pass');
    assert.deepEqual(report.failures, []);
  });

  test('fails when reward-hack scan quarantine is present', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', {
          decision: 'quarantine',
          reason: 'verifier_pattern',
        }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.equal(report.quarantineCount, 10);
    assert.deepEqual(report.failures, ['reward_hack_quarantine_present']);
  });

  test('fails closed on unknown reward-hack scan decisions', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', {
          decision: 'skipped',
        } as unknown as PromptCandidateRewardHackScan),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.equal(report.quarantineCount, 10);
    assert.deepEqual(report.failures, ['reward_hack_quarantine_present']);
  });

  test('fails closed on null reward-hack scan evidence', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      const event = decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', {
        decision: 'clean',
      });
      (event as { rewardHackScan: unknown }).rewardHackScan = null;
      events.push(event);
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.equal(report.quarantineCount, 10);
    assert.deepEqual(report.failures, ['reward_hack_quarantine_present']);
  });

  test('fails when task evidence is appended after decision rounds', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      );
    }
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.roundsWithoutTaskEvidence, [
      'round-1',
      'round-2',
      'round-3',
      'round-4',
      'round-5',
      'round-6',
      'round-7',
      'round-8',
      'round-9',
      'round-10',
    ]);
    assert.deepEqual(report.failures, ['task_evidence_missing']);
  });

  test('fails when task evidence uses a different prompt hash from the committed candidate', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(
        completedEvent(roundId, `task-${index}`, 0.1, 'run-1', `sha256:stale-${roundId}`),
      );
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.roundsWithoutTaskEvidence, [
      'round-1',
      'round-2',
      'round-3',
      'round-4',
      'round-5',
      'round-6',
      'round-7',
      'round-8',
      'round-9',
      'round-10',
    ]);
    assert.deepEqual(report.failures, ['task_evidence_missing']);
  });

  test('fails when matching task evidence has no prior candidate commit', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.roundsWithoutTaskEvidence, [
      'round-1',
      'round-2',
      'round-3',
      'round-4',
      'round-5',
      'round-6',
      'round-7',
      'round-8',
      'round-9',
      'round-10',
    ]);
    assert.deepEqual(report.failures, ['task_evidence_missing']);
  });

  test('fails when matching task evidence predates the candidate commit', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(committedEvent(roundId));
      events.push(
        decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      );
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.roundsWithoutTaskEvidence, [
      'round-1',
      'round-2',
      'round-3',
      'round-4',
      'round-5',
      'round-6',
      'round-7',
      'round-8',
      'round-9',
      'round-10',
    ]);
    assert.deepEqual(report.failures, ['task_evidence_missing']);
  });

  test('fails R2 smoke when controller attribution is missing or appended before decision', () => {
    const missingAttribution = [
      committedEvent('round-1'),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
    ];
    const missingReport = promptStructuralSmokeReport({
      events: missingAttribution,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(missingReport.status, 'fail');
    assert.deepEqual(missingReport.failures, ['rsi_attribution_missing']);
    assert.deepEqual(missingReport.roundsWithoutRsiAttribution, ['round-1']);

    const wrongOrder = [
      committedEvent('round-1'),
      completedEvent('round-1', 'task-1', 0.1),
      attributionEvent('round-1'),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
    ];
    const wrongOrderReport = promptStructuralSmokeReport({
      events: wrongOrder,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(wrongOrderReport.status, 'fail');
    assert.deepEqual(wrongOrderReport.failures, ['rsi_attribution_missing']);
    assert.deepEqual(wrongOrderReport.roundsWithoutRsiAttribution, ['round-1']);
  });

  test('fails R2 smoke when attribution is appended after the next candidate starts', () => {
    const events = [
      committedEvent('round-1'),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      committedEvent('round-2'),
      attributionEvent('round-1'),
    ];

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['rsi_attribution_missing']);
    assert.deepEqual(report.roundsWithoutRsiAttribution, ['round-1']);
  });

  test('fails R2 smoke when attribution hashes or held-in task scope are invalid', () => {
    const hashMismatch = [
      committedEvent('round-1'),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      attributionEvent('round-1', { candidateRationaleHash: 'sha256:wrong-rationale' }),
    ];
    const hashReport = promptStructuralSmokeReport({
      events: hashMismatch,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(hashReport.status, 'fail');
    assert.deepEqual(hashReport.failures, ['rsi_attribution_malformed']);
    assert.deepEqual(hashReport.roundsWithMalformedRsiAttribution, ['round-1']);

    const taskScopeMismatch = [
      committedEvent('round-1', 'run-1', promptHashForRound('round-1'), ['task-1']),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      attributionEvent('round-1', {
        predictedFixes: [{ taskId: 'held-out-secret', outcome: 'improved' }],
      }),
    ];
    const taskScopeReport = promptStructuralSmokeReport({
      events: taskScopeMismatch,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(taskScopeReport.status, 'fail');
    assert.deepEqual(taskScopeReport.failures, [
      'rsi_attribution_malformed',
      'rsi_attribution_task_scope_invalid',
    ]);
    assert.deepEqual(taskScopeReport.roundsWithOutOfScopeRsiAttribution, ['round-1']);
  });

  test('fails R2 smoke when attribution disagrees with committed candidate rationale', () => {
    const committedRationale = candidateRationale({
      evidenceRefs: ['rsi-sig:coverage'],
      predictedFixes: ['task-1'],
      riskTasks: ['task-2'],
    });

    const evidenceMismatch = [
      committedEvent(
        'round-1',
        'run-1',
        promptHashForRound('round-1'),
        ['task-1', 'task-2'],
        committedRationale,
      ),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      attributionEvent('round-1', {
        evidenceRefs: ['rsi-sig:other'],
        predictedFixes: [{ taskId: 'task-1', outcome: 'improved' }],
        riskTasks: [{ taskId: 'task-2', outcome: 'safe' }],
      }),
    ];

    const evidenceReport = promptStructuralSmokeReport({
      events: evidenceMismatch,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(evidenceReport.status, 'fail');
    assert.deepEqual(evidenceReport.failures, ['rsi_attribution_malformed']);
    assert.deepEqual(evidenceReport.roundsWithMalformedRsiAttribution, ['round-1']);

    const taskListMismatch = [
      committedEvent(
        'round-1',
        'run-1',
        promptHashForRound('round-1'),
        ['task-1', 'task-2'],
        committedRationale,
      ),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      attributionEvent('round-1', {
        evidenceRefs: ['rsi-sig:coverage'],
        predictedFixes: [{ taskId: 'task-2', outcome: 'improved' }],
        riskTasks: [{ taskId: 'task-1', outcome: 'safe' }],
      }),
    ];
    const taskListReport = promptStructuralSmokeReport({
      events: taskListMismatch,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(taskListReport.status, 'fail');
    assert.deepEqual(taskListReport.failures, ['rsi_attribution_malformed']);
    assert.deepEqual(taskListReport.roundsWithMalformedRsiAttribution, ['round-1']);
  });

  test('fails R2 smoke when attribution decision disagrees with the preceding decision event', () => {
    const events = [
      committedEvent('round-1'),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      attributionEvent('round-1', { decision: { decision: 'keep', reason: 'held_in_improved' } }),
    ];

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['rsi_attribution_malformed']);
    assert.deepEqual(report.roundsWithMalformedRsiAttribution, ['round-1']);
  });

  test('passes R2 smoke when safety-plane decision reasons stay out of prompt projection', () => {
    const events = [
      committedEvent('round-1'),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_out_regressed', 'run-1', { decision: 'clean' }),
      attributionEvent('round-1', {
        decision: { decision: 'discard', reason: 'held_out_regressed' },
      }),
    ];

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(report.status, 'pass');
    assert.deepEqual(report.failures, []);
  });

  test('passes R2 smoke when nested controller-only fields stay out of prompt projection', () => {
    const events = [
      committedEvent(
        'round-1',
        'run-1',
        promptHashForRound('round-1'),
        ['task-1'],
        candidateRationale({
          predictedFixes: ['task-1'],
          riskTasks: ['task-1'],
        }),
      ),
      completedEvent('round-1', 'task-1', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      attributionEvent('round-1', {
        predictedFixes: [
          { taskId: 'task-1', outcome: 'improved', candidateCommitSha: 'nested-commit-secret' },
        ],
        riskTasks: [{ taskId: 'task-1', outcome: 'safe', threshold: 'nested-threshold-secret' }],
        unexpectedHeldInFlips: [
          { taskId: 'task-1', from: 'fail', to: 'pass', heldOutMetric: 'nested-held-out-secret' },
        ],
      } as unknown as Partial<
        Extract<FixedPromptWalEvent, { type: 'rsi_controller_attribution' }>
      >),
    ];

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(report.status, 'pass');
    assert.deepEqual(report.failures, []);
  });

  test('fails R2 smoke when prompt attribution projection contains held-out markers', () => {
    const events = [
      committedEvent('round-1', 'run-1', promptHashForRound('round-1'), ['held-out-secret']),
      completedEvent('round-1', 'held-out-secret', 0.1),
      decisionEvent('round-1', 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }),
      attributionEvent('round-1', {
        unexpectedHeldInFlips: [{ taskId: 'held-out-secret', from: 'fail', to: 'pass' }],
      }),
    ];

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 1,
      requireRsiR2Evidence: true,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['rsi_attribution_malformed']);
    assert.deepEqual(report.roundsWithMalformedRsiAttribution, ['round-1']);
  });
});

function committedEvent(
  roundId: string,
  runId = 'run-1',
  promptHash = promptHashForRound(roundId),
  heldInTaskIds: readonly string[] = [`task-${roundId.slice('round-'.length)}`],
  rationale = candidateRationale(),
): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'prompt_candidate_committed',
    id: `commit-${roundId}`,
    ts: 1,
    runId,
    roundId,
    commitSha: `candidate-${roundId}`,
    summary: `candidate ${roundId}`,
    promptHash,
    heldInTaskSetHash: 'sha256:held-in-task-set',
    heldInTaskIds,
    candidateRationaleHash: 'sha256:candidate-rationale',
    candidateRationale: rationale,
  };
}

function candidateRationale(
  overrides: Partial<PromptCandidateRationale> = {},
): PromptCandidateRationale {
  return {
    editedSurface: 'system_prompt',
    failurePattern: 'coverage_regression' as const,
    evidenceRefs: [],
    hypothesis: 'held-in coverage can improve with a clearer prompt',
    targetedFix: 'make success criteria explicit without task-specific answers',
    predictedFixes: [],
    riskTasks: [],
    ...overrides,
  };
}

function decisionEvent(
  roundId: string,
  decision: 'keep' | 'discard',
  reason: string,
  runId = 'run-1',
  rewardHackScan?: PromptCandidateRewardHackScan,
): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'prompt_candidate_decided',
    id: `decision-${roundId}`,
    ts: 1,
    runId,
    roundId,
    decision,
    reason,
    candidateCommitSha: `candidate-${roundId}`,
    previousLastKeptCommitSha: 'kept-0',
    lastKeptCommitSha: decision === 'keep' ? `candidate-${roundId}` : 'kept-0',
    previousHeldInReferencePassEligibleRate: 0.5,
    heldInReferencePassEligibleRate: 0.5,
    originalCommitSha: 'original-0',
    originalHeldOutPassEligibleRate: 0.5,
    heldInPassRateNoiseBand: 0.05,
    heldOutPassRateNoiseBand: 0.05,
    ...(rewardHackScan ? { rewardHackScan } : {}),
    metrics: {},
  };
}

function completedEvent(
  roundId: string,
  taskId: string,
  costUsd: number,
  runId = 'run-1',
  promptHash = promptHashForRound(roundId),
): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_completed',
    id: `task-${roundId}-${taskId}`,
    ts: 1,
    runId,
    roundId,
    taskId,
    status: 'completed',
    passed: false,
    scored: true,
    eligible: true,
    promptHash,
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd }),
    steps: 1,
    durationMs: 10,
    runtimeEventsPath: `/logs/${roundId}/${taskId}.jsonl`,
    harbor: { reward: 0 },
  };
}

function budgetExhaustedEvent(
  roundId: string,
  taskId: string,
  costUsd: number,
): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_budget_exhausted',
    id: `budget-${roundId}-${taskId}`,
    ts: 1,
    runId: 'run-1',
    roundId,
    taskId,
    status: 'budget_exhausted',
    passed: false,
    scored: false,
    eligible: true,
    errorClass: 'budget_exhausted',
    error: 'agent timed out',
    expectedPromptHash: promptHashForRound(roundId),
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd }),
  };
}

function attributionEvent(
  roundId: string,
  overrides: Partial<Extract<FixedPromptWalEvent, { type: 'rsi_controller_attribution' }>> = {},
): FixedPromptWalEvent {
  const event: Extract<FixedPromptWalEvent, { type: 'rsi_controller_attribution' }> = {
    schemaVersion: 1,
    type: 'rsi_controller_attribution',
    id: `attribution-${roundId}`,
    ts: 1,
    runId: 'run-1',
    roundId,
    candidateCommitSha: `candidate-${roundId}`,
    heldInTaskSetHash: 'sha256:held-in-task-set',
    candidateRationaleHash: 'sha256:candidate-rationale',
    evidenceRefs: [],
    predictedFixes: [],
    riskTasks: [],
    unexpectedHeldInFlips: [],
    decision: { decision: 'discard', reason: 'held_in_within_noise' },
    rootCauseSignalMatch: 'unknown',
  };
  return { ...event, ...overrides };
}

function promptHashForRound(roundId: string): string {
  return `sha256:${roundId}`;
}

function plumbingFailedEvent(roundId: string, taskId: string): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_plumbing_failed',
    id: `plumbing-${roundId}-${taskId}`,
    ts: 1,
    runId: 'run-1',
    roundId,
    taskId,
    status: 'plumbing_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'prompt_hash_mismatch',
    error: 'prompt hash mismatch',
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd: 1 }),
    steps: 1,
    durationMs: 10,
    runtimeEventsPath: `/logs/${roundId}/${taskId}.jsonl`,
    harbor: { reward: 0 },
  };
}

function infraFailedEvent(roundId: string, taskId: string): FixedPromptWalEvent {
  return {
    schemaVersion: 1,
    type: 'task_infra_failed',
    id: `infra-${roundId}-${taskId}`,
    ts: 1,
    runId: 'run-1',
    roundId,
    taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'infra_error',
    error: 'container crashed',
  };
}
