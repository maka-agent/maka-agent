import { createHash } from 'node:crypto';
import { buildAbRunManifest, buildRunManifestFingerprint } from './ab-manifest.js';
import type { AbRunManifest } from './ab-types.js';

export type HarnessAbArmId = 'maka' | 'opencode';

export interface HarnessAbArmInput {
  id: HarnessAbArmId;
  version: string;
  config: Record<string, unknown>;
}

export interface HarnessAbRunManifestInput {
  benchmark: {
    dataset: 'terminal-bench';
    version: '2.1';
    revision: string;
  };
  taskIds: readonly string[];
  orderSeed: string;
  pilotTaskCount: number;
  model: {
    provider: string;
    id: string;
    reasoningEffort: 'max';
  };
  pricing: {
    currency: 'USD';
    unit: 'per_1m_tokens';
    input: number;
    cachedInput: number;
    output: number;
    source: string;
  };
  arms: readonly [HarnessAbArmInput, HarnessAbArmInput];
  taskBudgetSec: number;
  harborTimeoutMs: number;
  subjectFingerprint: string;
  taskSourceFingerprint: string;
  toolchainFingerprint: string;
}

export type HarnessAbRunManifest = AbRunManifest & {
  experimentKind: 'harness';
  metadata: {
    benchmark: HarnessAbRunManifestInput['benchmark'];
    metric: 'pass@1';
    order: {
      algorithm: 'sha256-rank-v1';
      seed: string;
      pilotTaskCount: number;
    };
    model: HarnessAbRunManifestInput['model'];
    pricing: HarnessAbRunManifestInput['pricing'];
  };
  pilotTaskIds: string[];
};

export function deterministicHarnessTaskOrder(taskIds: readonly string[], seed: string): string[] {
  if (seed.length === 0) throw new Error('harness task order seed must not be empty');
  const unique = new Set<string>();
  for (const taskId of taskIds) {
    if (unique.has(taskId)) throw new Error(`duplicate harness task id: ${taskId}`);
    unique.add(taskId);
  }
  return [...unique].sort((left, right) => {
    const rankDelta = taskRank(seed, left).localeCompare(taskRank(seed, right));
    return rankDelta || left.localeCompare(right);
  });
}

export function buildHarnessAbRunManifest(input: HarnessAbRunManifestInput): HarnessAbRunManifest {
  const evaluationTaskIds = deterministicHarnessTaskOrder(input.taskIds, input.orderSeed);
  if (
    !Number.isSafeInteger(input.pilotTaskCount)
    || input.pilotTaskCount < 1
    || input.pilotTaskCount > evaluationTaskIds.length
  ) {
    throw new Error(`pilotTaskCount must be between 1 and ${evaluationTaskIds.length}`);
  }
  const metadata: HarnessAbRunManifest['metadata'] = {
    benchmark: { ...input.benchmark },
    metric: 'pass@1',
    order: {
      algorithm: 'sha256-rank-v1',
      seed: input.orderSeed,
      pilotTaskCount: input.pilotTaskCount,
    },
    model: { ...input.model },
    pricing: { ...input.pricing },
  };
  const manifest = buildAbRunManifest({
    experimentKind: 'harness',
    arms: input.arms.map((arm) => ({
      id: arm.id,
      kind: 'harness' as const,
      fingerprint: buildRunManifestFingerprint({ version: arm.version, config: arm.config }),
      metadata: { version: arm.version, config: arm.config },
    })) as unknown as [HarnessAbRunManifest['arms'][number], HarnessAbRunManifest['arms'][number]],
    metadata,
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds,
    pilotTaskIds: evaluationTaskIds.slice(0, input.pilotTaskCount),
    reps: 1,
    candidateLimit: null,
    maxConcurrency: 1,
    selectionMode: 'explicit',
  });
  return manifest as HarnessAbRunManifest;
}

function taskRank(seed: string, taskId: string): string {
  return createHash('sha256').update(seed).update('\0').update(taskId).digest('hex');
}
