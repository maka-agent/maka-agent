import { randomUUID } from 'node:crypto';
import type { ResultRecord, Task } from './contracts.js';
import { normalizeVerifier } from './verifier.js';
import {
  taxonomyFromResultRecord,
  type AutonomousResultTaxonomy,
  type ScoreResult,
  type TaskAttemptStatus,
  type TaskDefinition,
  type TaskEvent,
  type TaskRunError,
  type TaskRunResult,
  type VerifierResult,
} from './task-contracts.js';
import type { TaskRunProjection } from './task-run-projection.js';
import { taskAttemptExecutionEvidence } from './task-execution-lineage.js';

export interface TaskEventsFromResultRecordOptions {
  task?: Task;
  taskRunId?: string;
  attemptId?: string;
  eventId?: () => string;
}

export function taskDefinitionFromTask(task: Task): TaskDefinition {
  const verifier = normalizeVerifier(task);
  return {
    id: task.id,
    instruction: task.instruction,
    workspaceDir: task.workspaceDir,
    verification:
      verifier.kind === 'command'
        ? {
            command: verifier.command,
            ...(verifier.timeoutMs === undefined ? {} : { timeoutMs: verifier.timeoutMs }),
            protectedPaths: [...verifier.protectedPaths],
          }
        : {
            command: verifier.kind,
            protectedPaths: verifier.protectedPaths ? [...verifier.protectedPaths] : [],
          },
  };
}

export function taskEventsFromResultRecord(
  record: ResultRecord,
  options: TaskEventsFromResultRecordOptions = {},
): TaskEvent[] {
  const eventId = options.eventId ?? randomUUID;
  const taskRunId =
    options.taskRunId ??
    (record.runId || `${record.configId}-${record.taskId}-${record.startedAt}`);
  const attemptId = options.attemptId ?? `${taskRunId}-attempt-1`;
  const taxonomy = taxonomyFromResultRecord(record);
  const shouldRecordVerifier =
    record.status === 'completed' || record.exitCode !== null || taxonomy === 'verification_error';
  const verifier = options.task ? normalizeVerifier(options.task) : undefined;
  const verifierResult: VerifierResult | undefined = shouldRecordVerifier
    ? {
        id: eventId(),
        taskRunId,
        attemptId,
        ts: record.finishedAt,
        kind: 'command',
        passed: record.status === 'completed' && record.passed,
        exitCode: record.exitCode,
        ...(verifier?.kind === 'command' ? { command: verifier.command } : {}),
        ...(record.error ? { error: record.error } : {}),
      }
    : undefined;
  const scoreResult: ScoreResult = {
    id: eventId(),
    taskRunId,
    attemptId,
    ts: record.finishedAt,
    passed: record.status === 'completed' && record.passed,
    taxonomy,
    details: { steps: record.steps },
  };
  const result: TaskRunResult = {
    passed: scoreResult.passed,
    taxonomy,
    ...(verifierResult ? { verifierResultId: verifierResult.id } : {}),
    scoreResultId: scoreResult.id,
  };
  const events: TaskEvent[] = [
    {
      type: 'task_run_created',
      id: eventId(),
      taskRunId,
      ts: record.startedAt,
      taskId: record.taskId,
      configId: record.configId,
      ...(options.task ? { taskDefinition: taskDefinitionFromTask(options.task) } : {}),
      sourceResultRecord: record,
    },
    {
      type: 'task_run_started',
      id: eventId(),
      taskRunId,
      ts: record.startedAt,
      startedAt: record.startedAt,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.runId ? { agentRunId: record.runId } : {}),
    },
    {
      type: 'task_attempt_started',
      id: eventId(),
      taskRunId,
      ts: record.startedAt,
      attemptId,
      startedAt: record.startedAt,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.runId ? { agentRunId: record.runId } : {}),
    },
  ];

  if (record.sessionId && record.runId) {
    events.push({
      type: 'task_attempt_execution_linked',
      id: eventId(),
      taskRunId,
      attemptId,
      ts: record.finishedAt,
      evidence: taskAttemptExecutionEvidence({
        taskRunId,
        attemptId,
        sessionId: record.sessionId,
        agentRunId: record.runId,
        runtimeEvents: [],
      }),
    });
  }

  if (verifierResult) {
    events.push({
      type: 'verifier_result_recorded',
      id: eventId(),
      taskRunId,
      ts: record.finishedAt,
      result: verifierResult,
    });
  }
  events.push({
    type: 'score_result_recorded',
    id: eventId(),
    taskRunId,
    ts: record.finishedAt,
    result: scoreResult,
  });
  events.push({
    type: 'task_attempt_completed',
    id: eventId(),
    taskRunId,
    ts: record.finishedAt,
    attemptId,
    finishedAt: record.finishedAt,
    status: attemptStatusFromResult(record.status, taxonomy),
    ...(record.status === 'failed' ? { error: errorFromResultRecord(record, taxonomy) } : {}),
  });

  events.push(terminalEventFromResult(record, taxonomy, result, taskRunId, eventId));

  return events;
}

function attemptStatusFromResult(
  status: ResultRecord['status'],
  taxonomy: AutonomousResultTaxonomy,
): Exclude<TaskAttemptStatus, 'running'> {
  if (status === 'completed') return 'completed';
  switch (taxonomy) {
    case 'agent_incomplete':
      return 'incomplete';
    case 'blocked':
      return 'blocked';
    case 'policy_denied':
      return 'policy_denied';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'aborted':
      return 'aborted';
    case 'cancelled':
      return 'cancelled';
    case 'passed':
    case 'verification_failed':
    case 'verification_error':
    case 'agent_failed':
    case 'invalid_setup':
    case 'unsupported_adapter':
    case 'isolation_required':
    case 'setup_failed':
    case 'infra_failed':
      return 'failed';
  }
}

function terminalEventFromResult(
  record: ResultRecord,
  taxonomy: AutonomousResultTaxonomy,
  result: TaskRunResult,
  taskRunId: string,
  eventId: () => string,
): TaskEvent {
  const base = { id: eventId(), taskRunId, ts: record.finishedAt, finishedAt: record.finishedAt };
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

export function resultRecordFromTaskRunProjection(projection: TaskRunProjection): ResultRecord {
  const base = projection.sourceResultRecord ?? baseResultRecord(projection);
  const latestScore = projection.latestScoreResult;
  const taxonomy = latestScore?.taxonomy ?? projection.result?.taxonomy;
  const passed =
    latestScore?.passed ??
    projection.result?.passed ??
    projection.latestVerifierResult?.passed ??
    false;
  const exitCode = projection.latestVerifierResult?.exitCode ?? base.exitCode;

  if (projection.status === 'completed') {
    const { error: _error, errorClass: _errorClass, ...completedBase } = base;
    return {
      ...completedBase,
      status: 'completed',
      passed,
      exitCode,
    };
  }

  const failureClass = legacyFailureClass(projection.status, taxonomy);
  if (failureClass) {
    const errorClass =
      projection.error?.class ??
      base.errorClass ??
      (projection.sourceResultRecord ? undefined : failureClass);
    return {
      ...base,
      status: 'failed',
      passed: false,
      exitCode,
      error:
        projection.error?.message ??
        base.error ??
        errorMessageFromTaxonomy(taxonomy, projection.status),
      ...(errorClass ? { errorClass } : {}),
    };
  }

  return {
    ...base,
    status: 'failed',
    passed: false,
    exitCode,
    error: base.error ?? `task run is ${projection.status}`,
    errorClass: base.errorClass ?? 'non_terminal',
  };
}

function legacyFailureClass(
  status: TaskRunProjection['status'],
  taxonomy: AutonomousResultTaxonomy | undefined,
): string | undefined {
  switch (status) {
    case 'failed':
      return taxonomy ?? 'failed';
    case 'incomplete':
      return 'agent_incomplete';
    case 'blocked':
      return 'blocked';
    case 'policy_denied':
      return 'policy_denied';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'aborted':
      return 'aborted';
    case 'cancelled':
      return 'cancelled';
    case 'queued':
    case 'created':
    case 'running':
    case 'verifying':
    case 'completed':
      return undefined;
  }
}

function baseResultRecord(projection: TaskRunProjection): ResultRecord {
  const startedAt = projection.startedAt ?? projection.events[0]?.ts ?? 0;
  const finishedAt = projection.finishedAt ?? projection.events.at(-1)?.ts ?? startedAt;
  return {
    taskId: projection.taskId,
    configId: projection.configId,
    sessionId: projection.sessionId ?? '',
    runId: projection.agentRunId ?? projection.taskRunId,
    status: 'failed',
    passed: false,
    exitCode: projection.latestVerifierResult?.exitCode ?? null,
    steps: projection.events.length,
    durationMs: finishedAt - startedAt,
    startedAt,
    finishedAt,
  };
}

function errorFromResultRecord(
  record: ResultRecord,
  taxonomy: AutonomousResultTaxonomy,
): TaskRunError {
  return {
    message: record.error ?? errorMessageFromTaxonomy(taxonomy),
    ...(record.errorClass ? { class: record.errorClass } : {}),
  };
}

function errorMessageFromTaxonomy(
  taxonomy: AutonomousResultTaxonomy | undefined,
  status?: TaskRunProjection['status'],
): string {
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
    case undefined:
      if (status) return `task run is ${status}`;
      return 'task run failed';
  }
}
