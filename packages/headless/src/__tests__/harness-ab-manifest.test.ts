import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildHarnessAbRunManifest,
  deterministicHarnessTaskOrder,
} from '../harness-ab-manifest.js';

describe('harness A/B manifest', () => {
  test('freezes one deterministic 40-task prefix inside the full task order', () => {
    const taskIds = Array.from({ length: 89 }, (_, index) => `task-${String(index + 1).padStart(2, '0')}`);
    const input = manifestInput(taskIds);

    const manifest = buildHarnessAbRunManifest(input);

    assert.equal(manifest.experimentKind, 'harness');
    assert.equal(manifest.reps, 1);
    assert.equal(manifest.evaluationTaskIds.length, 89);
    assert.deepEqual(manifest.pilotTaskIds, manifest.evaluationTaskIds.slice(0, 40));
    assert.deepEqual(
      manifest.evaluationTaskIds,
      deterministicHarnessTaskOrder([...taskIds].reverse(), input.orderSeed),
    );
    assert.equal(new Set(manifest.evaluationTaskIds).size, 89);
    assert.deepEqual(manifest.metadata, {
      benchmark: { dataset: 'terminal-bench', version: '2.1', revision: 'tb-revision' },
      metric: 'pass@1',
      order: { algorithm: 'sha256-rank-v1', seed: 'maka-glm-5.2-v1', pilotTaskCount: 40 },
      model: { provider: 'zai-coding-plan', id: 'glm-5.2', reasoningEffort: 'max' },
      pricing: {
        currency: 'USD',
        unit: 'per_1m_tokens',
        input: 1.4,
        cachedInput: 0.26,
        output: 4.4,
        source: 'z.ai-public-2026-07-13',
      },
    });
  });

  test('changes identity when a frozen harness config changes', () => {
    const original = buildHarnessAbRunManifest(manifestInput(['a', 'b', 'c']));
    const changed = buildHarnessAbRunManifest({
      ...manifestInput(['a', 'b', 'c']),
      arms: [
        { id: 'maka', version: '98e3846e', config: { continuation: true } },
        { id: 'opencode', version: '1.17.19', config: { variant: 'max' } },
      ],
    });

    assert.notEqual(changed.fingerprint, original.fingerprint);
    assert.notEqual(changed.arms[1].fingerprint, original.arms[1].fingerprint);
  });

  test('rejects duplicate tasks and a pilot longer than the full run', () => {
    assert.throws(
      () => deterministicHarnessTaskOrder(['a', 'a'], 'seed'),
      /duplicate harness task id: a/,
    );
    assert.throws(
      () => buildHarnessAbRunManifest({ ...manifestInput(['a']), pilotTaskCount: 2 }),
      /pilotTaskCount must be between 1 and 1/,
    );
  });
});

function manifestInput(taskIds: readonly string[]) {
  return {
    benchmark: { dataset: 'terminal-bench' as const, version: '2.1' as const, revision: 'tb-revision' },
    taskIds,
    orderSeed: 'maka-glm-5.2-v1',
    pilotTaskCount: Math.min(40, taskIds.length),
    model: { provider: 'zai-coding-plan', id: 'glm-5.2', reasoningEffort: 'max' as const },
    pricing: {
      currency: 'USD' as const,
      unit: 'per_1m_tokens' as const,
      input: 1.4,
      cachedInput: 0.26,
      output: 4.4,
      source: 'z.ai-public-2026-07-13',
    },
    arms: [
      { id: 'maka' as const, version: '98e3846e', config: { continuation: true } },
      { id: 'opencode' as const, version: '1.17.18', config: { variant: 'max' } },
    ] as const,
    taskBudgetSec: 900,
    harborTimeoutMs: 1_200_000,
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
  };
}
