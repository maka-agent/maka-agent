import { buildRunManifestFingerprint } from './ab-manifest.js';
import { runAbComparison } from './ab-run.js';
import { withAbRunLock } from './ab-run-lock.js';
import type { AbComparisonSummary } from './ab-types.js';
import type { Config } from './contracts.js';
import type { HarborBillingMode } from './harbor-task-runner.js';
import {
  runFixedPromptController,
  type FixedPromptTask,
  type HarborTaskRunner,
} from './fixed-prompt-controller.js';
import { HARNESS_AB_PAIR_CONCURRENCY, type HarnessAbArmId } from './harness-ab-manifest.js';

export interface HarnessAbRuntimeArm {
  id: HarnessAbArmId;
  config: Config;
  expectedPricingProfile: string;
  billingMode?: HarborBillingMode;
  harborRunner: HarborTaskRunner;
}

export interface RunHarnessAbComparisonInput {
  runId: string;
  runRoot: string;
  resultsJsonlPath: string;
  systemPromptPath: string;
  resumeFingerprint: string;
  evaluationTasks: readonly FixedPromptTask[];
  arms: readonly [HarnessAbRuntimeArm, HarnessAbRuntimeArm];
  pairConcurrency?: number;
  now?: () => number;
  newId?: () => string;
}

export async function runHarnessAbComparison(
  input: RunHarnessAbComparisonInput,
): Promise<AbComparisonSummary> {
  return withAbRunLock(input.runRoot, () => runHarnessAbComparisonUnlocked(input));
}

export function withHarnessAbRunLock<T>(runRoot: string, action: () => Promise<T>): Promise<T> {
  return withAbRunLock(runRoot, action);
}

export async function runHarnessAbComparisonUnlocked(
  input: RunHarnessAbComparisonInput,
): Promise<AbComparisonSummary> {
  const pairConcurrency = input.pairConcurrency ?? HARNESS_AB_PAIR_CONCURRENCY;
  if (!Number.isSafeInteger(pairConcurrency) || pairConcurrency < 1) {
    throw new Error('pairConcurrency must be a positive integer');
  }
  return runAbComparison({
    runId: input.runId,
    arms: input.arms.map((arm) => ({
      id: arm.id,
      kind: 'harness' as const,
      fingerprint: buildRunManifestFingerprint({
        config: arm.config,
        expectedPricingProfile: arm.expectedPricingProfile,
        billingMode: arm.billingMode,
      }),
    })) as unknown as [
      { id: HarnessAbArmId; kind: 'harness'; fingerprint: string },
      { id: HarnessAbArmId; kind: 'harness'; fingerprint: string },
    ],
    evaluationTasks: input.evaluationTasks,
    reps: 1,
    maxConcurrency: pairConcurrency,
    armExecution: 'parallel',
    runArm: async ({ roundId, arm, task }) => {
      const runtimeArm = input.arms.find((candidate) => candidate.id === arm.id);
      if (!runtimeArm) throw new Error(`harness A/B arm ${arm.id} is not configured`);
      const result = await runFixedPromptController({
        runId: input.runId,
        roundId,
        config: runtimeArm.config,
        systemPromptPath: input.systemPromptPath,
        resultsJsonlPath: input.resultsJsonlPath,
        tasks: [task],
        infraFailurePolicy: 'terminal',
        protectPassAtOne: true,
        requireExecutionIdentity: true,
        requireFinalUsage: true,
        expectedPricingProfile: runtimeArm.expectedPricingProfile,
        ...(runtimeArm.billingMode ? { billingMode: runtimeArm.billingMode } : {}),
        resumeFingerprint: input.resumeFingerprint,
        harborRunner: runtimeArm.harborRunner,
        ...(input.now ? { now: input.now } : {}),
        ...(input.newId ? { newId: input.newId } : {}),
      });
      const event = result.events.find((candidate) => candidate.taskId === task.id);
      if (!event) throw new Error(`harness A/B arm ${roundId} produced no event for ${task.id}`);
      return event;
    },
  });
}
