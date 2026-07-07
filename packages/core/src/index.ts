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
  AttachmentIngestItem,
} from './events.js';
export {
  TOOL_OUTPUT_DELTA_MAX_CHARS,
  TOOL_OUTPUT_STREAMS,
} from './events.js';

// runtime-event.ts — canonical Runtime v2 event contract.
// Subpath `@maka/core/runtime-event` is the canonical import; these barrel
// re-exports are for convenience.
export type {
  RuntimeEvent,
  RuntimeEventRole,
  RuntimeEventAuthor,
  RuntimeEventStatus,
  RuntimeEventTextContent,
  RuntimeEventThinkingContent,
  RuntimeEventFunctionCallContent,
  RuntimeEventFunctionResponseContent,
  RuntimeEventErrorContent,
  RuntimeEventContent,
  RuntimeEventContentKind,
  RuntimeEventTokenUsage,
  RuntimeEventPermissionDecision,
  RuntimeEventActions,
  RuntimeEventRefs,
} from './runtime-event.js';
export {
  RUNTIME_EVENT_ROLES,
  RUNTIME_EVENT_AUTHORS,
  RUNTIME_EVENT_STATUSES,
  TERMINAL_RUNTIME_EVENT_STATUSES,
  RUNTIME_EVENT_CONTENT_KINDS,
  isRuntimeEventRole,
  isRuntimeEventAuthor,
  isRuntimeEventStatus,
  isTerminalRuntimeEventStatus,
  isTerminalRuntimeEvent,
  isPartialRuntimeEvent,
  runtimeEventHasModelVisibleContent,
  createRuntimeEventId,
} from './runtime-event.js';

// runtime-event-store.ts
export type {
  RuntimeEventStore,
} from './runtime-event-store.js';

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

// model-thinking.ts
export type { ThinkingLevel } from './model-thinking.js';
export {
  THINKING_LEVELS,
  isThinkingLevel,
  thinkingVariantsForModel,
} from './model-thinking.js';

// agent-run.ts
export type {
  AgentRunEvent,
  AgentRunEventType,
  AgentRunHeader,
  AgentRunInputSummary,
  AgentRunStatus,
  AgentRunStore,
} from './agent-run.js';
export { AGENT_RUN_STATUSES } from './agent-run.js';

// shell-run.ts
export type {
  ShellRunRecord,
  ShellRunStatus,
  ShellRunStore,
  ShellRunTerminalStatus,
} from './shell-run.js';
export {
  SHELL_RUN_STATUSES,
  SHELL_RUN_TERMINAL_STATUSES,
  isShellRunStatus,
  isTerminalShellRunStatus,
} from './shell-run.js';

// browser.ts
export type {
  BrowserAddressInputFailureReason,
  BrowserAddressInputResult,
  BrowserState,
  BrowserViewRect,
} from './browser.js';
export { normalizeBrowserAddressInput } from './browser.js';

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
  ToolExecutionFacts,
  ToolExecutionIsolation,
  ToolExecutionNetwork,
  ToolExecutionSecrets,
  ToolExecutionWriteBack,
  PreToolUseInput,
  PreToolUseResult,
  PermissionRequest,
  PermissionResponse,
} from './permission.js';
export {
  PERMISSION_MODES,
  TOOL_CATEGORIES,
  PERMISSION_POLICY,
  BUILTIN_TOOL_CATEGORY,
  SAFE_SHELL_PREFIXES,
  PRIVILEGED_SHELL_PREFIXES,
  FS_DESTRUCTIVE_PATTERNS,
  DESTRUCTIVE_GIT_PATTERNS,
  categorizeBash,
  isPermissionMode,
  isToolCategory,
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
  AgentSpec,
  BranchFromTurnInput,
  ChildAgentTurnInput,
  CreateSessionInput,
  RegenerateTurnInput,
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

// capability-audit.ts
export type {
  AutomationLastRunStatus,
  AutomationRecord,
  AutomationRecordTrigger,
  CapabilityAuditPermissionMode,
  CapabilityAuditReport,
  CapabilityAuditSkillInput,
  CapabilityAuditSummary,
  DeriveCapabilityAuditReportInput,
  SkillAuditRecord,
  SourceAuthType,
  SourceRecord,
  SourceRecordStatus,
  SourceRecordType,
} from './capability-audit.js';
export {
  AUTOMATION_LAST_RUN_STATUSES,
  AUTOMATION_RECORD_TRIGGERS,
  CAPABILITY_AUDIT_PERMISSION_MODES,
  LOCAL_SKILL_SOURCE_SLUG,
  SOURCE_AUTH_TYPES,
  SOURCE_RECORD_STATUSES,
  SOURCE_RECORD_TYPES,
  deriveCapabilityAuditReport,
} from './capability-audit.js';

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
// task-ledger.ts (main agent session task tracking)
export type {
  CreateTaskInput,
  ResumeTrust,
  Task,
  TaskLedgerEvent,
  TaskLedgerEventRefs,
  TaskLedgerEventType,
  TaskLedgerListOptions,
  TaskLedgerMutationContext,
  TaskLedgerNormalizeResult,
  TaskLedgerProjection,
  TaskLedgerStore,
  TaskStatus,
  UpdateTaskInput,
} from './task-ledger.js';
export {
  TASK_EVIDENCE_MAX_CHARS,
  TASK_ID_MAX_CHARS,
  TASK_LEDGER_EVENT_TYPES,
  TASK_LEDGER_MAX_TASKS,
  TASK_RESUME_TRUST_LEVELS,
  TASK_STATUSES,
  TASK_SUBJECT_MAX_CHARS,
  canTransitionTaskStatus,
  classifyTaskResumeTrust,
  filterModelVisibleTaskLedgerTasks,
  isSafeTaskId,
  isResumeTrust,
  isTaskStatus,
  normalizeCreateTaskInput,
  normalizeResumeTrust,
  normalizeTaskEvidenceText,
  normalizeTaskStatus,
  normalizeTaskSubject,
  normalizeUpdateTaskInput,
  projectTaskLedgerEvents,
  renderTaskLedgerDebugText,
  renderSafeTaskLedgerText,
  taskLedgerEventTypeForCreate,
  taskLedgerEventTypeForUpdate,
  validateTaskEvidence,
  validateTaskUpdate,
} from './task-ledger.js';

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
  LocalMemoryEntryStatus,
  LocalMemoryEntryPreview,
  LocalMemoryEntryDraft,
  LocalMemoryEntryDraftRange,
  LocalMemoryBackupInfo,
  LocalMemoryOrigin,
  LocalMemoryParseResult,
  LocalMemorySettings,
  LocalMemoryScope,
  LocalMemorySource,
  LocalMemoryState,
  AppendManualLocalMemoryEntryInput,
  AppendManualLocalMemoryEntryResult,
  AppendApprovedLocalMemoryEntryInput,
  AppendApprovedLocalMemoryEntryResult,
  AppendLocalMemoryProposalInput,
  AppendLocalMemoryProposalResult,
  ApproveLocalMemoryProposalInput,
  ApproveLocalMemoryProposalResult,
  RejectLocalMemoryProposalInput,
  RejectLocalMemoryProposalResult,
  SetLocalMemoryEntryStatusInput,
  SetLocalMemoryEntryStatusResult,
} from './local-memory.js';
export {
  LOCAL_MEMORY_MAX_BYTES,
  LOCAL_MEMORY_PROMPT_MAX_CHARS,
  appendApprovedLocalMemoryEntryDraft,
  appendLocalMemoryProposalDraft,
  appendManualLocalMemoryEntryDraft,
  approveLocalMemoryProposalDraft,
  buildLocalMemoryPromptBody,
  defaultLocalMemoryMarkdown,
  defaultLocalMemorySettings,
  findLocalMemoryEntryDraft,
  findLocalMemoryEntryDraftRange,
  normalizeLocalMemorySettings,
  parseLocalMemoryMarkdown,
  rejectLocalMemoryProposalDraft,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryEntryId,
  stableLocalMemoryProposalId,
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
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_DEFAULTS,
  CATALOG_PROVIDER_TYPES,
  READY_PROVIDER_TYPES,
  backendKindOf,
  effectiveBaseUrl,
  migrateConnectionV1ToV2,
  normalizeConnectionBaseUrl,
  persistedBaseUrl,
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
  hasSettledInitialOnboarding,
  isOnboardingMilestone,
  sanitizeOnboardingMilestones,
} from './onboarding.js';

// model-catalog.ts
export type {
  BuildModelCatalogInput,
  BuildConnectionModelCatalogInput,
  KnownModelCapabilities,
  ModelCapabilitySource,
  ModelCatalogAvailability,
  ModelCatalogEntry,
  ModelCatalogLifecycle,
  ModelCatalogPricing,
  ModelCatalogProvenanceSources,
  ModelCatalogUserChoiceSource,
  ModelUnavailableReason,
  SavedModelChoice,
} from './model-catalog.js';
export {
  buildConnectionModelCatalogEntries,
  buildModelCatalogEntries,
  isModelExplicitlyUnsupportedForChat,
  validateChatDefaultModel,
} from './model-catalog.js';

// model-metadata.ts
export { resolveModelVisionSupport } from './model-metadata.js';

// settings.ts
export type {
  AppearanceSettings,
  AppSettings,
  BotChannelSettings,
  BotChatSettings,
  BotProvider,
  BotReadinessState,
  ChatDefaultPermissionMode,
  ChatDefaultsSettings,
  NetworkProxySettings,
  NetworkSettings,
  OpenGatewaySettings,
  OpenGatewayRuntimeStatus,
  PrivacySettings,
  ProxyProtocol,
  SettingsSection,
  SettingsTestResult,
  PersonalizationSettings,
  PersonalizationSettingsWarning,
  ThemePalette,
  ThemePreference,
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
  CHAT_DEFAULT_PERMISSION_MODES,
  DEFAULT_PROXY_BYPASS_DOMAINS,
  MAX_ALLOWED_USER_IDS,
  THEME_PALETTES,
  createDefaultBotChannel,
  createDefaultSettings,
  hasBotChannelCredentials,
  isBotDeliveryProvider,
  isBotReadinessState,
  isChatDefaultPermissionMode,
  isThemePalette,
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
  BotAttachmentKind,
  BotAttachmentRef,
  BotMessageEvent,
  BotPlatform,
} from './bot-events.js';
export {
  BOT_PLAINTEXT_HELP_COMMANDS,
  BOT_PLAINTEXT_RESET_COMMANDS,
  botConversationKey,
  botDisplayLabel,
  botSourceEventKey,
  formatBotMessageForSession,
  humanizeBotStatusReason,
  isPlaintextHelpCommand,
  isPlaintextResetCommand,
  nonTextMessageAck,
  plaintextHelpReply,
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
  ContextBudgetDiagnostic,
  PricingConfig,
  PromptSegmentEstimate,
  PromptSegmentKind,
  TimeRange,
  ToolInvocationRecord,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from './usage-stats/types.js';

export {
  formatCompactTimestamp,
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
  resetRelativeTimeFormatters,
} from './relative-time.js';

// text-file-import.ts — pure prompt-context limits shared by main and renderer.
export type {
  DroppedTextFilePreflightInput,
  TextFileImportPreflightFailureReason,
  TextFileImportPreflightResult,
} from './text-file-import.js';
export {
  MAX_IMPORTED_FOLDER_COUNT,
  MAX_IMPORTED_FOLDER_DEPTH,
  MAX_IMPORTED_FOLDER_ENTRIES,
  MAX_IMPORTED_FOLDERS_ENTRIES,
  MAX_IMPORTED_TEXT_FILE_BYTES,
  MAX_IMPORTED_TEXT_FILE_CHARS,
  MAX_IMPORTED_TEXT_FILE_COUNT,
  MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES,
  MAX_IMPORTED_TEXT_FILES_CHARS,
  isDroppedTextFileImportCompatible,
  preflightDroppedTextFilesForPromptImport,
} from './text-file-import.js';

// daily-review.ts (PR-DAILY-REVIEW-MVP-0 + PR-DAILY-REVIEW-FULL-0)
export type {
  DailyReviewArchive,
  DailyReviewArchiveSectionContent,
  DailyReviewArchiveStatus,
  DailyReviewArchiveSummary,
  DailyReviewConfig,
  DailyReviewExternalNotify,
  DailyReviewMode,
  DailyReviewSectionKey,
  DailyReviewSectionToggles,
  DailyReviewSessionRow,
  DailyReviewSummary,
  DailyReviewTopEntry,
  DailyReviewTotals,
  DailyReviewTrigger,
  DayRangeMs,
} from './daily-review.js';
export {
  DAILY_REVIEW_ARCHIVE_STATUSES,
  DAILY_REVIEW_LIST_LIMIT,
  DAILY_REVIEW_MODES,
  DAILY_REVIEW_SECTION_KEYS,
  DEFAULT_DAILY_REVIEW_CONFIG,
  buildDailyReviewSummary,
  dailyReviewArchiveId,
  dailyReviewArchiveToSummary,
  dailyUsageQuery,
  isDailyReviewExecuteTime,
  localDayBoundsAt,
  localDayBoundsForInstant,
  normalizeDailyReviewConfig,
  pickDailyReviewSessions,
  pickDailyReviewTopEntries,
} from './daily-review.js';

// web-search.ts (PR-WEB-SEARCH-TAVILY-0) — explicit user-triggered
// web search contract. Renderer never sees the API key.
export type {
  WebSearchErrorReason,
  WebSearchCredentialStatus,
  WebSearchCredentialSource,
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
  WEB_SEARCH_CREDENTIAL_SOURCES,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_QUERY_MAX_CHARS,
  defaultWebSearchSettings,
  isWebSearchCredentialStatus,
  isWebSearchCredentialSource,
  isWebSearchProvider,
  maskedTokenForDisplay,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
  reconcileMaskedToken,
  webSearchCredentialStatusFromResponse,
  webSearchCredentialSourceFromStoredKey,
} from './web-search.js';

// explore-agent.ts — read-only deep research session profile.
export type { QuickChatMode } from './explore-agent.js';
export {
  DEEP_RESEARCH_EVIDENCE_CHECKLIST,
  DEEP_RESEARCH_PROGRESS_CHECKPOINTS,
  DEEP_RESEARCH_SESSION_LABEL,
  DEEP_RESEARCH_REPORT_SECTIONS,
  DEEP_RESEARCH_SCOPE_OPTIONS,
  DEEP_RESEARCH_STARTER_PROMPTS,
  DEEP_RESEARCH_WORKFLOW_STEPS,
  QUICK_CHAT_MODES,
  buildDeepResearchSystemPromptFragment,
  isDeepResearchSession,
  isQuickChatMode,
  normalizeQuickChatMode,
} from './explore-agent.js';

// attachments.ts
export { attachmentKindFromMimeType, guessMimeFromName, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from './attachments.js';
