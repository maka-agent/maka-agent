// Public surface of @maka/headless. Deliberately curated — the workspace copy
// (sandbox.ts), the verification runner (evaluator.ts), and the backend wiring
// (backends.ts) are internals the runner owns, not part of the API. Minimal
// usage is `runExperiment(config, task, { storageRoot })`.
export type {
  ArtifactFreezeResult,
  BenchmarkContract,
  CommandVerifierSpec,
  Config,
  ResultRecord,
  SubmittedSnapshot,
  SweBenchVerifierSpec,
  Task,
  TaskVerification,
  TerminalBenchVerifierSpec,
  VerifierSpec,
} from './contracts.js';
export type { FinalScore, FinalScorer, FinalScorerInput } from './scorer.js';
export type {
  AutonomousDecision,
  AutonomousResultTaxonomy,
  EnvNetworkSecretPolicy,
  FeedbackObservation,
  HeadlessInterventionMode,
  IsolationPolicyRecordedEvent,
  PermissionDecision,
  PermissionDecisionRecordedEvent,
  PermissionDecisionSource,
  PermissionGrantRecordedEvent,
  PermissionRequestRecordedEvent,
  PermissionResourceScope,
  ResultTaxonomy,
  ScoreResult,
  SelfCheckObservation,
  TaskAttempt,
  TaskAttemptStatus,
  TaskDefinition,
  TaskEvent,
  TaskEventCorrupt,
  TaskInboxItem,
  TaskInboxItemRecordedEvent,
  TaskInboxItemResolvedEvent,
  TaskInboxKind,
  TaskInboxStatus,
  TaskInterventionPolicy,
  TaskIsolationFacts,
  TaskPermissionGrant,
  TaskPermissionRequest,
  TaskRunAbortedEvent,
  TaskRunBlockedEvent,
  TaskRunBudgetExhaustedEvent,
  TaskRunCancelledEvent,
  TaskRunCompletedEvent,
  TaskRunCreatedEvent,
  TaskRunFailedEvent,
  TaskRunIncompleteEvent,
  TaskRunNeedsApprovalEvent,
  TaskRunParkedState,
  TaskRunPolicyDeniedEvent,
  TaskRunQueuedEvent,
  TaskRunStartedEvent,
  TaskRunVerifyingEvent,
  TaskRun,
  TaskRunError,
  TaskRunResult,
  TaskRunStatus,
  ToolExecutorIdentity,
  ToolExecutorIdentityRecordedEvent,
  VerifierResult,
  WorkspaceLeaseRecordedEvent,
  WorkspaceLeaseFacts,
} from './task-contracts.js';
export {
  TASK_RUN_TERMINAL_STATUSES,
  isFailureTaxonomy,
  isTerminalTaskRunStatus,
  taxonomyFromResultRecord,
} from './task-contracts.js';
export {
  commandResourceScope,
  hashNormalizedArgs,
  matchPermissionGrant,
  normalizePermissionArgs,
  permissionPreview,
  resourceScopeEquals,
  type NormalizedPermissionArgs,
} from './permission-grants.js';
export type { TaskRunProjection, TaskRunStore } from './task-run-store.js';
export { createInMemoryTaskRunStore, createTaskRunStore, projectTaskRun } from './task-run-store.js';
export type { TaskEventsFromResultRecordOptions } from './task-run-adapter.js';
export {
  resultRecordFromTaskRunProjection,
  taskDefinitionFromTask,
  taskEventsFromResultRecord,
} from './task-run-adapter.js';
export type { RunTaskOnceDeps, RunTaskOnceResult } from './task-agent-controller.js';
export { runTaskOnce, TaskAgentController } from './task-agent-controller.js';
export type {
  AutonomousDecisionInput,
  AutonomousDecisionPolicy,
  AutonomousDecisionPolicyResult,
  AutonomousLoopBudget,
  FeedbackPromptInput,
  LoopBudgetSnapshot,
  RunAutonomousTaskOptions,
  RunAutonomousTaskResult,
  SelfCheckInput,
  SelfCheckOutput,
  SelfCheckPolicy,
} from './autonomous-agent-loop.js';
export { AutonomousAgentLoop, runAutonomousTask } from './autonomous-agent-loop.js';
export { runExperiment, type RunExperimentDeps } from './runner.js';
export { runMatrix, type ExperimentSpec } from './matrix.js';
export { defaultFinalScorer } from './scorer.js';
export { readResults, summarizeMatrix, writeResults, toComparisonTable, type MatrixSummary } from './results.js';
export { normalizeVerifier } from './verifier.js';
export type {
  HeadlessBackendContext,
  IsolatedCommandInput,
  IsolatedCommandResult,
  IsolatedToolExecutor,
  RealBackendIsolation,
} from './isolation.js';
export {
  buildIsolatedBashTool,
  buildIsolatedHeadlessToolAvailability,
  buildIsolatedHeadlessTools,
} from './tools.js';
