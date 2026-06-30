import { app, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { release as osRelease, arch as osArch } from 'node:os';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
  redactSecrets,
  buildHealthSnapshot,
  buildConnectionModelCatalogEntries,
  healthSignalFromCapability,
  healthSignalFromConnection,
  healthSignalFromConnectionRuntime,
  isPermissionMode,
  normalizeConnectionBaseUrl,
  DEEP_RESEARCH_SESSION_LABEL,
  botDisplayLabel,
  humanizeBotStatusReason,
} from '@maka/core';
import type {
  AppSettings,
  ArtifactSaveResult,
  BotProvider,
  BotReadinessState,
  ConnectionEvent,
  CreateConnectionInput,
  CreateSessionInput,
  DailyReviewConfig,
  DailyReviewMode,
  DailyReviewSummary,
  SessionChangedEvent,
  SessionChangedReason,
  SessionEvent,
  SessionHeader,
  SessionListFilter,
  StoredMessage,
  SettingsTestResult,
  UpdateAppSettingsResult,
  UpdateConnectionInput,
  UpdateAppSettingsInput,
  UsageRange,
  LocalMemoryState,
} from '@maka/core';
import {
  isWebSearchProvider,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
} from '@maka/core';
import { queryTavily, TAVILY_TEST_QUERY, TAVILY_TEST_LIMIT } from './web-search/tavily.js';
import { buildWebSearchAgentTool, WEB_SEARCH_TOOL_NAME } from './web-search/agent-tool.js';
import { buildRiveWorkflowTool } from './rive-workflow-tool.js';
import { resolveTavilyApiKey } from './web-search/credentials.js';
import { runThreadSearch } from './search/thread-search.js';
import {
  persistArchivedToolResultToArtifacts,
  readArchivedToolResultFromArtifacts,
} from './tool-result-archive-artifacts.js';
import {
  normalizeBranchFromTurnInput,
  normalizePermissionResponse,
  normalizeRegenerateTurnInput,
  normalizeRetryTurnInput,
  normalizeSessionSendCommand,
  normalizeStopSessionInput,
} from './permission-response-guard.js';
import {
  ClaudeSubscriptionService,
  isSubscriptionExperimentalEnabled,
} from './oauth/claude-subscription-service.js';
import {
  CodexSubscriptionService,
  isCodexSubscriptionExperimentalEnabled,
} from './oauth/codex-subscription-service.js';
import {
  CursorSubscriptionService,
  isCursorSubscriptionExperimentalEnabled,
} from './oauth/cursor-subscription-service.js';
import {
  AntigravitySubscriptionService,
  isAntigravitySubscriptionExperimentalEnabled,
} from './oauth/antigravity-subscription-service.js';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';
import type {
  PricingConfig,
  UsageGroupBy,
  UsageQuery,
} from '@maka/core/usage-stats/types';
import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from '@maka/core/usage-stats/pricing';
import type {
  TestProxyInput,
  TestProxyResult,
} from '@maka/core/settings/network-settings';
import { SENSITIVE_PLACEHOLDER } from '@maka/core/settings/network-settings';
import { err, ok, tryResult, type Result } from '@maka/core/settings/result';
import {
  AiSdkBackend,
  BackendRegistry,
  FakeBackend,
  PermissionEngine,
  SessionManager,
  buildBuiltinTools,
  buildChildAgentTools,
  buildSubagentProjectionTools,
  buildSubagentSpawnTool,
  buildSubagentToolGroup,
  fetchProviderModels,
  getAIModel,
  buildProviderOptions,
  recordLlmCall,
  recordToolInvocation,
  buildPricingLookup,
  BotRegistry,
  getWechatBridgeQrCode,
  testBotChannel as testRuntimeBotChannel,
  setActiveProxy,
  testConnection,
} from '@maka/runtime';
import type {
  ToolAvailabilityConfig,
  ToolArtifactRecorderInput,
  ToolResultArchiveReaderInput,
  ToolResultArchiveReadResult,
  ToolResultArchiveRecorderInput,
} from '@maka/runtime';
import { testProxyConnection } from '@maka/runtime/network/proxy-test';
import { fetchWeChatQrcode, pollWeChatQrcodeStatus } from './wechat-scan-login.js';
import {
  PROVIDER_DEFAULTS,
  type LlmConnection,
} from '@maka/core/llm-connections';
import { createAgentRunStore, createArtifactStore, createConnectionStore, createPlanReminderStore, createRuntimeEventStore, createSessionStore, createSettingsStore, createTelemetryRepo, resolveArtifactPath } from '@maka/storage';
import {
  ensureSessionCanSendOrRebind,
  errorCode,
  errorMessage,
  errorReason,
  requireReadyConnection,
} from './chat-readiness.js';
import { createFileCredentialStore, migrateLegacyCredentials } from './credential-store.js';
import { bindOnboardingDeps, createOnboardingService } from './onboarding-service.js';
import { handleQuickChatStart as runQuickChatStart, type QuickChatResult } from './quick-chat.js';
import { connectionTestStatusPatch } from './connection-test-status.js';
import { probeOfficeCli } from './officecli-probe.js';
import { resolveOpenPath, type OpenPathResult } from './open-path-guard.js';
import { resolveProjectGitInfo, resolveProjectRoot } from './project-context.js';
import { createDailyReviewArchiveStore } from './daily-review-archive-store.js';
import { botTestErrorMessage, buildSettingsUpdateResult, maskAppSettings, preserveSensitivePlaceholders, toSettingsTestResult } from './settings-ipc-helpers.js';
import {
  buildSkillAgentTool,
  createStarterSkill,
  ensureBundledOfficeSkills,
  listInstalledSkills,
  resolveSkillOpenPath,
} from './skills.js';
import {
  createWorkspaceInstructionFile,
  getWorkspaceInstructionsState,
  resolveWorkspaceInstructionFileForOpen,
  type WorkspaceInstructionCreateFailureReason,
  type WorkspaceInstructionOpenFailureReason,
} from './workspace-instructions.js';
import { buildCapabilitySnapshotCollection, buildPermissionSnapshot } from './capability-snapshot.js';
import { openSystemPermissionPane, requestPermissionAccess } from './permissions-actions.js';
import {
  getVisualSmokeState,
  resolveVisualSmokeFixture,
  seedVisualSmokeFixture,
} from './visual-smoke-fixture.js';
import { resolveBuildInfo } from './build-info.js';
import { OpenGatewayService } from './open-gateway.js';
import { LocalMemoryService } from './local-memory-service.js';
import {
  createAttachmentApprovalRegistry,
  validateRendererAttachments,
  type AttachmentValidationFailureReason,
} from './attachment-approval.js';
import {
  readFolderOutlinesForPromptImport,
  readDroppedTextFilesForPromptImport,
  readTextFilesForPromptImport,
  type DroppedTextFilePayload,
  type FolderOutlineImportFailureReason,
  type TextFileImportFailureReason,
} from './text-file-import.js';
import { buildExploreAgentTool } from './explore-agent-tool.js';
import { buildOfficeDocumentEditTool, buildOfficeDocumentTool } from './office-document-tool.js';
import {
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
} from './history-compact-artifacts.js';
import {
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
} from './synthesis-cache-artifacts.js';
import { buildBrowserTools } from './browser/browser-tools.js';
import { createBrowserViewHost } from './browser/automation-host.js';
import { provideBrowserViewHost } from './browser/browser-host.js';
import { releaseBrowserSession, revokeHiddenBrowserActions } from './browser/session.js';
import type { BrowserViewRect } from './browser/logic.js';
import { createMainWindowController } from './main-window.js';
import { createDailyReviewMainService } from './daily-review-main.js';
import { createPlanReminderMainService } from './plan-reminders-main.js';
import { createBotIncomingMainService } from './bot-incoming-main.js';
import { createSubscriptionModelFetch } from './subscription-model-fetch.js';
import { buildContextBudgetPolicy } from './context-budget-policy.js';
import { createSystemPromptMainService } from './system-prompt-main.js';
import {
  CLAUDE_SUBSCRIPTION_CONNECTION_SLUG,
  CODEX_SUBSCRIPTION_CONNECTION_SLUG,
  createOAuthModelConnectionsMainService,
} from './oauth-model-connections-main.js';
import {
  applyNetworkPatch,
  maskNetworkSettings,
  toAppNetworkPatch,
  toContractNetworkSettings,
} from './network-settings-main.js';

const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());

// PR-VISUAL-SMOKE-HEADLESS: resolve the fixture defensively. An unknown
// scenario (e.g. the capture script's list got ahead of a stale build, or
// a typo'd MAKA_VISUAL_SMOKE_FIXTURE) throws here during top-level module
// evaluation. Left uncaught it surfaces a blocking native error dialog and
// the capture driver waits out its full marker timeout (~60s). In capture
// mode we instead log a parseable line and exit fast so the run fails in
// milliseconds with no dialog. Outside capture mode the throw is rethrown.
let visualSmokeFixture: ReturnType<typeof resolveVisualSmokeFixture>;
try {
  visualSmokeFixture = resolveVisualSmokeFixture(
    process.env.MAKA_VISUAL_SMOKE_FIXTURE,
    app.isPackaged,
    process.env.MAKA_VISUAL_SMOKE_REDUCED_MOTION,
    process.env.MAKA_VISUAL_SMOKE_AUTO_CAPTURE,
    process.env.MAKA_VISUAL_SMOKE_THEME,
    process.env.MAKA_VISUAL_SMOKE_LOCALE,
    process.env.MAKA_VISUAL_SMOKE_TIMEZONE,
  );
} catch (error) {
  if (process.env.MAKA_VISUAL_SMOKE_FIXTURE) {
    console.error(`[visual-smoke] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  throw error;
}
const workspaceRoot = join(app.getPath('userData'), 'workspaces', visualSmokeFixture?.workspaceName ?? 'default');
const store = createSessionStore(workspaceRoot);
const runStore = createAgentRunStore(workspaceRoot);
const runtimeEventStore = createRuntimeEventStore(workspaceRoot);
const connectionStore = createConnectionStore(workspaceRoot);
const settingsStore = createSettingsStore(workspaceRoot);
const telemetryRepo = createTelemetryRepo(workspaceRoot);
const dailyReviewArchiveStore = createDailyReviewArchiveStore(workspaceRoot);
const artifactStore = createArtifactStore(workspaceRoot);
const attachmentApprovals = createAttachmentApprovalRegistry();
const credentialStore = createFileCredentialStore(workspaceRoot);
// PR-OAUTH-SUBSCRIPTION-0: Claude subscription OAuth service.
// Lives in main process only; renderer accesses via IPC. Tokens
// never cross the IPC boundary (xuan G-X3). Cloak path is dynamic-
// imported behind MAKA_CLAUDE_SUBSCRIPTION_CLOAK flag (xuan G-X4)
// and lives in a separate module not statically imported here.
const claudeSubscription = new ClaudeSubscriptionService({
  userDataDir: app.getPath('userData'),
});
// PR-MODEL-OAUTH-ALL-0: Codex / Cursor / Antigravity subscription
// services. Same shape as `claudeSubscription` — main-process only,
// IPC payloads never carry tokens, each gated behind its own
// MAKA_*_EXPERIMENTAL env var. Antigravity is a `preview` placeholder
// until the Google client_id question is resolved.
const codexSubscription = new CodexSubscriptionService({
  userDataDir: app.getPath('userData'),
});
const buildSubscriptionModelFetch = createSubscriptionModelFetch({
  claudeSubscription,
  codexSubscription,
});
const oauthModelConnections = createOAuthModelConnectionsMainService({
  connectionStore,
  credentialStore,
  claudeSubscription,
  codexSubscription,
});
const isClaudeSubscriptionAuthenticatedState = oauthModelConnections.isClaudeSubscriptionAuthenticatedState;
const isCodexSubscriptionAuthenticatedState = oauthModelConnections.isCodexSubscriptionAuthenticatedState;

function syncClaudeSubscriptionConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncClaudeSubscriptionConnection();
}

function syncCodexSubscriptionConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncCodexSubscriptionConnection();
}

function syncOAuthModelConnections(): Promise<void> {
  return oauthModelConnections.syncOAuthModelConnections();
}

function resolveConnectionSecret(slug: string): Promise<string | null> {
  return oauthModelConnections.resolveConnectionSecret(slug);
}
const cursorSubscription = new CursorSubscriptionService({
  userDataDir: app.getPath('userData'),
});
const antigravitySubscription = new AntigravitySubscriptionService({
  userDataDir: app.getPath('userData'),
});

const IPC_CONNECTION_SLUG_MAX_LENGTH = 64;
const IPC_CONNECTION_SECRET_MAX_LENGTH = 4096;
const IPC_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const IPC_CONNECTION_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

function hasTraversalLookingSlugSegment(value: string): boolean {
  return value.split('.').some((segment) => segment.length === 0);
}

function normalizeConnectionSlugForIpc(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (value.length === 0) {
    throw new Error(`${label} is required`);
  }
  if (value.length > IPC_CONNECTION_SLUG_MAX_LENGTH) {
    throw new Error(`${label} must be ${IPC_CONNECTION_SLUG_MAX_LENGTH} characters or fewer`);
  }
  if (!IPC_CONNECTION_SLUG_PATTERN.test(value) || IPC_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} contains invalid characters`);
  }
  if (hasTraversalLookingSlugSegment(value)) {
    throw new Error(`${label} contains invalid path traversal segments`);
  }
  return value;
}

function normalizeConnectionApiKeyForIpc(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (value.length > IPC_CONNECTION_SECRET_MAX_LENGTH) {
    throw new Error(`${label} must be ${IPC_CONNECTION_SECRET_MAX_LENGTH} characters or fewer`);
  }
  if (IPC_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} contains invalid characters`);
  }
  return value;
}

function normalizeCreateConnectionInput(input: CreateConnectionInput): CreateConnectionInput {
  const apiKey = input.apiKey === undefined
    ? undefined
    : normalizeConnectionApiKeyForIpc(input.apiKey, 'apiKey');
  const slug = normalizeConnectionSlugForIpc(input.slug, 'connection slug');
  const normalizedInput = { ...input, slug, ...(apiKey !== undefined ? { apiKey } : {}) };
  const defaults = PROVIDER_DEFAULTS[normalizedInput.providerType];
  if (defaults.authKind === 'oauth_token') {
    return { ...normalizedInput, baseUrl: defaults.baseUrl };
  }
  if (normalizedInput.baseUrl === undefined) return normalizedInput;
  const result = normalizeConnectionBaseUrl(normalizedInput.baseUrl);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { ...normalizedInput, baseUrl: result.value };
}

function normalizeConnectionPatchSecretsForIpc(patch: UpdateConnectionInput): UpdateConnectionInput {
  if (!Object.prototype.hasOwnProperty.call(patch, 'apiKey')) return patch;
  if (patch.apiKey === undefined) return patch;
  return {
    ...patch,
    apiKey: normalizeConnectionApiKeyForIpc(patch.apiKey, 'apiKey'),
  };
}

async function normalizeUpdateConnectionInput(
  slug: string,
  patch: UpdateConnectionInput,
): Promise<UpdateConnectionInput> {
  const normalizedPatch = normalizeConnectionPatchSecretsForIpc(patch);
  const existing = await connectionStore.get(slug);
  const providerType = existing?.providerType;
  if (providerType && PROVIDER_DEFAULTS[providerType].authKind === 'oauth_token') {
    return { ...normalizedPatch, baseUrl: PROVIDER_DEFAULTS[providerType].baseUrl };
  }
  if (normalizedPatch.baseUrl === undefined) return normalizedPatch;
  const result = normalizeConnectionBaseUrl(normalizedPatch.baseUrl);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { ...normalizedPatch, baseUrl: result.value };
}

const planReminderStore = createPlanReminderStore(workspaceRoot);

async function getWorkspacePrivacyContext(): Promise<WorkspacePrivacyContext> {
  const settings = await settingsStore.get();
  return { incognitoActive: settings.privacy.incognitoActive === true };
}

const localMemory = new LocalMemoryService({
  workspaceRoot,
  getSettings: () => settingsStore.get(),
  updateSettings: (patch) => settingsStore.update(patch),
  getPrivacyContext: getWorkspacePrivacyContext,
});
const systemPromptService = createSystemPromptMainService({
  settingsStore,
  workspaceRoot,
  localMemory,
});
const mainWindowController = createMainWindowController({
  workspaceRoot,
  visualSmokeFixture,
  settingsStore,
  ensureBundledOfficeSkills,
});
const safeSendToRenderer = mainWindowController.send;
const openGateway = new OpenGatewayService({
  getSettings: () => settingsStore.get(),
  listSessions: () => runtime.listSessions(),
  readMessages: (sessionId) => runtime.getMessages(sessionId),
  sendMessage: async (sessionId, input) => {
    await ensureSessionCanSend(sessionId);
    const turnId = randomUUID();
    const iterator = runtime.sendMessage(sessionId, {
      turnId,
      text: input.text,
    });
    void streamEvents(sessionId, iterator, turnId);
    return { turnId };
  },
  searchThread: (query) =>
    runThreadSearch({ source: 'thread', query }, {
      listSessions: () => runtime.listSessions(),
      readMessages: (sessionId: string) => runtime.getMessages(sessionId),
      getPrivacyContext: getWorkspacePrivacyContext,
    }),
  onStatusChanged: (status) => {
    safeSendToRenderer('gateway:statusChanged', status);
  },
});
const backends = new BackendRegistry();
const permissionEngine = new PermissionEngine({ newId: randomUUID, now: Date.now });
// Unified tool availability (issue #37). Deferred capability groups (Rive,
// Office, browser, agent orchestration) are withheld from the
// per-turn prompt and loaded on demand via `load_tools`, keeping their schemas
// off the wire until needed. Everything else (ungrouped) stays always-on.
// Kill-switch: set MAKA_DISABLE_DEFERRED_TOOLS to any value to turn economy off
// and advertise every tool every turn (legacy behavior).
const economyEnabled = !process.env.MAKA_DISABLE_DEFERRED_TOOLS;
const riveTools = [buildRiveWorkflowTool()];
const officeTools = [buildOfficeDocumentTool(), buildOfficeDocumentEditTool()];
// Embedded-browser observe→act tools. They drive the conversation's own
// WebContentsView via the BrowserViewHost the desktop provides in registerIpc;
// outside the app (no host) they report the browser as unavailable.
const browserTools = buildBrowserTools();
const agentTools = [buildSubagentSpawnTool(), ...buildSubagentProjectionTools()];
const deferredTools = [...riveTools, ...officeTools, ...browserTools, ...agentTools];
const toolAvailability: ToolAvailabilityConfig = {
  economy: economyEnabled,
  groups: [
    { id: 'rive', label: 'Rive', description: 'Durable multi-agent Rive workflows: validate/import/run/status, scheduler, retries.', toolNames: riveTools.map((tool) => tool.name) },
    { id: 'office', label: 'Office', description: 'Read and edit Office documents (Word, Excel, PowerPoint, PDF).', toolNames: officeTools.map((tool) => tool.name) },
    { id: 'browser', label: 'Browser', description: 'Drive the embedded browser: navigate, snapshot, click, type, wait, extract.', toolNames: browserTools.map((tool) => tool.name) },
    buildSubagentToolGroup(),
  ],
};
const builtinTools = [
  ...buildBuiltinTools().filter((tool) => tool.name !== 'Edit'),
  // External reference lazy-skill pattern: the prompt lists available skills,
  // and this read-only tool loads the full SKILL.md only when the task matches.
  buildSkillAgentTool(workspaceRoot),
  // External reference plan-mode borrow: a bounded read-only local worker for
  // self-contained code/repo investigations. The tool advertises the
  // `subagent` category; explore mode allows it, but the implementation
  // itself only reads filenames/text snippets under the session cwd.
  buildExploreAgentTool(),
  // PR-AGENT-WEB-SEARCH-TOOL-0: Tavily-backed WebSearch tool. Closed
  // over settingsStore so the renderer never sees the API key; the
  // permission engine routes it through the `web_read` policy which
  // prompts the user in explore / ask modes.
  buildWebSearchAgentTool({
    settingsStore,
    getPrivacyContext: getWorkspacePrivacyContext,
  }),
  // The `load_tools` connector is built by ToolAvailabilityRuntime; deferred
  // group tools just need to be present so they are dispatchable once loaded.
  ...deferredTools,
];
const childAgentTools = buildChildAgentTools(builtinTools);
let lookupPricing = buildPricingLookup();
// PR-BOT-LASTERROR-FROM-SEND-0: per-platform last-observed readiness so
// we only persist `lastError` on transitions, not on every status emit
// (avoids thrashing the settings file when the live bridge re-emits the
// same readiness during reconnect attempts).
const previousBotReadiness = new Map<BotProvider, BotReadinessState>();
let botIncoming: ReturnType<typeof createBotIncomingMainService>;
const botRegistry = new BotRegistry({
  onIncomingMessage: (message) => {
    // Only log incoming bot messages in dev — production stdout leaking
    // platform + chatId is operational noise at best and a small privacy
    // signal at worst (which bridges are connected, with what frequency).
    if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
      console.log('[bot] incoming message', message.platform, message.chatId);
    }
    void botIncoming.handleBotIncomingMessage(message);
  },
  onStatusChange: (status) => {
    safeSendToRenderer('settings:bots:statusChanged', status);
    // PR-BOT-LASTERROR-FROM-SEND-0: persist send-path failure reasons
    // to settings so they survive a Settings page close/reopen. The
    // existing connection-test path writes `lastError` only on test
    // failures; without this hook, a runtime 429 / timeout would
    // disappear the moment the renderer status panel closed.
    const prev = previousBotReadiness.get(status.platform);
    previousBotReadiness.set(status.platform, status.readiness);
    if (prev === status.readiness) return;
    if (status.readiness === 'degraded') {
      const humanized = humanizeBotStatusReason(status.reason);
      if (humanized) {
        void settingsStore.update({
          botChat: {
            channels: {
              [status.platform]: {
                lastError: humanized,
                readinessUpdatedAt: Date.now(),
              },
            },
          },
        }).catch(() => {});
      }
    } else if (status.readiness === 'operational' && prev === 'degraded') {
      // Clear `lastError` once the bridge recovers; otherwise the
      // Settings page would keep surfacing a stale failure description
      // even though sends are succeeding.
      void settingsStore.update({
        botChat: {
          channels: {
            [status.platform]: {
              lastError: undefined,
              readinessUpdatedAt: Date.now(),
            },
          },
        },
      }).catch(() => {});
    }
  },
});
const planReminders = createPlanReminderMainService({
  store: planReminderStore,
  getPrivacyContext: getWorkspacePrivacyContext,
  sendBotMessage: (platform, chatId, text) =>
    botRegistry.sendMessage(platform, chatId, text),
  emitChanged: (reason, reminder) => {
    safeSendToRenderer('plans:changed', {
      type: 'plans_changed',
      reason,
      reminderId: reminder.id,
      ts: Date.now(),
    });
  },
  emitDue: (reminder) => {
    safeSendToRenderer('plans:due', reminder);
  },
});

app.setName('Maka');

/**
 * PR-DAILY-REVIEW-EXPORT-FILE-0 + PR-CMD-PALETTE-SAVE-CONVERSATION-FILE-0:
 * shared save-markdown-via-dialog helper. Shape-validates the renderer
 * payload (1MB markdown cap / 200 char filename cap / sanitized path
 * separators) so a misbehaving renderer cannot force a large write or
 * pre-populate the dialog with traversal text.
 */
async function saveMarkdownViaDialog(
  input: { markdown?: unknown; defaultName?: unknown } | undefined,
  dialogTitle: string,
): Promise<
  | { ok: true; path: string }
  | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
> {
  const markdown = typeof input?.markdown === 'string' ? input.markdown : null;
  const defaultName = typeof input?.defaultName === 'string' ? input.defaultName : null;
  if (!markdown || markdown.length === 0 || markdown.length > 1_000_000) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!defaultName || defaultName.length === 0 || defaultName.length > 200) {
    return { ok: false, reason: 'invalid_input' };
  }
  // Strip directory separators from the proposed filename so a
  // malicious or buggy caller cannot bypass the save dialog's
  // path picker.
  const safeName = defaultName.replace(/[\\/]/g, '_');
  const saveDialogOptions = {
    title: dialogTitle,
    defaultPath: safeName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const result = await mainWindowController.showSaveDialog(saveDialogOptions);
  if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' };
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(result.filePath, markdown, 'utf8');
    return { ok: true, path: result.filePath };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
}

async function persistToolArtifacts(cwd: string, event: ToolArtifactRecorderInput): Promise<void> {
  for (const candidate of event.candidates) {
    let content = candidate.content;
    if (content === undefined && candidate.sourcePath) {
      const sourcePath = await resolveToolArtifactSourcePath(cwd, candidate.sourcePath);
      if (!sourcePath) continue;
      content = await readFile(sourcePath);
    }
    if (content === undefined) continue;
    const artifact = await artifactStore.create({
      sessionId: event.sessionId,
      turnId: event.turnId,
      name: candidate.name,
      kind: candidate.kind,
      content,
      ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
      source: candidate.source ?? 'tool_result',
      ...(candidate.summary ? { summary: candidate.summary } : {}),
    });
    safeSendToRenderer('artifacts:changed', {
      reason: 'created',
      artifactId: artifact.id,
      sessionId: artifact.sessionId,
      ts: Date.now(),
    });
  }
}

async function persistArchivedToolResult(
  event: ToolResultArchiveRecorderInput,
): Promise<{ artifactId: string }> {
  return persistArchivedToolResultToArtifacts(artifactStore, event);
}

async function readArchivedToolResult(
  event: ToolResultArchiveReaderInput,
): Promise<ToolResultArchiveReadResult> {
  return readArchivedToolResultFromArtifacts(artifactStore, event);
}

async function resolveToolArtifactSourcePath(cwd: string, sourcePath: string): Promise<string | null> {
  const candidate = isAbsolute(sourcePath) ? sourcePath : resolve(cwd, sourcePath);
  let root: string;
  let target: string;
  try {
    [root, target] = await Promise.all([
      realpath(cwd),
      realpath(candidate),
    ]);
  } catch {
    return null;
  }
  return isInsideOrSamePath(root, target) ? target : null;
}

/**
 * Sanitize a single path segment for use under `screenshots/`. Allows
 * only `[a-zA-Z0-9._-]`; rejects everything else (slashes, `..`, NUL,
 * UTF-8 letters). Returns null when the input is empty after sanitization
 * so the capture IPC can fail-closed rather than write to an attacker-
 * controlled relative path.
 */
function sanitizeSegment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  return trimmed;
}

function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && rel !== '..' && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}

backends.register('ai-sdk', async (ctx) => {
  const { connection, apiKey, model } = await getReadyConnection(ctx.header.llmConnectionSlug, ctx.header.model);
  const modelFetch = buildSubscriptionModelFetch(connection, ctx.sessionId, model);
  const memoryPromptSnapshot = await systemPromptService.buildLocalMemoryPromptFragment();

  return new AiSdkBackend({
    sessionId: ctx.sessionId,
    header: { ...ctx.header, model },
    appendMessage: ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
    connection,
    apiKey: apiKey ?? '',
    modelId: model,
    permissionEngine,
    modelFactory: (input) => getAIModel({ ...input, fetch: modelFetch }),
    tools: [...(ctx.tools ?? builtinTools)],
    toolAvailability,
    spawnChildAgent: (input) => runtime.spawnChildAgent(ctx.sessionId, input),
    listChildAgents: () => runtime.listChildAgents(ctx.sessionId),
    readChildAgentOutput: (input) => runtime.readChildAgentOutput(ctx.sessionId, input),
    providerOptions: buildProviderOptions(connection, model),
    contextBudget: buildContextBudgetPolicy(connection),
    systemPrompt: ({ cwd }) => systemPromptService.buildBackendSystemPrompt(ctx.header, cwd, {
      memoryFragment: memoryPromptSnapshot,
      childInstruction: ctx.systemPrompt,
    }),
    turnTailPrompt: ({ cwd }) => systemPromptService.buildTurnTailPrompt(cwd),
    lookupPricing,
    recordLlmCall: (event) => recordLlmCall({ repo: telemetryRepo, lookupPricing }, event),
    recordToolInvocation: (event) =>
      recordToolInvocation(
        { repo: telemetryRepo },
        // PR-AGENT-WEB-SEARCH-TOOL-0: scrub the query out of the
        // telemetry record. The agent passes the raw user query as
        // the tool argument; persisting it in `argsSummary` would
        // leak user-derived content into the usage log.
        event.toolName === WEB_SEARCH_TOOL_NAME
          ? { ...event, argsSummary: undefined }
          : event,
      ),
    recordToolArtifacts: (event) => persistToolArtifacts(ctx.header.cwd, event),
    archiveToolResult: (event) => persistArchivedToolResult(event),
    readToolResultArchive: (event) => readArchivedToolResult(event),
    loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
    writeHistoryCompact: (event) => persistHistoryCompactBlocksToArtifacts(artifactStore, event, {
      onArtifactCreated: (artifact) => {
        safeSendToRenderer('artifacts:changed', {
          reason: 'created',
          artifactId: artifact.id,
          sessionId: artifact.sessionId,
          ts: Date.now(),
        });
      },
    }),
    loadSynthesisCache: (event) => loadSynthesisCacheBlocksFromArtifacts(artifactStore, event),
    writeSynthesisCache: (event) => persistSynthesisCacheBlocksToArtifacts(artifactStore, event, {
      onArtifactCreated: (artifact) => {
        safeSendToRenderer('artifacts:changed', {
          reason: 'created',
          artifactId: artifact.id,
          sessionId: artifact.sessionId,
          ts: Date.now(),
        });
      },
    }),
    recordRunTrace: ctx.recordRunTrace,
    recordActiveFullCompactBlock: ctx.recordActiveFullCompactBlock,
    newId: randomUUID,
    now: Date.now,
  });
});

async function tryWeChatQrResult<T>(fn: () => Promise<T>, errorCode: string): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(errorCode, weChatQrFailureMessage(error));
  }
}

function weChatQrFailureMessage(error: unknown): string {
  return generalizedErrorMessageChinese(error, '微信扫码登录暂时不可用，请稍后重试。');
}

backends.register('fake', (ctx) =>
  new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store, appendMessage: ctx.appendMessage }),
);

const runtime = new SessionManager({
  store,
  runStore,
  runtimeEventStore,
  backends,
  childTools: childAgentTools,
  listArtifactsForTurn: async (sessionId, turnId) =>
    (await artifactStore.list(sessionId)).filter((artifact) =>
      artifact.turnId === turnId && artifact.status !== 'deleted'
    ),
  newId: randomUUID,
  now: Date.now,
});
const dailyReview = createDailyReviewMainService({
  archiveStore: dailyReviewArchiveStore,
  connectionStore,
  telemetryRepo,
  listSessions: () => runtime.listSessions(),
  resolveConnectionSecret,
  buildSubscriptionModelFetch,
});
botIncoming = createBotIncomingMainService({
  runtime,
  botRegistry,
  cwd: () => process.cwd(),
  getDefaultConnectionSlug: () => connectionStore.getDefault(),
  getReadyConnection,
  readSessionHeader: (sessionId) => store.readHeader(sessionId),
  ensureSessionCanSend,
  emitSessionsChanged,
  sendToRenderer: safeSendToRenderer,
  isStatusChangingSessionEvent,
  isTurnStatusChangingSessionEvent,
});

// PR110b: onboarding service composes existing stores + runtime to
// derive `OnboardingState` and manage `OnboardingMilestone[]`.
// Constructed AFTER `runtime` so `listSessions()` is bindable. The
// service never reaches into credentialStore directly except through
// the explicit `hasApiKey` predicate.
const onboardingService = createOnboardingService(
  bindOnboardingDeps({
    settingsStore,
    connectionStore,
    credentialStore,
    listSessions: () => runtime.listSessions(),
  }),
);

// The session the renderer currently shows; browser:* renderer channels are
// validated against it so a stale/miswired panel can't steer another
// conversation's view (the agent path uses the runtime's trusted sessionId).
let shownBrowserSessionId: string | null = null;

function localMemoryOpenFailureCopy(reason: string): string {
  switch (reason) {
    case 'incognito_blocked':
      return '隐身模式下不能打开本地 MEMORY.md。';
    case 'disabled':
      return '本地记忆已关闭。';
    case 'missing':
      return 'MEMORY.md 不存在。';
    case 'not-allowed':
      return 'MEMORY.md 不在允许的工作区范围内。';
    case 'not-a-file':
      return 'MEMORY.md 不是普通文件。';
    case 'open-failed':
      return '系统未能打开 MEMORY.md。';
    default:
      return '无法打开 MEMORY.md。';
  }
}

function localMemoryBackupOpenFailureCopy(reason: string): string {
  switch (reason) {
    case 'incognito_blocked':
      return '隐身模式下不能打开本地 MEMORY.md 备份。';
    case 'disabled':
      return '本地记忆关闭时不能打开 MEMORY.md 备份。';
    case 'missing':
      return '还没有可打开的上一版 MEMORY.md 备份。';
    case 'not-allowed':
      return 'MEMORY.md 备份不在允许的工作区范围内。';
    case 'not-a-file':
      return 'MEMORY.md 备份不是普通文件。';
    case 'open-failed':
      return '系统未能打开 MEMORY.md 备份。';
    default:
      return '无法打开 MEMORY.md 备份。';
  }
}

function workspaceInstructionOpenFailureCopy(reason: WorkspaceInstructionOpenFailureReason | 'open-failed'): string {
  switch (reason) {
    case 'unknown-file':
      return '只能打开 AGENTS.md / CLAUDE.md / GEMINI.md。';
    case 'missing':
      return '项目指令文件不存在。';
    case 'blocked':
      return '项目指令文件不在当前工作区范围内。';
    case 'not-a-file':
      return '项目指令路径不是普通文件。';
    case 'open-failed':
      return '系统未能打开这个文件。';
  }
}

function workspaceInstructionCreateFailureCopy(reason: WorkspaceInstructionCreateFailureReason): string {
  switch (reason) {
    case 'unknown-file':
      return '只能创建 AGENTS.md / CLAUDE.md / GEMINI.md。';
    case 'exists':
      return '项目指令文件已经存在。';
    case 'blocked':
      return '当前工作区路径不可写或不在允许范围内。';
    case 'write-failed':
      return '写入项目指令文件失败。';
  }
}

function textFileImportFailureCopy(reason: TextFileImportFailureReason): string {
  switch (reason) {
    case 'missing':
      return '所选文件不存在或不是普通文件。';
    case 'too-large':
      return '文件过大；请先截取需要讨论的部分。';
    case 'binary':
      return '这个文件不像纯文本，已取消导入。';
    case 'too-many-files':
      return '一次最多导入 5 个文件。';
    case 'office-file':
      return 'Office 文档请用导入文件按钮选择；拖放或粘贴拿不到可授权的本地路径。';
    case 'unsupported-type':
      return '只支持直接导入文本文件和 Office 文档。';
    case 'read-failed':
      return '读取文件失败。';
    case 'officecli_missing':
      return '本机未检测到 officecli，暂时无法导入 Office 文档内容。';
    case 'officecli_timeout':
      return 'Office 文档内容导入超时。';
    case 'officecli_failed':
      return 'Office 文档内容导入失败。';
  }
}

function folderOutlineImportFailureCopy(reason: FolderOutlineImportFailureReason): string {
  switch (reason) {
    case 'missing':
      return '所选位置不存在或不是文件夹。';
    case 'read-failed':
      return '读取文件夹目录失败。';
    case 'too-many-folders':
      return '一次最多导入 3 个文件夹目录。';
    case 'empty':
      return '这个文件夹里没有可导入的文件目录。';
  }
}

function attachmentValidationFailureCopy(reason: AttachmentValidationFailureReason): string {
  switch (reason) {
    case 'too_many_attachments':
      return '一次最多发送 8 个附件。';
    case 'unapproved_external_path':
      return '附件来源已过期，请重新选择文件后再发送。';
    case 'invalid_attachment':
      return '附件信息无效，请重新选择文件后再发送。';
  }
}

function proxyTestFailureMessage(result: TestProxyResult): string {
  const raw = redactSecrets(result.error ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower.includes('proxy disabled')) return '代理未启用，请先打开代理开关。';
  if (lower.includes('proxy host/port required')) return '请填写代理服务器地址和端口后再测试。';
  if (lower.includes('proxy test timeout') || lower.includes('timeout')) return '代理测试超时，请检查代理服务是否可达。';
  if (result.status) return `代理测试返回 HTTP ${result.status}，请检查代理服务或测试地址。`;
  const classified = generalizedErrorMessageChinese(raw, '');
  if (classified) return classified;
  if (raw && /[\u4E00-\u9FFF]/.test(raw)) return raw;
  return '代理不可达，请检查代理服务器地址、端口或认证信息。';
}

function registerIpc(): void {
  let selectedProjectRoot: string | null = null;

  async function currentProjectRoot(): Promise<string> {
    if (selectedProjectRoot) return selectedProjectRoot;
    return resolveProjectRoot([process.cwd(), app.getAppPath()]);
  }

  ipcMain.handle('window:setTitlebarControlsVisible', (event, visible: unknown): void => {
    mainWindowController.setTitlebarControlsVisible(event.sender, visible);
  });
  ipcMain.handle('app:info', async () => {
    const projectPath = await currentProjectRoot();
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
      platform: process.platform,
      arch: osArch(),
      osRelease: osRelease(),
      workspacePath: workspaceRoot,
      projectPath,
      projectGit: await resolveProjectGitInfo(projectPath),
      buildMode: buildInfo.mode,
      buildCommit: buildInfo.commit,
    };
  });
  ipcMain.handle('app:openPath', async (_event, key: string): Promise<OpenPathResult> => {
    const resolved = await resolveOpenPath({ key, workspaceRoot, projectRoot: await currentProjectRoot() });
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.path);
    if (error) return { ok: false, reason: 'open-failed' };
    return { ok: true, opened: resolved.key };
  });
  ipcMain.handle(
    'app:selectProjectDirectory',
    async (): Promise<
      | { ok: true; projectPath: string; projectGit: Awaited<ReturnType<typeof resolveProjectGitInfo>> }
      | { ok: false; reason: 'cancelled' | 'missing-selection' }
    > => {
      const result = await mainWindowController.showOpenDialog({
        title: '选择工作目录',
        properties: ['openDirectory'],
      });
      const selectedPath = result.filePaths[0];
      if (result.canceled) return { ok: false, reason: 'cancelled' };
      if (!selectedPath) return { ok: false, reason: 'missing-selection' };
      const projectPath = await resolveProjectRoot([selectedPath]);
      selectedProjectRoot = projectPath;
      return {
        ok: true,
        projectPath,
        projectGit: await resolveProjectGitInfo(projectPath),
      };
    },
  );
  ipcMain.handle('memory:getState', async (): Promise<LocalMemoryState> => localMemory.getState());
  ipcMain.handle('memory:listProposals', async () => localMemory.listProposals());
  ipcMain.handle('memory:propose', async (_event, input: unknown) => {
    const proposal = normalizeMemoryTextInput(input);
    if (!proposal) {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆提议参数无效。',
      };
    }
    return localMemory.proposeMemory({
      title: proposal.title,
      content: proposal.content,
      scope: proposal.scope,
    });
  });
  ipcMain.handle('memory:remember', async (_event, input: unknown) => {
    const memory = normalizeMemoryTextInput(input);
    if (!memory) {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆参数无效。',
      };
    }
    return localMemory.rememberUserAuthored({
      title: memory.title,
      content: memory.content,
      scope: memory.scope,
    });
  });
  ipcMain.handle('memory:approveProposal', async (_event, proposalId: unknown) => {
    if (typeof proposalId !== 'string') {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆提议 ID 无效。',
      };
    }
    return localMemory.approveProposal(proposalId);
  });
  ipcMain.handle('memory:rejectProposal', async (_event, proposalId: unknown) => {
    if (typeof proposalId !== 'string') {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆提议 ID 无效。',
      };
    }
    return localMemory.rejectProposal(proposalId);
  });
  ipcMain.handle('memory:archiveEntry', async (_event, entryId: unknown, reason: unknown) => {
    if (typeof entryId !== 'string') {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆 ID 无效。',
      };
    }
    return localMemory.archiveEntry(entryId, typeof reason === 'string' ? reason : undefined);
  });
  ipcMain.handle('memory:restoreEntry', async (_event, entryId: unknown) => {
    if (typeof entryId !== 'string') {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆 ID 无效。',
      };
    }
    return localMemory.restoreEntry(entryId);
  });
  ipcMain.handle('memory:save', async (_event, content: unknown): Promise<LocalMemoryState> => {
    if (typeof content !== 'string') return localMemory.getState();
    return localMemory.save(content);
  });
  ipcMain.handle('memory:reset', async (): Promise<LocalMemoryState> => localMemory.reset());
  ipcMain.handle('memory:restoreLatestBackup', async (): Promise<
    { ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }
  > => localMemory.restoreLatestBackup());
  ipcMain.handle('memory:restoreBackup', async (_event, kind: unknown): Promise<
    { ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }
  > => {
    if (kind !== 'save' && kind !== 'reset' && kind !== 'restore') {
      return { ok: false, state: await localMemory.getState(), message: '只能恢复已验证的 MEMORY.md 备份候选。' };
    }
    return localMemory.restoreBackup(kind);
  });
  ipcMain.handle('memory:setEnabled', async (_event, enabled: unknown): Promise<LocalMemoryState> =>
    localMemory.setEnabled(enabled === true),
  );
  ipcMain.handle('memory:setAgentReadEnabled', async (_event, enabled: unknown): Promise<LocalMemoryState> =>
    localMemory.setAgentReadEnabled(enabled === true),
  );
  ipcMain.handle('memory:openFile', async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    const resolved = await localMemory.resolveFileForOpen();
    if (!resolved.ok) return { ok: false, message: localMemoryOpenFailureCopy(resolved.reason) };
    const error = await shell.openPath(resolved.path);
    return error ? { ok: false, message: localMemoryOpenFailureCopy('open-failed') } : { ok: true };
  });
  ipcMain.handle('memory:openLatestBackup', async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    const resolved = await localMemory.resolveLatestBackupForOpen();
    if (!resolved.ok) return { ok: false, message: localMemoryBackupOpenFailureCopy(resolved.reason) };
    const error = await shell.openPath(resolved.path);
    return error ? { ok: false, message: localMemoryBackupOpenFailureCopy('open-failed') } : { ok: true };
  });
  ipcMain.handle('memory:openBackup', async (_event, kind: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (kind !== 'save' && kind !== 'reset' && kind !== 'restore') return { ok: false, message: localMemoryBackupOpenFailureCopy('not-allowed') };
    const resolved = await localMemory.resolveBackupForOpen(kind);
    if (!resolved.ok) return { ok: false, message: localMemoryBackupOpenFailureCopy(resolved.reason) };
    const error = await shell.openPath(resolved.path);
    return error ? { ok: false, message: localMemoryBackupOpenFailureCopy('open-failed') } : { ok: true };
  });
  ipcMain.handle('workspaceInstructions:getState', () => getWorkspaceInstructionsState(process.cwd()));
  ipcMain.handle(
    'workspaceInstructions:openFile',
    async (_event, file: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
      const resolved = await resolveWorkspaceInstructionFileForOpen(process.cwd(), typeof file === 'string' ? file : '');
      if (!resolved.ok) return { ok: false, message: workspaceInstructionOpenFailureCopy(resolved.reason) };
      const error = await shell.openPath(resolved.path);
      return error ? { ok: false, message: workspaceInstructionOpenFailureCopy('open-failed') } : { ok: true };
    },
  );
  ipcMain.handle(
    'workspaceInstructions:createFile',
    async (_event, file: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
      const created = await createWorkspaceInstructionFile(process.cwd(), typeof file === 'string' ? file : '');
      if (!created.ok) return { ok: false, message: workspaceInstructionCreateFailureCopy(created.reason) };
      return { ok: true };
    },
  );
  ipcMain.handle(
    'context:importTextFile',
    async (): Promise<
      | { ok: true; name: string; bytes: number; files: number; truncated: boolean; prompt: string }
      | { ok: false; reason: 'cancelled'; message: string }
      | { ok: false; reason: TextFileImportFailureReason; message: string }
    > => {
      const textFileFilters = [
        { name: 'Text', extensions: ['txt', 'text', 'md', 'markdown', 'mdx', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hh', 'hpp', 'sh', 'zsh', 'sql', 'ini', 'conf', 'env'] },
        { name: 'Office', extensions: ['docx', 'xlsx', 'pptx'] },
        { name: 'All Files', extensions: ['*'] },
      ];
      const result = await mainWindowController.showOpenDialog({
        title: '导入文件内容',
        properties: ['openFile', 'multiSelections'],
        filters: textFileFilters,
      });
      if (result.canceled || !result.filePaths[0]) {
        return { ok: false, reason: 'cancelled', message: '已取消导入。' };
      }
      const imported = await readTextFilesForPromptImport(result.filePaths);
      if (!imported.ok) {
        return { ...imported, message: textFileImportFailureCopy(imported.reason) };
      }
      return imported;
    },
  );
  ipcMain.handle(
    'context:importDroppedTextFiles',
    async (_event, payloads: unknown): Promise<
      | { ok: true; name: string; bytes: number; files: number; truncated: boolean; prompt: string }
      | { ok: false; reason: TextFileImportFailureReason; message: string }
    > => {
      const safePayloads: DroppedTextFilePayload[] = Array.isArray(payloads)
        ? payloads.map((payload) => {
            const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
            return {
              name: typeof value.name === 'string' ? value.name : '',
              size: typeof value.size === 'number' ? value.size : 0,
              type: typeof value.type === 'string' ? value.type : '',
              text: typeof value.text === 'string' ? value.text : '',
            };
          })
        : [];
      const imported = readDroppedTextFilesForPromptImport(safePayloads);
      if (!imported.ok) {
        return { ...imported, message: textFileImportFailureCopy(imported.reason) };
      }
      return imported;
    },
  );
  ipcMain.handle(
    'context:importFolderOutline',
    async (): Promise<
      | { ok: true; name: string; folders: number; entries: number; truncated: boolean; prompt: string }
      | { ok: false; reason: 'cancelled'; message: string }
      | { ok: false; reason: FolderOutlineImportFailureReason; message: string }
    > => {
      const result = await mainWindowController.showOpenDialog({
        title: '导入文件夹目录',
        properties: ['openDirectory', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths[0]) {
        return { ok: false, reason: 'cancelled', message: '已取消导入。' };
      }
      const imported = await readFolderOutlinesForPromptImport(result.filePaths);
      if (!imported.ok) {
        return { ...imported, message: folderOutlineImportFailureCopy(imported.reason) };
      }
      return imported;
    },
  );
  // Opens an artifact in Finder. Reuses the artifact-root realpath guard
  // (mirrors PR56 open-path-guard) so renderer never assembles absolute
  // paths — it only passes an artifactId; main looks up the record, runs
  // the same prefix + symlink-escape check ArtifactStore uses for
  // readText/readBinary, and only then hands the absolute path to
  // `shell.openPath`. Failure-reason shape matches `app:openPath` so the
  // renderer can route both through the same toast copy.
  ipcMain.handle(
    'app:openArtifactPath',
    async (
      _event,
      artifactId: string,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > => {
      const record = await artifactStore.get(artifactId);
      if (!record) return { ok: false, reason: 'missing' };
      if (record.status === 'deleted') return { ok: false, reason: 'missing' };
      const artifactRoot = join(workspaceRoot, 'artifacts');
      const resolved = await resolveArtifactPath({
        artifactRoot,
        relativePath: record.relativePath,
      });
      if (!resolved.ok) {
        // Map storage-layer reasons onto the openPath taxonomy so toast
        // routing in the renderer doesn't have to learn a second enum.
        if (resolved.reason === 'not_allowed') return { ok: false, reason: 'not-allowed' };
        return { ok: false, reason: 'missing' };
      }
      // "在 Finder 中打开" means reveal-in-OS, not open-with-default-app.
      // `shell.showItemInFinder` highlights the file in its containing
      // folder so the user can manually open it themselves — keeps the
      // "preview in pane is view-only, escape valve = OS" boundary
      // explicit (per §9.1.5 contract).
      shell.showItemInFolder(resolved.path);
      return { ok: true, opened: record.name };
    },
  );
  ipcMain.handle('app:saveArtifactAs', async (_event, artifactId: string): Promise<ArtifactSaveResult> => {
    const record = await artifactStore.get(artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
    const resolved = await resolveArtifactPath({
      artifactRoot: join(workspaceRoot, 'artifacts'),
      relativePath: record.relativePath,
    });
    if (!resolved.ok) {
      if (resolved.reason === 'not_allowed') return { ok: false, reason: 'not_allowed' };
      return { ok: false, reason: 'not_found' };
    }
    const saveDialogOptions = {
      title: `另存为 ${record.name}`,
      defaultPath: record.name,
    };
    const result = await mainWindowController.showSaveDialog(saveDialogOptions);
    if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' };
    try {
      await copyFile(resolved.path, result.filePath);
      return { ok: true, saved: record.name };
    } catch {
      return { ok: false, reason: 'write_failed' };
    }
  });
  ipcMain.handle('visualSmoke:getState', () => getVisualSmokeState(visualSmokeFixture));
  /**
   * PR-IR-01 screenshot capture (dev/test-only).
   *
   * Available only when `MAKA_VISUAL_SMOKE_FIXTURE` is set — refuses
   * otherwise so real users / packaged builds can't be coerced into
   * dumping the renderer to disk. The capture script
   * (`scripts/capture-screenshots.mjs`) drives this IPC after the
   * fixture finishes settling.
   *
   * Returns the absolute path of the written file or a structured
   * failure reason. The renderer never sees absolute paths (per the
   * filesystem-boundary contract); the script reads the result back
   * over IPC because it owns the screenshot directory.
   */
  ipcMain.handle(
    'visualSmoke:capture',
    async (
      _event,
      input: { scenario: string; variant: string },
    ): Promise<
      | { ok: true; path: string }
      | { ok: false; reason: 'not_in_fixture_mode' | 'invalid_input' | 'capture_failed' | 'write_failed' }
    > => {
      if (!visualSmokeFixture) return { ok: false, reason: 'not_in_fixture_mode' };
      const scenario = sanitizeSegment(input?.scenario);
      const variant = sanitizeSegment(input?.variant);
      if (!scenario || !variant) return { ok: false, reason: 'invalid_input' };
      let image: Electron.NativeImage;
      try {
        const capture = await mainWindowController.capturePage();
        if (!capture) return { ok: false, reason: 'capture_failed' };
        image = capture;
      } catch {
        return { ok: false, reason: 'capture_failed' };
      }
      const dir = join(workspaceRoot, 'screenshots', scenario);
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        return { ok: false, reason: 'write_failed' };
      }
      const filePath = join(dir, `${variant}.png`);
      try {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(filePath, image.toPNG());
      } catch {
        return { ok: false, reason: 'write_failed' };
      }
      // Deterministic stdout marker so the driver script
      // (`scripts/capture-screenshots.mjs`) can match on the line and
      // know the capture completed without polling the filesystem.
      // The line is single-token whitespace-separated so it's easy to
      // parse by regex.
      console.log(`[visual-smoke] captured scenario=${scenario} variant=${variant} path=${filePath}`);
      return { ok: true, path: filePath };
    },
  );
  ipcMain.handle('artifacts:list', (_event, sessionId: string, opts?: { includeDeleted?: boolean }) =>
    artifactStore.list(sessionId, opts),
  );
  ipcMain.handle('artifacts:get', (_event, artifactId: string) => artifactStore.get(artifactId));
  ipcMain.handle('artifacts:readText', (_event, artifactId: string) => artifactStore.readText(artifactId));
  ipcMain.handle('artifacts:readBinary', (_event, artifactId: string) => artifactStore.readBinary(artifactId));
  ipcMain.handle('artifacts:delete', async (_event, artifactId: string) => {
    await artifactStore.delete(artifactId);
    const artifact = await artifactStore.get(artifactId);
    if (artifact) {
      safeSendToRenderer('artifacts:changed', {
        reason: 'deleted',
        artifactId,
        sessionId: artifact.sessionId,
        ts: Date.now(),
      });
    }
  });
  ipcMain.handle('skills:list', async () => listInstalledSkills(workspaceRoot));
  ipcMain.handle('skills:createStarter', async () => createStarterSkill(workspaceRoot));
  ipcMain.handle('skills:open', async (_event, id: string, target: 'file' | 'directory' = 'file') => {
    const resolved = await resolveSkillOpenPath(workspaceRoot, id, target);
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.path);
    if (error) return { ok: false, reason: 'open_failed' as const };
    return { ok: true as const, target: resolved.target };
  });
  ipcMain.handle('plans:list', () => planReminders.list());
  ipcMain.handle('plans:create', async (_event, input: unknown) => {
    const privacy = await getWorkspacePrivacyContext();
    if (privacy.incognitoActive) {
      throw new Error('隐私模式已开启，不能创建计划提醒。');
    }
    return planReminders.create(input);
  });
  ipcMain.handle('plans:update', (_event, id: string, patch: unknown) =>
    planReminders.update(id, patch),
  );
  ipcMain.handle('plans:setEnabled', (_event, id: string, enabled: boolean) =>
    planReminders.setEnabled(id, enabled),
  );
  ipcMain.handle('plans:triggerNow', (_event, id: string) =>
    planReminders.triggerNow(id),
  );
  ipcMain.handle('plans:snooze', (_event, id: string) =>
    planReminders.snooze(id),
  );
  ipcMain.handle('plans:clearRunHistory', (_event, id: string) =>
    planReminders.clearRunHistory(id),
  );
  ipcMain.handle('plans:delete', async (_event, id: string) => {
    await planReminders.delete(id);
  });
  ipcMain.handle('sessions:list', (_event, filter?: SessionListFilter) => runtime.listSessions(filter));
  ipcMain.handle('sessions:create', async (_event, input?: Partial<CreateSessionInput>) => {
    const cwd = input?.cwd ?? process.cwd();
    if (input?.backend === 'fake') {
      if (!canCreateFakeSessionFromRenderer()) {
        throw new Error('FakeBackend sessions are only available in development.');
      }
      const session = await runtime.createSession({
        cwd,
        backend: 'fake',
        llmConnectionSlug: input.llmConnectionSlug ?? 'fake',
        model: input.model ?? 'fake-model',
        permissionMode: input.permissionMode ?? 'ask',
        name: input.name ?? 'New Chat',
        labels: input.labels,
      });
      emitSessionsChanged('created', session.id);
      return session;
    }

    const requestedSlug = input?.llmConnectionSlug ?? (await connectionStore.getDefault());
    const { connection, model } = await getReadyConnection(requestedSlug, input?.model);

    const session = await runtime.createSession({
      cwd,
      backend: 'ai-sdk',
      llmConnectionSlug: connection.slug,
      model,
      permissionMode: input?.permissionMode ?? 'ask',
      name: input?.name ?? 'New Chat',
      labels: input?.labels,
    });
    emitSessionsChanged('created', session.id);
    return session;
  });
  ipcMain.handle('sessions:readMessages', async (_event, sessionId: string) => {
    if (visualSmokeFixture) return store.readMessages(sessionId);
    const messages = await runtime.getMessages(sessionId);
    await runtime.markSessionRead(sessionId, latestStoredMessageTs(messages));
    return messages;
  });
  ipcMain.handle('sessions:listTurns', (_event, sessionId: string) => runtime.listTurns(sessionId));
  // PR-SEARCH-2: local thread search. Renderer-facing channel; the pure
  // helper in `./search/thread-search.ts` enforces all gates (G1 snippet
  // redaction, G2 fake-backend exclude, G4 caps, G5 case-fold + NFC,
  // G9 tool_result scan cap, G10 system/meta exclusion). The helper
  // receives the runtime via DI so unit tests stay Electron-agnostic.
  // We deliberately do NOT log the request body — query text never enters
  // telemetry.
  // ===========================================================
  // PR-OAUTH-SUBSCRIPTION-0: Claude subscription OAuth IPC.
  // All handlers return either `SubscriptionAccountState` or
  // `SubscriptionActionResult` — never raw tokens (xuan G-X3).
  //
  // kenji `1da909d5` blocking concern: Anthropic does not permit
  // third-party developers to offer Claude.ai login on behalf of
  // users. Until product/legal sign-off, the entire feature is
  // gated behind `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=1`. The
  // Settings UI also hides the card; this guard is the second line
  // of defense (a DevTools-triggered call to `window.maka` still
  // hits the experimental gate).
  // ===========================================================
  // kenji `45b31e16`: use the dedicated `experimental_disabled`
  // reason so the user-visible state is clearly "this feature is
  // not enabled by Maka" — NOT "Anthropic rejected my account".
  const experimentalDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Claude 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('claude-subscription:get-auth-url', async () => {
    // kenji `027c93c0` + xuan `2e5be5a`: when the experimental
    // flag is off, return the shared `experimental_disabled`
    // envelope so the renderer sees the same fail-closed shape as
    // every other handler in this namespace. Settings UI
    // self-gates via `isExperimentalEnabled` before reaching this;
    // the envelope path is defense-in-depth for DevTools-triggered
    // calls. Return type is now a union — renderer code checks the
    // `ok` discriminator.
    if (!isSubscriptionExperimentalEnabled()) {
      return experimentalDisabledResponse;
    }
    return claudeSubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'claude-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return claudeSubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'claude-subscription:complete-authorization',
    async (_event, authRequestId: unknown, pasted: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      const result = await claudeSubscription.completeAuthorization(authRequestId, pasted);
      if (result.ok) {
        await syncClaudeSubscriptionConnection();
        emitConnectionListChanged();
      }
      return result;
    },
  );
  ipcMain.handle(
    'claude-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return { ok: true as const };
      claudeSubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('claude-subscription:get-account-state', async () => {
    if (!isSubscriptionExperimentalEnabled()) {
      // Returning the disabled state lets the UI fail-closed: the
      // card is not rendered in the first place, but a manual call
      // surfaces a coherent state instead of an opaque throw.
      return {
        provider: 'claude-subscription' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    const state = await claudeSubscription.getAccountState();
    if (isClaudeSubscriptionAuthenticatedState(state)) {
      await syncClaudeSubscriptionConnection();
    }
    return state;
  });
  ipcMain.handle('claude-subscription:refresh-quota', async () => {
    if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
    return claudeSubscription.refreshQuota();
  });
  ipcMain.handle('claude-subscription:refresh-tokens', async () => {
    if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
    const result = await claudeSubscription.refreshTokens();
    if (result.ok) {
      await syncClaudeSubscriptionConnection();
      emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('claude-subscription:logout', async () => {
    // Logout is always allowed — even if experimental is off,
    // a user might want to clear a stale token file from a
    // previous opt-in. local-clear is harmless.
    const result = await claudeSubscription.logout();
    const existing = await connectionStore.get(CLAUDE_SUBSCRIPTION_CONNECTION_SLUG);
    if (existing) {
      await connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'Claude OAuth 已退出登录。',
      });
      emitConnectionListChanged();
    }
    return result;
  });
  /**
   * Read-only signal so the renderer's Settings card can decide
   * whether to render the Claude subscription UI at all. Returns
   * `false` when `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL` is not
   * set to `'1'`.
   */
  ipcMain.handle('claude-subscription:is-experimental-enabled', async () =>
    isSubscriptionExperimentalEnabled(),
  );

  // ===========================================================
  // PR-MODEL-OAUTH-ALL-0: Codex / Cursor / Antigravity subscription
  // IPC. Same envelope shape as `claude-subscription:*` — every
  // handler returns either a state snapshot or a
  // `SubscriptionActionResult` envelope. Tokens never cross the
  // IPC boundary; the experimental kill-switch is re-checked here
  // so a DevTools-triggered `window.maka.codexSubscription.*`
  // call cannot bypass the renderer-side hide.
  // ===========================================================
  const codexDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'OpenAI Codex 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('codex-subscription:is-experimental-enabled', async () =>
    isCodexSubscriptionExperimentalEnabled(),
  );
  ipcMain.handle('codex-subscription:get-auth-url', async () => {
    if (!isCodexSubscriptionExperimentalEnabled()) return codexDisabledResponse;
    return codexSubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'codex-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isCodexSubscriptionExperimentalEnabled()) return codexDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return codexSubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'codex-subscription:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCodexSubscriptionExperimentalEnabled()) return codexDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      const result = await codexSubscription.completeAuthorization(authRequestId);
      if (result.ok) {
        await syncCodexSubscriptionConnection();
        emitConnectionListChanged();
      }
      return result;
    },
  );
  ipcMain.handle(
    'codex-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCodexSubscriptionExperimentalEnabled()) return { ok: true as const };
      codexSubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('codex-subscription:get-account-state', async () => {
    if (!isCodexSubscriptionExperimentalEnabled()) {
      return {
        provider: 'codex-subscription' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    const state = await codexSubscription.getAccountState();
    if (isCodexSubscriptionAuthenticatedState(state)) {
      await syncCodexSubscriptionConnection();
    }
    return state;
  });
  ipcMain.handle('codex-subscription:refresh-tokens', async () => {
    if (!isCodexSubscriptionExperimentalEnabled()) return codexDisabledResponse;
    const result = await codexSubscription.refreshTokens();
    if (result.ok) {
      await syncCodexSubscriptionConnection();
      emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('codex-subscription:logout', async () => {
    // Logout is always allowed — even if experimental is off,
    // clearing a stale local token file is harmless.
    const result = await codexSubscription.logout();
    const existing = await connectionStore.get(CODEX_SUBSCRIPTION_CONNECTION_SLUG);
    if (existing) {
      await connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'Codex OAuth 已退出登录。',
      });
      emitConnectionListChanged();
    }
    return result;
  });

  const cursorDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Cursor 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('cursor-subscription:is-experimental-enabled', async () =>
    isCursorSubscriptionExperimentalEnabled(),
  );
  ipcMain.handle('cursor-subscription:get-auth-url', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
    return cursorSubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'cursor-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return cursorSubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'cursor-subscription:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return cursorSubscription.completeAuthorization(authRequestId);
    },
  );
  ipcMain.handle(
    'cursor-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return { ok: true as const };
      cursorSubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('cursor-subscription:get-account-state', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) {
      return {
        provider: 'cursor-subscription' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    return cursorSubscription.getAccountState();
  });
  ipcMain.handle('cursor-subscription:refresh-tokens', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
    return cursorSubscription.refreshTokens();
  });
  ipcMain.handle('cursor-subscription:logout', async () => {
    return cursorSubscription.logout();
  });

  const antigravityDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Google Antigravity 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('antigravity-subscription:is-experimental-enabled', async () =>
    isAntigravitySubscriptionExperimentalEnabled(),
  );
  ipcMain.handle('antigravity-subscription:get-auth-url', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
    // The service itself returns the "需要 Google client_id" envelope
    // when GOOGLE_CLIENT_ID is empty (preview status). This handler
    // just forwards.
    return antigravitySubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'antigravity-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return antigravitySubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'antigravity-subscription:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return antigravitySubscription.completeAuthorization(authRequestId);
    },
  );
  ipcMain.handle(
    'antigravity-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return { ok: true as const };
      antigravitySubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('antigravity-subscription:get-account-state', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) {
      return {
        provider: 'antigravity-subscription' as const,
        status: 'preview' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    return antigravitySubscription.getAccountState();
  });
  ipcMain.handle('antigravity-subscription:refresh-tokens', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
    return antigravitySubscription.refreshTokens();
  });
  ipcMain.handle('antigravity-subscription:logout', async () => {
    return antigravitySubscription.logout();
  });

  // PR-WEB-SEARCH-TAVILY-0: explicit user-triggered web search. Token
  // is read from settings inside main; renderer never sees it. Falls
  // back to the `apiKey` carried by the request only when present (the
  // Settings "测试" button passes a draft key so the user can validate
  // before saving). Incognito workspaces fail closed before fetch.
  const unsupportedWebSearchProviderResponse = {
    ok: false,
    reason: 'unsupported_provider' as const,
    message: '当前配置不支持这个搜索引擎，请选择 Tavily 后重试。',
  };
  ipcMain.handle(
    'web-search:query',
    async (
      _event,
      request: { query?: unknown; limit?: unknown; provider?: unknown; apiKey?: unknown },
    ) => {
      const provider = request?.provider;
      if (provider !== undefined && !isWebSearchProvider(provider)) {
        return unsupportedWebSearchProviderResponse;
      }
      const query = normalizeWebSearchQuery(request?.query);
      if (query === null) {
        return { ok: false, reason: 'invalid_query' as const, message: '请输入有效的搜索关键词。' };
      }
      const privacy = await getWorkspacePrivacyContext();
      if (privacy.incognitoActive) {
        return { ok: false, reason: 'incognito_active' as const, message: '隐身模式下禁用联网搜索。' };
      }
      const settings = await settingsStore.get();
      if (!settings.webSearch.enabled) {
        return {
          ok: false,
          reason: 'not_configured' as const,
          message: '请先在 设置 · 联网搜索 中启用 Tavily。',
        };
      }
      const effectiveKey = resolveTavilyApiKey({ settings, draftKey: request?.apiKey });
      const limit = normalizeWebSearchLimit(request?.limit);
      return queryTavily({ apiKey: effectiveKey, query, limit });
    },
  );

  ipcMain.handle(
    'web-search:test',
    async (
      _event,
      request: { provider?: unknown; apiKey?: unknown } | undefined,
    ) => {
      const provider = request?.provider;
      if (provider !== undefined && !isWebSearchProvider(provider)) {
        return unsupportedWebSearchProviderResponse;
      }
      const settings = await settingsStore.get();
      const effectiveKey = resolveTavilyApiKey({ settings, draftKey: request?.apiKey });
      return queryTavily({
        apiKey: effectiveKey,
        query: TAVILY_TEST_QUERY,
        limit: TAVILY_TEST_LIMIT,
      });
    },
  );

  ipcMain.handle('search:thread', async (_event, request: unknown) => {
    // PR-SEARCH-2 review fixup (@xuan `2f1aba55`): pass `unknown`
    // through to the helper, which runs an object-shape guard and
    // returns an `invalid_query` error envelope for null / non-object
    // / missing-field payloads. Never throws across the IPC boundary.
    //
    // PR-SEARCH-2.5 (@xuan `2c55b975`): wire `getPrivacyContext` to
    // the main-authority workspace privacy state.
    //
    // This is the main-owned workspace privacy source, not a renderer
    // self-attestation. The helper validates whatever shape is returned
    // via `validateWorkspacePrivacyContext`, so a future drift in
    // authority source is automatically fail-closed.
    return runThreadSearch(request, {
      listSessions: () => runtime.listSessions(),
      readMessages: (sessionId: string) => runtime.getMessages(sessionId),
      getPrivacyContext: getWorkspacePrivacyContext,
    });
  });
  ipcMain.handle('sessions:stop', async (_event, sessionId: string, input?: { source?: 'stop_button' }) => {
    await runtime.stopSession(sessionId, normalizeStopSessionInput(input));
    emitSessionsChanged('status-change', sessionId);
    emitSessionsChanged('turn-status-change', sessionId);
    emitSessionsChanged('message-appended', sessionId);
  });
  ipcMain.handle('sessions:respondToPermission', (_event, sessionId: string, response) =>
    runtime.respondToPermission(sessionId, normalizePermissionResponse(response)),
  );
  ipcMain.handle('sessions:send', async (event, sessionId: string, command: unknown) => {
    const sendCommand = normalizeSessionSendCommand(command);
    if (!sendCommand) return;
    await ensureSessionCanSend(sessionId);
    const attachments = validateRendererAttachments(sendCommand.attachments, {
      senderId: event.sender.id,
      approvals: attachmentApprovals,
    });
    if (!attachments.ok) {
      throw new Error(attachmentValidationFailureCopy(attachments.reason));
    }
    const turnId = sendCommand.turnId || randomUUID();
    const iterator = runtime.sendMessage(sessionId, {
      turnId,
      text: sendCommand.text,
      attachments: attachments.attachments,
    });
    void streamEvents(sessionId, iterator, turnId);
  });
  ipcMain.handle('sessions:retryTurn', async (_event, sessionId: string, input: unknown) => {
    await ensureSessionCanSend(sessionId);
    const normalized = normalizeRetryTurnInput(input);
    const turnId = normalized.turnId ?? randomUUID();
    void streamEvents(sessionId, runtime.retryTurn(sessionId, { ...normalized, turnId }), turnId);
  });
  ipcMain.handle('sessions:regenerateTurn', async (_event, sessionId: string, input: unknown) => {
    await ensureSessionCanSend(sessionId);
    const normalized = normalizeRegenerateTurnInput(input);
    const turnId = normalized.turnId ?? randomUUID();
    void streamEvents(sessionId, runtime.regenerateTurn(sessionId, { ...normalized, turnId }), turnId);
  });
  ipcMain.handle('sessions:branchFromTurn', async (_event, sessionId: string, input: unknown) => {
    const session = await runtime.branchFromTurn(sessionId, normalizeBranchFromTurnInput(input));
    emitSessionsChanged('created', session.id);
    return session;
  });
  ipcMain.handle('sessions:archive', async (_event, sessionId: string) => {
    await runtime.archive(sessionId);
    // An archived conversation is no longer shown: drop its browser connection
    // and view so it does not keep a live Chromium page in the background.
    await releaseBrowserSession(sessionId);
    emitSessionsChanged('archived', sessionId);
  });
  ipcMain.handle('sessions:unarchive', async (_event, sessionId: string) => {
    await runtime.unarchive(sessionId);
    emitSessionsChanged('updated', sessionId);
  });
  ipcMain.handle('sessions:setFlagged', async (_event, sessionId: string, isFlagged: boolean) => {
    await runtime.setFlagged(sessionId, isFlagged);
    emitSessionsChanged('pinned', sessionId);
  });
  ipcMain.handle('sessions:rename', async (_event, sessionId: string, name: string) => {
    await runtime.renameSession(sessionId, name);
    emitSessionsChanged('renamed', sessionId);
  });
  ipcMain.handle('sessions:setPermissionMode', (_event, sessionId: string, mode: unknown) => {
    if (!isPermissionMode(mode)) {
      throw new Error(`Invalid permission mode: ${String(mode)}`);
    }
    return runtime.setPermissionMode(sessionId, mode).then((session) => {
      emitSessionsChanged('mode-change', sessionId);
      return session;
    });
  });
  ipcMain.handle('sessions:setModel', async (_event, sessionId: string, input: unknown) => {
    const { llmConnectionSlug, model } = normalizeSessionModelSelection(input);
    const header = await store.readHeader(sessionId);
    if (header.status === 'running') {
      throw new Error('当前对话正在运行，等结束后再切换模型。');
    }
    if (header.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换模型。');
    }
    const ready = await getReadyConnection(llmConnectionSlug, model);
    const next = await runtime.updateSession(sessionId, {
      backend: 'ai-sdk',
      llmConnectionSlug: ready.connection.slug,
      model: ready.model,
      connectionLocked: true,
      status: 'active',
      blockedReason: undefined,
      statusUpdatedAt: Date.now(),
    });
    emitSessionsChanged('updated', sessionId, {
      connectionSlug: ready.connection.slug,
      modelId: ready.model,
    });
    return next;
  });
  ipcMain.handle('sessions:remove', async (_event, sessionId: string) => {
    await runtime.remove(sessionId);
    // Drop the conversation's browser connection and destroy its view (no-op
    // if it never opened one). releaseBrowserSession disposes the view via the
    // host, covering both agent-driven and hand-opened views.
    await releaseBrowserSession(sessionId);
    emitSessionsChanged('deleted', sessionId);
  });

  // ── Embedded browser (P3) ──────────────────────────────────────────────────
  // Provide the host the browser tools / BrowserSession resolve through. The
  // endpoint + secret it returns stay same-process and never cross these
  // renderer channels.
  // The getter reads the live shownBrowserSessionId so the host's visible-lease
  // gate (canDrive) reflects the conversation the window currently shows.
  provideBrowserViewHost(createBrowserViewHost(mainWindowController.getBrowserViews(), () => shownBrowserSessionId));

  // Never trust the renderer's target: it must be the session the calling
  // window currently shows (reported via browser:active-session). The agent
  // automation path does NOT use these channels — it uses the runtime's
  // sessionId — so this only guards the human's manual navigation.
  ipcMain.on('browser:active-session', (_event, sessionId: unknown) => {
    shownBrowserSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
    // Main owns visibility: proactively hide every other conversation's view so a
    // stale one can never float over the newly-shown conversation, regardless of
    // renderer effect ordering or a reload. The shown view is re-positioned by
    // its panel's rect mirror.
    mainWindowController.getBrowserViews().hideAllExcept(shownBrowserSessionId);
    // The visible lease is continuous: revoke any browser action still running
    // for a conversation that just went off screen, so it can't keep reading or
    // driving a hidden, logged-in page. canDrive only gates the START.
    revokeHiddenBrowserActions(shownBrowserSessionId);
  });
  const browserTargetOk = (target: unknown): target is string =>
    typeof target === 'string' && target.length > 0 && target === shownBrowserSessionId;

  // The renderer mirrors its browser panel strip's on-screen rect here so the
  // native view tracks it; a null rect (modal open / panel unmounted) hides it.
  ipcMain.on('browser:setViewport', (_event, input: { sessionId?: unknown; rect?: BrowserViewRect | null }) => {
    if (!browserTargetOk(input?.sessionId)) return;
    mainWindowController.getBrowserViews().setViewport(input.sessionId, input.rect ?? null);
  });
  // Create on first navigate so conversations that never open the browser pay nothing.
  ipcMain.handle('browser:navigate', async (_event, target: unknown, url: unknown) => {
    if (!browserTargetOk(target)) return;
    await mainWindowController.getBrowserViews().getOrCreate(target).navigate(String(url ?? ''));
  });
  ipcMain.handle('browser:back', (_event, target: unknown) => {
    if (browserTargetOk(target)) mainWindowController.getBrowserViews().get(target)?.goBack();
  });
  ipcMain.handle('browser:forward', (_event, target: unknown) => {
    if (browserTargetOk(target)) mainWindowController.getBrowserViews().get(target)?.goForward();
  });
  ipcMain.handle('browser:reload', (_event, target: unknown) => {
    if (browserTargetOk(target)) mainWindowController.getBrowserViews().get(target)?.reload();
  });
  ipcMain.handle('browser:stop', (_event, target: unknown) => {
    if (browserTargetOk(target)) mainWindowController.getBrowserViews().get(target)?.stop();
  });
  // Read-only state query, intentionally NOT gated by browserTargetOk: the panel
  // issues it from its mount effect, which runs BEFORE the parent's
  // setActiveSession updates shownBrowserSessionId. Gating it dropped the seed
  // during a conversation switch, leaving the switched-to panel stuck on its
  // empty state with the native view hidden. Reading a session's own view state
  // is not a trust boundary — only mutation (navigate/back/...) and view
  // positioning (setViewport) are, and those stay guarded.
  ipcMain.handle('browser:get-state', (_event, target: unknown) =>
    typeof target === 'string' && target.length > 0
      ? (mainWindowController.getBrowserViews().get(target)?.state() ?? null)
      : null,
  );
  // The tab's × promises "Close": destroy the conversation's page outright via
  // the same dispose chain as session delete.
  ipcMain.handle('browser:close-page', async (_event, target: unknown) => {
    if (browserTargetOk(target)) await releaseBrowserSession(target);
  });

  ipcMain.handle('connections:list', async () => {
    await syncOAuthModelConnections();
    return connectionStore.list();
  });
  ipcMain.handle('connections:getDefault', () => connectionStore.getDefault());
  ipcMain.handle('connections:setDefault', async (_event, slug: string | null) => {
    const normalizedSlug = slug === null ? null : normalizeConnectionSlugForIpc(slug, 'connection slug');
    if (normalizedSlug && !(await connectionStore.get(normalizedSlug))) {
      throw new Error(`No such connection: ${normalizedSlug}`);
    }
    await connectionStore.setDefault(normalizedSlug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:setDefaultModel', async (_event, input: { slug: string; model: string } | null) => {
    if (input === null) {
      await connectionStore.setDefault(null);
      emitConnectionListChanged();
      return;
    }
    if (!input || typeof input !== 'object' || typeof input.slug !== 'string' || typeof input.model !== 'string') {
      throw new Error('Default model input must include slug and model');
    }
    const slug = normalizeConnectionSlugForIpc(input.slug, 'connection slug');
    const model = input.model.trim();
    if (!model) throw new Error('Default model must not be empty');
    const connection = await connectionStore.get(slug);
    if (!connection) throw new Error(`No such connection: ${slug}`);
    if (!connection.enabled) throw new Error(`Connection is disabled: ${slug}`);
    const selectable = buildConnectionModelCatalogEntries({ connection })
      .some((entry) => entry.id === model && entry.canUseAsChatDefault);
    if (!selectable) {
      throw new Error(`Model is not available for chat default: ${model}`);
    }
    if (connection.defaultModel !== model) {
      await connectionStore.update(slug, { defaultModel: model });
    }
    await connectionStore.setDefault(slug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:create', async (_event, input: CreateConnectionInput) => {
    // PR-UI-IPC-1 (@kenji msg 35260e29 + 8755ffb3 + 6b638e08):
    // baseUrl is a credentials-exfiltration boundary. Normalize
    // BEFORE the store ever sees the input — `javascript:` /
    // `file:///etc/passwd` / garbage MUST NOT persist, AND raw
    // whitespace-padded strings MUST NOT slip past as overrides.
    // Localhost and private-network URLs are intentionally allowed
    // (Ollama, LM Studio, vLLM). See `normalizeConnectionBaseUrl`
    // JSDoc.
    //
    // Construct a NEW `normalizedInput` rather than mutating
    // `input` — avoids any chance of later handler logic or
    // reference aliasing seeing the raw renderer payload.
    //
    // OAuth subscription connections are stricter than API-key
    // connections: their access token is provider-bound, so the
    // renderer must never be able to redirect it to a custom baseUrl.
    const normalizedInput = normalizeCreateConnectionInput(input);
    const connection = await connectionStore.create(normalizedInput);
    if (normalizedInput.apiKey) {
      await credentialStore.setSecret(connection.slug, 'api_key', normalizedInput.apiKey);
    }
    emitConnectionListChanged();
    return connection;
  });
  ipcMain.handle('connections:update', async (_event, slug: string, patch: UpdateConnectionInput) => {
    // PR-UI-IPC-1 same boundary on update. `patch.baseUrl ===
    // undefined` means "don't touch" — skip validation entirely and
    // don't include the key in the normalized patch.
    //
    // EXPLICIT CLEAR INTENT: when the user types whitespace into
    // the baseUrl form field, the renderer sends a string (often
    // `''` or `'   '`). After normalize, that becomes `''`, which
    // the store's existing
    // `patch.baseUrl !== undefined ? patch.baseUrl || undefined : current.baseUrl`
    // clears as an explicit override removal. Preserve that —
    // don't convert to `undefined` (which would silently swallow
    // the clear intent as "don't touch"). @kenji msg 6b638e08.
    //
    // Same OAuth-boundary rule as create: if the current/new provider
    // uses an OAuth token, force the canonical provider endpoint and
    // ignore renderer-provided baseUrl text entirely.
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    const normalizedPatch = await normalizeUpdateConnectionInput(slug, patch);
    const connection = await connectionStore.update(slug, normalizedPatch);
    if (normalizedPatch.apiKey !== undefined) {
      if (normalizedPatch.apiKey) await credentialStore.setSecret(slug, 'api_key', normalizedPatch.apiKey);
      else await credentialStore.deleteSecret(slug, 'api_key');
    }
    emitConnectionListChanged();
    return connection;
  });
  ipcMain.handle('connections:delete', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    await connectionStore.delete(slug);
    await credentialStore.deleteSecret(slug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:test', async (_event, slug: string, opts?: { model?: string }) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    const connection = await connectionStore.get(slug);
    if (!connection) return { ok: false, errorMessage: `找不到模型连接：${slug}` };
    const apiKey = await resolveConnectionSecret(slug);
    if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'none' && !apiKey) {
      return {
        ok: false,
        errorMessage: PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token'
          ? '这个 OAuth 模型连接还没有登录'
          : '这个模型连接还没有保存 API key',
        errorClass: 'auth',
      };
    }
    const result = await testConnection(connection, apiKey ?? '', opts?.model);
    await connectionStore.update(slug, connectionTestStatusPatch(result));
    emitConnectionListChanged();
    return result;
  });
  ipcMain.handle('connections:fetchModels', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    const connection = await connectionStore.get(slug);
    if (!connection) throw new Error(`找不到模型连接：${slug}`);
    const apiKey = await resolveConnectionSecret(slug);
    if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'none' && !apiKey) {
      throw new Error(PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token'
        ? '这个 OAuth 模型连接还没有登录'
        : '这个模型连接还没有保存 API key');
    }
    try {
      const fetchedAt = Date.now();
      const models = await fetchProviderModels(connection, apiKey ?? '');
      await connectionStore.update(slug, {
        models,
        modelSource: 'fetched',
        modelsFetchedAt: fetchedAt,
      });
      emitConnectionListChanged();
      return {
        models,
        source: 'fetched',
        fetchedAt,
      };
    } catch (error) {
      throw new Error(generalizedErrorMessageChinese(error, '拉取模型列表失败'));
    }
  });
  ipcMain.handle('connections:hasSecret', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    return Boolean(await resolveConnectionSecret(slug));
  });

  // PR110b: Onboarding snapshot + milestone IPCs. Renderer polls via
  // these on app load and whenever `sessions:changed` /
  // `connections:changed` / settings change events fire. No push from
  // main; see smoke.md Path 16.
  ipcMain.handle('onboarding:getSnapshot', async () => onboardingService.getSnapshot());
  ipcMain.handle('onboarding:setMilestone', async (_event, id: unknown, status: unknown) => {
    // Service throws INVALID_MILESTONE_ID / INVALID_MILESTONE_STATUS
    // for bad inputs; let the error propagate so the renderer sees
    // it as a typed reject rather than silently swallowing.
    return onboardingService.setMilestone(id, status);
  });
  ipcMain.handle('onboarding:clearMilestone', async (_event, id: unknown) => {
    return onboardingService.clearMilestone(id);
  });
  // PR110b: Quick Chat entry. Input shape is intentionally minimal —
  // `{ prompt?: string }` — to keep readiness gating airtight. Override
  // surfaces (connectionSlug / model) will land in PR110c/d when the
  // model-picker UI is ready.
  ipcMain.handle('quickChat:start', async (_event, input: unknown) => {
    return handleQuickChatStart(input);
  });

  ipcMain.handle('permissions:getSnapshot', () => buildPermissionSnapshot());
  ipcMain.handle('permissions:openSystemSettings', async (_event, permId: unknown) => {
    return openSystemPermissionPane(permId);
  });
  ipcMain.handle('permissions:requestAccess', async (_event, permId: unknown) => {
    return requestPermissionAccess(permId);
  });
  ipcMain.handle('capabilities:getSnapshot', async () => {
    const permissions = buildPermissionSnapshot();
    const settings = await settingsStore.get();
    const officeCliProbe = await probeOfficeCli({ now: permissions.checkedAt });
    return buildCapabilitySnapshotCollection({
      settings,
      permissions,
      botStatuses: botRegistry.allStatuses(),
      officeCliProbe,
      now: permissions.checkedAt,
    });
  });
  ipcMain.handle('health:getSnapshot', async () => {
    const now = Date.now();
    const permissions = buildPermissionSnapshot(now);
    const settings = await settingsStore.get();
    const officeCliProbe = await probeOfficeCli({ now });
    const capabilitySnapshot = buildCapabilitySnapshotCollection({
      settings,
      permissions,
      botStatuses: botRegistry.allStatuses(),
      officeCliProbe,
      now,
    });
    const connections = await connectionStore.list();
    const connectionSignals = connections.flatMap((connection) => [
      healthSignalFromConnection(connection, now),
      healthSignalFromConnectionRuntime(
        connection,
        telemetryRepo.latestLlmRuntimeProbe(connection.slug, connection.defaultModel),
        now,
      ),
    ].filter((signal): signal is NonNullable<typeof signal> => Boolean(signal)));
    return buildHealthSnapshot(now, [
      ...connectionSignals,
      ...capabilitySnapshot.capabilities.map(healthSignalFromCapability),
    ]);
  });

  ipcMain.handle('settings:get', async () => maskAppSettings(await settingsStore.get()));
  ipcMain.handle('settings:update', async (_event, patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult> => {
    const normalizedPatch = await normalizeSettingsPatch(patch);
    const next = await settingsStore.update(normalizedPatch);
    await applySettingsRuntimeEffects(next, patch);
    return buildSettingsUpdateResult(next, patch);
  });
  ipcMain.handle('gateway:status', async () => openGateway.getStatus());
  ipcMain.handle('settings:testNetworkProxy', async (_event, input: TestProxyInput = {}) => {
    const started = Date.now();
    const stored = toContractNetworkSettings((await settingsStore.get()).network).proxy;
    const proxy = input.proxy?.password === SENSITIVE_PLACEHOLDER
      ? { ...input.proxy, password: stored.password }
      : input.proxy;
    const testedProxy = proxy ?? stored;
    const result = await testProxyConnection({ ...input, proxy }, stored);
    const latencyMs = result.latencyMs ?? (Date.now() - started);
    if (!result.ok) {
      return {
        ok: false,
        message: proxyTestFailureMessage(result),
        latencyMs,
      } satisfies SettingsTestResult;
    }
    return {
      ok: true,
      message: result.ip
        ? `代理配置有效：${testedProxy.type}://${testedProxy.host}:${testedProxy.port} · ${result.countryFlag ?? ''} ${result.ip}`.trim()
        : `代理配置有效：${testedProxy.type}://${testedProxy.host}:${testedProxy.port}`,
      latencyMs,
      details: {
        status: result.status,
        ip: result.ip,
        countryCode: result.countryCode,
        countryFlag: result.countryFlag,
        bypassList: testedProxy.bypassList,
      },
    } satisfies SettingsTestResult;
  });
  ipcMain.handle('settings:testBotChannel', async (_event, provider: BotProvider) => {
    const settings = await settingsStore.get();
    const result = await testRuntimeBotChannel(provider, settings.botChat.channels[provider]);
    await settingsStore.update({
      botChat: {
        channels: {
          [provider]: {
            connected: result.ok,
            readiness: result.ok ? 'credentials_valid' : 'configured',
            readinessReason: result.ok ? undefined : botTestErrorMessage(provider, result.error),
            readinessUpdatedAt: Date.now(),
            lastTestAt: Date.now(),
            lastError: result.ok ? undefined : botTestErrorMessage(provider, result.error),
          },
        },
      },
    });
    const next = await settingsStore.get();
    await applySettingsRuntimeEffects(next, { botChat: { channels: { [provider]: {} } } });
    return toSettingsTestResult(provider, result);
  });
  ipcMain.handle('settings:bots:listStatuses', () =>
    tryResult(async () => botRegistry.allStatuses(), 'BOTS_STATUS_FAILED'),
  );
  ipcMain.handle('settings:bots:restart', (_event, provider: BotProvider) =>
    tryResult(async () => {
      const settings = await settingsStore.get();
      await botRegistry.applySettings(settings.botChat);
      return botRegistry.getStatus(provider);
    }, 'BOTS_RESTART_FAILED'),
  );

  // PR-BOT-WECHAT-QR-MODAL-0 (WAWQAQ msg `10ec1fbe`): WeChat ClawBot
  // scan-login. Renderer triggers the QR fetch from the modal, then
  // polls the status endpoint until 'confirmed' or 'expired'. Main
  // process owns the actual HTTP calls so the renderer never sees
  // raw response bodies.
  ipcMain.handle('settings:bots:wechat:fetchQrcode', () =>
    tryWeChatQrResult(async () => fetchWeChatQrcode(), 'WECHAT_QR_FETCH_FAILED'),
  );
  ipcMain.handle('settings:bots:wechat:pollQrcodeStatus', (_event, qrToken: unknown) =>
    tryWeChatQrResult(async () => {
      if (typeof qrToken !== 'string' || !qrToken) {
        throw new Error('qrToken must be a non-empty string');
      }
      return pollWeChatQrcodeStatus(qrToken);
    }, 'WECHAT_QR_STATUS_FAILED'),
  );
  ipcMain.handle('settings:bots:wechatQrCode', async () => {
    const settings = await settingsStore.get();
    return getWechatBridgeQrCode(settings.botChat.channels.wechat);
  });
  ipcMain.handle('settings:usageStats', (_event, range?: UsageRange) =>
    settingsStore.usageStats(range),
  );
  ipcMain.handle('usage:summary', (_event, query: UsageQuery) =>
    tryResult(async () => telemetryRepo.summary(query), 'USAGE_SUMMARY_FAILED'),
  );
  // PR-DAILY-REVIEW-MVP-0: bundle one day's telemetry + session
  // metadata into a single IPC payload so the renderer panel does not
  // have to fan out 4 IPC calls of its own. All reads are local: the
  // existing telemetry repo + session list. No new disk/network IO.
  ipcMain.handle(
    'daily-review:day',
    (
      _event,
      payload: { offsetDays?: number; daySpan?: number } | undefined,
    ) =>
      tryResult(async (): Promise<DailyReviewSummary> => {
        const offset = Number.isFinite(payload?.offsetDays) ? Math.trunc(payload!.offsetDays!) : 0;
        const rawSpan = Number.isFinite(payload?.daySpan) ? Math.trunc(payload!.daySpan!) : 1;
        return dailyReview.buildSummaryForRange(offset, rawSpan);
      }, 'DAILY_REVIEW_DAY_FAILED'),
  );
  ipcMain.handle('daily-review:getConfig', () => dailyReviewArchiveStore.getConfig());
  ipcMain.handle('daily-review:setConfig', (_event, patch: Partial<DailyReviewConfig>) =>
    dailyReviewArchiveStore.setConfig(patch),
  );
  ipcMain.handle(
    'daily-review:runOnce',
    (_event, input: { mode?: DailyReviewMode; day?: number; modelKey?: string } | undefined) =>
      dailyReview.run({
        mode: input?.mode === 'deep' ? 'deep' : 'daily',
        day: Number.isFinite(input?.day) ? Math.trunc(input!.day!) : undefined,
        modelKeyOverride: typeof input?.modelKey === 'string' ? input.modelKey : undefined,
        trigger: 'manual',
      }),
  );
  ipcMain.handle('daily-review:list', () => dailyReviewArchiveStore.listArchives());
  ipcMain.handle('daily-review:get', (_event, archiveId: string) =>
    dailyReviewArchiveStore.getArchive(archiveId),
  );
  ipcMain.handle('daily-review:delete', async (_event, archiveId: string) => {
    await dailyReviewArchiveStore.deleteArchive(archiveId);
  });
  /**
   * PR-DAILY-REVIEW-EXPORT-FILE-0: save a renderer-formatted Daily
   * Review markdown to a user-chosen file. The markdown is rendered
   * renderer-side (where the human-readable title context lives) and
   * shipped here as bytes; this handler is purely the save dialog +
   * write. Defensive shape check on the input so a misbehaving caller
   * cannot e.g. force a 100 MB string write.
   */
  ipcMain.handle(
    'daily-review:saveMarkdownToFile',
    (_event, input: { markdown?: unknown; defaultName?: unknown } | undefined) =>
      saveMarkdownViaDialog(input, '保存今日回顾'),
  );
  // PR-CMD-PALETTE-SAVE-CONVERSATION-FILE-0: chat-side companion to the
  // daily review export. Renderer formats the current session as
  // Markdown (existing `renderConversationMarkdown`) and ships the bytes
  // here; main owns the save dialog + write. Same input shape + cap as
  // the daily-review handler so the renderer can treat both IPCs
  // interchangeably.
  ipcMain.handle(
    'chat:saveConversationToFile',
    (_event, input: { markdown?: unknown; defaultName?: unknown } | undefined) =>
      saveMarkdownViaDialog(input, '保存当前对话'),
  );
  ipcMain.handle('usage:buckets', (_event, query: UsageQuery & { groupBy: UsageGroupBy }) =>
    tryResult(async () => telemetryRepo.buckets(query, query.groupBy), 'USAGE_BUCKETS_FAILED'),
  );
  ipcMain.handle('usage:logs', (_event, query: UsageQuery & { offset?: number; limit?: number }) =>
    tryResult(async () => telemetryRepo.logs(query, query.offset, query.limit), 'USAGE_LOGS_FAILED'),
  );
  ipcMain.handle('usage:pricing:list', () =>
    tryResult(async () => telemetryRepo.listPricingOverrides(), 'USAGE_PRICING_LIST_FAILED'),
  );
  ipcMain.handle('usage:pricing:put', (_event, pricing: unknown) =>
    // PR-UI-IPC-3 (@kenji msg 9033abdf): normalize at the IPC
    // store boundary. Telemetry repo only ever sees the canonical
    // `PricingConfig` shape — required rates are finite >= 0,
    // optional cache rates are either omitted or finite >= 0,
    // modelKey is trimmed + non-empty + length-capped, extra
    // fields stripped. Bad payload throws a typed error to the
    // renderer; nothing reaches `telemetryRepo.upsertPricing`.
    tryResult(async () => {
      const normalized = normalizePricingConfig(pricing);
      if (!normalized.ok) {
        throw new Error(normalized.error);
      }
      await telemetryRepo.upsertPricing(normalized.value);
      lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
      safeSendToRenderer('usage:pricing:changed');
      return normalized.value;
    }, 'USAGE_PRICING_PUT_FAILED'),
  );
  ipcMain.handle('usage:pricing:reset', (_event, modelKey: unknown) =>
    // PR-UI-IPC-3: same modelKey gate as put. Without this, reset
    // could crash on a non-string key (e.g. `localeCompare`
    // operates on the stored keys) or pass an empty string that
    // matches an orphan entry. Sharing the helper means put + reset
    // can't drift.
    tryResult(async () => {
      const keyResult = normalizePricingModelKey(modelKey);
      if (!keyResult.ok) {
        throw new Error(keyResult.error);
      }
      await telemetryRepo.deletePricing(keyResult.value);
      lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
      safeSendToRenderer('usage:pricing:changed');
    }, 'USAGE_PRICING_RESET_FAILED'),
  );

}

function canCreateFakeSessionFromRenderer(): boolean {
  return !app.isPackaged && (
    Boolean(visualSmokeFixture) ||
    Boolean(process.env.VITE_DEV_SERVER_URL) ||
    process.env.NODE_ENV === 'development'
  );
}

async function normalizeSettingsPatch(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsInput> {
  const current = await settingsStore.get();
  return preserveSensitivePlaceholders(patch, current);
}

async function applySettingsRuntimeEffects(settings: AppSettings, patch: UpdateAppSettingsInput): Promise<void> {
  if (patch.network) {
    const network = toContractNetworkSettings(settings.network);
    setActiveProxy(network.proxy);
    safeSendToRenderer('settings:network:changed', maskNetworkSettings(network));
  }
  if (patch.botChat) {
    await botRegistry.applySettings(settings.botChat);
  }
  if (patch.openGateway) {
    const status = await openGateway.sync(settings.openGateway);
    safeSendToRenderer('gateway:statusChanged', status);
  }
}

async function streamEvents(
  sessionId: string,
  iterator: AsyncIterable<SessionEvent>,
  fallbackTurnId?: string,
): Promise<void> {
  let userAppendBroadcasted = false;
  let finalAppendBroadcasted = false;
  try {
    for await (const event of iterator) {
      if (!userAppendBroadcasted) {
        emitSessionsChanged('message-appended', sessionId);
        userAppendBroadcasted = true;
      }
      safeSendToRenderer(`sessions:event:${sessionId}`, event);
      openGateway.publishSessionEvent(sessionId, event);
      if (isStatusChangingSessionEvent(event)) {
        emitSessionsChanged('status-change', sessionId);
      }
      if (isTurnStatusChangingSessionEvent(event)) {
        emitSessionsChanged('turn-status-change', sessionId);
      }
    }
    if (!finalAppendBroadcasted) {
      emitSessionsChanged('message-appended', sessionId);
      finalAppendBroadcasted = true;
    }
  } catch (error) {
    const event = {
      type: 'error',
      id: randomUUID(),
      turnId: fallbackTurnId ?? randomUUID(),
      ts: Date.now(),
      recoverable: false,
      code: errorCode(error),
      reason: errorReason(error),
      message: errorMessage(error),
    } satisfies SessionEvent;
    safeSendToRenderer(`sessions:event:${sessionId}`, event);
    openGateway.publishSessionEvent(sessionId, event);
    emitSessionsChanged('status-change', sessionId);
    emitSessionsChanged('turn-status-change', sessionId);
    if (!finalAppendBroadcasted) {
      emitSessionsChanged('message-appended', sessionId);
      finalAppendBroadcasted = true;
    }
  }
}

function isStatusChangingSessionEvent(event: SessionEvent): boolean {
  return event.type === 'permission_request' ||
    event.type === 'permission_decision_ack' ||
    event.type === 'complete' ||
    event.type === 'abort' ||
    event.type === 'error';
}

function latestStoredMessageTs(messages: readonly StoredMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (Number.isFinite(message.ts)) latest = latest === undefined ? message.ts : Math.max(latest, message.ts);
  }
  return latest;
}

function isTurnStatusChangingSessionEvent(event: SessionEvent): boolean {
  return event.type === 'complete' || event.type === 'abort' || event.type === 'error';
}

async function ensureSessionCanSend(sessionId: string): Promise<void> {
  const header = await store.readHeader(sessionId);
  let result: Awaited<ReturnType<typeof ensureSessionCanSendOrRebind>>;
  try {
    result = await ensureSessionCanSendOrRebind(sessionId, header, {
      readyConnectionDeps,
      getDefaultSlug: () => connectionStore.getDefault(),
      updateSession: (_sessionId, patch) => runtime.updateSession(_sessionId, {
        ...patch,
        status: 'active',
        blockedReason: undefined,
        statusUpdatedAt: Date.now(),
      }),
    });
  } catch (error) {
    await runtime.setSessionStatus(sessionId, 'blocked', 'NO_REAL_CONNECTION').catch(() => {});
    emitSessionsChanged('status-change', sessionId);
    throw error;
  }
  if (result.rebound) {
    emitSessionsChanged('rebound', sessionId, {
      connectionSlug: result.connectionSlug,
      modelId: result.modelId,
    });
  }
}

const readyConnectionDeps = {
  getConnection: (slug: string) => connectionStore.get(slug),
  getApiKey: (slug: string) => resolveConnectionSecret(slug),
};

function getReadyConnection(slug: string | null | undefined, model?: string) {
  return requireReadyConnection(slug, readyConnectionDeps, model);
}

/**
 * PR110b: Quick Chat entry — thin adapter over the extracted helper.
 * The discriminated-union logic + readiness gating lives in
 * `./quick-chat.ts` so it can be unit-tested without spinning up an
 * Electron app.
 */
async function handleQuickChatStart(rawInput: unknown): Promise<QuickChatResult> {
  return runQuickChatStart(rawInput, {
    getOnboardingState: async () => (await onboardingService.getSnapshot()).state,
    createSession: async (input) => {
      // Re-run requireReadyConnection inside the create path to close
      // the race window between `getSnapshot()` and `createSession()`
      // (e.g. user revoked credential in another window).
      const ready = await getReadyConnection(input.defaultConnectionSlug, input.defaultModel);
      return runtime.createSession({
        cwd: process.cwd(),
        backend: 'ai-sdk',
        llmConnectionSlug: ready.connection.slug,
        model: ready.model,
        permissionMode: input.mode === 'deep_research' ? 'explore' : 'ask',
        name: input.mode === 'deep_research' ? 'Deep Research' : 'New Chat',
        labels: input.mode === 'deep_research' ? [DEEP_RESEARCH_SESSION_LABEL] : [],
      });
    },
    emitCreated: (sessionId) => emitSessionsChanged('created', sessionId),
    ensureCanSend: (sessionId) => ensureSessionCanSend(sessionId),
    sendFirstMessage: async (sessionId, text) => {
      // @xuan PR110b: do NOT return the turnId — its lifetime / id
      // ownership belongs to SessionManager + the eventual
      // sessions:event stream, not to Quick Chat. The user message
      // id is generated inside `runtime.sendMessage()`.
      const turnId = randomUUID();
      const iterator = runtime.sendMessage(sessionId, { turnId, text });
      void streamEvents(sessionId, iterator, turnId);
    },
  });
}

function normalizeMemoryTextInput(input: unknown): {
  title: string;
  content: string;
  scope?: 'workspace' | 'session';
} | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (typeof value.title !== 'string' || typeof value.content !== 'string') return null;
  const scope = value.scope === 'session' ? 'session' : value.scope === 'workspace' ? 'workspace' : undefined;
  return {
    title: value.title,
    content: value.content,
    ...(scope ? { scope } : {}),
  };
}

function emitConnectionListChanged(): void {
  const event: ConnectionEvent = {
    type: 'connection_list_changed',
    id: randomUUID(),
    ts: Date.now(),
  };
  safeSendToRenderer('connections:event', event);
}

function emitSessionsChanged(
  reason: SessionChangedReason,
  sessionId?: string,
  extra?: Pick<SessionChangedEvent, 'connectionSlug' | 'modelId'>,
): void {
  const event: SessionChangedEvent = {
    type: 'sessions_changed',
    reason,
    ts: Date.now(),
  };
  if (sessionId) event.sessionId = sessionId;
  if (extra?.connectionSlug) event.connectionSlug = extra.connectionSlug;
  if (extra?.modelId) event.modelId = extra.modelId;
  safeSendToRenderer('sessions:changed', event);
}

function normalizeSessionModelSelection(input: unknown): { llmConnectionSlug: string; model: string } {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid model selection');
  }
  const record = input as Record<string, unknown>;
  const llmConnectionSlug = typeof record.llmConnectionSlug === 'string' ? record.llmConnectionSlug.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!llmConnectionSlug) {
    throw new Error('Missing model connection');
  }
  if (!model) {
    throw new Error('Missing model');
  }
  return { llmConnectionSlug, model };
}

async function recoverInterruptedSessionsOnStartup(): Promise<void> {
  try {
    await runtime.recoverInterruptedSessions();
  } catch {
    // Best-effort: startup should still reach the renderer so users can inspect
    // and repair any remaining local session state.
  }
}

async function ensureBootstrapConnection(): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  if ((await connectionStore.list()).length > 0) return;

  if (process.env.ANTHROPIC_API_KEY) {
    const slug = 'env-anthropic';
    await connectionStore.create({
      slug,
      name: 'Anthropic (env)',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });
    await credentialStore.setSecret(slug, 'api_key', process.env.ANTHROPIC_API_KEY);
    await connectionStore.setDefault(slug);
    return;
  }

  if (process.env.OPENAI_API_KEY) {
    const slug = 'env-openai';
    await connectionStore.create({
      slug,
      name: 'OpenAI (env)',
      providerType: 'openai',
      defaultModel: 'gpt-4o-mini',
    });
    await credentialStore.setSecret(slug, 'api_key', process.env.OPENAI_API_KEY);
    await connectionStore.setDefault(slug);
  }
}

registerIpc();

app.whenReady().then(async () => {
  // PR-GRAY-CARD-LIFT-0 (WAWQAQ msg `0eb99429` 2026-06-20): set the
  // app's dock icon (macOS) so the dev `npm start` run shows Maka's
  // brand mark instead of the generic Electron icon. Packaged
  // builds get the icon via .app bundle Info.plist; this covers the
  // dev path.
  if (process.platform === 'darwin' && app.dock) {
    if (process.env.MAKA_VISUAL_SMOKE_FIXTURE) {
      // PR-VISUAL-SMOKE-HEADLESS: hide the dock icon so the spawned
      // Electron runs as an accessory app — no dock bounce, and it
      // never becomes frontmost / steals focus from the developer's
      // active window during a capture run.
      app.dock.hide();
    } else {
      try {
        const iconPath = join(import.meta.dirname, '..', '..', 'assets', 'icon.png');
        app.dock.setIcon(nativeImage.createFromPath(iconPath));
      } catch (error) {
        console.error('[icon] failed to set dock icon:', error);
      }
    }
  }

  // One-time migration of credentials.json off Electron safeStorage so
  // the pure-Node runtime can read it (issue #32). Runs before any
  // credential read/write below; failure is non-fatal (legacy file is
  // left intact and later credential reads fail closed with guidance).
  try {
    await migrateLegacyCredentials(workspaceRoot, safeStorage);
  } catch (error) {
    console.error('[credentials] migration off safeStorage failed; legacy file left intact:', error);
  }
  if (visualSmokeFixture) {
    console.log(`[visual-smoke] scenario=${visualSmokeFixture.scenario} workspace=${workspaceRoot}`);
    await seedVisualSmokeFixture({ workspaceRoot, fixture: visualSmokeFixture, credentialStore });
  } else {
    await ensureBootstrapConnection();
  }
  const settings = await settingsStore.get();
  setActiveProxy(toContractNetworkSettings(settings.network).proxy);
  await telemetryRepo.load();
  lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
  await recoverInterruptedSessionsOnStartup();
  await botRegistry.applySettings(settings.botChat);
  await openGateway.sync(settings.openGateway);
  await mainWindowController.createWindow();
  await planReminders.refreshTimers();
  dailyReview.startScheduler();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  planReminders.stopTimers();
  dailyReview.stopScheduler();
  void botRegistry.stopAll();
  void openGateway.stop();
  void mainWindowController.disposeBrowserViews();
});

app.on('activate', () => {
  if (!mainWindowController.hasOpenWindows()) void mainWindowController.createWindow();
});
