import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAbRunLock } from './ab-run-lock.js';
import {
  runRuntimePolicyAbComparisonUnlocked,
  type RunRuntimePolicyAbComparisonInput,
  type RuntimePolicyAbComparisonSummary,
} from './runtime-policy-ab-run.js';

export interface RunRuntimePolicyAbLifecycleInput extends Omit<RunRuntimePolicyAbComparisonInput, 'evaluationTasks' | 'reps' | 'roundIdPrefix'> {
  manifestFingerprint: string;
  pilotTasks: RunRuntimePolicyAbComparisonInput['evaluationTasks'];
  evaluationTasks: RunRuntimePolicyAbComparisonInput['evaluationTasks'];
  fullReps: number;
}

export interface RuntimePolicyAbLifecycleState {
  schemaVersion: 'maka.runtime_policy_ab.lifecycle.v1';
  manifestFingerprint: string;
  status: 'pilot_pending' | 'pilot_not_cleared' | 'pilot_cleared' | 'full_completed' | 'invalid';
  reason?: string;
  pilot?: RuntimePolicyAbComparisonSummary;
  full?: RuntimePolicyAbComparisonSummary;
}

export async function runRuntimePolicyAbLifecycle(
  input: RunRuntimePolicyAbLifecycleInput,
): Promise<RuntimePolicyAbLifecycleState> {
  return withAbRunLock(input.runRoot, async () => {
    const statePath = join(input.runRoot, 'runtime-policy-ab-state.json');
    let state = await readState(statePath, input.manifestFingerprint);
    if (state.status === 'full_completed' || state.status === 'invalid' || state.status === 'pilot_not_cleared') return state;

    if (state.status === 'pilot_pending') {
      const pilotResult = await runRuntimePolicyAbComparisonUnlocked({
        ...input,
        evaluationTasks: input.pilotTasks,
        reps: 1,
        roundIdPrefix: 'pilot',
      });
      const pilot: RuntimePolicyAbComparisonSummary = pilotResult;
      const clearanceFailure = pilotClearanceFailure(pilot);
      state = {
        schemaVersion: 'maka.runtime_policy_ab.lifecycle.v1',
        manifestFingerprint: input.manifestFingerprint,
        status: clearanceFailure ? 'pilot_not_cleared' : 'pilot_cleared',
        ...(clearanceFailure ? { reason: clearanceFailure } : {}),
        pilot,
      };
      await writeState(statePath, state);
      if (clearanceFailure) return state;
    }

    if (input.fullReps < 2 || !Number.isSafeInteger(input.fullReps)) {
      state = { ...state, status: 'invalid', reason: 'full_reps_must_be_at_least_2' };
      await writeState(statePath, state);
      return state;
    }
    const pilotCost = (state.pilot?.baseline.totalCostUsd ?? 0) + (state.pilot?.candidate.totalCostUsd ?? 0);
    const remainingCostUsd = input.executionProfile.observedCostStopUsd - pilotCost;
    if (remainingCostUsd <= 0) {
      state = { ...state, status: 'invalid', reason: 'observed_cost_stop_reached_during_pilot' };
      await writeState(statePath, state);
      return state;
    }
    const full = await runRuntimePolicyAbComparisonUnlocked({
      ...input,
      evaluationTasks: input.evaluationTasks,
      reps: input.fullReps,
      roundIdPrefix: 'full',
      executionProfile: { ...input.executionProfile, observedCostStopUsd: remainingCostUsd },
    });
    const invalidReason = full.stopReason ?? (full.decision === 'invalid' ? full.reason : undefined);
    state = {
      ...state,
      status: invalidReason ? 'invalid' : 'full_completed',
      ...(invalidReason ? { reason: invalidReason } : {}),
      full,
    };
    await writeState(statePath, state);
    return state;
  });
}

function pilotClearanceFailure(summary: RuntimePolicyAbComparisonSummary): string | undefined {
  if (summary.stopReason) return summary.stopReason;
  if (summary.baseline.infraFailed + summary.candidate.infraFailed > 0) return 'pilot_infra_failure';
  if (summary.baseline.plumbingFailed + summary.candidate.plumbingFailed > 0) return 'pilot_plumbing_failure';
  if (summary.baseline.coverageRate !== 1 || summary.candidate.coverageRate !== 1) return 'pilot_incomplete';
  if ((summary.candidate.contextBudget?.activatedAttempts ?? 0) === 0) return 'pilot_candidate_not_activated';
  return undefined;
}

async function readState(path: string, manifestFingerprint: string): Promise<RuntimePolicyAbLifecycleState> {
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as RuntimePolicyAbLifecycleState;
    if (state.schemaVersion !== 'maka.runtime_policy_ab.lifecycle.v1') throw new Error('unsupported runtime policy A/B lifecycle state');
    if (state.manifestFingerprint !== manifestFingerprint) throw new Error('runtime policy A/B lifecycle state does not match manifest');
    return state;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return {
      schemaVersion: 'maka.runtime_policy_ab.lifecycle.v1',
      manifestFingerprint,
      status: 'pilot_pending',
    };
  }
}

async function writeState(path: string, state: RuntimePolicyAbLifecycleState): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
