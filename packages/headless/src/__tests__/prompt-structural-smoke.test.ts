import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FixedPromptWalEvent, PromptCandidateRewardHackScan } from '../fixed-prompt-controller.js';
import {
  promptStructuralSmokeReport,
  renderPromptStructuralSmokeMarkdown,
} from '../prompt-structural-smoke.js';

describe('prompt structural smoke report', () => {
  test('passes after ten unattended discard decisions under budget', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }));
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
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }));
    }
    events.push(committedEvent('round-9'));
    events.push(completedEvent('round-9', 'task-9', 4));
    events.push(decisionEvent('round-9', 'discard', 'reward_hack_quarantined', 'run-1', {
      decision: 'quarantine',
      reason: 'verifier_pattern',
    }));
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

  test('fails when decision rounds have no task evidence', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      events.push(decisionEvent(`round-${index}`, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }));
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
      events.push(decisionEvent(roundId, 'discard', 'coverage_regressed', 'run-1', { decision: 'clean' }));
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
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-current', { decision: 'clean' }));
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
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-a', { decision: 'clean' }));
    }
    for (let index = 6; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId, 'run-b'));
      events.push(completedEvent(roundId, `task-${index}`, 0.1, 'run-b'));
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-b', { decision: 'clean' }));
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['multiple_runs_present']);
  });

  test('fails when decision rounds have no reward-hack scan evidence', () => {
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

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['reward_hack_scan_missing']);
  });

  test('fails when reward-hack scan quarantines despite a mismatched reason', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', {
        decision: 'quarantine',
        reason: 'verifier_pattern',
      }));
    }

    const report = promptStructuralSmokeReport({
      events,
      minimumRounds: 10,
      costCeilingUsd: 30,
    });

    assert.equal(report.status, 'fail');
    assert.deepEqual(report.failures, ['reward_hack_quarantine_present']);
  });

  test('fails when reward-hack scan has an unknown decision', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', {
        decision: 'skipped',
      } as unknown as PromptCandidateRewardHackScan));
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

  test('fails when reward-hack scan evidence is null', () => {
    const events: FixedPromptWalEvent[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const roundId = `round-${index}`;
      events.push(committedEvent(roundId));
      events.push(completedEvent(roundId, `task-${index}`, 0.1));
      const event = decisionEvent(
        roundId,
        'discard',
        'held_in_within_noise',
        'run-1',
        { decision: 'clean' },
      );
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
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }));
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
      events.push(completedEvent(roundId, `task-${index}`, 0.1, 'run-1', `sha256:stale-${roundId}`));
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }));
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
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }));
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
      events.push(decisionEvent(roundId, 'discard', 'held_in_within_noise', 'run-1', { decision: 'clean' }));
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
});

function committedEvent(
  roundId: string,
  runId = 'run-1',
  promptHash = promptHashForRound(roundId),
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
    tokenSummary: { input: 1, output: 1, reasoning: 0, total: 2, costUsd },
    steps: 1,
    durationMs: 10,
    runtimeEventsPath: `/logs/${roundId}/${taskId}.jsonl`,
    harbor: { reward: 0 },
  };
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
    tokenSummary: { input: 1, output: 1, reasoning: 0, total: 2, costUsd: 1 },
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
