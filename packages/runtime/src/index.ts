/**
 * @maka/runtime — barrel export.
 *
 * Surface in V0.1 (Sprint 0):
 *  - SessionManager    — top-level Runtime entry point (createSession, sendMessage, ...)
 *  - BackendRegistry   — factory dispatch by BackendKind
 *  - PermissionEngine  — wraps core's pure preToolUse() with state + parking
 *  - AiSdkBackend      — AgentBackend over Vercel AI SDK providers
 *  - Materializer      — JSONL → ChatItem[] for UI render
 *  - AsyncEventQueue   — internal helper, also useful for FakeBackend
 *
 * Not yet implemented:
 *  - FakeBackend       — text-only stub for UI development
 */

export { SessionManager, BackendRegistry, headerToSummary, changesBackendConfig } from './session-manager.js';
export type {
  CompactSessionInput,
  SessionManagerDeps,
  SessionStore,
  BackendFactory,
  BackendFactoryContext,
  SpawnChildAgentInput,
  SpawnChildAgentResult,
  AgentListItem,
  AgentListResult,
  AgentOutputInput,
  AgentOutputResult,
} from './session-manager.js';

export { PermissionEngine, createDefaultPermissionEngineDeps } from './permission-engine.js';
export type { EvaluateResult, EvaluateInput, PermissionEngineDeps } from './permission-engine.js';

export { AiSdkBackend } from './ai-sdk-backend.js';
export type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
  AiSdkBackendInput,
  AppendMessageFn,
  AttachmentByteReader,
  MakaTool,
  MakaToolContext,
  ModelFactory,
  ModelFactoryInput,
  RunTraceEvent,
  RunTraceRecorder,
  HistoryCompactLoader,
  HistoryCompactLoadInput,
  HistoryCompactLoadResult,
  HistoryCompactWriter,
  HistoryCompactWriteInput,
  HistoryCompactWriteResult,
  SynthesisCacheLoader,
  SynthesisCacheLoadInput,
  SynthesisCacheLoadResult,
  SynthesisCacheWriter,
  SynthesisCacheWriteInput,
  SynthesisCacheWriteResult,
  ToolResultArchiveRecorder,
  ToolResultArchiveRecorderInput,
  SemanticCompactBlockRecorder,
} from './ai-sdk-backend.js';
export { PiAgentBackend, normalizePiAgentFrame } from './pi-agent-backend.js';
export type {
  PiAgentBackendInput,
  PiAgentFrame,
  PiAgentSendInput,
  PiAgentTransport,
} from './pi-agent-backend.js';

export { buildBuiltinTools } from './builtin-tools.js';
export type {
  BuildBuiltinToolsOptions,
  MakaTool as BuiltinMakaTool,
  MakaToolContext as BuiltinMakaToolContext,
} from './builtin-tools.js';
export {
  buildBackgroundBashTool,
  buildForegroundBashTool,
  buildLocalForegroundBashTool,
  buildStopBackgroundTaskTool,
  shapeTerminalResult,
} from './shell-tools.js';
export type {
  BuildForegroundBashToolOptions,
  ForegroundBashExecuteInput,
  ForegroundBashResult,
  ShellRunToolController,
} from './shell-tools.js';
export {
  DEFAULT_BASH_YIELD_TIME_MS,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_MAX_LIVE_SHELL_RUNS,
  DEFAULT_SHELL_RUN_FLUSH_BYTES,
  DEFAULT_SHELL_RUN_FLUSH_INTERVAL_MS,
  MAX_BASH_YIELD_TIME_MS,
  MAX_SHELL_RUN_TIMEOUT_MS,
  MIN_BASH_YIELD_TIME_MS,
  SHELL_RUN_CONTEXT_SUMMARY_LIMIT,
  SHELL_RUN_RESOURCE_PREFIX,
  ShellRunProcessManager,
  isShellRunResourceRef,
  shellRunResourceRef,
} from './shell-run-manager.js';
export type {
  ShellRunBashInput,
  ShellRunProcessManagerInput,
} from './shell-run-manager.js';
export {
  LOCAL_WORKSPACE_EXECUTOR_FACTS,
  LocalWorkspaceExecutor,
  createLocalWorkspaceExecutor,
} from './workspace-executor.js';
export type {
  WorkspaceExecInput,
  WorkspaceExecResult,
  WorkspaceBashExecutor,
  WorkspaceCommandExecutor,
  WorkspaceEditExecutor,
  WorkspaceExistingPathResolver,
  WorkspaceExecutor,
  WorkspaceExecutorFacts,
  WorkspaceExecutorFactsProvider,
  WorkspaceGlobExecutor,
  WorkspaceGlobFilesExecutor,
  WorkspaceGlobInput,
  WorkspaceGlobResult,
  WorkspaceGrepExecutor,
  WorkspaceGrepFilesExecutor,
  WorkspaceGrepInput,
  WorkspaceGrepResult,
  WorkspaceIsolationKind,
  WorkspaceNetworkMode,
  WorkspaceReadExecutor,
  WorkspaceReadFileInput,
  WorkspaceReadFileExecutor,
  WorkspaceReadFileResult,
  WorkspaceResolvePathInput,
  WorkspaceResolvePathResult,
  WorkspaceSecretMode,
  WorkspaceSearchExecutor,
  WorkspaceWritablePathResolver,
  WorkspaceWriteExecutor,
  WorkspaceWriteBackMode,
  WorkspaceWriteFileInput,
  WorkspaceWriteFileExecutor,
  WorkspaceWriteFileResult,
  WorkspaceWriteLockKeyInput,
  WorkspaceWriteLockProvider,
  WorkspaceWriteLockKeyResult,
} from './workspace-executor.js';
export { computeEditedSource, COMPUTE_EDITED_SOURCE_FN_SOURCE } from './edit-replace.js';
export type { EditMatch, EditMatchStrategy } from './edit-replace.js';
export { truncateToolOutput } from './tool-output.js';
export type { TruncateToolOutputOptions, TruncatedToolOutput } from './tool-output.js';
export { runShellWithBoundedTail, BASH_MAX_RETAINED_CHARS } from './shell-exec.js';
export type { BoundedShellOptions, BoundedShellResult } from './shell-exec.js';
export {
  AGENT_CONTEXT_ISOLATED,
  AGENT_INVOCATION_FOREGROUND,
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_AGENT_PROFILES,
  IMPLEMENTATION_AGENT_DEFINITION,
  IMPLEMENTATION_AGENT_ID,
  IMPLEMENTATION_AGENT_PROFILE,
  LOCAL_READ_AGENT_DEFINITION,
  LOCAL_READ_AGENT_ID,
  LOCAL_READ_AGENT_PROFILE,
  WEB_RESEARCH_AGENT_DEFINITION,
  WEB_RESEARCH_AGENT_ID,
  WEB_RESEARCH_AGENT_PROFILE,
  assertAgentDefinitionRunnable,
  buildToolsForAgentDefinition,
  evaluateAgentDefinitionAvailability,
  evaluateAgentDefinitionToolAccess,
  getBuiltinAgentDefinition,
  getBuiltinAgentDefinitionByProfile,
  listBuiltinAgentDefinitions,
  requireBuiltinAgentDefinition,
  requireBuiltinAgentDefinitionByProfile,
} from './agent-catalog.js';
export type {
  AgentCapability,
  AgentDefinition,
  AgentDefinitionAvailability,
  AgentDefinitionListItem,
  AgentDefinitionListOptions,
  AgentContextMode,
  AgentInvocationMode,
  AgentProfile,
  AgentProfileContract,
  AgentWorkspaceMode,
  AgentWriteBackMode,
} from './agent-catalog.js';
export {
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  AGENT_SPAWN_TOOL_NAME,
  AGENT_TOOL_GROUP_ID,
  AGENT_TOOL_NAMES,
  CHILD_AGENT_TOOL_NAMES,
  buildChildAgentTools,
  buildSubagentListTool,
  buildSubagentOutputTool,
  buildSubagentProjectionTools,
  buildSubagentSpawnTool,
  buildSubagentToolGroup,
} from './subagent-tools.js';
export {
  LEGACY_TASK_CREATE_TOOL_NAME,
  LEGACY_TASK_UPDATE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  buildTaskLedgerTools,
  isTaskLedgerToolsEnabled,
} from './task-ledger-tools.js';
export {
  deriveToolArtifactCandidates,
  extractStdoutRedirectPath,
  recordToolArtifactsSafely,
} from './tool-artifacts.js';
export type {
  ToolArtifactCandidate,
  ToolArtifactDerivationInput,
  ToolArtifactRecorder,
  ToolArtifactRecorderInput,
} from './tool-artifacts.js';
export { createToolOutputDeltaEmitter } from './tool-output-delta.js';
export type { ToolOutputDeltaEmitter, ToolOutputDeltaEmitterInput } from './tool-output-delta.js';
export {
  DEFAULT_STREAM_CONNECT_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  StreamWatchdog,
  formatStreamWatchdogError,
} from './stream-watchdog.js';
export type { StreamWatchdogInput, StreamWatchdogPhase, StreamWatchdogTimeout } from './stream-watchdog.js';

export { getAIModel, buildProviderOptions } from './model-factory.js';
export type { ModelFactoryInput as GetAIModelInput } from './model-factory.js';
export {
  extractOAuthSubscriptionAccessToken,
  isOAuthSubscriptionProvider,
  parseOAuthSubscriptionTokens,
  resolveOAuthSubscriptionAccessToken,
  resolveOAuthSubscriptionTokens,
  serializeOAuthSubscriptionTokens,
} from './subscription-credentials.js';
export type {
  OAuthSubscriptionCredentialStore,
  OAuthSubscriptionProvider,
  OAuthSubscriptionTokens,
  ResolveOAuthSubscriptionAccessTokenInput,
} from './subscription-credentials.js';
export { buildSubscriptionModelFetch } from './subscription-model-fetch.js';
export type { SubscriptionModelFetchInput } from './subscription-model-fetch.js';
export {
  compactionDecisionDiagnosticPatch,
  compactionDecisionToDiagnostic,
  historyCompactBlockToCompactionBoundary,
} from './compaction-boundary.js';
export type {
  CompactionArchiveRef,
  CompactionBoundary,
  CompactionBoundaryKind,
  CompactionCoverage,
  CompactionDecision,
  CompactionDecisionKind,
  CompactionSourceKind,
  CompactionStage,
} from './compaction-boundary.js';
export { buildDefaultContextBudgetPolicy, buildManualCompactLookupPolicy } from './context-budget-policy.js';
export type {
  BuildDefaultContextBudgetPolicyOptions,
  BuildManualCompactLookupPolicyOptions,
} from './context-budget-policy.js';
export {
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
} from './history-compact-artifacts.js';
export type {
  HistoryCompactArtifactStore,
  PersistHistoryCompactBlocksDeps,
} from './history-compact-artifacts.js';
export { buildLlmHistorySummarizer } from './history-compact-summarizer.js';
export type {
  BuildLlmHistorySummarizerOptions,
} from './history-compact-summarizer.js';
export {
  ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventHistoryCompact,
  applyRuntimeEventContextBudget,
  buildHistoryCompactBlockFromSummary,
  buildSynthesisCacheBlocksFromHydratedArchives,
  buildPromptSegmentEstimates,
  collectStaleToolResultArchiveCandidates,
  deriveSynthesisCoverageFromSourceRefs,
  estimateModelMessagesChars,
  estimateRuntimeEventsTokens,
  estimateTokens,
  isArchivedToolResultPlaceholder,
  rawEvidenceRequestReason,
  deserializeToolResultArchive,
  historyCompactBlockToRuntimeEvent,
  renderHistoryCompactBlock,
  retrieveArchivedToolResultsForReplay,
  retrieveRuntimeEventHistoryAround,
  searchRuntimeEventHistory,
  serializeToolResultForArchive,
  stableSynthesisBlockId,
  validateHistoryCompactBlockShape,
  validateSynthesisCacheBlockShape,
} from './context-budget.js';
export type {
  ArchivedToolResultReason,
  BudgetedRuntimeContext,
  ContextBudgetPolicy,
  ArchiveRetrievalMode,
  ArchiveRetrievalPolicy,
  ArchiveRetrievalResult,
  HistoryCompactBlock,
  HistoryCompactCoverage,
  HistoryCompactPolicy,
  HistoryCompactReplayResult,
  HistoryCompactSourceArchiveRef,
  HistoryRewriteGatePolicy,
  RuntimeEventHistoryAroundResult,
  RuntimeEventHistorySearchHit,
  RuntimeEventHistorySearchPolicy,
  StaleToolResultPrunePolicy,
  StaleToolResultArchiveCandidate,
  SynthesisCacheBlock,
  SynthesisCacheCoverage,
  SynthesisCachePolicy,
  SynthesisSourceRef,
  ToolResultArchiveReader,
  ToolResultArchiveReaderInput,
  ToolResultArchiveReadFailureReason,
  ToolResultArchiveReadResult,
  ToolResultArchiveRef,
  ArchivedToolResultPlaceholder,
  ActiveArchivedToolResultPlaceholder,
  PromptSegmentInput,
} from './context-budget.js';
export {
  activeFullCompactBlockToCompactionBoundary,
  activeFullCompactCoverageFromEntries,
  activeFullCompactDecisionDiagnosticPatch,
  activeFullCompactBlockToModelMessage,
  buildDeterministicActiveFullCompactSummary,
  buildDeterministicProcessStateActiveFullCompactSummary,
  buildActiveFullCompactBlockFromSummary,
  buildActiveFullCompactSourceIndex,
  estimateActiveFullCompactTokens,
  renderActiveFullCompactBlock,
  rewriteActiveFullCompactInMessages,
  selectActiveFullCompactCoveredSpan,
  validateActiveFullCompactBlockForSourceIndex,
  validateActiveFullCompactBlockShape,
} from './active-full-compact.js';
export type {
  ActiveFullCompactArchiveRef,
  ActiveFullCompactBlock,
  ActiveFullCompactContentKind,
  ActiveFullCompactCoverage,
  ActiveFullCompactFailOpenReason,
  ActiveFullCompactPolicy,
  ActiveFullCompactProviderRole,
  ActiveFullCompactRewriteDecision,
  ActiveFullCompactRewriteInput,
  ActiveFullCompactRewriteResult,
  ActiveFullCompactSelection,
  ActiveFullCompactSourceEntry,
  ActiveFullCompactSourceIndex,
  ActiveFullCompactSourceIndexInput,
  ActiveFullCompactSourceRef,
  ActiveFullCompactSummary,
  ActiveFullCompactValidationResult,
  BuildActiveFullCompactBlockInput,
} from './active-full-compact.js';
export {
  renderSemanticCompactBlock,
  rewriteSemanticCompactInMessages,
  semanticCompactBlockToModelMessage,
} from './semantic-compact.js';
export type {
  SemanticCompactBlock,
  SemanticCompactDecision,
  SemanticCompactPolicy,
  SemanticCompactRewriteInput,
  SemanticCompactRewriteResult,
  SemanticCompactStateCard,
  SemanticCompactSummarizer,
  SemanticCompactSummaryRequest,
} from './semantic-compact.js';
export { testConnection } from './test-connection.js';
export { fetchProviderModels } from './model-fetcher.js';

export {
  materializeSession,
  applyAppendedMessage,
  setToolStatus,
} from './materializer.js';
export type { ToolActivityItem, ChatItem, SessionViewModel } from './materializer.js';

export { AsyncEventQueue } from './async-queue.js';
export { FakeBackend } from './fake-backend.js';

export {
  BUILTIN_PRICING,
  buildPricingLookup,
  computeCost,
  getBuiltinPricing,
  recordLlmCall,
  recordToolInvocation,
} from './telemetry/index.js';
export type {
  LlmRecorderDeps,
  PersistedLlmCallRecord,
  PersistedToolInvocationRecord,
  TelemetryRepoLite,
  ToolRecorderDeps,
} from './telemetry/index.js';

export {
  BaseBotAdapter,
  BotRegistry,
  botReadinessFromSettings,
  botSettingsRequireRestart,
  getWechatBridgeQrCode,
  mapWechatIlinkMessage,
  normalizeWechatBridgeUrl,
  normalizeWechatIlinkBaseUrl,
  proxiedFetch,
  testBotChannel,
  testWechatBridge,
  testWechatIlinkCredentials,
  WechatBridge,
} from './bots/index.js';
export { setActiveProxy, resolveActiveProxy } from './network/active-proxy-state.js';
export type {
  BotBridge,
  BotIncomingMessage,
  BotPlatform,
  BotStatus,
  BotTestResult,
  WechatBridgeQrCodeResult,
  SendCapable,
} from './bots/index.js';

// ───────────────────────────────────────────────────────────────────────────
// Runtime v2 seam (Phase 1–4 increments).
//
// Subpath imports (e.g. `@maka/runtime/runtime-runner`) remain canonical;
// the barrel re-exports below are for convenience. `InvocationContext` is the
// canonical runner/flow spine exported from `./invocation-context.js` and used
// by the formal `AgentFlow` seam.
// ───────────────────────────────────────────────────────────────────────────

// invocation-context.ts — runner spine types + providers.
export type {
  InvocationContext,
  InvocationRequest,
  InvocationSource,
  InvocationLineage,
  InvocationProviders,
  InvocationResult,
  InvocationResultStatus,
  InvocationFailure,
} from './invocation-context.js';
export {
  INVOCATION_SOURCES,
  isInvocationSource,
  createDefaultInvocationProviders,
} from './invocation-context.js';

// runtime-runner.ts — RuntimeRunner shell + gate.
export { RuntimeRunner, runtimeGateFromCallback } from './runtime-runner.js';
export type {
  RuntimeGate,
  RuntimeGateDecision,
  AgentFlowLike,
  RuntimeRunnerDeps,
} from './runtime-runner.js';

// runtime-event-adapters.ts — legacy StoredMessage ↔ RuntimeEvent bridge.
export {
  storedMessageToRuntimeEvent,
  storedMessageToRuntimeEvents,
  runtimeEventToStoredMessageDraft,
  createRuntimeEventId,
} from './runtime-event-adapters.js';
export type {
  StoredMessageEventContext,
  RuntimeEventToDraftOptions,
} from './runtime-event-adapters.js';

// runtime-event-read-model.ts — side-by-side RuntimeEvent read projection.
export {
  projectRuntimeEventsToStoredMessages,
  projectRuntimeEventsToStoredMessagesWithArchiveStatuses,
  applyArchivedToolResultReadModelStatuses,
  compareRuntimeReadModelMessages,
  classifyRuntimeEventTerminalFact,
} from './runtime-event-read-model.js';
export type {
  ArchivedToolResultReadModelStatus,
  ProjectRuntimeEventsToStoredMessagesOptions,
  RuntimeEventReadModelDiagnostic,
  RuntimeEventReadModelDiagnosticCode,
  RuntimeEventReadModelProjection,
  RuntimeReadModelCompatibilityResult,
  RuntimeEventTerminalFact,
  RuntimeEventTerminalFactResult,
} from './runtime-event-read-model.js';
export {
  RuntimeReadModel,
  RuntimeReadModelError,
} from './runtime-read-model.js';
export type {
  RuntimeReadModelDeps,
  RuntimeReadModelProjectionCache,
  RuntimeReadModelSessionView,
} from './runtime-read-model.js';
export { RuntimeKernel } from './runtime-kernel.js';
export type {
  RuntimeKernelDeps,
  RuntimeKernelLike,
} from './runtime-kernel.js';
export { AgentRun } from './agent-run.js';
export type {
  AgentRunActiveSession,
  AgentRunLineage,
} from './agent-run.js';

// agent-run-inspect.ts — internal AgentRun/RuntimeEvent source-health view.
export {
  inspectAgentRunReadModel,
  inspectSessionRunReadModels,
} from './agent-run-inspect.js';
export type {
  AgentRunInspectDiagnostic,
  AgentRunInspectDiagnosticCode,
  AgentRunInspectModel,
  AgentRunInspectProjectionSummary,
  AgentRunInspectSourceHealth,
  InspectAgentRunOptions,
} from './agent-run-inspect.js';

// model-history.ts — policy-driven model-history projection.
export { buildModelHistoryFromRuntimeEvents } from './model-history.js';
export type {
  ModelHistoryEntry,
  BuildModelHistoryOptions,
} from './model-history.js';

// agent-flow.ts — formal Flow seam.
export type {
  AgentFlow,
  AgentFlowControl,
  FlowInput,
  RunnableAgentFlow,
} from './agent-flow.js';
export { flowSupportsControl } from './agent-flow.js';

// ai-sdk-flow.ts — default AgentFlow implementation over AiSdkBackend.
export {
  AiSdkFlow,
  mapSessionEventToRuntimeEvent,
  mapCompleteStopReason,
  createSessionEventMapMemory,
} from './ai-sdk-flow.js';
export type {
  AiSdkFlowInput,
  CompleteStopReason,
  SessionEventMapMemory,
} from './ai-sdk-flow.js';

// tool-availability.ts — unified tool-availability runtime (catalog, the
// `load_tools` connector, same-turn activation, gating, diagnostics).
export { ToolAvailabilityRuntime, LOAD_TOOLS_NAME } from './tool-availability.js';
export type {
  ToolAvailabilityConfig,
  ToolGroup,
  ToolAvailabilityPlan,
  StepLike,
  RuntimeEventLike,
} from './tool-availability.js';

// ───────────────────────────────────────────────────────────────────────────
// System-prompt fragments (shared by the desktop app and the CLI/TUI).
// Read-only, stateless builders for project instructions, personalization, git
// context, and the per-turn environment tail. The stateful LocalMemoryService
// stays with the desktop app and is injected as a fragment by each caller.
// ───────────────────────────────────────────────────────────────────────────
export {
  buildWorkspaceInstructionsPromptFragment,
  getWorkspaceInstructionsState,
  isPathInside,
  WORKSPACE_INSTRUCTION_FILES,
  MAX_WORKSPACE_INSTRUCTION_FILE_CHARS,
  MAX_WORKSPACE_INSTRUCTIONS_PROMPT_CHARS,
} from './system-prompt/workspace-instructions.js';
export type {
  WorkspaceInstructionFileStatus,
  WorkspaceInstructionFileState,
  WorkspaceInstructionsState,
  PathInsideApi,
} from './system-prompt/workspace-instructions.js';
export {
  buildPersonalizationPromptFragment,
  sanitizeDisplayName,
  sanitizeAssistantTone,
  collectPersonalizationWarnings,
} from './system-prompt/personalization-prompt.js';
export type { PersonalizationPromptFragment } from './system-prompt/personalization-prompt.js';
export {
  resolveProjectGitInfo,
  resolveProjectRoot,
} from './system-prompt/project-context.js';
export type { ProjectGitInfo } from './system-prompt/project-context.js';
export { buildSessionEnvironmentPromptFragment } from './system-prompt/session-environment-prompt.js';
export type { SessionEnvironmentPromptInput } from './system-prompt/session-environment-prompt.js';
