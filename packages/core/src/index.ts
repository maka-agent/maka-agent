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
  SessionChangedEvent,
  SessionChangedReason,
  SessionStatus,
  SessionBlockedReason,
  TurnRecord,
  TurnStateMessage,
  TurnStatus,
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
export {
  SESSION_STATUSES,
  SESSION_BLOCKED_REASONS,
  TURN_STATUSES,
  deriveTurnRecords,
  isSessionStatus,
  isSessionBlockedReason,
  isTurnStatus,
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

// artifacts.ts
export type {
  ArtifactBinaryReadFailureReason,
  ArtifactBinaryReadResult,
  ArtifactChangedEvent,
  ArtifactChangedReason,
  ArtifactKind,
  ArtifactReadFailureReason,
  ArtifactSaveFailureReason,
  ArtifactSaveResult,
  ArtifactRecord,
  ArtifactSource,
  ArtifactStatus,
  ArtifactTextReadResult,
} from './artifacts.js';

// runtime-inputs.ts
export type {
  BranchFromTurnInput,
  CreateSessionInput,
  RegenerateTurnInput,
  RetryTurnInput,
  UserMessageInput,
  SessionListFilter,
} from './runtime-inputs.js';

// visual-smoke.ts
export type {
  VisualSmokeLiveTool,
  VisualSmokeScenario,
  VisualSmokeState,
} from './visual-smoke.js';

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
  ModelDiscoveryResult,
  ModelDiscoverySource,
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

// connection-readiness.ts (PR110a)
export type {
  ChatConfigurationReason,
  IsConnectionReadyInput,
  IsConnectionReadyResult,
} from './connection-readiness.js';
export {
  isConnectionReady,
  isRealConnection,
} from './connection-readiness.js';

// onboarding.ts (PR110a)
export type {
  DeriveOnboardingStateInput,
  OnboardingMilestone,
  OnboardingMilestoneId,
  OnboardingState,
} from './onboarding.js';
export {
  ONBOARDING_MILESTONE_IDS,
  deriveOnboardingState,
  isOnboardingMilestone,
  sanitizeOnboardingMilestones,
} from './onboarding.js';

// model-catalog.ts
export type {
  BuildModelCatalogInput,
  KnownModelCapabilities,
  ModelCapabilitySource,
  ModelCatalogAvailability,
  ModelCatalogEntry,
  ModelCatalogPricing,
  ModelUnavailableReason,
} from './model-catalog.js';
export {
  buildModelCatalogEntries,
  validateChatDefaultModel,
} from './model-catalog.js';

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
