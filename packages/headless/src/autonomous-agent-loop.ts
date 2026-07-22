import { randomUUID } from 'node:crypto';
import type { Config, ResultRecord, Task } from './contracts.js';
import { validateRealBackendIsolation } from './isolation.js';
import { resolveHeavyTaskMode } from './heavy-task-policy.js';
import { renderHeavyTaskProgressForPrompt } from './heavy-task-progress.js';
import {
  authenticateHeadlessStorageWriter,
  openHeadlessStorageForWrite,
  type HeadlessStorageWriter,
} from './headless-storage.js';
import { backendNeedsIsolation, validateTaskVerification } from './runner.js';
import { budgetExtensionInboxItem } from './task-inbox.js';
import {
  runTaskOnceWithStorage,
  type RunTaskOnceDeps,
  type RunTaskOnceResult,
} from './task-agent-controller.js';
import {
  taxonomyFromResultRecord,
  type AutonomousDecision,
  type AutonomousResultTaxonomy,
  type FeedbackObservation,
  type SelfCheckObservation,
  type TaskEvent,
  type TaskInterventionPolicy,
  type TaskRunError,
  type TaskRunResult,
} from './task-contracts.js';
import type { TaskRunProjection } from './task-run-projection.js';
import type { TaskRunWriter } from './task-run-store.js';
import { taskDefinitionFromTask } from './task-run-adapter.js';

export interface AutonomousLoopBudget {
  maxAttempts: number;
  maxRuntimeSteps?: number;
  maxWallTimeMs?: number;
}

export interface LoopBudgetSnapshot {
  attemptsUsed: number;
  maxAttempts: number;
  runtimeStepsUsed: number;
  maxRuntimeSteps?: number;
  elapsedMs: number;
  maxWallTimeMs?: number;
}

export interface SelfCheckPolicy {
  observe(input: SelfCheckInput): SelfCheckOutput | Promise<SelfCheckOutput>;
}

export interface SelfCheckInput {
  config: Config;
  task: Task;
  attempt: RunTaskOnceResult;
  budget: LoopBudgetSnapshot;
}

export interface SelfCheckOutput {
  summary: string;
  details?: Record<string, unknown>;
}

export interface FeedbackPromptInput {
  config: Config;
  task: Task;
  attempt: RunTaskOnceResult;
  budget: LoopBudgetSnapshot;
  feedback: readonly FeedbackObservation[];
  selfCheck?: SelfCheckObservation;
}

export interface AutonomousDecisionInput {
  config: Config;
  task: Task;
  attempt: RunTaskOnceResult;
  budget: LoopBudgetSnapshot;
  selfCheck?: SelfCheckObservation;
}

export interface AutonomousDecisionPolicyResult {
  decision: AutonomousDecision['decision'];
  reason?: string;
  instructionOverride?: string;
  details?: Record<string, unknown>;
}

export type AutonomousDecisionPolicy = (
  input: AutonomousDecisionInput,
) => AutonomousDecisionPolicyResult | Promise<AutonomousDecisionPolicyResult>;

export interface RunAutonomousTaskOptions extends RunTaskOnceDeps {
  budget: AutonomousLoopBudget;
  replayPriorAttemptRuntimeContext?: boolean;
  selfCheck?: false | SelfCheckPolicy;
  feedbackPrompt?: (input: FeedbackPromptInput) => string;
  decision?: AutonomousDecisionPolicy;
}

export interface RunAutonomousTaskResult {
  taskRunId: string;
  attempts: RunTaskOnceResult[];
  projection: TaskRunProjection;
  /** Latest authoritative attempt result; loop/cap terminal status lives in projection. */
  resultRecord: ResultRecord;
}

export class AutonomousAgentLoop {
  constructor(private readonly deps: RunAutonomousTaskOptions) {}

  run(config: Config, task: Task): Promise<RunAutonomousTaskResult> {
    return runAutonomousTask(config, task, this.deps);
  }
}

export async function runAutonomousTask(
  config: Config,
  task: Task,
  options: RunAutonomousTaskOptions,
): Promise<RunAutonomousTaskResult> {
  const storage = await openHeadlessStorageForWrite(options.storageRoot);
  return runAutonomousTaskWithStorage(config, task, options, storage);
}

export async function runAutonomousTaskWithStorage(
  config: Config,
  task: Task,
  options: RunAutonomousTaskOptions,
  storage: HeadlessStorageWriter,
): Promise<RunAutonomousTaskResult> {
  storage = authenticateHeadlessStorageWriter(storage);
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const taskRunId = options.taskRunId ?? newId();
  const taskRunStore = storage.taskRunStore;
  const startedAt = now();
  const attempts: RunTaskOnceResult[] = [];

  await appendTaskEvent(taskRunStore, taskRunId, {
    type: 'task_run_created',
    id: newId(),
    taskRunId,
    ts: startedAt,
    taskId: task.id,
    configId: config.id,
    taskDefinition: taskDefinitionFromTask(task),
  });
  await appendTaskEvent(taskRunStore, taskRunId, {
    type: 'task_run_queued',
    id: newId(),
    taskRunId,
    ts: now(),
    taskId: task.id,
    configId: config.id,
    taskDefinition: taskDefinitionFromTask(task),
  });

  const budgetError = validateBudget(options.budget);
  if (budgetError) {
    const finishedAt = now();
    const resultRecord = syntheticResultRecord(
      config,
      task,
      taskRunId,
      'setup_failed',
      budgetError,
      startedAt,
      finishedAt,
    );
    await appendTaskEvent(
      taskRunStore,
      taskRunId,
      terminalEventFromResultRecord(resultRecord, taskRunId, newId),
    );
    return { taskRunId, attempts, projection: await taskRunStore.project(taskRunId), resultRecord };
  }

  try {
    if (backendNeedsIsolation(config.backend)) {
      validateRealBackendIsolation(options.realBackendIsolation);
      if (!options.registerBackends) {
        throw new Error(
          `@maka/headless: backend "${config.backend}" requires registerBackends to wire an isolated backend factory`,
        );
      }
    }
    validateTaskVerification(task);
  } catch (error) {
    const finishedAt = now();
    const resultRecord = syntheticResultRecord(
      config,
      task,
      taskRunId,
      'setup_failed',
      error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt,
    );
    await appendTaskEvent(
      taskRunStore,
      taskRunId,
      terminalEventFromResultRecord(resultRecord, taskRunId, newId),
    );
    return { taskRunId, attempts, projection: await taskRunStore.project(taskRunId), resultRecord };
  }

  let instructionOverride: string | undefined = options.instructionOverride;
  let runtimeStepsUsed = 0;
  let latestResultRecord: ResultRecord | undefined;
  let priorRuntimeContext = options.priorRuntimeContext ? [...options.priorRuntimeContext] : [];
  const budgetStartedAt = now();

  while (attempts.length < options.budget.maxAttempts) {
    const beforeAttemptBudget = budgetSnapshot(
      options.budget,
      attempts.length,
      runtimeStepsUsed,
      budgetStartedAt,
      now(),
    );
    if (attempts.length > 0 && isWallTimeExhausted(beforeAttemptBudget)) {
      await appendSystemFeedback(
        taskRunStore,
        taskRunId,
        undefined,
        now,
        newId,
        'wall time cap reached before attempt',
        { budget: beforeAttemptBudget },
      );
      const finishedAt = now();
      const resultRecord =
        latestResultRecord ??
        syntheticResultRecord(
          config,
          task,
          taskRunId,
          'budget_exhausted',
          'wall time cap reached before attempt',
          startedAt,
          finishedAt,
        );
      await appendBudgetTerminal(
        taskRunStore,
        taskRunId,
        now,
        newId,
        beforeAttemptBudget,
        'wall time cap reached before attempt',
        options.interventionPolicy,
      );
      return {
        taskRunId,
        attempts,
        projection: await taskRunStore.project(taskRunId),
        resultRecord,
      };
    }

    const attemptNumber = attempts.length + 1;
    const attemptId = `${taskRunId}-attempt-${attemptNumber}`;
    const attempt = await runTaskOnceWithStorage(
      config,
      task,
      {
        ...options,
        taskRunId,
        attemptId,
        createTaskRun: false,
        closeTaskRun: false,
        ...(instructionOverride ? { instructionOverride } : {}),
        ...(priorRuntimeContext.length > 0 ? { priorRuntimeContext } : {}),
      },
      storage,
    );
    attempts.push(attempt);
    latestResultRecord = attempt.resultRecord;
    runtimeStepsUsed += attempt.resultRecord.steps;
    if (options.replayPriorAttemptRuntimeContext) {
      priorRuntimeContext = [
        ...priorRuntimeContext,
        ...attempt.invocations.flatMap((invocation) => invocation.events),
      ];
    }

    const afterAttemptBudget = budgetSnapshot(
      options.budget,
      attempts.length,
      runtimeStepsUsed,
      budgetStartedAt,
      now(),
    );
    if (attempt.settledByDeadline) {
      await appendBudgetTerminal(
        taskRunStore,
        taskRunId,
        now,
        newId,
        afterAttemptBudget,
        'benchmark deadline reached during attempt',
      );
      return {
        taskRunId,
        attempts,
        projection: await taskRunStore.project(taskRunId),
        resultRecord: attempt.resultRecord,
      };
    }
    const selfCheck = isWallTimeExhausted(afterAttemptBudget)
      ? undefined
      : await maybeRecordSelfCheck(
          options.selfCheck,
          {
            config,
            task,
            attempt,
            budget: afterAttemptBudget,
          },
          taskRunStore,
          taskRunId,
          attemptId,
          now,
          newId,
        );
    const verifierFeedback = await appendVerifierFeedback(
      taskRunStore,
      taskRunId,
      attemptId,
      now,
      newId,
      attempt.resultRecord,
      attempt.projection.latestVerifierResult?.id,
      attempt.projection.latestScoreResult?.id,
    );
    if (selfCheck) {
      await appendSystemFeedback(
        taskRunStore,
        taskRunId,
        attemptId,
        now,
        newId,
        'self-check recorded as advisory feedback',
        { selfCheckId: selfCheck.id, selfCheckSummary: selfCheck.summary },
      );
    }

    const defaultDecision = defaultDecisionForAttempt(attempt, afterAttemptBudget);
    const policyDecision = options.decision
      ? await options.decision({ config, task, attempt, budget: afterAttemptBudget, selfCheck })
      : defaultDecision;
    const decision = enforceCaps(policyDecision, attempt, afterAttemptBudget);
    const nextInstruction =
      decision.instructionOverride ??
      options.feedbackPrompt?.({
        config,
        task,
        attempt,
        budget: afterAttemptBudget,
        feedback: [verifierFeedback],
        ...(selfCheck ? { selfCheck } : {}),
      }) ??
      defaultContinuationPrompt(config, task, attempt, selfCheck);

    await appendDecision(
      taskRunStore,
      taskRunId,
      attemptId,
      now,
      newId,
      decision,
      attempt,
      afterAttemptBudget,
      selfCheck,
    );

    if (decision.decision === 'continue' || decision.decision === 'retry') {
      instructionOverride = nextInstruction;
      continue;
    }

    if (shouldBudgetTerminal(decision, attempt, afterAttemptBudget)) {
      await appendBudgetTerminal(
        taskRunStore,
        taskRunId,
        now,
        newId,
        afterAttemptBudget,
        decision.reason ?? 'loop budget exhausted',
        options.interventionPolicy,
      );
    } else {
      await appendTaskEvent(
        taskRunStore,
        taskRunId,
        terminalEventFromResultRecord(attempt.resultRecord, taskRunId, newId, {
          verifierResultId: attempt.projection.latestVerifierResult?.id,
          scoreResultId: attempt.projection.latestScoreResult?.id,
        }),
      );
    }
    return {
      taskRunId,
      attempts,
      projection: await taskRunStore.project(taskRunId),
      resultRecord: attempt.resultRecord,
    };
  }

  const exhaustedBudget = budgetSnapshot(
    options.budget,
    attempts.length,
    runtimeStepsUsed,
    budgetStartedAt,
    now(),
  );
  if (latestResultRecord?.passed) {
    const latestAttempt = attempts[attempts.length - 1];
    await appendTaskEvent(
      taskRunStore,
      taskRunId,
      terminalEventFromResultRecord(latestResultRecord, taskRunId, newId, {
        verifierResultId: latestAttempt?.projection.latestVerifierResult?.id,
        scoreResultId: latestAttempt?.projection.latestScoreResult?.id,
      }),
    );
    return {
      taskRunId,
      attempts,
      projection: await taskRunStore.project(taskRunId),
      resultRecord: latestResultRecord,
    };
  }
  await appendBudgetTerminal(
    taskRunStore,
    taskRunId,
    now,
    newId,
    exhaustedBudget,
    'max attempts exhausted',
    options.interventionPolicy,
  );
  const resultRecord =
    latestResultRecord ??
    syntheticResultRecord(
      config,
      task,
      taskRunId,
      'budget_exhausted',
      'max attempts exhausted',
      startedAt,
      now(),
    );
  return { taskRunId, attempts, projection: await taskRunStore.project(taskRunId), resultRecord };
}

function validateBudget(budget: AutonomousLoopBudget): string | undefined {
  if (!Number.isInteger(budget.maxAttempts) || budget.maxAttempts < 1) {
    return 'budget.maxAttempts must be a positive integer';
  }
  if (
    budget.maxRuntimeSteps !== undefined &&
    (!Number.isInteger(budget.maxRuntimeSteps) || budget.maxRuntimeSteps < 1)
  ) {
    return 'budget.maxRuntimeSteps must be a positive integer when provided';
  }
  if (
    budget.maxWallTimeMs !== undefined &&
    (!Number.isInteger(budget.maxWallTimeMs) || budget.maxWallTimeMs < 1)
  ) {
    return 'budget.maxWallTimeMs must be a positive integer when provided';
  }
  return undefined;
}

function budgetSnapshot(
  budget: AutonomousLoopBudget,
  attemptsUsed: number,
  runtimeStepsUsed: number,
  startedAt: number,
  currentTime: number,
): LoopBudgetSnapshot {
  return {
    attemptsUsed,
    maxAttempts: budget.maxAttempts,
    runtimeStepsUsed,
    ...(budget.maxRuntimeSteps !== undefined ? { maxRuntimeSteps: budget.maxRuntimeSteps } : {}),
    elapsedMs: Math.max(0, currentTime - startedAt),
    ...(budget.maxWallTimeMs !== undefined ? { maxWallTimeMs: budget.maxWallTimeMs } : {}),
  };
}

function isWallTimeExhausted(budget: LoopBudgetSnapshot): boolean {
  return budget.maxWallTimeMs !== undefined && budget.elapsedMs >= budget.maxWallTimeMs;
}

function defaultDecisionForAttempt(
  attempt: RunTaskOnceResult,
  budget: LoopBudgetSnapshot,
): AutonomousDecisionPolicyResult {
  const taxonomy = taxonomyFromResultRecord(attempt.resultRecord);
  if (attempt.resultRecord.passed && taxonomy === 'passed') {
    return { decision: 'stop', reason: 'authoritative verification passed' };
  }
  if (isNonRetryable(taxonomy)) {
    return {
      decision: taxonomy === 'aborted' || taxonomy === 'cancelled' ? 'abort' : 'stop',
      reason: `${taxonomy} is not retryable`,
    };
  }
  if (budget.attemptsUsed >= budget.maxAttempts) {
    return { decision: 'stop', reason: 'max attempts exhausted' };
  }
  if (budget.maxRuntimeSteps !== undefined && budget.runtimeStepsUsed >= budget.maxRuntimeSteps) {
    return { decision: 'stop', reason: 'runtime step cap reached' };
  }
  if (isWallTimeExhausted(budget)) {
    return { decision: 'stop', reason: 'wall time cap reached' };
  }
  return { decision: 'continue', reason: `${taxonomy} can be retried while budget remains` };
}

function enforceCaps(
  decision: AutonomousDecisionPolicyResult,
  attempt: RunTaskOnceResult,
  budget: LoopBudgetSnapshot,
): AutonomousDecisionPolicyResult {
  if (decision.decision !== 'continue' && decision.decision !== 'retry') return decision;
  if (attempt.resultRecord.passed)
    return { ...decision, decision: 'stop', reason: 'authoritative verification passed' };
  if (budget.attemptsUsed >= budget.maxAttempts)
    return { ...decision, decision: 'stop', reason: 'max attempts exhausted' };
  if (budget.maxRuntimeSteps !== undefined && budget.runtimeStepsUsed >= budget.maxRuntimeSteps) {
    return { ...decision, decision: 'stop', reason: 'runtime step cap reached' };
  }
  if (isWallTimeExhausted(budget))
    return { ...decision, decision: 'stop', reason: 'wall time cap reached' };
  return decision;
}

function shouldBudgetTerminal(
  decision: AutonomousDecisionPolicyResult,
  attempt: RunTaskOnceResult,
  budget: LoopBudgetSnapshot,
): boolean {
  if (attempt.resultRecord.passed) return false;
  if (decision.reason?.includes('max attempts') || decision.reason?.includes('cap')) return true;
  if (budget.attemptsUsed >= budget.maxAttempts) return true;
  if (budget.maxRuntimeSteps !== undefined && budget.runtimeStepsUsed >= budget.maxRuntimeSteps)
    return true;
  return isWallTimeExhausted(budget);
}

function isNonRetryable(taxonomy: AutonomousResultTaxonomy): boolean {
  return (
    taxonomy === 'policy_denied' ||
    taxonomy === 'blocked' ||
    taxonomy === 'aborted' ||
    taxonomy === 'cancelled' ||
    taxonomy === 'setup_failed' ||
    taxonomy === 'infra_failed'
  );
}

async function maybeRecordSelfCheck(
  policy: false | SelfCheckPolicy | undefined,
  input: SelfCheckInput,
  store: TaskRunWriter,
  taskRunId: string,
  attemptId: string,
  now: () => number,
  newId: () => string,
): Promise<SelfCheckObservation | undefined> {
  if (!policy) return undefined;
  const output = await policy.observe(input);
  const ts = now();
  const observation: SelfCheckObservation = {
    id: newId(),
    taskRunId,
    attemptId,
    ts,
    summary: output.summary.slice(0, 1000),
    ...(output.details ? { details: output.details } : {}),
  };
  await appendTaskEvent(store, taskRunId, {
    type: 'self_check_observed',
    id: newId(),
    taskRunId,
    ts,
    observation,
  });
  return observation;
}

async function appendVerifierFeedback(
  store: TaskRunWriter,
  taskRunId: string,
  attemptId: string,
  now: () => number,
  newId: () => string,
  record: ResultRecord,
  verifierResultId: string | undefined,
  scoreResultId: string | undefined,
): Promise<FeedbackObservation> {
  const taxonomy = taxonomyFromResultRecord(record);
  const ts = now();
  const observation: FeedbackObservation = {
    id: newId(),
    taskRunId,
    attemptId,
    ts,
    source: 'verifier',
    summary: record.passed ? 'verification passed' : `verification did not pass: ${taxonomy}`,
    details: {
      passed: record.passed,
      taxonomy,
      status: record.status,
      exitCode: record.exitCode,
      steps: record.steps,
      ...(record.error ? { error: record.error } : {}),
      ...(record.errorClass ? { errorClass: record.errorClass } : {}),
      ...(verifierResultId ? { verifierResultId } : {}),
      ...(scoreResultId ? { scoreResultId } : {}),
    },
  };
  await appendTaskEvent(store, taskRunId, {
    type: 'feedback_observed',
    id: newId(),
    taskRunId,
    ts,
    observation,
  });
  return observation;
}

async function appendSystemFeedback(
  store: TaskRunWriter,
  taskRunId: string,
  attemptId: string | undefined,
  now: () => number,
  newId: () => string,
  summary: string,
  details: Record<string, unknown>,
): Promise<void> {
  const ts = now();
  const observation: FeedbackObservation = {
    id: newId(),
    taskRunId,
    ...(attemptId ? { attemptId } : {}),
    ts,
    source: 'system',
    summary,
    details,
  };
  await appendTaskEvent(store, taskRunId, {
    type: 'feedback_observed',
    id: newId(),
    taskRunId,
    ts,
    observation,
  });
}

async function appendDecision(
  store: TaskRunWriter,
  taskRunId: string,
  attemptId: string,
  now: () => number,
  newId: () => string,
  decision: AutonomousDecisionPolicyResult,
  attempt: RunTaskOnceResult,
  budget: LoopBudgetSnapshot,
  selfCheck: SelfCheckObservation | undefined,
): Promise<void> {
  const ts = now();
  const recorded: AutonomousDecision = {
    id: newId(),
    taskRunId,
    attemptId,
    ts,
    decision: decision.decision,
    ...(decision.reason ? { reason: decision.reason } : {}),
    details: {
      attemptNumber: budget.attemptsUsed,
      budget,
      latestScoreId: attempt.projection.latestScoreResult?.id,
      latestVerifierId: attempt.projection.latestVerifierResult?.id,
      latestTaxonomy: taxonomyFromResultRecord(attempt.resultRecord),
      selfCheckContributed: Boolean(selfCheck),
      ...(selfCheck ? { selfCheckId: selfCheck.id } : {}),
      ...(decision.details ? decision.details : {}),
    },
  };
  await appendTaskEvent(store, taskRunId, {
    type: 'autonomous_decision_recorded',
    id: newId(),
    taskRunId,
    ts,
    decision: recorded,
  });
}

async function appendBudgetTerminal(
  store: TaskRunWriter,
  taskRunId: string,
  now: () => number,
  newId: () => string,
  budget: LoopBudgetSnapshot,
  reason: string,
  policy: TaskInterventionPolicy | undefined = undefined,
): Promise<void> {
  const ts = now();
  if (policy?.mode === 'park' && policy.allowBudgetExtensionRequests) {
    const item = budgetExtensionInboxItem({
      inboxItemId: newId(),
      taskRunId,
      reason,
      createdAt: ts,
      budget: { ...budget },
    });
    await appendTaskEvent(store, taskRunId, {
      type: 'task_inbox_item_recorded',
      id: newId(),
      taskRunId,
      ts,
      item,
    });
    await appendTaskEvent(store, taskRunId, {
      type: 'task_run_needs_approval',
      id: newId(),
      taskRunId,
      ts,
      reason: 'budget_extension',
      inboxItemId: item.inboxItemId,
    });
    return;
  }
  await appendTaskEvent(store, taskRunId, {
    type: 'task_run_budget_exhausted',
    id: newId(),
    taskRunId,
    ts,
    finishedAt: ts,
    error: {
      message: reason,
      class: 'budget_exhausted',
      details: { budget },
    },
  });
}

function terminalEventFromResultRecord(
  record: ResultRecord,
  taskRunId: string,
  newId: () => string,
  refs: { verifierResultId?: string; scoreResultId?: string } = {},
): TaskEvent {
  const taxonomy = taxonomyFromResultRecord(record);
  const result: TaskRunResult = {
    passed: record.passed,
    taxonomy,
    ...(refs.verifierResultId ? { verifierResultId: refs.verifierResultId } : {}),
    ...(refs.scoreResultId ? { scoreResultId: refs.scoreResultId } : {}),
  };
  const base = { id: newId(), taskRunId, ts: record.finishedAt, finishedAt: record.finishedAt };
  if (record.status === 'completed') {
    return { type: 'task_run_completed', ...base, result };
  }

  const error = errorFromResultRecord(record, taxonomy);
  switch (taxonomy) {
    case 'agent_incomplete':
      return { type: 'task_run_incomplete', ...base, error };
    case 'blocked':
      return { type: 'task_run_blocked', ...base, error };
    case 'policy_denied':
      return { type: 'task_run_policy_denied', ...base, error };
    case 'budget_exhausted':
      return { type: 'task_run_budget_exhausted', ...base, error };
    case 'aborted':
      return { type: 'task_run_aborted', ...base, error };
    case 'cancelled':
      return { type: 'task_run_cancelled', ...base, error };
    case 'passed':
    case 'verification_failed':
    case 'verification_error':
    case 'agent_failed':
    case 'invalid_setup':
    case 'unsupported_adapter':
    case 'isolation_required':
    case 'setup_failed':
    case 'infra_failed':
      return { type: 'task_run_failed', ...base, error };
  }
}

function syntheticResultRecord(
  config: Config,
  task: Task,
  taskRunId: string,
  taxonomy: AutonomousResultTaxonomy,
  message: string,
  startedAt: number,
  finishedAt: number,
): ResultRecord {
  return {
    taskId: task.id,
    configId: config.id,
    sessionId: taskRunId,
    runId: taskRunId,
    status: 'failed',
    passed: false,
    exitCode: null,
    steps: 0,
    durationMs: finishedAt - startedAt,
    startedAt,
    finishedAt,
    error: message,
    errorClass: taxonomy,
  };
}

function errorFromResultRecord(
  record: ResultRecord,
  taxonomy: AutonomousResultTaxonomy,
): TaskRunError {
  return {
    message: record.error ?? errorMessageFromTaxonomy(taxonomy),
    ...(record.errorClass ? { class: record.errorClass } : { class: taxonomy }),
  };
}

function errorMessageFromTaxonomy(taxonomy: AutonomousResultTaxonomy): string {
  switch (taxonomy) {
    case 'agent_failed':
      return 'agent run failed';
    case 'agent_incomplete':
      return 'agent run incomplete';
    case 'invalid_setup':
      return 'invalid setup';
    case 'unsupported_adapter':
      return 'unsupported verifier adapter';
    case 'isolation_required':
      return 'isolated executor required';
    case 'setup_failed':
      return 'task setup failed';
    case 'infra_failed':
      return 'infrastructure failed';
    case 'verification_error':
      return 'verification errored';
    case 'policy_denied':
      return 'task run denied by policy';
    case 'budget_exhausted':
      return 'task run budget exhausted';
    case 'aborted':
      return 'task run aborted';
    case 'blocked':
      return 'task run blocked';
    case 'cancelled':
      return 'task run cancelled';
    case 'verification_failed':
      return 'verification failed';
    case 'passed':
      return 'task run failed';
  }
}

function defaultContinuationPrompt(
  config: Config,
  task: Task,
  attempt: RunTaskOnceResult,
  selfCheck: SelfCheckObservation | undefined,
): string {
  const taxonomy = taxonomyFromResultRecord(attempt.resultRecord);
  const selfCheckLine = selfCheck ? `\nAdvisory self-check: ${selfCheck.summary}` : '';
  const progressBlock = resolveHeavyTaskMode(config, task).enabled
    ? renderHeavyTaskProgressForPrompt(attempt.projection)
    : undefined;
  const progressLine = progressBlock ? `\n\n${progressBlock}` : '';
  return `${task.instruction}

Previous autonomous attempt did not pass authoritative verification.
Verifier taxonomy: ${taxonomy}.
Verification exit code: ${attempt.resultRecord.exitCode ?? 'none'}.
Continue from that feedback and produce a corrected solution.${selfCheckLine}${progressLine}`;
}

function appendTaskEvent(store: TaskRunWriter, taskRunId: string, event: TaskEvent): Promise<void> {
  return store.appendEvent(taskRunId, event);
}
