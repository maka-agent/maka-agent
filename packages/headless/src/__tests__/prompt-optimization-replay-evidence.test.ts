import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  type PromptCandidateDecisionEvent,
} from '../fixed-prompt-controller.js';
import type { PromptAcceptanceResult } from '../prompt-acceptance-policy.js';
import { assertReplayedDecisionMatchesResult } from '../prompt-optimization-replay-evidence.js';

describe('prompt optimization replay evidence', () => {
  test('accepts legacy report-only reward-hack quarantine metadata after scanner fixes', () => {
    const result = cleanAcceptanceResult();
    const legacyDecision: PromptCandidateDecisionEvent = {
      schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
      type: 'prompt_candidate_decided',
      id: 'decision-1',
      ts: 1,
      ...result,
      rewardHackScan: {
        decision: 'quarantine',
        reason: 'verifier_pattern',
        matchedPatterns: ['OLD_FALSE_POSITIVE'],
      },
    };

    assert.doesNotThrow(() => assertReplayedDecisionMatchesResult(legacyDecision, result));
  });
});

function cleanAcceptanceResult(): PromptAcceptanceResult {
  const summary = {
    taskCount: 1,
    observed: 1,
    eligible: 1,
    scored: 1,
    passed: 1,
    passEligibleRate: 1,
    coverageRate: 1,
    unscoredTaskIds: [],
    infraFailedTaskIds: [],
    plumbingFailedTaskIds: [],
    missingTaskIds: [],
  };
  return {
    runId: 'run-1',
    roundId: 'round-1',
    decision: 'keep',
    reason: 'held_in_improved',
    candidateCommitSha: 'candidate-1',
    previousLastKeptCommitSha: 'kept-0',
    lastKeptCommitSha: 'candidate-1',
    previousHeldInReferencePassEligibleRate: 0.5,
    heldInReferencePassEligibleRate: 1,
    originalCommitSha: 'original-0',
    originalHeldOutPassEligibleRate: 1,
    heldInPassRateNoiseBand: 0,
    heldOutPassRateNoiseBand: 0,
    rewardHackScan: { decision: 'clean' },
    metrics: {
      original: { heldOut: summary },
      lastKept: { heldIn: summary },
      candidate: { heldIn: summary, heldOut: summary },
    },
  };
}
