import { randomUUID } from 'node:crypto';
import type { Config } from './contracts.js';
import {
  runFixedPromptController,
  readFixedPromptWal,
  type FixedPromptControllerResult,
  type FixedPromptTask,
  type FixedPromptTaskCompletedEvent,
  type FixedPromptTaskWalEvent,
  type HarborTaskRunner,
  type PromptCandidateRewardHackScan,
} from './fixed-prompt-controller.js';
import {
  extractTrajectoryDigest,
  runPromptCandidateRound,
  scanRuntimeEventsForRewardHack,
  type MetaAgent,
  type PromptCandidateGit,
  type TrajectoryDigest,
} from './prompt-candidate-loop.js';
import {
  appendPromptAcceptanceDecision,
  calibratePromptAcceptanceBaseline,
  decidePromptAcceptance,
  selectStablePromptTasks,
  type PromptAcceptanceBaseline,
  type PromptAcceptanceBaselineRun,
  type PromptAcceptanceResult,
} from './prompt-acceptance-policy.js';
import {
  promptStructuralSmokeReport,
  type PromptStructuralSmokeReport,
} from './prompt-structural-smoke.js';

/**
 * Top-level driver for the RSI prompt-optimization loop (Issue #64).
 *
 * It composes the four existing layers into one unattended run:
 *   1. baseline calibration — sweep the held-in and held-out partitions a few
 *      times on the unchanged prompt to learn each partition's noise band;
 *   2. for each round: ask the meta-agent for a candidate prompt (commits it),
 *      sweep both partitions on the candidate, scan held-in trajectories for
 *      reward-hacking, then run the acceptance policy and KEEP (advance the
 *      lineage) or DISCARD (roll the candidate commit back);
 *   3. a structural smoke report over the whole write-ahead log.
 *
 * Every expensive edge is injected: `harborRunner` (Docker/Harbor) and
 * `metaAgent` (the model call) are dependencies, so the full composition is
 * unit-testable with fakes and no network or containers. The controller-only
 * artifacts (`resultsJsonlPath`, the two TSVs) MUST live outside `agentCwdPath`
 * — the candidate round asserts this so the meta-agent can never read held-out
 * results.
 */
export interface PromptOptimizationLoopInput {
  runId: string;
  /** Number of candidate rounds after baseline calibration. */
  rounds: number;
  /** Baseline sweeps per partition before the loop (default 3, minimum 1). */
  baselineRuns?: number;
  /** z-score for the noise-band width (default 1.96). */
  zScore?: number;

  // Prompt repo (agent-visible working tree the meta-agent edits).
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;

  // Controller-only artifacts — must resolve OUTSIDE agentCwdPath.
  /** Shared write-ahead log for every sweep, candidate, and decision. */
  resultsJsonlPath: string;
  /** Held-in TSV; the controller rewrites it each sweep and the next round's
   * candidate reads it as feedback. */
  heldInResultsTsvPath: string;
  /** Held-out TSV (kept out of the meta-agent's view). */
  heldOutResultsTsvPath: string;

  heldInTasks: readonly FixedPromptTask[];
  heldOutTasks: readonly FixedPromptTask[];
  /** Extra held-out artifact paths the candidate round must keep hidden. */
  heldOutArtifactPaths?: readonly string[];

  config: Config;
  harborRunner: HarborTaskRunner;
  metaAgent: MetaAgent;
  git: PromptCandidateGit;
  /** HEAD of the prompt repo before any candidate commit. */
  originalCommitSha: string;

  /** Verifier strings, by task id, that must not be visible to the model. A
   * held-in task that completes without configured patterns quarantines the
   * round (fail-loud). */
  rewardHackVerifierPatternsByTaskId?: Readonly<Record<string, readonly string[]>>;

  /** Abort if fewer than this many held-in tasks complete (scored + eligible)
   * across every baseline sweep (default 1). A floor above 1 guards against
   * calibrating on an unrepresentative subset after a harness/cache regression
   * silently drops most tasks. */
  minStableHeldInTasks?: number;
  /** Same floor for the held-out partition (default 1). */
  minStableHeldOutTasks?: number;
  /** Drop a task whose baseline trial ran longer than this (any sweep) from the
   * calibrated set and all candidate rounds. Keeps the loop tractable when a
   * few tasks are pathologically slow for the agent. Unset = no duration cap. */
  maxStableTaskDurationMs?: number;

  /** Stop the loop once cumulative task cost reaches this (checked per round). */
  costCeilingUsd?: number;
  /** Stop the loop once the cumulative infra-failure rate exceeds this. */
  maxInfraFailureRate?: number;
  /** Per-sweep harbor concurrency (default 1). */
  maxConcurrency?: number;

  now?: () => number;
  newId?: () => string;
}

export type PromptOptimizationLoopStopReason =
  | 'rounds_complete'
  | 'cost_ceiling_exceeded'
  | 'infra_failure_rate_exceeded';

export interface PromptOptimizationLoopResult {
  runId: string;
  baseline: PromptAcceptanceBaseline;
  decisions: PromptAcceptanceResult[];
  keptCount: number;
  lastKeptCommitSha: string;
  heldInReferencePassEligibleRate: number | null;
  totalCostUsd: number;
  stopReason: PromptOptimizationLoopStopReason;
  smoke: PromptStructuralSmokeReport;
  /** Held-in task ids dropped before calibration: they did not complete
   * (scored + eligible) across every baseline sweep, so they carry no signal. */
  droppedHeldInTaskIds: string[];
  /** Held-out task ids dropped before calibration, same criterion. */
  droppedHeldOutTaskIds: string[];
}

export async function runPromptOptimizationLoop(
  input: PromptOptimizationLoopInput,
): Promise<PromptOptimizationLoopResult> {
  const now = input.now ?? Date.now;
  const newId = input.newId ?? randomUUID;
  const baselineRunCount = input.baselineRuns ?? 3;
  if (baselineRunCount < 1) throw new Error('baselineRuns must be at least 1');
  if (input.rounds < 0) throw new Error('rounds must be non-negative');

  const heldInTaskIds = input.heldInTasks.map((task) => task.id);
  const heldOutTaskIds = input.heldOutTasks.map((task) => task.id);

  let totalCostUsd = 0;
  let infraFailed = 0;
  let taskAttempts = 0;
  const accumulate = (result: FixedPromptControllerResult): void => {
    totalCostUsd += result.totalCostUsd;
    for (const event of result.events) {
      taskAttempts += 1;
      if (event.type === 'task_infra_failed') infraFailed += 1;
    }
  };

  const sweep = (
    roundId: string,
    tasks: readonly FixedPromptTask[],
    resultsTsvPath: string,
  ): Promise<FixedPromptControllerResult> => runFixedPromptController({
    runId: input.runId,
    roundId,
    config: input.config,
    systemPromptPath: input.systemPromptPath,
    resultsJsonlPath: input.resultsJsonlPath,
    resultsTsvPath,
    tasks,
    harborRunner: input.harborRunner,
    ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
    now,
    newId,
  });

  const digestsFor = (events: readonly FixedPromptTaskWalEvent[]): Promise<TrajectoryDigest[]> => Promise.all(
    events
      .filter((event): event is FixedPromptTaskCompletedEvent => event.type === 'task_completed')
      .map((event) => extractTrajectoryDigest({
        taskId: event.taskId,
        ...(event.errorClass ? { errorClass: event.errorClass } : {}),
        runtimeEventsPath: event.runtimeEventsPath,
        verifierSummary: `status=${event.status} passed=${event.passed} reward=${event.harbor.reward}`,
      })),
  );

  // Reward-hacking guard over the held-in trajectories the meta-agent optimizes
  // against. First non-clean task decides the round (deterministic by order).
  const scanHeldIn = async (
    events: readonly FixedPromptTaskWalEvent[],
  ): Promise<PromptCandidateRewardHackScan> => {
    for (const event of events) {
      if (event.type !== 'task_completed') continue;
      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath: event.runtimeEventsPath,
        verifierPatterns: input.rewardHackVerifierPatternsByTaskId?.[event.taskId] ?? [],
      });
      if (result.decision === 'quarantine') {
        return result.reason === 'verifier_pattern'
          ? { decision: 'quarantine', reason: result.reason, matchedPatterns: result.matchedPatterns }
          : { decision: 'quarantine', reason: result.reason };
      }
    }
    return { decision: 'clean' };
  };

  const stopGuard = (): PromptOptimizationLoopStopReason | undefined => {
    if (input.costCeilingUsd !== undefined && totalCostUsd >= input.costCeilingUsd) {
      return 'cost_ceiling_exceeded';
    }
    if (
      input.maxInfraFailureRate !== undefined
      && taskAttempts > 0
      && infraFailed / taskAttempts > input.maxInfraFailureRate
    ) {
      return 'infra_failure_rate_exceeded';
    }
    return undefined;
  };

  // 1. Baseline calibration — repeated sweeps of the unchanged prompt.
  const baselineRunsData: PromptAcceptanceBaselineRun[] = [];
  for (let index = 0; index < baselineRunCount; index += 1) {
    const roundId = `baseline-${index}`;
    const heldIn = await sweep(roundId, input.heldInTasks, input.heldInResultsTsvPath);
    const heldOut = await sweep(roundId, input.heldOutTasks, input.heldOutResultsTsvPath);
    accumulate(heldIn);
    accumulate(heldOut);
    baselineRunsData.push({ heldInEvents: heldIn.events, heldOutEvents: heldOut.events });
  }
  // Drop tasks that did not complete cleanly (scored + eligible) across every
  // baseline sweep. Such a task carries no calibration signal and, left in,
  // would abort the whole run via the strict completeness check inside
  // calibratePromptAcceptanceBaseline. Completion-only filter (any pass/fail
  // spread allowed) — a flaky-pass task's variance is honest noise the band
  // already absorbs. Dropped tasks are excluded from every candidate round too,
  // so they neither cost more nor skew a decision. The run aborts only when a
  // whole partition has no stable task left (then there is nothing to calibrate).
  const durationCap = input.maxStableTaskDurationMs !== undefined
    ? { maxDurationMs: input.maxStableTaskDurationMs }
    : {};
  const heldInStable = selectStablePromptTasks({
    taskIds: heldInTaskIds,
    baselineRuns: baselineRunsData.map((run) => run.heldInEvents),
    maxPassRateSpread: 1,
    ...durationCap,
  });
  const heldOutStable = selectStablePromptTasks({
    taskIds: heldOutTaskIds,
    baselineRuns: baselineRunsData.map((run) => run.heldOutEvents),
    maxPassRateSpread: 1,
    ...durationCap,
  });
  const minStableHeldIn = input.minStableHeldInTasks ?? 1;
  const minStableHeldOut = input.minStableHeldOutTasks ?? 1;
  if (heldInStable.selectedTaskIds.length < minStableHeldIn) {
    throw new Error(
      `held-in stable task count ${heldInStable.selectedTaskIds.length} is below the minimum ${minStableHeldIn} `
      + `(${heldInTaskIds.length} configured, ${heldInStable.rejectedTaskIds.length} dropped across baseline sweeps)`,
    );
  }
  if (heldOutStable.selectedTaskIds.length < minStableHeldOut) {
    throw new Error(
      `held-out stable task count ${heldOutStable.selectedTaskIds.length} is below the minimum ${minStableHeldOut} `
      + `(${heldOutTaskIds.length} configured, ${heldOutStable.rejectedTaskIds.length} dropped across baseline sweeps)`,
    );
  }
  const stableHeldInTaskIds = heldInStable.selectedTaskIds;
  const stableHeldOutTaskIds = heldOutStable.selectedTaskIds;
  const droppedHeldInTaskIds = heldInStable.rejectedTaskIds.map((rejected) => rejected.taskId);
  const droppedHeldOutTaskIds = heldOutStable.rejectedTaskIds.map((rejected) => rejected.taskId);
  const stableHeldInSet = new Set(stableHeldInTaskIds);
  const stableHeldOutSet = new Set(stableHeldOutTaskIds);
  const roundHeldInTasks = input.heldInTasks.filter((task) => stableHeldInSet.has(task.id));
  const roundHeldOutTasks = input.heldOutTasks.filter((task) => stableHeldOutSet.has(task.id));
  const stableHeldIn = (events: readonly FixedPromptTaskWalEvent[]): FixedPromptTaskWalEvent[] =>
    events.filter((event) => stableHeldInSet.has(event.taskId));
  const stableHeldOut = (events: readonly FixedPromptTaskWalEvent[]): FixedPromptTaskWalEvent[] =>
    events.filter((event) => stableHeldOutSet.has(event.taskId));

  const baseline = calibratePromptAcceptanceBaseline({
    heldInTaskIds: stableHeldInTaskIds,
    heldOutTaskIds: stableHeldOutTaskIds,
    baselineRuns: baselineRunsData,
    ...(input.zScore !== undefined ? { zScore: input.zScore } : {}),
  });

  const originalHeldOutEvents = stableHeldOut(baselineRunsData[0]!.heldOutEvents);
  let lastKeptCommitSha = input.originalCommitSha;
  let heldInReference = baseline.heldIn.referencePassEligibleRate;
  let lastKeptHeldInEvents: readonly FixedPromptTaskWalEvent[] = stableHeldIn(baselineRunsData[0]!.heldInEvents);
  let nextHeldInDigests = await digestsFor(stableHeldIn(baselineRunsData[baselineRunsData.length - 1]!.heldInEvents));

  // 2. Candidate rounds.
  const decisions: PromptAcceptanceResult[] = [];
  let stopReason: PromptOptimizationLoopStopReason = 'rounds_complete';
  for (let round = 0; round < input.rounds; round += 1) {
    // Check the budget before starting a round so an over-budget baseline (or a
    // prior round) cannot kick off another expensive candidate + sweeps.
    const guard = stopGuard();
    if (guard) {
      stopReason = guard;
      break;
    }
    const roundId = `round-${round}`;
    const candidate = await runPromptCandidateRound({
      runId: input.runId,
      roundId,
      agentCwdPath: input.agentCwdPath,
      programPath: input.programPath,
      systemPromptPath: input.systemPromptPath,
      resultsTsvPath: input.heldInResultsTsvPath,
      resultsJsonlPath: input.resultsJsonlPath,
      heldInTaskIds: stableHeldInTaskIds,
      heldInDigests: nextHeldInDigests,
      // The held-out TSV is controller-only; always hide it so a careless caller
      // cannot leak held-out results into the meta-agent's view.
      heldOutArtifactPaths: [input.heldOutResultsTsvPath, ...(input.heldOutArtifactPaths ?? [])],
      metaAgent: input.metaAgent,
      git: input.git,
      now,
      newId,
    });

    const heldIn = await sweep(roundId, roundHeldInTasks, input.heldInResultsTsvPath);
    const heldOut = await sweep(roundId, roundHeldOutTasks, input.heldOutResultsTsvPath);
    accumulate(heldIn);
    accumulate(heldOut);

    const result = decidePromptAcceptance({
      runId: input.runId,
      roundId,
      candidateCommitSha: candidate.commitSha,
      previousLastKeptCommitSha: lastKeptCommitSha,
      originalCommitSha: input.originalCommitSha,
      heldInTaskIds: stableHeldInTaskIds,
      heldOutTaskIds: stableHeldOutTaskIds,
      previousHeldInReferencePassEligibleRate: heldInReference,
      originalHeldOutPassEligibleRate: baseline.heldOut.originalPassEligibleRate,
      heldInPassRateNoiseBand: baseline.heldIn.noiseBand,
      heldOutPassRateNoiseBand: baseline.heldOut.noiseBand,
      originalEvents: originalHeldOutEvents,
      lastKeptEvents: lastKeptHeldInEvents,
      candidateEvents: [...heldIn.events, ...heldOut.events],
      rewardHackScan: await scanHeldIn(heldIn.events),
    });
    if (result.decision === 'discard') {
      // Revert the candidate commit BEFORE persisting the decision; HEAD has not
      // moved since the commit, so this is safe, and a crash can never leave the
      // WAL saying "discard" while HEAD still holds the discarded prompt.
      await input.git.rollbackCommit(candidate.commitSha);
    }
    await appendPromptAcceptanceDecision({
      resultsJsonlPath: input.resultsJsonlPath,
      id: newId(),
      ts: now(),
      result,
    });
    decisions.push(result);

    if (result.decision === 'keep') {
      lastKeptCommitSha = result.lastKeptCommitSha;
      heldInReference = result.heldInReferencePassEligibleRate;
      lastKeptHeldInEvents = heldIn.events;
    }

    // The most recent attempt seeds the next round's meta-agent feedback, even
    // when discarded — "this change did not help" is useful signal.
    nextHeldInDigests = await digestsFor(heldIn.events);
  }

  // 3. Structural smoke report over the full WAL.
  const events = await readFixedPromptWal(input.resultsJsonlPath);
  const smoke = promptStructuralSmokeReport({
    events,
    minimumRounds: input.rounds,
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
  });

  return {
    runId: input.runId,
    baseline,
    decisions,
    keptCount: decisions.filter((decision) => decision.decision === 'keep').length,
    lastKeptCommitSha,
    heldInReferencePassEligibleRate: heldInReference,
    totalCostUsd,
    stopReason,
    smoke,
    droppedHeldInTaskIds,
    droppedHeldOutTaskIds,
  };
}
