/**
 * @maka/core — barrel export.
 *
 * Convention: subpath imports (e.g. `@maka/core/permission`) are
 * the canonical form. The barrel below re-exports everything for convenience
 * but downstream code should prefer subpaths to keep the dependency graph
 * explicit.
 */

// events.ts
export type {
  SessionEvent,
  SessionCommand,
  TextDeltaEvent,
  TextCompleteEvent,
  ThinkingDeltaEvent,
  ThinkingCompleteEvent,
  ToolStartEvent,
  ToolProgressEvent,
  ToolResultEvent,
  ToolResultContent,
  PermissionRequestEvent,
  PermissionDecisionAckEvent,
  PlanSubmittedEvent,
  PlanStep,
  TokenUsageEvent,
  ErrorEvent,
  CompleteEvent,
  AbortEvent,
  StorageRef,
  AttachmentRef,
} from './events.js';

// session.ts
export type {
  SessionHeader,
  SessionSummary,
  BackendKind,
  StoredMessage,
  UserMessage,
  AssistantMessage,
  ToolCallMessage,
  ToolResultMessage,
  PermissionDecisionMessage,
  TokenUsageMessage,
  SystemNoteMessage,
} from './session.js';

// permission.ts
export type {
  PermissionMode,
  ToolCategory,
  PolicyDecision,
  PreToolUseInput,
  PreToolUseResult,
  PermissionRequest,
  PermissionResponse,
} from './permission.js';
export {
  PERMISSION_MODES,
  PERMISSION_POLICY,
  BUILTIN_TOOL_CATEGORY,
  SAFE_SHELL_PREFIXES,
  PRIVILEGED_SHELL_PREFIXES,
  FS_DESTRUCTIVE_PATTERNS,
  DESTRUCTIVE_GIT_PATTERNS,
  categorizeBash,
  isPermissionMode,
  preToolUse,
} from './permission.js';

// connections.ts
export type {
  ConnectionEvent,
  ConnectionCommand,
  ConnectionCredentialRequestEvent,
  ConnectionTestResultEvent,
  ConnectionListChangedEvent,
} from './connections.js';

// workspace.ts
export type { WorkspaceConfig } from './workspace.js';

// runtime-inputs.ts
export type { CreateSessionInput, UserMessageInput, SessionListFilter } from './runtime-inputs.js';

// backend-types.ts
export type { BackendSendInput, PermissionDecision } from './backend-types.js';

// llm-connections.ts
export type {
  ConnectionAuth,
  ConnectionLastTestStatus,
  ConnectionTestResult,
  ConnectionTestErrorClass,
  CreateConnectionInput,
  LlmConnection,
  ModelInfo,
  ProviderCategory,
  ProviderDefaults,
  ProviderType,
  UpdateConnectionInput,
} from './llm-connections.js';
export {
  PROVIDER_DEFAULTS,
  CATALOG_PROVIDER_TYPES,
  READY_PROVIDER_TYPES,
  backendKindOf,
  effectiveBaseUrl,
  migrateConnectionV1ToV2,
  validateSlug,
} from './llm-connections.js';

// settings.ts
export type {
  AppearanceSettings,
  AppSettings,
  BotChannelSettings,
  BotChatSettings,
  BotProvider,
  NetworkProxySettings,
  NetworkSettings,
  ProxyProtocol,
  SettingsSection,
  SettingsTestResult,
  PersonalizationSettings,
  PersonalizationSettingsWarning,
  ThemePreference,
  UiDensity,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
  UpdateAppSettingsWarnings,
  UsageRange,
  UsageRequestLog,
  UsageSettings,
  UsageStats,
  UsageStatus,
  UsageSummary,
  UsageTab,
} from './settings.js';
export {
  BOT_PROVIDERS,
  DEFAULT_PROXY_BYPASS_DOMAINS,
  createDefaultBotChannel,
  createDefaultSettings,
  mergeSettings,
  normalizeSettings,
} from './settings.js';

// redaction.ts
export {
  generalizedErrorMessage,
  redactSecrets,
} from './redaction.js';

// usage-stats/types.ts
export type {
  LlmCallRecord,
  PricingConfig,
  TimeRange,
  ToolInvocationRecord,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from './usage-stats/types.js';
