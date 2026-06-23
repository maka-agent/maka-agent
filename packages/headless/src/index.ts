// Public surface of @maka/headless. Deliberately curated — the workspace copy
// (sandbox.ts), the verification runner (evaluator.ts), and the backend wiring
// (backends.ts) are internals the runner owns, not part of the API. Minimal
// usage is `runExperiment(config, task, { storageRoot })`.
export type {
  HarborCellOutput,
  HarborCellRuntimeRefs,
  HarborCellTokenSummary,
  HarborCellToolSummary,
} from './cell-output.js';
export {
  HARBOR_CELL_OUTPUT_SCHEMA_VERSION,
  buildHarborCellOutput,
  summarizeCellTokens,
  summarizeCellTools,
  validateHarborCellOutput,
} from './cell-output.js';
export type {
  RunHarborCellEnv,
  RunHarborCellFromEnvOptions,
  RunHarborCellInput,
  RunHarborCellResult,
} from './harbor-cell.js';
export {
  buildAiSdkCellBackendRegistration,
  buildHarborCellAiSdkTools,
  createHarborCellLocalToolExecutor,
  HARBOR_CELL_OUTPUT_FILENAME,
  HARBOR_CELL_RUNTIME_EVENTS_FILENAME,
  runHarborCell,
  runHarborCellFromEnv,
} from './harbor-cell.js';
export type {
  HarborOfficialArtifactInput,
  ReadHarborOfficialArtifactInput,
} from './harbor-official-artifacts.js';
export {
  harborOfficialVerifierOutputFromArtifacts,
  readHarborOfficialVerifierOutput,
} from './harbor-official-artifacts.js';
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
  HarborProcessRunner,
  HarborRunRequest,
  HarborRunResult,
  HarborTaskPricing,
  HarborTaskRunnerOptions,
} from './harbor-task-runner.js';
export {
  buildHarborJobConfig,
  createHarborTaskRunner,
  HarborInfraError,
} from './harbor-task-runner.js';
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
export {
  createAiSdkMetaAgent,
  createAiSdkMetaAgentCompletion,
  extractJsonObject,
} from './meta-agent-completion.js';
export type { CreateAiSdkMetaAgentInput } from './meta-agent-completion.js';
export { runPromptOptimizationLoop } from './prompt-optimization-loop.js';
export type {
  PromptOptimizationLoopInput,
  PromptOptimizationLoopResult,
  PromptOptimizationLoopStopReason,
} from './prompt-optimization-loop.js';
export {
  buildRewardHackVerifierPatterns,
  discoverCachedHarborTasks,
  extractRewardHackVerifierPatterns,
  partitionPromptTasks,
  runPromptOptimizationRun,
} from './prompt-optimization-run.js';
export type {
  PromptOptimizationRunInput,
  PromptTaskPartition,
} from './prompt-optimization-run.js';
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
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskDiffSummary,
  HeavyTaskEngineeringCompleteness,
  HeavyTaskEngineeringLinks,
  HeavyTaskEngineeringRecord,
  HeavyTaskEngineeringRecordKind,
  HeavyTaskEngineeringRecordRecordedEvent,
  HeavyTaskEvidenceKind,
  HeavyTaskEvidenceRecordedEvent,
  HeavyTaskOutputSummary,
  HeavyTaskInventoryItem,
  HeavyTaskInventoryRecordedEvent,
  HeavyTaskInventoryState,
  HeavyTaskModeRecordedEvent,
  HeavyTaskArtifactEvidence,
  HeavyTaskCommandEvidence,
  HeavyTaskProgressSource,
  HeavyTaskSelfCheckRecordedEvent,
  HeavyTaskSelfCheckStatus,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskSourceGuardResult,
  HeavyTaskToolEvidenceName,
  HeavyTaskTodoItem,
  HeavyTaskTodoState,
  HeavyTaskTodosRecordedEvent,
  HeavyTaskTruncationRef,
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
  TaskRunArtifact,
  TaskRunArtifactAuthority,
  TaskRunArtifactAuthoritySource,
  TaskRunArtifactDescriptor,
  TaskRunArtifactKind,
  TaskRunArtifactRecordedEvent,
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
export {
  appendHeavyTaskPolicyToSystemPrompt,
  buildHeavyTaskSystemPromptPolicy,
  configWithHeavyTaskPolicy,
  FORBIDDEN_HEAVY_TASK_POLICY_TERMS,
  HEAVY_TASK_POLICY_VERSION,
  resolveHeavyTaskMode,
  type HeavyTaskModeSelection,
  type HeavyTaskModeTriggerSource,
} from './heavy-task-policy.js';
export type {
  HeavyTaskInventorySubmitInput,
  HeavyTaskProgressRecorder,
  HeavyTaskTodoUpdateInput,
} from './heavy-task-progress.js';
export {
  buildHeavyTaskProgressTools,
  createHeavyTaskProgressRecorder,
  heavyTaskInventoryItemSchema,
  heavyTaskInventorySubmitSchema,
  heavyTaskTodoItemSchema,
  heavyTaskTodoUpdateSchema,
  HEAVY_TASK_PROGRESS_TOOL_NAMES,
  renderHeavyTaskProgressForPrompt,
} from './heavy-task-progress.js';
export type {
  HeavyTaskPublicSelfCheckValidation,
  HeavyTaskSelfCheckRecorder,
  HeavyTaskSelfCheckSubmitInput,
} from './heavy-task-self-check.js';
export {
  buildHeavyTaskSelfCheckTools,
  createHeavyTaskSelfCheckRecorder,
  HEAVY_TASK_SELF_CHECK_TOOL_NAMES,
  heavyTaskArtifactEvidenceSchema,
  heavyTaskCommandEvidenceSchema,
  heavyTaskSelfCheckSubmitSchema,
  isAcceptedHeavyTaskSelfCheck,
  renderHeavyTaskSelfCheckForPrompt,
  validateHeavyTaskPublicSelfCheck,
} from './heavy-task-self-check.js';
export type {
  CheckRecordSubmitInput,
  EngineeringRecordSubmitInput,
  HeavyTaskEngineeringArtifactLink,
  HeavyTaskEngineeringEvent,
  HeavyTaskEngineeringRecorder,
  HeavyTaskEngineeringRecordResult,
} from './heavy-task-engineering.js';
export {
  buildHeavyTaskEngineeringTools,
  checkRecordSubmitSchema,
  compactHeavyTaskEngineeringState,
  createHeavyTaskEngineeringRecorder,
  DEFAULT_EXPORT_ENGINEERING_LIMIT,
  DEFAULT_PROMPT_ENGINEERING_LIMIT,
  engineeringRecordSubmitSchema,
  HEAVY_TASK_ENGINEERING_SCHEMA_VERSION,
  HEAVY_TASK_ENGINEERING_TOOL_NAMES,
  isPublicHeavyTaskEngineeringRecord,
  renderHeavyTaskEngineeringForPrompt,
  resolveHeavyTaskEngineeringRecordLinks,
} from './heavy-task-engineering.js';
export type {
  CompactTextEvidenceOptions,
  HeavyTaskCompactEvidenceInput,
  HeavyTaskEvidenceRecorder,
  HeavyTaskToolEvidenceInput,
} from './heavy-task-evidence.js';
export {
  compactArtifactEvidence,
  compactSelfCheckEvidence,
  compactTextEvidence,
  compactToolEvidence,
  createHeavyTaskEvidenceRecorder,
  DEFAULT_EXPORT_EVIDENCE_LIMIT,
  DEFAULT_PROMPT_EVIDENCE_LIMIT,
  DEFAULT_TEXT_EVIDENCE_LIMIT_CHARS,
  HEAVY_TASK_EVIDENCE_SCHEMA_VERSION,
  renderHeavyTaskEvidenceForPrompt,
} from './heavy-task-evidence.js';
export type {
  HeavyTaskCompletionInput,
  HeavyTaskCompletionStatus,
  HeavyTaskEvidenceChainItem,
  HeavyTaskEvidenceChainOutcome,
  HeavyTaskEvidenceChainSummary,
  HeavyTaskRuntimeCapKind,
  HeavyTaskSemanticStatus,
} from './heavy-task-finalization.js';
export {
  evaluateHeavyTaskCompletionStatus,
} from './heavy-task-finalization.js';
export type {
  HeadlessBackendContext,
  IsolatedCommandInput,
  IsolatedCommandResult,
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
