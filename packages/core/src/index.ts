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
  ToolOutputDeltaEvent,
  ToolOutputStream,
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
export {
  TOOL_OUTPUT_DELTA_MAX_CHARS,
  TOOL_OUTPUT_STREAMS,
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

// capabilities.ts
export type {
  ActionApprovalState,
  CapabilityActionApprovalSignal,
  CapabilityConfigurationSignal,
  CapabilityConfigurationState,
  CapabilityFeatureSignal,
  CapabilityId,
  CapabilityMemoryAcceptanceSignal,
  CapabilityPermissionRequirement,
  CapabilityReadinessState,
  CapabilityRuntimeProbeSignal,
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  DeriveCapabilityReadinessInput,
  FeatureEnablementState,
  MemoryAcceptanceState,
  OsPermissionId,
  OsPermissionSnapshot,
  OsPermissionState,
  PermissionSnapshot,
  RuntimeProbeState,
} from './capabilities.js';
export {
  ACTION_APPROVAL_STATES,
  CAPABILITY_CONFIGURATION_STATES,
  CAPABILITY_READINESS_STATES,
  FEATURE_ENABLEMENT_STATES,
  MEMORY_ACCEPTANCE_STATES,
  OS_PERMISSION_IDS,
  OS_PERMISSION_STATES,
  RUNTIME_PROBE_STATES,
  deriveCapabilityReadiness,
  isCapabilityReadinessState,
  isOsPermissionState,
  runtimeProbeFromBotReadiness,
} from './capabilities.js';

// health.ts
export type {
  HealthSignal,
  HealthSignalLayer,
  HealthSignalScope,
  HealthSignalSource,
  HealthSignalStatus,
  HealthSnapshot,
  HealthSnapshotSummary,
} from './health.js';
export {
  HEALTH_SIGNAL_LAYERS,
  HEALTH_SIGNAL_STATUSES,
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  healthSignalFromConnectionRuntime,
  isHealthSignalStatus,
} from './health.js';

// search.ts (PR-SEARCH-0 + PR-SEARCH-1.5)
export type {
  SearchError,
  SearchErrorReason,
  SearchNormalizeResult,
  SearchOk,
  SearchProviderKind,
  SearchRequest,
  SearchResult,
  SearchResultTarget,
  SearchSourceKind,
  SearchSourceSnapshot,
  WebFetchRequest,
} from './search.js';
export {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_DOMAIN_MAX_CHARS,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_URL_MAX_CHARS,
  normalizeSearchDomain,
  normalizeSearchDomainList,
  normalizeSearchLimit,
  normalizeSearchQuery,
  normalizeSearchUrl,
  rewriteSearchQueryForFreshness,
  searchDomainMatches,
  stripSearchTrackingParams,
} from './search.js';

// oauth-subscription.ts (PR-OAUTH-SUBSCRIPTION-0) — closed-state types
// + pure PKCE helpers for Claude subscription OAuth. No token-shaped
// fields exposed; main-process service owns tokens.
export type {
  AuthorizationUrlPayload,
  ClaudeAuthorizationConfig,
  OAuthSubscriptionProvider,
  OAuthSubscriptionRuntimeState,
  PastedAuthorization,
  QuotaSnapshot,
  QuotaWindow,
  Sha256Digest,
  SubscriptionAccountProfile,
  SubscriptionAccountState,
  SubscriptionActionFailureReason,
  SubscriptionActionResult,
} from './oauth-subscription.js';
export {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  QUOTA_CACHE_TTL_MS,
  TOKEN_REFRESH_SKEW_MS,
  base64urlEncode,
  buildClaudeAuthorizationUrl,
  constantTimeStringEqual,
  parsePastedAuthorization,
  pkceCodeChallenge,
} from './oauth-subscription.js';

// incognito.ts (PR-INCOGNITO-0) — cross-lane privacy contract; no IPC/storage/UI.
export type {
  WorkspacePrivacyContext,
  WorkspacePrivacyContextInvalidReason,
  WorkspacePrivacyContextResult,
} from './incognito.js';
export {
  WORKSPACE_PRIVACY_CONTEXT_INVALID_REASONS,
  defaultWorkspacePrivacyContext,
  isWorkspacePrivacyContext,
  validateWorkspacePrivacyContext,
} from './incognito.js';

// plan-reminders.ts (PR-PLAN-REMINDER-MVP-0)
export type {
  CreatePlanReminderInput,
  PlanReminder,
  PlanReminderBlockReason,
  PlanReminderNormalizeResult,
  PlanReminderRunRecord,
  PlanReminderRunStatus,
  PlanReminderSchedule,
  PlanReminderStatus,
  UpdatePlanReminderInput,
} from './plan-reminders.js';
export {
  PLAN_REMINDER_MAX_DELAY_MS,
  PLAN_REMINDER_NOTE_MAX_CHARS,
  PLAN_REMINDER_RUN_STATUSES,
  PLAN_REMINDER_STATUSES,
  PLAN_REMINDER_TITLE_MAX_CHARS,
  isPlanReminderDue,
  isPlanReminderStatus,
  nextPlanReminderStateAfterTrigger,
  normalizeCreatePlanReminderInput,
  normalizePlanReminderNote,
  normalizePlanReminderRunAt,
  normalizePlanReminderTitle,
  normalizeUpdatePlanReminderInput,
} from './plan-reminders.js';

// memory.ts (PR-MEMORY-1) — core contract; no IPC/storage/embedding/UI.
export type {
  DraftMemoryEntry,
  DurableMemoryEntry,
  MemoryBlockReason,
  MemoryCandidateSource,
  MemoryCapabilitySnapshot,
  MemoryEntry,
  MemoryMode,
  MemoryPersistenceState,
  MemoryResult,
  MemoryScope,
  MemorySource,
  MemorySourceResolution,
  MemoryUsePolicy,
  MemoryWriteRequest,
  MemoryWriteRequestContext,
} from './memory.js';
export {
  MEMORY_BLOCK_REASONS,
  MEMORY_CANDIDATE_SOURCES,
  MEMORY_CONTENT_MAX_CODE_POINTS,
  MEMORY_MODES,
  MEMORY_PERSISTENCE_STATES,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_USE_POLICIES,
  isMemoryCandidateSource,
  isMemoryMode,
  isMemoryPersistenceState,
  isMemoryScope,
  isMemorySource,
  isMemoryUsePolicy,
  normalizeMemoryContent,
  normalizeMemoryMode,
  normalizeMemoryPersistenceState,
  normalizeMemoryScope,
  normalizeMemorySource,
  validateMemoryWriteRequest,
} from './memory.js';

// voice.ts (PR-VOICE-0) — core contract; no IPC/storage/provider/runtime/UI.
export type {
  VoiceCapabilitySnapshot,
  VoiceCaptureCaps,
  VoiceCaptureRequest,
  VoiceInputMode,
  VoiceNormalizeResult,
  VoicePermissionStatus,
  VoicePrivacyFlags,
  VoiceReadinessReason,
  VoiceSttProvider,
  VoiceTranscriptPersistence,
  VoiceTranscriptRequest,
  VoiceTranscriptResult,
  VoiceTranscriptSource,
  VoiceTtsPolicy,
  VoiceTtsProvider,
  VoiceTtsRequest,
} from './voice.js';
export {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_CAPTURE_DURATION_MS,
  VOICE_MAX_CHANNELS,
  VOICE_MAX_SAMPLE_RATE,
  VOICE_MAX_TRANSCRIPT_CHARS,
  VOICE_TTS_MAX_TEXT_CHARS,
  defaultVoiceCapabilitySnapshot,
  defaultVoiceCaptureCaps,
  defaultVoicePrivacyFlags,
  normalizeVoiceInputMode,
  normalizeVoiceTranscriptText,
  normalizeVoiceTtsPolicy,
  validateVoiceCaptureRequest,
  validateVoiceTranscriptResult,
  validateVoiceTtsRequest,
} from './voice.js';

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
  normalizeConnectionBaseUrl,
  validateConnectionBaseUrl,
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

// session-name.ts (PR-UI-IPC-2)
export type { NormalizeSessionNameResult } from './session-name.js';
export {
  SESSION_NAME_MAX_CODE_POINTS,
  normalizeUserSessionName,
} from './session-name.js';

// provider-auth.ts (PR-AUTH-0)
export type {
  ProviderAuthAction,
  ProviderAuthActionAvailability,
  ProviderAuthContract,
  ProviderAuthContractInput,
  ProviderAuthSetupMode,
  ProviderAuthState,
} from './provider-auth.js';
export {
  PROVIDER_AUTH_ACTIONS,
  PROVIDER_AUTH_SETUP_MODES,
  PROVIDER_AUTH_STATES,
  deriveProviderAuthContract,
  deriveProviderAuthContractFromConnection,
  isProviderAuthState,
} from './provider-auth.js';

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
  BotReadinessState,
  NetworkProxySettings,
  NetworkSettings,
  ProxyProtocol,
  SettingsSection,
  SettingsTestResult,
  PersonalizationSettings,
  PersonalizationSettingsWarning,
  ThemePalette,
  ThemePreference,
  ToastPosition,
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
  BOT_READINESS_STATES,
  BOT_PROVIDERS,
  DEFAULT_PROXY_BYPASS_DOMAINS,
  THEME_PALETTES,
  TOAST_POSITIONS,
  createDefaultBotChannel,
  createDefaultSettings,
  isBotReadinessState,
  isThemePalette,
  isToastPosition,
  mergeSettings,
  normalizeSettings,
} from './settings.js';

// redaction.ts
export {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
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
