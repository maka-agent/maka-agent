// Public surface of @maka/headless. Deliberately curated — the workspace copy
// (sandbox.ts), the verification runner (evaluator.ts), and the backend wiring
// (backends.ts) are internals the runner owns, not part of the API. Minimal
// usage is `runExperiment(config, task, { storageRoot })`.
export type {
  HarborCellOutput,
  HarborCellRuntimeRefs,
  HarborCellTokenSummary,
} from './cell-output.js';
export {
  HARBOR_CELL_OUTPUT_SCHEMA_VERSION,
  buildHarborCellOutput,
  summarizeCellTokens,
  validateHarborCellOutput,
} from './cell-output.js';
export type {
  RunHarborCellEnv,
  RunHarborCellFromEnvOptions,
  RunHarborCellInput,
  RunHarborCellResult,
} from './harbor-cell.js';
export {
  HARBOR_CELL_OUTPUT_FILENAME,
  HARBOR_CELL_RUNTIME_EVENTS_FILENAME,
  runHarborCell,
  runHarborCellFromEnv,
} from './harbor-cell.js';
export type {
  FixedPromptControllerStopReason,
  FixedPromptControllerResult,
  FixedPromptTask,
  FixedPromptTaskCompletedEvent,
  FixedPromptTaskInfraFailedEvent,
  FixedPromptTaskPlumbingFailedEvent,
  FixedPromptTaskWalEvent,
  FixedPromptWalEvent,
  HarborTaskRunInput,
  HarborTaskRunOutput,
  HarborTaskRunner,
  PromptCandidateCommittedEvent,
  PromptCandidateDecisionEvent,
  PromptCandidateRewardHackScan,
  ReadHarborTaskRunOutputInput,
  RunFixedPromptControllerInput,
} from './fixed-prompt-controller.js';
export {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  appendFixedPromptWalEvent,
  hashSystemPrompt,
  readHarborTaskRunOutput,
  readFixedPromptWal,
  runFixedPromptController,
  writeFixedPromptResultsTsv,
} from './fixed-prompt-controller.js';
export type {
  MetaAgent,
  MetaAgentPromptInput,
  MetaAgentPromptResult,
  ExtractTrajectoryDigestInput,
  CreateScriptedMetaAgentInput,
  CreateCliPromptCandidateGitInput,
  MetaAgentCompletion,
  MetaAgentCompletionInput,
  PromptCandidateGit,
  PromptCandidateRoundResult,
  RewardHackScanInput,
  RewardHackScanResult,
  RunPromptCandidateRoundInput,
  TrajectoryDigest,
  TrajectoryToolCallDigest,
} from './prompt-candidate-loop.js';
export {
  assertOnlySystemPromptChanged,
  createCliPromptCandidateGit,
  createScriptedMetaAgent,
  extractTrajectoryDigest,
  parseMetaAgentResult,
  renderMetaAgentPrompt,
  runPromptCandidateRound,
  scanRuntimeEventsForRewardHack,
} from './prompt-candidate-loop.js';
export type {
  AppendPromptAcceptanceDecisionInput,
  CalibratePromptAcceptanceBaselineInput,
  DecidePromptAcceptanceInput,
  PromptAcceptanceBaseline,
  PromptAcceptanceBaselinePartition,
  PromptAcceptanceBaselineRun,
  PromptAcceptanceDecision,
  PromptAcceptanceMetrics,
  PromptAcceptanceNoiseBandInput,
  PromptAcceptancePartitionSummary,
  PromptAcceptanceReason,
  PromptAcceptanceResult,
  PromptAcceptanceState,
  SelectStablePromptTasksInput,
  StablePromptTaskRejectionReason,
  StablePromptTaskSelectionResult,
} from './prompt-acceptance-policy.js';
export {
  PROMPT_REWARD_HACK_QUARANTINE_REASON,
  appendPromptAcceptanceDecision,
  calibratePromptAcceptanceBaseline,
  decidePromptAcceptance,
  promptAcceptanceNoiseBand,
  promptAcceptanceStateFromWal,
  selectStablePromptTasks,
  summarizePromptAcceptancePartition,
} from './prompt-acceptance-policy.js';
export type {
  PromptStructuralSmokeFailure,
  PromptStructuralSmokeReport,
  PromptStructuralSmokeReportInput,
} from './prompt-structural-smoke.js';
export {
  promptStructuralSmokeReport,
  renderPromptStructuralSmokeMarkdown,
} from './prompt-structural-smoke.js';
export type {
  BenchmarkAdapter,
  BenchmarkAdapterRegistry,
  BenchmarkInstanceRef,
  BenchmarkVerifierInput,
  BenchmarkVerifierOutput,
} from './benchmark-adapters.js';
export { resolveBenchmarkAdapter } from './benchmark-adapters.js';
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
export {
  MATRIX_CELL_SEPARATOR,
  isRetryableTaxonomy,
  matrixCellKey,
  planMatrixRetry,
  readMatrixPriorRecords,
  readTaskRunStoreRecords,
  type MatrixCellDecision,
  type MatrixRetryPlanOptions,
} from './matrix-resume.js';
export { defaultFinalScorer } from './scorer.js';
export { readResults, summarizeMatrix, writeResults, toComparisonTable, type MatrixSummary } from './results.js';
export type { TaskRunExport, WriteTaskRunExportOptions, WriteTaskRunExportResult } from './result-export.js';
export {
  exportContentHash,
  renderTaskRunMarkdown,
  taskRunExportFromProjection,
  writeTaskRunExport,
} from './result-export.js';
export { normalizeVerifier } from './verifier.js';
export { BENCHMARK_BASE_SYSTEM_PROMPT } from './system-prompts.js';
export type {
  HeadlessBackendContext,
  IsolatedCommandInput,
  IsolatedCommandResult,
  IsolatedEditFileInput,
  IsolatedEditFileResult,
  IsolatedGlobInput,
  IsolatedGlobResult,
  IsolatedGrepInput,
  IsolatedGrepResult,
  IsolatedReadFileInput,
  IsolatedReadFileResult,
  IsolatedToolExecutor,
  IsolatedWriteFileInput,
  IsolatedWriteFileResult,
  RealBackendIsolation,
} from './isolation.js';
export {
  ISOLATED_HEADLESS_TOOL_NAMES,
} from './isolation.js';
export {
  buildIsolatedBashTool,
  buildIsolatedEditTool,
  buildIsolatedGlobTool,
  buildIsolatedGrepTool,
  buildIsolatedHeadlessToolAvailability,
  buildIsolatedHeadlessTools,
  buildIsolatedReadTool,
  buildIsolatedWriteTool,
} from './tools.js';
