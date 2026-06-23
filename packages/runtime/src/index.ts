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

export { SessionManager, BackendRegistry, headerToSummary } from './session-manager.js';
export type {
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
  AiSdkBackendInput,
  AppendMessageFn,
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
} from './ai-sdk-backend.js';
export { PiAgentBackend, normalizePiAgentFrame } from './pi-agent-backend.js';
export type {
  PiAgentBackendInput,
  PiAgentFrame,
  PiAgentSendInput,
  PiAgentTransport,
} from './pi-agent-backend.js';

export { buildBuiltinTools } from './builtin-tools.js';
export type { MakaTool as BuiltinMakaTool, MakaToolContext as BuiltinMakaToolContext } from './builtin-tools.js';
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
  PromptSegmentInput,
} from './context-budget.js';
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
