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

// session-event-health.ts
export type {
  SessionEventStreamSnapshot,
  SessionEventStreamStatus,
} from './session-event-health.js';
export {
  SESSION_EVENT_STREAM_REFRESH_COOLDOWN_MS,
  SESSION_EVENT_STREAM_STALE_AFTER_MS,
  SESSION_EVENT_STREAM_STATUSES,
  deriveSessionEventStreamStatus,
  isSessionEventStreamStatus,
  newestSessionStreamObservation,
  sessionExpectsEventStream,
  shouldRefreshStaleSessionEventStream,
} from './session-event-health.js';

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

// permission-request-health.ts
export type {
  PermissionRequestHealth,
  PermissionRequestHealthStatus,
} from './permission-request-health.js';
export {
  PERMISSION_REQUEST_EXPIRED_AFTER_MS,
  PERMISSION_REQUEST_HEALTH_STATUSES,
  PERMISSION_REQUEST_STALE_AFTER_MS,
  derivePermissionRequestHealth,
  formatPermissionRequestWait,
  isPermissionRequestHealthStatus,
} from './permission-request-health.js';

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
  PlanReminderBotDeliveryTarget,
  PlanReminderCronSchedule,
  PlanReminderDeliveryTarget,
  PlanReminderLocalDeliveryTarget,
  PlanReminderNormalizeResult,
  PlanReminderOnceSchedule,
  PlanReminderRecurrence,
  PlanReminderRecurringFrequency,
  PlanReminderRecurringSchedule,
  PlanReminderRunRecord,
  PlanReminderRunStatus,
  PlanReminderSchedule,
  PlanReminderStatus,
  UpdatePlanReminderInput,
} from './plan-reminders.js';
export {
  PLAN_REMINDER_CRON_EXPRESSION_MAX_CHARS,
  PLAN_REMINDER_DELIVERY_CHAT_ID_MAX_CHARS,
  PLAN_REMINDER_MAX_DELAY_MS,
  PLAN_REMINDER_NOTE_MAX_CHARS,
  PLAN_REMINDER_RECURRENCES,
  PLAN_REMINDER_RUN_STATUSES,
  PLAN_REMINDER_STATUSES,
  PLAN_REMINDER_TITLE_MAX_CHARS,
  createPlanReminderSchedule,
  formatPlanReminderDeliveryMessage,
  formatPlanReminderDeliveryTarget,
  isPlanReminderDue,
  isPlanReminderStatus,
  nextPlanReminderRunAtAfter,
  nextPlanReminderStateAfterTrigger,
  normalizeCreatePlanReminderInput,
  normalizePlanReminderCronExpression,
  normalizePlanReminderDeliveryChatId,
  normalizePlanReminderDeliveryTarget,
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

// local-memory.ts — transparent user-visible MEMORY.md MVP.
export type {
  LocalMemoryEntryPreview,
  LocalMemoryParseResult,
  LocalMemorySettings,
  LocalMemoryState,
} from './local-memory.js';
export {
  LOCAL_MEMORY_MAX_BYTES,
  defaultLocalMemoryMarkdown,
  defaultLocalMemorySettings,
  normalizeLocalMemorySettings,
  parseLocalMemoryMarkdown,
} from './local-memory.js';

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
  OpenGatewaySettings,
  OpenGatewayRuntimeStatus,
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
  BOT_DELIVERY_PROVIDERS,
  BOT_PROVIDERS,
  DEFAULT_PROXY_BYPASS_DOMAINS,
  MAX_ALLOWED_USER_IDS,
  THEME_PALETTES,
  TOAST_POSITIONS,
  createDefaultBotChannel,
  createDefaultSettings,
  isBotDeliveryProvider,
  isBotReadinessState,
  isThemePalette,
  isToastPosition,
  mergeSettings,
  normalizeAllowedUserIds,
  normalizeSettings,
  parseAllowedUserIdsFromText,
} from './settings.js';
export type { BotDeliveryProvider } from './settings.js';

// bot-platform-hints.ts
export type {
  BotFormattingProfile,
  BotPlatformPromptHint,
} from './bot-platform-hints.js';
export {
  botPlatformFromSessionLabels,
  buildBotPlatformPromptFragment,
  getBotPlatformPromptHint,
} from './bot-platform-hints.js';

// bot-events.ts
export type {
  BotAttachmentRef,
  BotMessageEvent,
  BotPlatform,
} from './bot-events.js';
export {
  BOT_PLAINTEXT_RESET_COMMANDS,
  botConversationKey,
  botDisplayLabel,
  formatBotMessageForSession,
  isPlaintextResetCommand,
} from './bot-events.js';

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

export {
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
  resetRelativeTimeFormatters,
} from './relative-time.js';

// daily-review.ts (PR-DAILY-REVIEW-MVP-0)
export type {
  DailyReviewSessionRow,
  DailyReviewSummary,
  DailyReviewTopEntry,
  DailyReviewTotals,
  DayRangeMs,
} from './daily-review.js';
export {
  DAILY_REVIEW_LIST_LIMIT,
  buildDailyReviewSummary,
  dailyUsageQuery,
  localDayBoundsAt,
  localDayBoundsForInstant,
  pickDailyReviewSessions,
  pickDailyReviewTopEntries,
} from './daily-review.js';

// web-search.ts (PR-WEB-SEARCH-TAVILY-0) — explicit user-triggered
// web search contract. Renderer never sees the API key.
export type {
  WebSearchErrorReason,
  WebSearchCredentialStatus,
  WebSearchProvider,
  WebSearchProviderSettings,
  WebSearchResponse,
  WebSearchResultRow,
  WebSearchSettings,
} from './web-search.js';
export {
  MASKED_TOKEN_SENTINEL,
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_CREDENTIAL_STATUSES,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_QUERY_MAX_CHARS,
  defaultWebSearchSettings,
  isWebSearchCredentialStatus,
  isWebSearchProvider,
  maskedTokenForDisplay,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
  reconcileMaskedToken,
  webSearchCredentialStatusFromResponse,
} from './web-search.js';

// explore-agent.ts — read-only deep research session profile.
export type { QuickChatMode } from './explore-agent.js';
export {
  DEEP_RESEARCH_SESSION_LABEL,
  QUICK_CHAT_MODES,
  buildDeepResearchSystemPromptFragment,
  isDeepResearchSession,
  isQuickChatMode,
  normalizeQuickChatMode,
} from './explore-agent.js';
