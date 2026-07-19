import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolvePromptOptimizationProfile } from '../prompt-optimization-profile.js';

describe('prompt optimization profile', () => {
  test('defaults unattended prompt optimization runs to the pilot profile', () => {
    assert.deepEqual(resolvePromptOptimizationProfile(undefined), {
      name: 'pilot',
      rounds: 3,
      baselineRuns: 1,
      heldInCount: 12,
      heldOutCount: 4,
      costCeilingUsd: 2,
    });
  });

  test('keeps full profile values explicit', () => {
    assert.deepEqual(resolvePromptOptimizationProfile('full'), {
      name: 'full',
      rounds: 10,
      baselineRuns: 3,
      heldInCount: 60,
      heldOutCount: 20,
      costCeilingUsd: 30,
    });
  });

  test('provides a light pilot profile for repeatable medium-smoke runs', () => {
    assert.deepEqual(resolvePromptOptimizationProfile('pilot-light'), {
      name: 'pilot-light',
      rounds: 2,
      baselineRuns: 1,
      heldInCount: 8,
      heldOutCount: 3,
      costCeilingUsd: 1.25,
    });
  });

  test('rejects unknown profiles before any benchmark work starts', () => {
    assert.throws(
      () => resolvePromptOptimizationProfile('medium'),
      /MAKA_PROMPT_PROFILE must be one of smoke, pilot-light, pilot, full/,
    );
  });
});
