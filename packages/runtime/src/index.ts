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
} from './ai-sdk-backend.js';

export { buildBuiltinTools } from './builtin-tools.js';
export type { MakaTool as BuiltinMakaTool, MakaToolContext as BuiltinMakaToolContext } from './builtin-tools.js';
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
  proxiedFetch,
  testBotChannel,
} from './bots/index.js';
export { setActiveProxy, resolveActiveProxy } from './network/active-proxy-state.js';
export type {
  BotBridge,
  BotIncomingMessage,
  BotPlatform,
  BotStatus,
  BotTestResult,
  SendCapable,
} from './bots/index.js';
