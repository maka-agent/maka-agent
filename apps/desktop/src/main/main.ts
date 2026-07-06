import { app, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { startConfigFileWatcher, type ConfigFileWatcher } from './config-file-watcher.js';
import { release as osRelease, arch as osArch } from 'node:os';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
  redactSecrets,
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  healthSignalFromConnectionRuntime,
  isPermissionMode,
  isThinkingLevel,
  thinkingVariantsForModel,
  resolveModelVisionSupport,
  DEEP_RESEARCH_SESSION_LABEL,
  botDisplayLabel,
  humanizeBotStatusReason,
} from '@maka/core';
import type {
  AppSettings,
  BotProvider,
  BotReadinessState,
  ConnectionEvent,
  CreateSessionInput,
  PermissionMode,
  SessionChangedEvent,
  SessionChangedReason,
  SessionEvent,
  SessionHeader,
  SessionListFilter,
  ThinkingLevel,
  StoredMessage,
  SettingsTestResult,
  UpdateAppSettingsResult,
  UpdateAppSettingsInput,
} from '@maka/core';
import { buildWebSearchAgentTool, WEB_SEARCH_TOOL_NAME } from './web-search/agent-tool.js';
import { buildRiveWorkflowTool } from './rive-workflow-tool.js';
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
import { ClaudeSubscriptionService } from './oauth/claude-subscription-service.js';
import { CodexSubscriptionService } from './oauth/codex-subscription-service.js';
import { CursorSubscriptionService } from './oauth/cursor-subscription-service.js';
import { AntigravitySubscriptionService } from './oauth/antigravity-subscription-service.js';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';
import type { LlmCallRecord, PricingConfig, ToolInvocationRecord } from '@maka/core/usage-stats/types';
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
  getAIModel,
  buildProviderOptions,
  recordLlmCall,
  recordToolInvocation,
  buildPricingLookup,
  BotRegistry,
  getWechatBridgeQrCode,
  testBotChannel as testRuntimeBotChannel,
  setActiveProxy,
} from '@maka/runtime';
import type {
  BotIncomingMessage,
  BotStatus,
  MakaTool,
  ToolAvailabilityConfig,
  ToolArtifactRecorderInput,
  ToolResultArchiveReaderInput,
  ToolResultArchiveReadResult,
  ToolResultArchiveRecorderInput,
} from '@maka/runtime';
import { testProxyConnection } from '@maka/runtime/network/proxy-test';
import { fetchWeChatQrcode, pollWeChatQrcodeStatus } from './wechat-scan-login.js';
import type { LlmConnection, ProviderType } from '@maka/core/llm-connections';
import { createAgentRunStore, createArtifactStore, createConnectionStore, createPlanReminderStore, createRuntimeEventStore, createSessionStore, createSettingsStore, createTelemetryRepo } from '@maka/storage';
import {
  ensureSessionCanSendOrRebind,
  errorCode,
  errorMessage,
  errorReason,
  requireReadyConnection,
} from './chat-readiness.js';
import {
  sessionReadMessagesFailureMessage,
} from './session-read-error-copy.js';
import { createFileCredentialStore, migrateLegacyCredentials } from './credential-store.js';
import { bindOnboardingDeps, createOnboardingService } from './onboarding-service.js';
import { handleQuickChatStart as runQuickChatStart, type QuickChatResult } from './quick-chat.js';
import { probeOfficeCli } from './officecli-probe.js';
import { resolveOpenPath, type OpenPathResult } from './open-path-guard.js';
import { resolveProjectGitInfo, resolveProjectRoot } from '@maka/runtime';
import { listLocalBranches, checkoutBranch } from './git-branch.js';
import { createDailyReviewArchiveStore } from './daily-review-archive-store.js';
import { botTestErrorMessage, buildSettingsUpdateResult, maskAppSettings, preserveSensitivePlaceholders, toSettingsTestResult } from './settings-ipc-helpers.js';
import {
  buildSkillAgentTool,
  ensureBundledOfficeSkills,
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
import { resolveDefaultPermissionMode } from './permission-mode-default.js';
import {
  getVisualSmokeState,
  resolveVisualSmokeFixture,
  seedVisualSmokeFixture,
} from './visual-smoke-fixture.js';
import { resolveBuildInfo } from './build-info.js';
import { OpenGatewayService } from './open-gateway.js';
import { LocalMemoryService } from './local-memory-service.js';
import { createAttachmentApprovalRegistry } from './attachment-approval.js';
import { createAttachmentByteReader } from './attachment-reader.js';
import { resizeImageForAttachment } from './attachment-resize-native.js';
import { resolveSessionSend } from './session-send-resolve.js';
import { buildExploreAgentTool } from './explore-agent-tool.js';
import { buildOfficeDocumentEditTool, buildOfficeDocumentTool } from './office-document-tool.js';
import {
  buildLlmHistorySummarizer,
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
} from '@maka/runtime';
import {
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
} from './synthesis-cache-artifacts.js';
import { buildBrowserTools } from './browser/browser-tools.js';
import { releaseBrowserSession } from './browser/session.js';
import { createMainWindowController } from './main-window.js';
import { createDailyReviewMainService } from './daily-review-main.js';
import { createPlanReminderMainService } from './plan-reminders-main.js';
import { createBotIncomingMainService } from './bot-incoming-main.js';
import { createSubscriptionModelFetch } from './subscription-model-fetch.js';
import { buildDefaultContextBudgetPolicy } from '@maka/runtime';
import { createSystemPromptMainService } from './system-prompt-main.js';
import { createMainTaskLedgerWiring } from './task-ledger-wiring.js';
import { createOAuthModelConnectionsMainService } from './oauth-model-connections-main.js';
import {
  applyNetworkPatch,
  maskNetworkSettings,
  toAppNetworkPatch,
  toContractNetworkSettings,
} from './network-settings-main.js';
import { registerMemoryIpc } from './memory-ipc-main.js';
import { registerSubscriptionIpc } from './subscription-ipc-main.js';
import { registerBrowserIpc } from './browser-ipc-main.js';
import { registerConnectionsIpc } from './connections-ipc-main.js';
import { registerConfigIpc } from './config-ipc-main.js';
import { registerPlanReminderIpc } from './plan-reminders-ipc-main.js';
import { registerWorkspaceResourcesIpc } from './workspace-resources-ipc-main.js';
import { registerDailyReviewIpc } from './daily-review-ipc-main.js';
import { registerUsageIpc } from './usage-ipc-main.js';
import { registerWebSearchIpc } from './web-search-ipc-main.js';

// Electron does not enforce single-instance by default. Must run before any
// workspace/store setup below -- a losing second process exits immediately,
// before touching shared state. See the 'second-instance' listener below for
// what the surviving process does about it.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

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
let configWatcher: ConfigFileWatcher | undefined;
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
  credentialStore,
});
// PR-MODEL-OAUTH-ALL-0: Codex / Cursor / Antigravity subscription
// services. Same shape as `claudeSubscription` — main-process only,
// IPC payloads never carry tokens, each gated behind its own
// MAKA_*_EXPERIMENTAL env var. Antigravity is a `preview` placeholder
// until the Google client_id question is resolved.
const codexSubscription = new CodexSubscriptionService({
  userDataDir: app.getPath('userData'),
  credentialStore,
});
const buildSubscriptionModelFetch = createSubscriptionModelFetch({
  claudeSubscription,
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

/**
 * Read-only credential-presence check for status paths (onboarding's
 * `getSnapshot`) that must not trigger `resolveConnectionSecret`'s
 * OAuth near-expiry refresh — that refresh hits the network and
 * mutates local token state, which a read-only status read must never
 * do just by being observed. Send/test/fetch-models paths keep using
 * `resolveConnectionSecret` so they still benefit from the refresh.
 *
 * Takes the `LlmConnection` directly rather than a slug: callers that
 * already hold the connection list (onboarding does) skip the extra
 * `connectionStore.get()` round trip and derive state from one
 * consistent snapshot.
 */
function hasConnectionSecret(connection: LlmConnection): Promise<boolean> {
  return oauthModelConnections.hasConnectionSecret(connection);
}
const cursorSubscription = new CursorSubscriptionService({
  userDataDir: app.getPath('userData'),
});
const antigravitySubscription = new AntigravitySubscriptionService({
  userDataDir: app.getPath('userData'),
});

const planReminderStore = createPlanReminderStore(workspaceRoot);
const taskLedgerWiring = createMainTaskLedgerWiring(workspaceRoot);
const taskLedgerStore = taskLedgerWiring.store;

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
  taskLedger: taskLedgerStore,
});
const mainWindowController = createMainWindowController({
  workspaceRoot,
  visualSmokeFixture,
  settingsStore,
});
// Shared by 'second-instance' and 'activate': focus the existing window, or
// create one if all windows were closed while the app (macOS: still in the
// dock) stayed running -- a second launch attempt must not be a silent no-op.
function focusOrCreateMainWindow(): void {
  if (mainWindowController.hasOpenWindows()) {
    mainWindowController.focus();
  } else {
    void mainWindowController.createWindow();
  }
}
app.on('second-instance', focusOrCreateMainWindow);
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
const riveTools: MakaTool[] = [buildRiveWorkflowTool()];
const officeTools: MakaTool[] = [buildOfficeDocumentTool(), buildOfficeDocumentEditTool()];
// Embedded-browser observe→act tools. They drive the conversation's own
// WebContentsView via the BrowserViewHost the desktop provides in registerIpc;
// outside the app (no host) they report the browser as unavailable.
const browserTools: MakaTool[] = buildBrowserTools();
const agentTools: MakaTool[] = [buildSubagentSpawnTool(), ...buildSubagentProjectionTools()];
const deferredTools: MakaTool[] = [...riveTools, ...officeTools, ...browserTools, ...agentTools];
const toolAvailability: ToolAvailabilityConfig = {
  economy: economyEnabled,
  groups: [
    { id: 'rive', label: 'Rive', description: 'Durable multi-agent Rive workflows: validate/import/run/status, scheduler, retries.', toolNames: riveTools.map((tool) => tool.name) },
    { id: 'office', label: 'Office', description: 'Read and edit Office documents (Word, Excel, PowerPoint, PDF).', toolNames: officeTools.map((tool) => tool.name) },
    { id: 'browser', label: 'Browser', description: 'Drive the embedded browser: navigate, snapshot, click, type, wait, extract.', toolNames: browserTools.map((tool) => tool.name) },
    buildSubagentToolGroup(),
  ],
};
const builtinTools: MakaTool[] = [
  ...buildBuiltinTools().filter((tool: MakaTool) => tool.name !== 'Edit'),
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
  // Session task ledger: model manages a flat task list; the current list is
  // re-injected each turn tail. Pure local state, so no permission gate.
  ...taskLedgerWiring.tools,
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
// botIncoming is wired at module load, before registerIpc() defines the
// current-project-root resolver. registerIpc reassigns this once the resolver
// exists; until then the launch directory is the safe fallback. Unifying
// project-root resolution is tracked as a follow-up.
let resolveCurrentProjectRoot: () => Promise<string> = async () => process.cwd();
const botRegistry = new BotRegistry({
  onIncomingMessage: (message: BotIncomingMessage) => {
    // Only log incoming bot messages in dev — production stdout leaking
    // platform + chatId is operational noise at best and a small privacy
    // signal at worst (which bridges are connected, with what frequency).
    if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
      console.log('[bot] incoming message', message.platform, message.chatId);
    }
    void botIncoming.handleBotIncomingMessage(message);
  },
  onStatusChange: (status: BotStatus) => {
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

function modelSupportsVision(connection: LlmConnection, model: string): boolean {
  return resolveModelVisionSupport(connection.providerType, connection.models, model);
}

backends.register('ai-sdk', async (ctx) => {
  const { connection, apiKey, model } = await getReadyConnection(ctx.header.llmConnectionSlug, ctx.header.model);
  const modelFetch = buildSubscriptionModelFetch(connection, ctx.sessionId, model);
  const memoryPromptSnapshot = await systemPromptService.buildLocalMemoryPromptFragment();
  const supportsVision = modelSupportsVision(connection, model);

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
    providerOptions: buildProviderOptions(connection, model, ctx.header.thinkingLevel),
    contextBudget: buildDefaultContextBudgetPolicy(connection, { name: 'desktop-default-history-budget' }),
    systemPrompt: ({ cwd }) => systemPromptService.buildBackendSystemPrompt(ctx.header, cwd, {
      memoryFragment: memoryPromptSnapshot,
      childInstruction: ctx.systemPrompt,
    }),
    turnTailPrompt: ({ cwd, sessionId }) => systemPromptService.buildTurnTailPrompt(cwd, sessionId),
    lookupPricing,
    recordLlmCall: (event: LlmCallRecord) => recordLlmCall({ repo: telemetryRepo, lookupPricing }, event),
    recordToolInvocation: (event: ToolInvocationRecord) =>
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
    recordToolArtifacts: (event: ToolArtifactRecorderInput) => persistToolArtifacts(ctx.header.cwd, event),
    archiveToolResult: (event: ToolResultArchiveRecorderInput) => persistArchivedToolResult(event),
    readToolResultArchive: (event: ToolResultArchiveReaderInput) => readArchivedToolResult(event),
    readAttachmentBytes: createAttachmentByteReader({ artifactStore, sessionId: ctx.sessionId }),
    supportsVision,
    loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
    writeHistoryCompact: (event) => persistHistoryCompactBlocksToArtifacts(artifactStore, event, {
      summarize: buildLlmHistorySummarizer({
        // Reuse the same connection/model the session already drives, so the
        // summary stays consistent with the model that will consume it.
        resolveModel: () =>
          getAIModel({ connection, apiKey: apiKey ?? '', modelId: model, fetch: modelFetch }),
        maxOutputTokens: 4096,
      }),
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
    recordSemanticCompactBlock: ctx.recordSemanticCompactBlock,
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
  getCurrentProjectRoot: () => resolveCurrentProjectRoot(),
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
// service checks credential presence through `hasConnectionSecret`
// (read-only — recognizes OAuth-subscription connections like the
// send-path's `resolveConnectionSecret` does, but never refreshes),
// so simply opening onboarding can't hit the network or mutate token
// state.
const onboardingService = createOnboardingService(
  bindOnboardingDeps({
    settingsStore,
    connectionStore,
    hasCredential: hasConnectionSecret,
    listSessions: () => runtime.listSessions(),
  }),
);

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
  const LAST_PROJECT_PATH_FILE = join(workspaceRoot, 'last-project-path.json');

  let selectedProjectRoot: string | null = null;

  async function loadPersistedProjectRoot(): Promise<string | null> {
    try {
      const raw = await readFile(LAST_PROJECT_PATH_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.projectPath === 'string' && parsed.projectPath) {
        await stat(parsed.projectPath);
        return await resolveProjectRoot([parsed.projectPath]);
      }
    } catch {
      // File missing, invalid, or points at a deleted directory.
    }
    return null;
  }
  const persistedProjectRootPromise = loadPersistedProjectRoot();

  async function saveLastProjectPath(projectPath: string): Promise<void> {
    try {
      await writeFile(LAST_PROJECT_PATH_FILE, JSON.stringify({ projectPath }), 'utf8');
    } catch {
      // Best-effort; failure should not block the selection.
    }
  }

  async function currentProjectRoot(): Promise<string> {
    if (selectedProjectRoot) return selectedProjectRoot;
    const persistedProjectRoot = await persistedProjectRootPromise;
    if (persistedProjectRoot) {
      selectedProjectRoot = persistedProjectRoot;
      return persistedProjectRoot;
    }
    return resolveProjectRoot([process.cwd(), app.getAppPath()]);
  }
  resolveCurrentProjectRoot = currentProjectRoot;

  async function resolveExplicitProjectRoot(projectPath: unknown): Promise<
    | { ok: true; projectPath: string }
    | { ok: false; reason: 'invalid-path' | 'not-found' }
  > {
    if (typeof projectPath !== 'string' || !projectPath) {
      return { ok: false, reason: 'invalid-path' };
    }
    try {
      await stat(projectPath);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: true, projectPath: await resolveProjectRoot([projectPath]) };
  }

  ipcMain.handle('window:setTitlebarControlsVisible', (event, visible: unknown): void => {
    mainWindowController.setTitlebarControlsVisible(event.sender, visible);
  });
  ipcMain.handle('window:setThemeSource', (event, themePref: unknown): void => {
    mainWindowController.setThemeSource(event.sender, themePref);
  });
  // PR-WINDOW-TITLEBAR-0: re-sync the native titleBarOverlay color when the
  // renderer resolves a new light/dark theme (user toggle or `auto` following
  // the system). No-op outside Windows.
  ipcMain.handle('window:setTitleBarOverlayTheme', (event, isDark: unknown): void => {
    mainWindowController.setTitleBarOverlayTheme(event.sender, isDark);
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
      void saveLastProjectPath(projectPath);
      return {
        ok: true,
        projectPath,
        projectGit: await resolveProjectGitInfo(projectPath),
      };
    },
  );
  ipcMain.handle(
    'app:selectProjectRoot',
    async (_event, projectPath: unknown): Promise<
      | { ok: true; projectPath: string; projectGit: Awaited<ReturnType<typeof resolveProjectGitInfo>> }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    > => {
      const explicitRoot = await resolveExplicitProjectRoot(projectPath);
      if (!explicitRoot.ok) return explicitRoot;
      const resolved = explicitRoot.projectPath;
      selectedProjectRoot = resolved;
      void saveLastProjectPath(resolved);
      return {
        ok: true,
        projectPath: resolved,
        projectGit: await resolveProjectGitInfo(resolved),
      };
    },
  );
  ipcMain.handle(
    'app:resolveProjectGitInfo',
    async (
      _event,
      projectPath: unknown,
    ): Promise<
      | { ok: true; projectPath: string; projectGit: Awaited<ReturnType<typeof resolveProjectGitInfo>> }
      | { ok: false; reason: 'invalid-path' | 'not-found' }
    > => {
      if (projectPath !== undefined) {
        const explicitRoot = await resolveExplicitProjectRoot(projectPath);
        if (!explicitRoot.ok) return explicitRoot;
        const resolved = explicitRoot.projectPath;
        return { ok: true, projectPath: resolved, projectGit: await resolveProjectGitInfo(resolved) };
      }
      const resolved = await currentProjectRoot();
      return { ok: true, projectPath: resolved, projectGit: await resolveProjectGitInfo(resolved) };
    },
  );
  ipcMain.handle('app:listGitBranches', async () => {
    const projectPath = await currentProjectRoot();
    return listLocalBranches(projectPath);
  });
  ipcMain.handle(
    'app:checkoutGitBranch',
    async (_event, branch: unknown): Promise<{ ok: boolean; branch?: string; reason?: string; message?: string }> => {
      if (typeof branch !== 'string' || !branch) {
        return { ok: false, reason: 'failed', message: '无效的分支名' };
      }
      const projectPath = await currentProjectRoot();
      return checkoutBranch(projectPath, branch);
    },
  );
  registerMemoryIpc({ localMemory });
  registerConfigIpc({ connectionStore, settingsStore, credentialStore, workspaceRoot });
  ipcMain.handle('workspaceInstructions:getState', async () => getWorkspaceInstructionsState(await currentProjectRoot()));
  ipcMain.handle(
    'workspaceInstructions:openFile',
    async (_event, file: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
      const resolved = await resolveWorkspaceInstructionFileForOpen(await currentProjectRoot(), typeof file === 'string' ? file : '');
      if (!resolved.ok) return { ok: false, message: workspaceInstructionOpenFailureCopy(resolved.reason) };
      const error = await shell.openPath(resolved.path);
      return error ? { ok: false, message: workspaceInstructionOpenFailureCopy('open-failed') } : { ok: true };
    },
  );
  ipcMain.handle(
    'workspaceInstructions:createFile',
    async (_event, file: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
      const created = await createWorkspaceInstructionFile(await currentProjectRoot(), typeof file === 'string' ? file : '');
      if (!created.ok) return { ok: false, message: workspaceInstructionCreateFailureCopy(created.reason) };
      return { ok: true };
    },
  );
  registerWorkspaceResourcesIpc({
    workspaceRoot,
    artifactStore,
    mainWindowController,
    sendToRenderer: safeSendToRenderer,
    bundledSkillsReady: bundledSkillsReady.promise,
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
  registerPlanReminderIpc({ planReminders, getWorkspacePrivacyContext });
  ipcMain.handle('sessions:list', (_event, filter?: SessionListFilter) => runtime.listSessions(filter));
  ipcMain.handle('sessions:create', async (_event, input?: Partial<CreateSessionInput>) => {
    const cwd = input?.cwd ?? (await currentProjectRoot());
    if (input?.backend === 'fake') {
      if (!canCreateFakeSessionFromRenderer()) {
        throw new Error('FakeBackend sessions are only available in development.');
      }
      const session = await runtime.createSession({
        cwd,
        backend: 'fake',
        llmConnectionSlug: input.llmConnectionSlug ?? 'fake',
        model: input.model ?? 'fake-model',
        permissionMode: input.permissionMode ?? (await resolveDefaultPermissionMode(() => settingsStore.get())),
        name: input.name ?? 'New Chat',
        labels: input.labels,
      });
      emitSessionsChanged('created', session.id);
      return session;
    }

    const requestedSlug = input?.llmConnectionSlug ?? (await connectionStore.getDefault());
    const { connection, model } = await getReadyConnection(requestedSlug, input?.model);
    const thinkingLevel = normalizeSupportedSessionThinkingLevel(input?.thinkingLevel, connection.providerType, model);

    const session = await runtime.createSession({
      cwd,
      backend: 'ai-sdk',
      llmConnectionSlug: connection.slug,
      model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      permissionMode: input?.permissionMode ?? (await resolveDefaultPermissionMode(() => settingsStore.get())),
      name: input?.name ?? 'New Chat',
      labels: input?.labels,
    });
    emitSessionsChanged('created', session.id);
    return session;
  });
  ipcMain.handle('sessions:readMessages', async (_event, sessionId: string) => {
    if (visualSmokeFixture) return store.readMessages(sessionId);
    let messages: StoredMessage[];
    try {
      messages = await runtime.getMessages(sessionId);
    } catch (error) {
      throw new Error(sessionReadMessagesFailureMessage(error));
    }
    try {
      await runtime.markSessionRead(sessionId, latestStoredMessageTs(messages));
    } catch {
      // Reading the content already succeeded. Leave the persisted unread
      // state for a later refresh instead of turning this into a load error.
    }
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
  registerSubscriptionIpc({
    connectionStore,
    claudeSubscription,
    codexSubscription,
    cursorSubscription,
    antigravitySubscription,
    isClaudeSubscriptionAuthenticatedState,
    isCodexSubscriptionAuthenticatedState,
    syncClaudeSubscriptionConnection,
    syncCodexSubscriptionConnection,
    emitConnectionListChanged,
  });

  registerWebSearchIpc({ settingsStore, getWorkspacePrivacyContext });

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
    const { turnId, attachments } = await resolveSessionSend({
      sessionId,
      senderId: event.sender.id,
      command: sendCommand,
      ensureCanSend: ensureSessionCanSend,
      readHeader: (id) => store.readHeader(id),
      approvals: attachmentApprovals,
      stat: async (path) => ({ size: (await stat(path)).size }),
      artifactStore,
      resizeImage: resizeImageForAttachment,
    });
    const iterator = runtime.sendMessage(sessionId, {
      turnId,
      text: sendCommand.text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    void streamEvents(sessionId, iterator, turnId);
    return { turnId, attachments };
  });
  ipcMain.handle(
    'attachments:pickFiles',
    async (event): Promise<
      | { ok: true; files: { approvalId: string; name: string; mimeType?: string; size: number }[] }
      | { ok: false; reason: 'cancelled' }
    > => {
      const result = await mainWindowController.showOpenDialog({
        title: '添加附件',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, reason: 'cancelled' };
      const chosen = await Promise.all(
        result.filePaths.map(async (path) => ({ path, name: basename(path), size: (await stat(path)).size })),
      );
      // Paths stay in main; the renderer only gets one-shot opaque tokens.
      return { ok: true, files: attachmentApprovals.issueApprovals(event.sender.id, chosen) };
    },
  );
  ipcMain.handle(
    'attachments:readBytes',
    async (_event, sessionId: string, relativePath: string): Promise<
      | { ok: true; base64: string; mimeType: string }
      | { ok: false; reason: string }
    > => {
      // Session-scoped read: only attachments filed under this session.
      const record = await artifactStore.get(relativePath).catch(() => null);
      if (!record || record.sessionId !== sessionId) return { ok: false, reason: 'not_found' };
      const result = await artifactStore.readBinary(relativePath);
      if (!result.ok) return result;
      return { ok: true, base64: result.base64, mimeType: result.mimeType };
    },
  );
  ipcMain.handle('sessions:retryTurn', async (_event, sessionId: string, input: unknown) => {
    await ensureSessionCanSend(sessionId);
    const normalized = normalizeRetryTurnInput(input);
    const turnId = normalized.turnId ?? randomUUID();
    void streamEvents(sessionId, runtime.retryTurn(sessionId, { ...normalized, turnId }), turnId);
  });
  ipcMain.handle('sessions:compact', async (_event, sessionId: string) => {
    await ensureSessionCanSend(sessionId);
    const turnId = randomUUID();
    void streamEvents(sessionId, runtime.compactSession(sessionId, { turnId }), turnId);
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
      // Switching model clears the per-model thinking variant (see model-thinking.ts).
      thinkingLevel: undefined,
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
  ipcMain.handle('sessions:setThinkingLevel', async (_event, sessionId: string, input: unknown) => {
    const header = await store.readHeader(sessionId);
    if (header.status === 'running') {
      throw new Error('当前对话正在运行，等结束后再切换思考级别。');
    }
    if (header.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换思考级别。');
    }
    const connection = await connectionStore.get(header.llmConnectionSlug);
    if (!connection) {
      throw new Error(`Unknown connection: ${header.llmConnectionSlug}`);
    }
    const nextThinkingLevel = normalizeSupportedSessionThinkingLevel(input, connection.providerType, header.model);
    const next = await runtime.updateSession(sessionId, nextThinkingLevel === undefined ? { thinkingLevel: undefined } : { thinkingLevel: nextThinkingLevel });
    emitSessionsChanged('updated', sessionId);
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

  registerBrowserIpc({ mainWindowController });

  registerConnectionsIpc({
    connectionStore,
    credentialStore,
    syncOAuthModelConnections,
    resolveConnectionSecret,
    emitConnectionListChanged,
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
    return handleQuickChatStart(input, currentProjectRoot);
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
  registerDailyReviewIpc({ dailyReview, dailyReviewArchiveStore, mainWindowController });
  registerUsageIpc({
    settingsStore,
    telemetryRepo,
    refreshPricingLookup: () => {
      lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
    },
    sendToRenderer: safeSendToRenderer,
  });

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

async function handleExternalSettingsChange(): Promise<void> {
  try {
    const settings = await settingsStore.get();
    const fullPatch: UpdateAppSettingsInput = {
      network: settings.network,
      botChat: settings.botChat,
      openGateway: settings.openGateway,
    };
    await applySettingsRuntimeEffects(settings, fullPatch);
  } catch (error) {
    console.error('[config-watcher] failed to apply external settings change:', error);
  }
  // Always notify renderer, even on partial failure above
  safeSendToRenderer('settings:externalChanged', { ts: Date.now() });
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

function normalizeSupportedSessionThinkingLevel(
  input: unknown,
  providerType: ProviderType,
  model: string,
): ThinkingLevel | undefined {
  const thinkingLevel = input === undefined || input === null ? undefined : input;
  if (thinkingLevel === undefined) return undefined;
  if (!isThinkingLevel(thinkingLevel)) {
    throw new Error(`Invalid thinking level: ${String(input)}`);
  }
  if (!thinkingVariantsForModel(providerType, model).includes(thinkingLevel)) {
    throw new Error(`当前模型不支持思考级别：${thinkingLevel}`);
  }
  return thinkingLevel;
}

/**
 * PR110b: Quick Chat entry — thin adapter over the extracted helper.
 * The discriminated-union logic + readiness gating lives in
 * `./quick-chat.ts` so it can be unit-tested without spinning up an
 * Electron app.
 */
async function handleQuickChatStart(
  rawInput: unknown,
  getCurrentProjectRoot: () => Promise<string>,
): Promise<QuickChatResult> {
  return runQuickChatStart(rawInput, {
    getOnboardingState: async () => (await onboardingService.getSnapshot()).state,
    createSession: async (input) => {
      // Re-run requireReadyConnection inside the create path to close
      // the race window between `getSnapshot()` and `createSession()`
      // (e.g. user revoked credential in another window).
      // Deep Research always forces 'explore' (read-only exploration
      // boundary) regardless of the user's default; any other Quick Chat
      // session seeds from the same default as the regular sessions:create
      // path. The settings read is independent of the connection check, and
      // this sits on the first-message latency path — run them in parallel.
      const [ready, permissionMode] = await Promise.all([
        getReadyConnection(input.defaultConnectionSlug, input.defaultModel),
        input.mode === 'deep_research'
          ? Promise.resolve<PermissionMode>('explore')
          : resolveDefaultPermissionMode(() => settingsStore.get()),
      ]);
      return runtime.createSession({
        cwd: await getCurrentProjectRoot(),
        backend: 'ai-sdk',
        llmConnectionSlug: ready.connection.slug,
        model: ready.model,
        permissionMode,
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

/**
 * Deferred handle for the bundled-Office-skills copy that now runs in
 * background startup (#456): skills:list awaits it so an early Skills
 * page open cannot see a half-bundled workspace.
 */
const bundledSkillsReady: { promise: Promise<void>; resolve: () => void } = (() => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
})();

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
    // Bootstrap runs in BACKGROUND startup (#456): the renderer may have
    // already seeded its connection list from the onboarding snapshot,
    // so push the change or the model picker stays empty until an
    // unrelated action refreshes it.
    emitConnectionListChanged();
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
    emitConnectionListChanged();
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

  // Launch the window as early as possible so the user sees the app
  // chrome (preload skeleton + backgroundColor) within milliseconds of
  // launch. Everything below — credential migration, connection
  // bootstrapping, telemetry/pricing load, interrupted-session recovery,
  // bot bridges, gateway, schedulers — runs concurrently in the
  // background and never blocks the first paint. The renderer's first
  // IPC calls (session enumeration, settings read, connection listing)
  // all read from stores that are initialized synchronously at module load,
  // so they succeed regardless of whether background startup has
  // settled. Any state that background startup mutates is pushed to the
  // renderer via the existing `sessions:changed` / `connections:event`
  // / `settings:bots:statusChanged` channels, so the UI converges lazily.
  const backgroundStartup = runBackgroundStartup();
  await mainWindowController.createWindow();
  // Keep the process alive until background work settles so schedulers
  // / bridges aren't torn down mid-start by a fast window-all-closed.
  await backgroundStartup;
});

/**
 * Non-critical startup work that must NOT block the first window paint.
 *
 * Order matters within this routine: `migrateLegacyCredentials` and
 * `ensureBootstrapConnection` touch the credential store, so they run
 * first; `setActiveProxy` must be applied before any network-bearing
 * step (`botRegistry.applySettings`, `openGateway.sync`); pricing depends
 * on `telemetryRepo.load()`. Everything here is best-effort and logged
 * on failure — none of it should prevent the user from seeing and
 * interacting with the app shell.
 */
async function runBackgroundStartup(): Promise<void> {
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
  try {
    await ensureBundledOfficeSkills(workspaceRoot);
  } catch (error) {
    console.error('[skills] ensureBundledOfficeSkills failed:', error);
  } finally {
    bundledSkillsReady.resolve();
  }
  await recoverInterruptedSessionsOnStartup();
  await botRegistry.applySettings(settings.botChat);
  await openGateway.sync(settings.openGateway);
  await planReminders.refreshTimers();
  dailyReview.startScheduler();
  configWatcher = startConfigFileWatcher(workspaceRoot, {
    onConnectionsChanged: () => emitConnectionListChanged(),
    onSettingsChanged: () => void handleExternalSettingsChange(),
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  configWatcher?.stop();
  planReminders.stopTimers();
  dailyReview.stopScheduler();
  void botRegistry.stopAll();
  void openGateway.stop();
  void mainWindowController.disposeBrowserViews();
});

app.on('activate', focusOrCreateMainWindow);
