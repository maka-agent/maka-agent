import type { ResultRecord, TaskVerification } from './contracts.js';

export type TaskRunStatus =
  | 'queued'
  | 'created'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'blocked'
  | 'policy_denied'
  | 'budget_exhausted'
  | 'aborted'
  | 'cancelled';
export type TaskAttemptStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'blocked'
  | 'policy_denied'
  | 'budget_exhausted'
  | 'aborted'
  | 'cancelled';

export const TASK_RUN_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'incomplete',
  'blocked',
  'policy_denied',
  'budget_exhausted',
  'aborted',
  'cancelled',
] as const;

export function isTerminalTaskRunStatus(status: TaskRunStatus): boolean {
  return (TASK_RUN_TERMINAL_STATUSES as readonly TaskRunStatus[]).includes(status);
}

export type AutonomousResultTaxonomy =
  | 'passed'
  | 'verification_failed'
  | 'verification_error'
  | 'agent_failed'
  | 'agent_incomplete'
  | 'setup_failed'
  | 'infra_failed'
  | 'policy_denied'
  | 'budget_exhausted'
  | 'aborted'
  | 'blocked'
  | 'cancelled';

export type ResultTaxonomy = AutonomousResultTaxonomy;

export function taxonomyFromResultRecord(record: ResultRecord): AutonomousResultTaxonomy {
  if (record.status === 'completed') {
    if (record.passed) return 'passed';
    return record.exitCode === null ? 'verification_error' : 'verification_failed';
  }

  const errorClass = record.errorClass?.toLowerCase() ?? '';
  const error = record.error?.toLowerCase() ?? '';
  const failureText = `${errorClass} ${error}`;
  if (includesAny(failureText, ['cancelled', 'canceled'])) return 'cancelled';
  if (includesAny(failureText, ['abort', 'aborted'])) return 'aborted';
  if (includesAny(failureText, ['budget', 'limit', 'limits_exceeded', 'max_steps', 'max_tokens'])) {
    return 'budget_exhausted';
  }
  if (includesAny(failureText, ['blocked', 'waiting_permission'])) return 'blocked';
  if (includesAny(failureText, ['policy', 'permission', 'denied'])) return 'policy_denied';
  if (includesAny(failureText, ['incomplete', 'tool_calls', 'no_submit', 'truncated'])) return 'agent_incomplete';
  if (includesAny(failureText, ['setup', 'fixture', 'config', 'preflight'])) return 'setup_failed';
  if (includesAny(failureText, ['infra', 'infrastructure', 'harbor', 'container', 'docker', 'fetch', 'materialize', 'network'])) {
    return 'infra_failed';
  }
  if (errorClass.includes('backend') || errorClass.includes('agent') || errorClass.includes('runtime') || record.sessionId || record.runId) {
    return 'agent_failed';
  }
  return 'setup_failed';
}

export function isFailureTaxonomy(taxonomy: AutonomousResultTaxonomy): boolean {
  return taxonomy !== 'passed';
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

export interface TaskDefinition {
  id: string;
  instruction: string;
  workspaceDir: string;
  verification: TaskVerification;
  metadata?: Record<string, unknown>;
}

export interface TaskRunError {
  message: string;
  class?: string;
  details?: Record<string, unknown>;
}

export interface TaskRunResult {
  passed: boolean;
  taxonomy: AutonomousResultTaxonomy;
  verifierResultId?: string;
  scoreResultId?: string;
}

export interface TaskRun {
  taskRunId: string;
  taskId: string;
  configId: string;
  status: TaskRunStatus;
  startedAt?: number;
  finishedAt?: number;
  sessionId?: string;
  agentRunId?: string;
  result?: TaskRunResult;
  error?: TaskRunError;
}

export interface TaskAttempt {
  attemptId: string;
  taskRunId: string;
  startedAt: number;
  finishedAt?: number;
  status: TaskAttemptStatus;
  sessionId?: string;
  agentRunId?: string;
  error?: TaskRunError;
}

export interface SelfCheckObservation {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  summary: string;
  details?: Record<string, unknown>;
}

export interface FeedbackObservation {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  source: 'verifier' | 'human' | 'runtime' | 'system';
  summary: string;
  details?: Record<string, unknown>;
}

export interface AutonomousDecision {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  decision: 'continue' | 'retry' | 'stop' | 'abort';
  reason?: string;
  details?: Record<string, unknown>;
}

export interface VerifierResult {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  kind: 'command';
  passed: boolean;
  exitCode: number | null;
  command?: string;
  durationMs?: number;
  error?: string;
}

export interface ScoreResult {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  passed: boolean;
  score?: number;
  maxScore?: number;
  taxonomy: AutonomousResultTaxonomy;
  details?: Record<string, unknown>;
}

interface BaseTaskEvent {
  id: string;
  taskRunId: string;
  ts: number;
}

export interface TaskRunCreatedEvent extends BaseTaskEvent {
  type: 'task_run_created';
  taskId: string;
  configId: string;
  taskDefinition?: TaskDefinition;
  sourceResultRecord?: ResultRecord;
}

export interface TaskRunQueuedEvent extends BaseTaskEvent {
  type: 'task_run_queued';
  taskId: string;
  configId: string;
  taskDefinition?: TaskDefinition;
}

export interface TaskRunStartedEvent extends BaseTaskEvent {
  type: 'task_run_started';
  startedAt?: number;
  sessionId?: string;
  agentRunId?: string;
}

export interface TaskRunVerifyingEvent extends BaseTaskEvent {
  type: 'task_run_verifying';
  startedAt?: number;
}

export interface TaskAttemptStartedEvent extends BaseTaskEvent {
  type: 'task_attempt_started';
  attemptId: string;
  startedAt?: number;
  sessionId?: string;
  agentRunId?: string;
}

export interface SelfCheckObservedEvent extends BaseTaskEvent {
  type: 'self_check_observed';
  observation: SelfCheckObservation;
}

export interface FeedbackObservedEvent extends BaseTaskEvent {
  type: 'feedback_observed';
  observation: FeedbackObservation;
}

export interface AutonomousDecisionRecordedEvent extends BaseTaskEvent {
  type: 'autonomous_decision_recorded';
  decision: AutonomousDecision;
}

export interface VerifierResultRecordedEvent extends BaseTaskEvent {
  type: 'verifier_result_recorded';
  result: VerifierResult;
}

export interface ScoreResultRecordedEvent extends BaseTaskEvent {
  type: 'score_result_recorded';
  result: ScoreResult;
}

export interface TaskAttemptCompletedEvent extends BaseTaskEvent {
  type: 'task_attempt_completed';
  attemptId: string;
  finishedAt?: number;
  status: Exclude<TaskAttemptStatus, 'running'>;
  error?: TaskRunError;
}

export interface TaskRunCompletedEvent extends BaseTaskEvent {
  type: 'task_run_completed';
  finishedAt?: number;
  result?: TaskRunResult;
}

export interface TaskRunFailedEvent extends BaseTaskEvent {
  type: 'task_run_failed';
  finishedAt?: number;
  error: TaskRunError;
}

export interface TaskRunIncompleteEvent extends BaseTaskEvent {
  type: 'task_run_incomplete';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunBlockedEvent extends BaseTaskEvent {
  type: 'task_run_blocked';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunPolicyDeniedEvent extends BaseTaskEvent {
  type: 'task_run_policy_denied';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunBudgetExhaustedEvent extends BaseTaskEvent {
  type: 'task_run_budget_exhausted';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunAbortedEvent extends BaseTaskEvent {
  type: 'task_run_aborted';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunCancelledEvent extends BaseTaskEvent {
  type: 'task_run_cancelled';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskEventCorrupt extends BaseTaskEvent {
  type: 'event_corrupt';
  raw?: string;
  error: string;
}

export type TaskEvent =
  | TaskRunCreatedEvent
  | TaskRunQueuedEvent
  | TaskRunStartedEvent
  | TaskRunVerifyingEvent
  | TaskAttemptStartedEvent
  | SelfCheckObservedEvent
  | FeedbackObservedEvent
  | AutonomousDecisionRecordedEvent
  | VerifierResultRecordedEvent
  | ScoreResultRecordedEvent
  | TaskAttemptCompletedEvent
  | TaskRunCompletedEvent
  | TaskRunFailedEvent
  | TaskRunIncompleteEvent
  | TaskRunBlockedEvent
  | TaskRunPolicyDeniedEvent
  | TaskRunBudgetExhaustedEvent
  | TaskRunAbortedEvent
  | TaskRunCancelledEvent
  | TaskEventCorrupt;
