import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRuntimePolicyAbSpec } from '../runtime-policy-ab-spec.js';

test('runtime A/B spec requires a real pilot and repeated full evidence', () => {
  const base = {
    schemaVersion: 1,
    id: 'stale-prune',
    arms: [
      { id: 'off', contextEnv: { MAKA_CONTEXT_BUDGET: 'off' } },
      { id: 'on', contextEnv: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on' } },
    ],
    sharedAgentEnv: {},
    pilotTaskIds: ['pilot'],
    evaluationTaskIds: ['full'],
    fullReps: 2,
    nonInferiorityMargin: 0.1,
  };

  assert.equal(parseRuntimePolicyAbSpec(base).fullReps, 2);
  assert.throws(
    () => parseRuntimePolicyAbSpec({ ...base, fullReps: 1 }),
    /fullReps must be an integer of at least 2/,
  );
  assert.throws(
    () => parseRuntimePolicyAbSpec({ ...base, pilotTaskIds: [] }),
    /pilotTaskIds must be a non-empty string array/,
  );
});
