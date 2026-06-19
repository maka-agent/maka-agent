import type { ResultRecord, TaskVerification, VerifierSpec } from './contracts.js';

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
  | 'needs_approval'
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
  | 'needs_approval'
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
  | 'invalid_setup'
  | 'unsupported_adapter'
  | 'isolation_required'
  | 'setup_failed'
  | 'infra_failed'
  | 'policy_denied'
  | 'budget_exhausted'
  | 'aborted'
  | 'blocked'
  | 'cancelled';

export type ResultTaxonomy = AutonomousResultTaxonomy;

export type HeadlessInterventionMode = 'fail_closed' | 'park';

export interface TaskInterventionPolicy {
  mode: HeadlessInterventionMode;
  approvalTimeoutMs?: number;
  allowBudgetExtensionRequests?: boolean;
  allowAmbiguousFailureTriage?: boolean;
}

export function taxonomyFromResultRecord(record: ResultRecord): AutonomousResultTaxonomy {
  if (record.status === 'completed') {
    if (record.passed) return 'passed';
    if (record.errorClass === 'unsupported_adapter') return 'unsupported_adapter';
    if (record.errorClass === 'invalid_setup') return 'invalid_setup';
    if (record.errorClass === 'isolation_required') return 'isolation_required';
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
  if (includesAny(failureText, ['verification_error'])) return 'verification_error';
  if (includesAny(failureText, ['verification_failed'])) return 'verification_failed';
  if (includesAny(failureText, ['unsupported_adapter'])) return 'unsupported_adapter';
  if (includesAny(failureText, ['invalid_setup'])) return 'invalid_setup';
  if (includesAny(failureText, ['isolation_required', 'isolated executor'])) return 'isolation_required';
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
  kind: VerifierSpec['kind'];
  passed: boolean;
  exitCode?: number | null;
  command?: string;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  error?: string;
  errorClass?: string;
  score?: number;
  maxScore?: number;
  details?: Record<string, unknown>;
  submittedSnapshotId?: string;
  scoringWorkspaceId?: string;
}

export interface ScoreResult {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  passed: boolean;
  scored?: boolean;
  eligible?: boolean;
  errorClass?: string;
  excludedReason?: string;
  score?: number;
  maxScore?: number;
  taxonomy: AutonomousResultTaxonomy;
  details?: Record<string, unknown>;
}

export interface EnvNetworkSecretPolicy {
  schemaVersion: 1;
  env: 'inherit_none' | 'allowlist';
  envAllowlist?: string[];
  network: 'disabled' | 'allowlist' | 'unrestricted_external_boundary';
  networkAllowlist?: string[];
  secrets: 'none' | 'brokered_by_executor' | 'explicit_allowlist';
  secretRefs?: string[];
}

export interface TaskIsolationFacts {
  schemaVersion: 1;
  backendKind: string;
  required: boolean;
  mode: 'inert_fake_backend' | 'external';
  label?: string;
  assertionSource: 'headless_deps' | 'test_fixture' | 'desktop' | 'ci';
  validatedAt: number;
}

export interface WorkspaceLeaseFacts {
  schemaVersion: 1;
  leaseId: string;
  taskRunId: string;
  attemptId?: string;
  sourceWorkspaceDir: string;
  workspaceDir: string;
  leaseKind: 'throwaway_copy';
  writable: boolean;
  cleanupPolicy: 'cleanup_on_finally';
  createdAt: number;
  releasedAt?: number;
}

export interface ToolExecutorIdentity {
  schemaVersion: 1;
  executorId: string;
  taskRunId: string;
  attemptId?: string;
  toolNames: string[];
  isolationMode: 'external' | 'inert_fake_backend';
  label: string;
  commandPolicy?: EnvNetworkSecretPolicy;
}

export type PermissionDecision = 'allow' | 'deny' | 'timeout' | 'expired';
export type PermissionDecisionSource = 'ci_policy' | 'desktop_user' | 'test_fixture' | 'policy_engine';

export interface PermissionResourceScope {
  kind: 'workspace_path' | 'network' | 'secret' | 'command' | 'tool' | 'budget';
  value: string;
  mode?: 'read' | 'write' | 'execute' | 'connect' | 'reveal' | 'extend';
}

export interface TaskPermissionRequest {
  schemaVersion: 1;
  requestId: string;
  taskRunId: string;
  attemptId: string;
  toolCallId: string;
  toolName: string;
  normalizedArgsHash: string;
  resourceScope: PermissionResourceScope;
  reason: string;
  preview: Record<string, unknown>;
  requestedAt: number;
  expiresAt: number;
}

export interface TaskPermissionGrant {
  schemaVersion: 1;
  grantId: string;
  requestId: string;
  taskRunId: string;
  attemptId?: string;
  toolCallId?: string;
  toolName: string;
  normalizedArgsHash: string;
  resourceScope: PermissionResourceScope;
  decision: PermissionDecision;
  actor: { kind: 'user' | 'system' | 'test'; id?: string };
  source: PermissionDecisionSource;
  decidedAt: number;
  expiresAt: number;
  reason?: string;
}

export type TaskInboxKind =
  | 'approval_request'
  | 'ambiguous_failure_triage'
  | 'budget_extension'
  | 'claim_to_chat';

export type TaskInboxStatus = 'open' | 'claimed' | 'resolved' | 'dismissed' | 'expired';

export interface TaskInboxItem {
  schemaVersion: 1;
  inboxItemId: string;
  taskRunId: string;
  attemptId?: string;
  kind: TaskInboxKind;
  status: TaskInboxStatus;
  title: string;
  reason: string;
  createdAt: number;
  expiresAt?: number;
  relatedRequestId?: string;
  relatedGrantId?: string;
  relatedVerifierResultId?: string;
  relatedScoreResultId?: string;
  claim?: { actorId: string; claimedAt: number; chatRef?: string };
  resolution?: { decision: string; actorId?: string; resolvedAt: number; reason?: string };
  preview?: Record<string, unknown>;
}

export interface TaskRunParkedState {
  reason: 'approval' | 'ambiguous_failure' | 'budget_extension' | 'claim_to_chat';
  inboxItemId: string;
  since: number;
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

export interface IsolationPolicyRecordedEvent extends BaseTaskEvent {
  type: 'isolation_policy_recorded';
  facts: TaskIsolationFacts;
}

export interface WorkspaceLeaseRecordedEvent extends BaseTaskEvent {
  type: 'workspace_lease_recorded';
  lease: WorkspaceLeaseFacts;
}

export interface ToolExecutorIdentityRecordedEvent extends BaseTaskEvent {
  type: 'tool_executor_identity_recorded';
  identity: ToolExecutorIdentity;
}

export interface PermissionRequestRecordedEvent extends BaseTaskEvent {
  type: 'permission_request_recorded';
  request: TaskPermissionRequest;
}

export interface PermissionGrantRecordedEvent extends BaseTaskEvent {
  type: 'permission_grant_recorded';
  grant: TaskPermissionGrant;
}

export interface PermissionDecisionRecordedEvent extends BaseTaskEvent {
  type: 'permission_decision_recorded';
  requestId: string;
  grant?: TaskPermissionGrant;
  decision: PermissionDecision;
  source: PermissionDecisionSource;
  decidedAt: number;
  reason?: string;
}

export interface TaskInboxItemRecordedEvent extends BaseTaskEvent {
  type: 'task_inbox_item_recorded';
  item: TaskInboxItem;
}

export interface TaskInboxItemResolvedEvent extends BaseTaskEvent {
  type: 'task_inbox_item_resolved';
  inboxItemId: string;
  status: Exclude<TaskInboxStatus, 'open'>;
  resolution?: NonNullable<TaskInboxItem['resolution']>;
}

export interface TaskRunNeedsApprovalEvent extends BaseTaskEvent {
  type: 'task_run_needs_approval';
  attemptId?: string;
  reason: TaskRunParkedState['reason'];
  inboxItemId: string;
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
  | IsolationPolicyRecordedEvent
  | WorkspaceLeaseRecordedEvent
  | ToolExecutorIdentityRecordedEvent
  | PermissionRequestRecordedEvent
  | PermissionGrantRecordedEvent
  | PermissionDecisionRecordedEvent
  | TaskInboxItemRecordedEvent
  | TaskInboxItemResolvedEvent
  | TaskRunNeedsApprovalEvent
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
