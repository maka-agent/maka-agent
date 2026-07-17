import { buildRunManifestFingerprint } from './ab-manifest.js';
import { buildAbRoundId, runAbComparison } from './ab-run.js';
import { withAbRunLock } from './ab-run-lock.js';
import type { AbComparisonSummary } from './ab-types.js';
import type { Config } from './contracts.js';
import type { HarborBillingMode } from './harbor-task-runner.js';
import {
  runFixedPromptController,
  type FixedPromptTask,
  type FixedPromptTaskWalEvent,
  type HarborTaskRunner,
} from './fixed-prompt-controller.js';
import {
  HARNESS_AB_MAX_CONCURRENT_ATTEMPTS,
  HARNESS_AB_PAIR_CONCURRENCY,
  type HarnessAbArmId,
} from './harness-ab-manifest.js';

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
  now?: () => number;
  newId?: () => string;
}

export interface HarnessAbCellSelection {
  taskId: string;
  armId: HarnessAbArmId;
}

export interface RunHarnessAbCellsInput extends RunHarnessAbComparisonInput {
  cells: readonly HarnessAbCellSelection[];
}

export interface HarnessAbCellResult extends HarnessAbCellSelection {
  event: FixedPromptTaskWalEvent;
}

export interface HarnessAbCellsResult {
  cells: HarnessAbCellResult[];
}

export async function runHarnessAbComparison(
  input: RunHarnessAbComparisonInput,
): Promise<AbComparisonSummary> {
  return withAbRunLock(input.runRoot, () => runHarnessAbComparisonUnlocked(input));
}

export function withHarnessAbRunLock<T>(runRoot: string, action: () => Promise<T>): Promise<T> {
  return withAbRunLock(runRoot, action);
}

export async function runHarnessAbCells(
  input: RunHarnessAbCellsInput,
): Promise<HarnessAbCellsResult> {
  return withAbRunLock(input.runRoot, () => runHarnessAbCellsUnlocked(input));
}

export async function runHarnessAbCellsUnlocked(
  input: RunHarnessAbCellsInput,
): Promise<HarnessAbCellsResult> {
  if (input.cells.length === 0) throw new Error('harness A/B cell selection must not be empty');
  const tasks = new Map(input.evaluationTasks.map((task) => [task.id, task]));
  const arms = new Map(input.arms.map((arm) => [arm.id, arm]));
  const seen = new Set<string>();
  const pending = input.cells.map((cell) => {
    const key = `${cell.taskId}\0${cell.armId}`;
    if (seen.has(key)) throw new Error(`duplicate harness A/B cell: ${cell.taskId}/${cell.armId}`);
    seen.add(key);
    const task = tasks.get(cell.taskId);
    if (!task) throw new Error(`harness A/B cell task ${cell.taskId} is not configured`);
    const arm = arms.get(cell.armId);
    if (!arm) throw new Error(`harness A/B cell arm ${cell.armId} is not configured`);
    return { cell, task, arm };
  });
  const results = new Array<HarnessAbCellResult>(pending.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(HARNESS_AB_MAX_CONCURRENT_ATTEMPTS, pending.length) },
    async () => {
      while (nextIndex < pending.length) {
        const index = nextIndex;
        nextIndex += 1;
        const current = pending[index]!;
        const roundId = buildAbRoundId(undefined, current.arm.id, 0, current.task.id);
        const event = await runHarnessArmCell(input, current.arm, current.task, roundId);
        results[index] = { ...current.cell, event };
      }
    },
  );
  const settledWorkers = await Promise.allSettled(workers);
  const rejectedWorker = settledWorkers.find(
    (worker): worker is PromiseRejectedResult => worker.status === 'rejected',
  );
  if (rejectedWorker) throw rejectedWorker.reason;
  return { cells: results };
}

export async function runHarnessAbComparisonUnlocked(
  input: RunHarnessAbComparisonInput,
): Promise<AbComparisonSummary> {
  return runAbComparison({
    runId: input.runId,
    arms: input.arms.map((arm) => ({
      id: arm.id,
      kind: 'harness' as const,
      fingerprint: buildRunManifestFingerprint({
        config: arm.config,
        expectedPricingProfile: arm.expectedPricingProfile,
        ...(arm.billingMode ? { billingMode: arm.billingMode } : {}),
      }),
    })) as unknown as [
      { id: HarnessAbArmId; kind: 'harness'; fingerprint: string },
      { id: HarnessAbArmId; kind: 'harness'; fingerprint: string },
    ],
    evaluationTasks: input.evaluationTasks,
    reps: 1,
    maxConcurrency: HARNESS_AB_PAIR_CONCURRENCY,
    armExecution: 'parallel',
    runArm: async ({ roundId, arm, task }) => {
      const runtimeArm = input.arms.find((candidate) => candidate.id === arm.id);
      if (!runtimeArm) throw new Error(`harness A/B arm ${arm.id} is not configured`);
      return runHarnessArmCell(input, runtimeArm, task, roundId);
    },
  });
}

async function runHarnessArmCell(
  input: RunHarnessAbComparisonInput,
  runtimeArm: HarnessAbRuntimeArm,
  task: FixedPromptTask,
  roundId: string,
): Promise<FixedPromptTaskWalEvent> {
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
}
