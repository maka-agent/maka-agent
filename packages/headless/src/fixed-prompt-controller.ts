import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  validateHarborCellOutput,
  type HarborCellContextBudgetPolicySnapshot,
  type HarborCellContextBudgetSummary,
  type HarborCellContinuationSummary,
  type HarborCellOutput,
  type HarborCellTaskToolSummary,
  type HarborCellTokenSummary,
} from './cell-output.js';
import type { Config } from './contracts.js';
import { assertFinitePositive, assertPositiveInt, assertRatio } from './numeric-guards.js';

export const FIXED_PROMPT_WAL_SCHEMA_VERSION = 1;
export const BUDGET_EXHAUSTED_RUNTIME_UNAVAILABLE_REASON = 'budget_exhausted_before_cell_output';

export interface FixedPromptTask {
  id: string;
  path: string;
  metadata?: {
    difficulty?: string;
    estimatedDurationSec?: number;
    expertTimeEstimateMin?: number;
    juniorTimeEstimateMin?: number;
    agentTimeoutSec?: number;
    verifierTimeoutSec?: number;
  };
}

export type HarborTaskRunCellOutput = HarborCellOutput & {
  traceEventsPath?: string;
};

export interface HarborTaskRunOutput {
  harbor: {
    reward: number;
    verifierFailureSummary?: string;
  };
  cell: HarborTaskRunCellOutput;
}

export interface HarborTaskRunInput {
  runId: string;
  roundId: string;
  task: FixedPromptTask;
  config: Config;
  systemPrompt: string;
  agentEnv?: Record<string, string>;
}

export type HarborTaskRunner = (input: HarborTaskRunInput) => Promise<HarborTaskRunOutput>;

export interface FixedPromptBudgetExhaustedArtifactRefs {
  runtimeEventsPath?: string;
  traceEventsPath?: string;
  runtimeEventsUnavailableReason?: string;
}

export class FixedPromptBudgetExhaustedError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly artifactRefs?: FixedPromptBudgetExhaustedArtifactRefs,
  ) {
    super(message);
    this.name = 'FixedPromptBudgetExhaustedError';
  }
}

export interface ReadHarborTaskRunOutputInput {
  harborResultPath: string;
  cellOutputPath: string;
}

export interface FixedPromptTaskCompletedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_completed';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  status: HarborCellOutput['status'];
  passed: boolean;
  scored: boolean;
  eligible: boolean;
  errorClass?: string;
  promptHash?: string;
  tokenSummary: HarborCellTokenSummary;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  contextBudgetSummary?: HarborCellContextBudgetSummary;
  continuationSummary?: HarborCellContinuationSummary;
  taskToolSummary?: HarborCellTaskToolSummary;
  steps: number;
  durationMs: number;
  runtimeEventsPath: string;
  traceEventsPath?: string;
  harbor: {
    reward: number;
    verifierFailureSummary?: string;
  };
}

export interface FixedPromptTaskInfraFailedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_infra_failed';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  status: 'infra_failed';
  passed: false;
  scored: false;
  eligible: false;
  errorClass: 'infra_error';
  error: string;
}

export interface FixedPromptTaskBudgetExhaustedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_budget_exhausted';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  status: 'budget_exhausted';
  passed: false;
  scored: false;
  eligible: true;
  errorClass: 'budget_exhausted';
  error: string;
  expectedPromptHash: string;
  runtimeEventsPath?: string;
  traceEventsPath?: string;
  runtimeEventsUnavailableReason?: string;
}

export interface FixedPromptTaskPlumbingFailedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_plumbing_failed';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  status: 'plumbing_failed';
  passed: false;
  scored: false;
  eligible: false;
  errorClass: 'zero_cost_with_tokens' | 'prompt_hash_mismatch' | 'missing_prompt_hash';
  error: string;
  promptHash?: string;
  expectedPromptHash?: string;
  tokenSummary: HarborCellTokenSummary;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  contextBudgetSummary?: HarborCellContextBudgetSummary;
  continuationSummary?: HarborCellContinuationSummary;
  taskToolSummary?: HarborCellTaskToolSummary;
  steps: number;
  durationMs: number;
  runtimeEventsPath: string;
  traceEventsPath?: string;
  harbor: {
    reward: number;
  };
}

export interface PromptCandidateCommittedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'prompt_candidate_committed';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  commitSha: string;
  summary: string;
  promptHash: string;
  heldInTaskSetHash: string;
  heldInTaskIds: readonly string[];
  candidateRationaleHash: string;
  candidateRationale: PromptCandidateRationale;
}

export const PROMPT_CANDIDATE_FAILURE_PATTERNS = [
  'coverage_regression',
  'tool_failed',
  'max_tokens',
  'runtime_error',
  'verification_failed',
  'other',
] as const;

export type PromptCandidateFailurePattern = typeof PROMPT_CANDIDATE_FAILURE_PATTERNS[number];

export interface PromptCandidateRationale {
  failurePattern: PromptCandidateFailurePattern;
  evidenceRefs: readonly string[];
  hypothesis: string;
  targetedFix: string;
  predictedFixes: readonly string[];
  riskTasks: readonly string[];
}

export type PromptCandidateRewardHackScan =
  | { decision: 'clean' }
  | { decision: 'quarantine'; reason: string; matchedPatterns?: readonly string[] };

export interface PromptCandidateDecisionEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'prompt_candidate_decided';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  decision: 'keep' | 'discard';
  reason: string;
  candidateCommitSha: string;
  previousLastKeptCommitSha: string;
  lastKeptCommitSha: string;
  previousHeldInReferencePassEligibleRate: number | null;
  heldInReferencePassEligibleRate: number | null;
  originalCommitSha: string;
  originalHeldOutPassEligibleRate: number | null;
  heldInPassRateNoiseBand: number;
  heldOutPassRateNoiseBand: number;
  rewardHackScan?: PromptCandidateRewardHackScan;
  metrics: unknown;
}

export type RsiPredictedFixOutcome = 'improved' | 'unchanged' | 'regressed' | 'unscored' | 'missing';
export type RsiRiskTaskOutcome = 'safe' | 'regressed' | 'unscored' | 'missing';
export type RsiRootCauseSignalMatch = 'matched' | 'contradicted' | 'unknown';

export interface RsiControllerAttributionEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'rsi_controller_attribution';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  candidateCommitSha: string;
  heldInTaskSetHash: string;
  candidateRationaleHash: string;
  evidenceRefs: readonly string[];
  predictedFixes: Array<{ taskId: string; outcome: RsiPredictedFixOutcome }>;
  riskTasks: Array<{ taskId: string; outcome: RsiRiskTaskOutcome }>;
  unexpectedHeldInFlips: Array<{ taskId: string; from: string; to: string }>;
  decision: {
    decision: 'keep' | 'discard';
    reason: string;
  };
  rootCauseSignalMatch: RsiRootCauseSignalMatch;
}

export type FixedPromptWalEvent =
  | FixedPromptTaskCompletedEvent
  | FixedPromptTaskInfraFailedEvent
  | FixedPromptTaskBudgetExhaustedEvent
  | FixedPromptTaskPlumbingFailedEvent
  | PromptCandidateCommittedEvent
  | PromptCandidateDecisionEvent
  | RsiControllerAttributionEvent;

export type FixedPromptTaskWalEvent =
  | FixedPromptTaskCompletedEvent
  | FixedPromptTaskInfraFailedEvent
  | FixedPromptTaskBudgetExhaustedEvent
  | FixedPromptTaskPlumbingFailedEvent;

export interface RunFixedPromptControllerInput {
  runId: string;
  roundId: string;
  config: Config;
  systemPromptPath: string;
  resultsJsonlPath: string;
  resultsTsvPath: string;
  tasks: readonly FixedPromptTask[];
  maxInfraFailureRate?: number;
  costCeilingUsd?: number;
  maxConcurrency?: number;
  resumeFingerprint?: string;
  harborRunner: HarborTaskRunner;
  now?: () => number;
  newId?: () => string;
}

export type FixedPromptControllerStopReason =
  | 'infra_failure_rate_exceeded'
  | 'cost_ceiling_exceeded';

export interface FixedPromptControllerResult {
  taskIds: string[];
  events: FixedPromptTaskWalEvent[];
  totalTokens: number;
  totalCostUsd: number;
  resultsTsvPath: string;
  stopReason?: FixedPromptControllerStopReason;
}

export async function runFixedPromptController(
  input: RunFixedPromptControllerInput,
): Promise<FixedPromptControllerResult> {
  const now = input.now ?? Date.now;
  const newId = input.newId ?? randomId;
  // Fail loud on out-of-contract guard knobs before any work: a NaN ceiling or
  // ratio would make `cost >= ceiling` / `rate > ratio` always false and
  // silently disable the guard (maxConcurrency is checked in normalizeMaxConcurrency).
  if (input.costCeilingUsd !== undefined) assertFinitePositive('costCeilingUsd', input.costCeilingUsd);
  if (input.maxInfraFailureRate !== undefined) assertRatio('maxInfraFailureRate', input.maxInfraFailureRate);
  assertUniqueTaskIds(input.tasks.map((task) => task.id));
  const systemPrompt = await readFile(input.systemPromptPath, 'utf8');
  const expectedPromptHash = hashSystemPrompt(systemPrompt);
  const config = { ...input.config, systemPrompt };
  const events = await readFixedPromptWal(input.resultsJsonlPath);
  const completed = terminalTaskEvents(events, input.runId, input.roundId, expectedPromptHash, input.resumeFingerprint);
  const stopEvidence = roundTaskEvents(events, input.runId, input.roundId, expectedPromptHash, input.resumeFingerprint);
  let stopReason = controllerStopReason({
    events: [...stopEvidence.values()],
    taskCount: input.tasks.length,
    maxInfraFailureRate: input.maxInfraFailureRate,
    costCeilingUsd: input.costCeilingUsd,
  });
  // Stop guards are checked after completed tasks; in-flight tasks are allowed
  // to finish so configured concurrency remains useful for benchmark waves.
  const maxConcurrency = normalizeMaxConcurrency(input.maxConcurrency);
  let nextTaskIndex = 0;
  let nextAppendIndex = 0;
  const pendingEvents = new Map<number, FixedPromptTaskWalEvent>();
  const active = new Map<number, Promise<{ index: number; event: FixedPromptTaskWalEvent }>>();

  const appendReadyEvents = async () => {
    while (nextAppendIndex < input.tasks.length) {
      const task = input.tasks[nextAppendIndex]!;
      if (completed.has(task.id) && !pendingEvents.has(nextAppendIndex)) {
        nextAppendIndex += 1;
        continue;
      }
      const event = pendingEvents.get(nextAppendIndex);
      if (!event) break;
      await appendFixedPromptWalEvent(input.resultsJsonlPath, event);
      events.push(event);
      completed.set(event.taskId, event);
      stopEvidence.set(event.taskId, event);
      pendingEvents.delete(nextAppendIndex);
      nextAppendIndex += 1;
    }
  };

  const launchReadyTasks = () => {
    while (!stopReason && active.size < maxConcurrency && nextTaskIndex < input.tasks.length) {
      const index = nextTaskIndex;
      const task = input.tasks[nextTaskIndex++]!;
      if (completed.has(task.id)) continue;
      active.set(index, runTaskAndBuildEvent({
        input,
        task,
        config,
        systemPrompt,
        expectedPromptHash,
        resumeFingerprint: input.resumeFingerprint,
        id: newId(),
        ts: now(),
      }).then((event) => ({ index, event })));
    }
  };

  launchReadyTasks();
  while (active.size > 0) {
    const { index, event } = await Promise.race(active.values());
    active.delete(index);
    pendingEvents.set(index, event);
    stopEvidence.set(event.taskId, event);
    stopReason = controllerStopReason({
      events: [...stopEvidence.values()],
      taskCount: input.tasks.length,
      maxInfraFailureRate: input.maxInfraFailureRate,
      costCeilingUsd: input.costCeilingUsd,
    });
    await appendReadyEvents();
    launchReadyTasks();
  }
  await appendReadyEvents();

  const resultByTask = stopReason ? stopEvidence : completed;
  const resultEvents = input.tasks
    .map((task) => resultByTask.get(task.id))
    .filter((event): event is FixedPromptTaskWalEvent => event !== undefined);
  await writeFixedPromptResultsTsv(input.resultsTsvPath, resultEvents);

  return {
    taskIds: resultEvents.map((event) => event.taskId),
    events: resultEvents,
    totalTokens: sum(resultEvents.map((event) => eventHasRunArtifacts(event) ? event.tokenSummary.total : 0)),
    totalCostUsd: sum(resultEvents.map((event) => eventHasRunArtifacts(event) ? event.tokenSummary.costUsd : 0)),
    resultsTsvPath: input.resultsTsvPath,
    ...(stopReason ? { stopReason } : {}),
  };
}

function assertUniqueTaskIds(taskIds: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const taskId of taskIds) {
    if (seen.has(taskId)) duplicates.add(taskId);
    seen.add(taskId);
  }
  if (duplicates.size > 0) {
    throw new Error(`tasks contain duplicate id(s): ${[...duplicates].sort().join(', ')}`);
  }
}

export async function readFixedPromptWal(path: string): Promise<FixedPromptWalEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const lines = raw.split('\n');
  const events: FixedPromptWalEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as FixedPromptWalEvent);
    } catch (error) {
      if (index === lines.length - 1 && !raw.endsWith('\n')) break;
      throw error;
    }
  }
  return events;
}

export async function readHarborTaskRunOutput(
  input: ReadHarborTaskRunOutputInput,
): Promise<HarborTaskRunOutput> {
  return {
    harbor: {
      reward: harborReward(await readJsonObject(input.harborResultPath)),
    },
    cell: validateHarborCellOutput(await readJsonObject(input.cellOutputPath)),
  };
}

export async function appendFixedPromptWalEvent(path: string, event: FixedPromptWalEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await truncateTornWalTail(path);
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
}

export async function writeFixedPromptResultsTsv(
  path: string,
  events: readonly FixedPromptTaskWalEvent[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = [
    'task_id',
    'status',
    'passed',
    'scored',
    'eligible',
    'error_class',
    'prompt_hash',
    'tokens',
    'cost_usd',
    'runtime_events_path',
  ];
  const rows = events.map((event) => [
    event.taskId,
    event.status,
    String(event.passed),
    String(event.scored),
    String(event.eligible),
    event.errorClass ?? '',
    eventHasRunArtifacts(event) ? event.promptHash ?? '' : '',
    String(eventHasRunArtifacts(event) ? event.tokenSummary.total : 0),
    String(eventHasRunArtifacts(event) ? event.tokenSummary.costUsd : 0),
    eventHasRunArtifacts(event) ? event.runtimeEventsPath : '',
  ]);
  const body = [header, ...rows].map((row) => row.map(tsvCell).join('\t')).join('\n');
  await writeFile(path, `${body}\n`, 'utf8');
}

async function runTaskAndBuildEvent(input: {
  input: RunFixedPromptControllerInput;
  task: FixedPromptTask;
  config: Config;
  systemPrompt: string;
  expectedPromptHash: string;
  resumeFingerprint?: string;
  id: string;
  ts: number;
}): Promise<FixedPromptTaskWalEvent> {
  const runHarbor = () => input.input.harborRunner({
    runId: input.input.runId,
    roundId: input.input.roundId,
    task: input.task,
    config: input.config,
    systemPrompt: input.systemPrompt,
  });
  let output;
  try {
    output = await runHarbor();
  } catch (error) {
    if (isBudgetExhaustedError(error)) {
      return taskBudgetExhaustedEvent({
        error,
        taskId: input.task.id,
        runId: input.input.runId,
        roundId: input.input.roundId,
        expectedPromptHash: input.expectedPromptHash,
        resumeFingerprint: input.resumeFingerprint,
        id: input.id,
        ts: input.ts,
      });
    }
    // #64: a thrown Harbor/Docker error is an infra failure, often a transient
    // flake (container build hiccup). Retry the same task + prompt once
    // before recording task_infra_failed, so a single blip does not pollute the
    // candidate's decision. A second failure is treated as a real infra failure.
    // A budget exhaustion is a benchmark outcome, not an infra flake, so it is
    // recorded immediately and counted separately by A/B reports.
    // A plumbing failure (a successful run with bad output) does not throw and is
    // not retried — it is deterministic.
    try {
      output = await runHarbor();
    } catch (error) {
      if (isBudgetExhaustedError(error)) {
        return taskBudgetExhaustedEvent({
          error,
          taskId: input.task.id,
          runId: input.input.runId,
          roundId: input.input.roundId,
          expectedPromptHash: input.expectedPromptHash,
          resumeFingerprint: input.resumeFingerprint,
          id: input.id,
          ts: input.ts,
        });
      }
      return taskInfraFailedEvent({
        error,
        taskId: input.task.id,
        runId: input.input.runId,
        roundId: input.input.roundId,
        resumeFingerprint: input.resumeFingerprint,
        id: input.id,
        ts: input.ts,
      });
    }
  }
  return taskEventFromOutput({
    output,
    expectedPromptHash: input.expectedPromptHash,
    resumeFingerprint: input.resumeFingerprint,
    taskId: input.task.id,
    runId: input.input.runId,
    roundId: input.input.roundId,
    id: input.id,
    ts: input.ts,
  });
}

function taskEventFromOutput(input: {
  output: HarborTaskRunOutput;
  expectedPromptHash: string;
  resumeFingerprint?: string;
  taskId: string;
  runId: string;
  roundId: string;
  id: string;
  ts: number;
}): FixedPromptTaskCompletedEvent | FixedPromptTaskPlumbingFailedEvent {
  const plumbingFailure = classifyPlumbingFailure(input.output, input.expectedPromptHash);
  if (plumbingFailure) {
    return taskPlumbingFailedEvent({
      ...input,
      errorClass: plumbingFailure.errorClass,
      error: plumbingFailure.error,
    });
  }
  return taskCompletedEvent(input);
}

function taskCompletedEvent(input: {
  output: HarborTaskRunOutput;
  taskId: string;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  id: string;
  ts: number;
}): FixedPromptTaskCompletedEvent {
  const { output } = input;
  const passed = output.cell.status === 'completed' && output.harbor.reward > 0;
  const errorClass = output.cell.errorClass ?? (passed ? undefined : 'verification_failed');
  const scored = output.cell.status === 'completed' && !isUnscoredCellFailure(errorClass);
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_completed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: output.cell.status,
    passed,
    scored,
    eligible: scored,
    ...(errorClass ? { errorClass } : {}),
    ...(output.cell.promptHash ? { promptHash: output.cell.promptHash } : {}),
    tokenSummary: output.cell.tokenSummary,
    ...(output.cell.contextBudgetPolicy ? { contextBudgetPolicy: output.cell.contextBudgetPolicy } : {}),
    ...(output.cell.contextBudgetSummary ? { contextBudgetSummary: output.cell.contextBudgetSummary } : {}),
    ...(output.cell.continuationSummary ? { continuationSummary: output.cell.continuationSummary } : {}),
    ...(output.cell.taskToolSummary ? { taskToolSummary: output.cell.taskToolSummary } : {}),
    steps: output.cell.steps,
    durationMs: output.cell.durationMs,
    runtimeEventsPath: output.cell.runtimeEventsPath,
    ...(output.cell.traceEventsPath ? { traceEventsPath: output.cell.traceEventsPath } : {}),
    harbor: {
      reward: output.harbor.reward,
      ...(output.harbor.verifierFailureSummary ? { verifierFailureSummary: output.harbor.verifierFailureSummary } : {}),
    },
  };
}

function isUnscoredCellFailure(errorClass: string | undefined): boolean {
  return errorClass === 'infra_failed' || errorClass === 'setup_failed' || errorClass === 'verification_error';
}

function taskPlumbingFailedEvent(input: {
  output: HarborTaskRunOutput;
  expectedPromptHash: string;
  resumeFingerprint?: string;
  taskId: string;
  runId: string;
  roundId: string;
  id: string;
  ts: number;
  errorClass: FixedPromptTaskPlumbingFailedEvent['errorClass'];
  error: string;
}): FixedPromptTaskPlumbingFailedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_plumbing_failed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: 'plumbing_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: input.errorClass,
    error: input.error,
    ...(input.output.cell.promptHash ? { promptHash: input.output.cell.promptHash } : {}),
    expectedPromptHash: input.expectedPromptHash,
    tokenSummary: input.output.cell.tokenSummary,
    ...(input.output.cell.contextBudgetPolicy
      ? { contextBudgetPolicy: input.output.cell.contextBudgetPolicy }
      : {}),
    ...(input.output.cell.contextBudgetSummary
      ? { contextBudgetSummary: input.output.cell.contextBudgetSummary }
      : {}),
    ...(input.output.cell.continuationSummary
      ? { continuationSummary: input.output.cell.continuationSummary }
      : {}),
    ...(input.output.cell.taskToolSummary
      ? { taskToolSummary: input.output.cell.taskToolSummary }
      : {}),
    steps: input.output.cell.steps,
    durationMs: input.output.cell.durationMs,
    runtimeEventsPath: input.output.cell.runtimeEventsPath,
    ...(input.output.cell.traceEventsPath ? { traceEventsPath: input.output.cell.traceEventsPath } : {}),
    harbor: {
      reward: input.output.harbor.reward,
    },
  };
}

function classifyPlumbingFailure(output: HarborTaskRunOutput, expectedPromptHash: string): {
  errorClass: FixedPromptTaskPlumbingFailedEvent['errorClass'];
  error: string;
} | undefined {
  if (output.cell.status === 'completed' && output.cell.promptHash === undefined) {
    return {
      errorClass: 'missing_prompt_hash',
      error: `Harbor cell did not report prompt hash ${expectedPromptHash}`,
    };
  }
  if (output.cell.promptHash !== undefined && output.cell.promptHash !== expectedPromptHash) {
    return {
      errorClass: 'prompt_hash_mismatch',
      error: `Harbor cell prompt hash ${output.cell.promptHash} did not match ${expectedPromptHash}`,
    };
  }
  if (output.cell.tokenSummary.total > 0 && output.cell.tokenSummary.costUsd === 0) {
    return {
      errorClass: 'zero_cost_with_tokens',
      error: 'Harbor cell reported token usage but zero costUsd',
    };
  }
  return undefined;
}

function taskInfraFailedEvent(input: {
  error: unknown;
  taskId: string;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  id: string;
  ts: number;
}): FixedPromptTaskInfraFailedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_infra_failed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'infra_error',
    error: errorMessage(input.error),
  };
}

function taskBudgetExhaustedEvent(input: {
  error: unknown;
  taskId: string;
  runId: string;
  roundId: string;
  expectedPromptHash: string;
  resumeFingerprint?: string;
  id: string;
  ts: number;
}): FixedPromptTaskBudgetExhaustedEvent {
  const artifactRefs = budgetExhaustedArtifactRefs(input.error);
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_budget_exhausted',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: 'budget_exhausted',
    passed: false,
    scored: false,
    eligible: true,
    errorClass: 'budget_exhausted',
    error: errorMessage(input.error),
    expectedPromptHash: input.expectedPromptHash,
    ...(artifactRefs.runtimeEventsPath ? { runtimeEventsPath: artifactRefs.runtimeEventsPath } : {}),
    ...(artifactRefs.traceEventsPath ? { traceEventsPath: artifactRefs.traceEventsPath } : {}),
    ...(artifactRefs.runtimeEventsUnavailableReason
      ? { runtimeEventsUnavailableReason: artifactRefs.runtimeEventsUnavailableReason }
      : {}),
  };
}

function budgetExhaustedArtifactRefs(error: unknown): FixedPromptBudgetExhaustedArtifactRefs {
  if (isBudgetExhaustedError(error)) {
    const refs = (error as { artifactRefs?: FixedPromptBudgetExhaustedArtifactRefs }).artifactRefs;
    if (refs && (refs.runtimeEventsPath || refs.traceEventsPath || refs.runtimeEventsUnavailableReason)) return refs;
  }
  return { runtimeEventsUnavailableReason: BUDGET_EXHAUSTED_RUNTIME_UNAVAILABLE_REASON };
}

function terminalTaskEvents(
  events: readonly FixedPromptWalEvent[],
  runId: string,
  roundId: string,
  expectedPromptHash: string,
  resumeFingerprint: string | undefined,
): Map<string, FixedPromptTaskWalEvent> {
  const byTask = new Map<string, FixedPromptTaskWalEvent>();
  for (const event of events) {
    if (!isTaskEvent(event)) continue;
    if (event.runId !== runId || event.roundId !== roundId) continue;
    if (!eventMatchesResumeIdentity(event, expectedPromptHash, resumeFingerprint)) continue;
    if (
      event.type === 'task_completed'
      || event.type === 'task_budget_exhausted'
      || event.type === 'task_plumbing_failed'
    ) {
      byTask.set(event.taskId, event);
    }
  }
  return byTask;
}

function roundTaskEvents(
  events: readonly FixedPromptWalEvent[],
  runId: string,
  roundId: string,
  expectedPromptHash: string,
  resumeFingerprint: string | undefined,
): Map<string, FixedPromptTaskWalEvent> {
  const byTask = new Map<string, FixedPromptTaskWalEvent>();
  for (const event of events) {
    if (!isTaskEvent(event)) continue;
    if (event.runId !== runId || event.roundId !== roundId) continue;
    if (!eventMatchesResumeIdentity(event, expectedPromptHash, resumeFingerprint)) continue;
    byTask.set(event.taskId, event);
  }
  return byTask;
}

function eventMatchesResumeIdentity(
  event: FixedPromptTaskWalEvent,
  expectedPromptHash: string,
  resumeFingerprint: string | undefined,
): boolean {
  if (resumeFingerprint !== undefined && event.resumeFingerprint !== resumeFingerprint) return false;
  if (event.type === 'task_infra_failed') return true;
  if (event.type === 'task_budget_exhausted') {
    return resumeFingerprint !== undefined && event.expectedPromptHash === expectedPromptHash;
  }
  if (event.promptHash === expectedPromptHash) return true;
  return event.type === 'task_plumbing_failed' && event.expectedPromptHash === expectedPromptHash;
}

function isTaskEvent(event: FixedPromptWalEvent): event is
  FixedPromptTaskWalEvent {
  return event.type === 'task_completed'
    || event.type === 'task_infra_failed'
    || event.type === 'task_budget_exhausted'
    || event.type === 'task_plumbing_failed';
}

function tsvCell(value: string): string {
  return value.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function controllerStopReason(input: {
  events: readonly FixedPromptTaskWalEvent[];
  taskCount: number;
  maxInfraFailureRate?: number;
  costCeilingUsd?: number;
}): FixedPromptControllerStopReason | undefined {
  if (
    input.maxInfraFailureRate !== undefined
    && infraFailureRate(input.events, input.taskCount) > input.maxInfraFailureRate
  ) {
    return 'infra_failure_rate_exceeded';
  }
  if (input.costCeilingUsd !== undefined && taskEventsCostUsd(input.events) >= input.costCeilingUsd) {
    return 'cost_ceiling_exceeded';
  }
  return undefined;
}

function infraFailureRate(events: readonly FixedPromptTaskWalEvent[], taskCount: number): number {
  if (taskCount <= 0) return 0;
  return events.filter((event) => event.type === 'task_infra_failed').length / taskCount;
}

function taskEventsCostUsd(events: readonly FixedPromptTaskWalEvent[]): number {
  return sum(events.map((event) => eventHasRunArtifacts(event) ? event.tokenSummary.costUsd : 0));
}

function eventHasRunArtifacts(
  event: FixedPromptTaskWalEvent,
): event is FixedPromptTaskCompletedEvent | FixedPromptTaskPlumbingFailedEvent {
  return event.type === 'task_completed' || event.type === 'task_plumbing_failed';
}

function isBudgetExhaustedError(error: unknown): boolean {
  return error instanceof FixedPromptBudgetExhaustedError
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'FixedPromptBudgetExhaustedError');
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  // A fractional concurrency must fail loud, not be silently floored.
  return assertPositiveInt('maxConcurrency', value);
}

async function truncateTornWalTail(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (raw.length === 0 || raw.endsWith('\n')) return;
  const lastNewline = raw.lastIndexOf('\n');
  await truncate(path, lastNewline < 0 ? 0 : lastNewline + 1);
}

export function hashSystemPrompt(systemPrompt: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(systemPrompt)).digest('hex')}`;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

function harborReward(value: Record<string, unknown>): number {
  const direct = numericField(value, 'reward') ?? numericField(value, 'score');
  if (direct !== undefined) return direct;
  const metrics = isRecord(value.metrics) ? value.metrics : undefined;
  const nested = metrics ? numericField(metrics, 'reward') ?? numericField(metrics, 'score') : undefined;
  if (nested !== undefined) return nested;
  const verifierResult = isRecord(value.verifier_result) ? value.verifier_result : undefined;
  const verifierRewards = verifierResult && isRecord(verifierResult.rewards) ? verifierResult.rewards : undefined;
  const verifierReward = verifierRewards
    ? numericField(verifierRewards, 'reward') ?? numericField(verifierRewards, 'score')
    : undefined;
  if (verifierReward !== undefined) return verifierReward;
  throw new Error('Harbor result must include a numeric reward or score');
}

function numericField(value: Record<string, unknown>, field: string): number | undefined {
  const raw = value[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`Harbor result field ${field} must be a finite number`);
  }
  return raw;
}

function randomId(): string {
  return randomUUID();
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
