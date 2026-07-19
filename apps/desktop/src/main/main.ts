import { app, ipcMain, nativeImage, powerSaveBlocker, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startConfigFileWatcher, type ConfigFileWatcher } from './config-file-watcher.js';
import {
  DEFAULT_SESSION_NAME,
  filterModelVisibleTaskLedgerTasks,
  resolveModelVisionSupport,
  DEEP_RESEARCH_SESSION_LABEL,
  expertTeamIdFromLabels,
} from '@maka/core';
import type {
  BotProvider,
  ConnectionEvent,
  CreateSessionInput,
  PermissionMode,
  SessionChangedEvent,
  SessionChangedReason,
  SessionEvent,
} from '@maka/core';
import { deriveBotStatusPersistenceUpdate } from './bot-status-persistence.js';
import { WEB_SEARCH_TOOL_NAME } from './web-search/agent-tool.js';
import { runThreadSearch } from './search/thread-search.js';
import { assembleDesktopTools } from './tool-assembly.js';
import { createToolArtifactPersistence } from './tool-artifact-persistence.js';
import { ClaudeSubscriptionService } from './oauth/claude-subscription-service.js';
import { OpenAiCodexService } from './oauth/openai-codex-service.js';
import { GitHubCopilotSubscriptionService } from './oauth/github-copilot-subscription-service.js';
import { CursorSubscriptionService } from './oauth/cursor-subscription-service.js';
import { AntigravitySubscriptionService } from './oauth/antigravity-subscription-service.js';
import { importLegacyOAuthTokenFiles } from './oauth/shared-credential-bridge.js';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';
import type { LlmCallRecord, ToolInvocationRecord } from '@maka/core/usage-stats/types';
import { ok } from '@maka/core/settings/result';
import {
  AiSdkBackend,
  BackendRegistry,
  FakeBackend,
  PermissionEngine,
  SessionManager,
  buildMcpTools,
  buildExpertDispatchToolForTeamId,
  createLocalContinuationSafetyInspector,
  getAIModel,
  generateSessionTitle as generateRuntimeSessionTitle,
  buildProviderOptions,
  recordLlmCall,
  recordToolInvocation,
  buildPricingLookup,
  BotRegistry,
  setActiveProxy,
  ShellRunProcessManager,
  SessionActivityRegistry,
} from '@maka/runtime';
import type {
  BotIncomingMessage,
  BotStatus,
  GoalTurnOutcome,
  HostCapabilities,
  HostCapabilitiesResolver,
  SessionActivityLease,
  ToolArtifactRecorderInput,
  ToolResultArchiveReaderInput,
  ToolResultArchiveReadResult,
  ToolResultArchiveRecorderInput,
} from '@maka/runtime';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  createAgentRunStore,
  createAgentMailboxStore,
  createAttachmentByteReader,
  createArtifactStore,
  createReadImageSnapshotter,
  createConnectionStore,
  createPlanReminderStore,
  openRuntimeEventPersistence,
  createSessionStore,
  createSettingsStore,
  createMcpConfigStore,
  createShellRunStore,
  createTelemetryRepo,
} from '@maka/storage';
import { McpClientManager } from '@maka/mcp';
import { registerMcpIpcMain } from './mcp-ipc-main.js';
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
import { createDailyReviewArchiveStore } from './daily-review-archive-store.js';
import { resolveDefaultPermissionMode } from './permission-mode-default.js';
import {
  resolveVisualSmokeFixture,
  seedVisualSmokeFixture,
} from './visual-smoke-fixture.js';
import { resolveBuildInfo } from './build-info.js';
import { OpenGatewayService } from './open-gateway.js';
import { LocalMemoryService } from './local-memory-service.js';
import { createAttachmentApprovalRegistry } from './attachment-approval.js';
import {
  buildLlmHistorySummarizer,
  cleanupLegacyHistoryCompactArtifacts,
  loadHistoryCompactBlocksFromArtifacts,
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
} from '@maka/runtime';
import { computerUseServiceHealth } from './computer-use-host.js';
import {
  computerUseAvailabilityForModel,
  computerUseToolsForModel,
} from './computer-use-model-tools.js';
import { createMainWindowController } from './main-window.js';
import { createDailyReviewMainService } from './daily-review-main.js';
import { createPlanReminderMainService } from './plan-reminders-main.js';
import { createBotIncomingMainService } from './bot-incoming-main.js';
import { createSubscriptionModelFetch } from './subscription-model-fetch.js';
import { buildDefaultContextBudgetPolicy, resolveSelectedModelContextWindow } from '@maka/runtime';
import { createSystemPromptMainService } from './system-prompt-main.js';
import { createMainTaskLedgerWiring } from './task-ledger-wiring.js';
import { createMainAutomationWiring, evaluateAutomationCanFire } from './automation-wiring.js';
import { createMainGoalWiring } from './goal-wiring.js';
import { startDesktopSessionTurn, type SessionGoalBoundary } from './session-turn-stream.js';
import { createOAuthModelConnectionsMainService } from './oauth-model-connections-main.js';
import { toContractNetworkSettings } from './network-settings-main.js';
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
import { registerNotificationsIpc } from './notifications-ipc-main.js';
import { registerAppIpc } from './app-ipc-main.js';
import { registerGitIpc } from './git-ipc-main.js';
import { registerWorkspaceSearchIpc } from './workspace-search-ipc-main.js';
import { registerWorkspaceInstructionsIpc } from './workspace-instructions-ipc-main.js';
import { registerOnboardingIpc } from './onboarding-ipc-main.js';
import { registerSessionEntryIpc } from './session-entry-ipc-main.js';
import { registerPermissionsIpc } from './permissions-ipc-main.js';
import { registerSettingsIpc } from './settings-ipc-main.js';
import type { SettingsIpcHandle } from './settings-ipc-main.js';
import { createVisualSmokeBotOnboardingAdapters } from './bot-onboarding-visual-smoke.js';
import { createKeepSystemAwakeController } from './keep-system-awake.js';
import { createSettingsRuntimeEffects } from './settings-runtime-effects.js';
import { registerGatewayIpc } from './gateway-ipc-main.js';
import { registerSessionsIpc } from './sessions-ipc-main.js';
import {
  assertSessionCanSendFromHeader,
  isSessionLifecycleError,
  sessionLifecycleErrorFromReadFailure,
} from './session-lifecycle.js';
import { createProjectRootController } from './project-root-controller.js';
import {
  assertSessionWorkspaceAvailable,
  resolveProjectContextRoot,
} from './project-context-root.js';

// E2E switches must never fire in a packaged build, and must never run against
// the real user data: a stray MAKA_E2E on a build/dev machine would otherwise
// swap in the fake backend or hide the window. app.isPackaged is true for
// asar-packaged builds; MAKA_E2E_USER_DATA_DIR must also be set, so the fake
// backend can't write test sessions into a real profile if someone sets only
// MAKA_E2E.
const hasIsolatedE2eProfile =
  !app.isPackaged &&
  !!process.env.MAKA_E2E_USER_DATA_DIR;
const isE2e = hasIsolatedE2eProfile && process.env.MAKA_E2E === '1';
const isComputerUseRealModelE2e =
  hasIsolatedE2eProfile &&
  process.env.MAKA_CU_REAL_MODEL_E2E === '1';
const isIsolatedE2e = isE2e || isComputerUseRealModelE2e;

// E2E isolation: redirect userData BEFORE the single-instance lock so the
// lock judges the throwaway dir, not the real user data — otherwise a
// developer with Maka open makes the E2E process exit as a "second instance".
// Gated by isE2e (not just the dir env) so a packaged build ignores it.
if (isIsolatedE2e && process.env.MAKA_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.MAKA_E2E_USER_DATA_DIR);
}

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
// 保持系统唤醒 (settings.system.keepSystemAwake): holds an Electron
// `powerSaveBlocker` so in-process scheduled tasks keep firing while the
// machine would otherwise sleep. Injected with electron's blocker; the
// controller owns the id + double-start guard. The blocker dies with the
// process, so quit needs no special teardown.
const keepSystemAwake = createKeepSystemAwakeController(powerSaveBlocker);
const store = createSessionStore(workspaceRoot);
const runStore = createAgentRunStore(workspaceRoot);
const runtimePersistence = await openRuntimeEventPersistence({
  workspaceRoot,
  sqliteCanonical: process.env.MAKA_RUNTIME_SQLITE_CANONICAL === '1',
});
const runtimeEventStore = runtimePersistence.runtimeEventStore;
const shellRunStore = createShellRunStore(workspaceRoot);
const connectionStore = createConnectionStore(workspaceRoot);
const settingsStore = createSettingsStore(workspaceRoot);
const mcpConfigStore = createMcpConfigStore(workspaceRoot);
const mcpManager = new McpClientManager({ clientName: 'maka-desktop', clientVersion: app.getVersion() });
let mcpStartup: Promise<void> | undefined;
function ensureMcpReady(): Promise<void> {
  if (!mcpStartup) {
    const startup = mcpConfigStore.get().then((config) => mcpManager.sync(config));
    mcpStartup = startup;
    void startup.catch(() => {
      if (mcpStartup === startup) mcpStartup = undefined;
    });
  }
  return mcpStartup;
}
const telemetryRepo = createTelemetryRepo(workspaceRoot);
const dailyReviewArchiveStore = createDailyReviewArchiveStore(workspaceRoot);
const artifactStore = createArtifactStore(workspaceRoot);
const storeReadImage = createReadImageSnapshotter(artifactStore);
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
const openAiCodex = new OpenAiCodexService({
  userDataDir: app.getPath('userData'),
  credentialStore,
});
const githubCopilotSubscription = new GitHubCopilotSubscriptionService({ credentialStore });
const buildSubscriptionModelFetch = createSubscriptionModelFetch({
  claudeSubscription,
});
const oauthModelConnections = createOAuthModelConnectionsMainService({
  connectionStore,
  credentialStore,
  claudeSubscription,
  openAiCodex,
  githubCopilotSubscription,
});
const isClaudeSubscriptionAuthenticatedState = oauthModelConnections.isClaudeSubscriptionAuthenticatedState;
const isOpenAiCodexAuthenticatedState = oauthModelConnections.isOpenAiCodexAuthenticatedState;

function syncClaudeSubscriptionConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncClaudeSubscriptionConnection();
}

function syncOpenAiCodexConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncOpenAiCodexConnection();
}

function syncGitHubCopilotConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncGitHubCopilotConnection();
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
  credentialStore,
});
const antigravitySubscription = new AntigravitySubscriptionService({
  userDataDir: app.getPath('userData'),
  credentialStore,
});

const planReminderStore = createPlanReminderStore(workspaceRoot);
const taskLedgerWiring = createMainTaskLedgerWiring(workspaceRoot);
const taskLedgerStore = taskLedgerWiring.store;
const agentMailboxStore = createAgentMailboxStore(workspaceRoot);

interface StreamEventsOptions {
  turnId: string;
  goalBoundary: SessionGoalBoundary;
  activity?: SessionActivityLease;
  observeEvent?: (event: SessionEvent) => void;
}

interface StreamEventsResult {
  turnId: string;
  ok: boolean;
  error?: string;
  outcome: GoalTurnOutcome;
}

const sessionActivities = new SessionActivityRegistry();

// Unified Automation — single "Automation" tool for heartbeat + cron.
// Deps are resolved lazily since runtime/store aren't ready at this point.
const automationWiring = createMainAutomationWiring({
  workspaceRoot,
  async canFire(automation): Promise<boolean> {
    // Kind-aware fire gate (see evaluateAutomationCanFire): incognito blocks all;
    // cron is never gated on its creator session; heartbeat needs an idle session.
    return evaluateAutomationCanFire(automation, {
      isIncognitoActive: async () => (await getWorkspacePrivacyContext()).incognitoActive,
      readSessionHeader: (sessionId) => store.readHeader(sessionId),
    });
  },
  // Heartbeat: inject into the automation's own session; resolve after the stream.
  async injectTurn(sessionId: string, prompt: string, automationId: string) {
    await ensureSessionCanSend(sessionId);
    const turnId = randomUUID();
    const iterator = runtime.sendMessage(sessionId, {
      turnId, text: prompt, origin: { kind: 'automation', automationId },
    });
    const r = await streamEvents(sessionId, iterator, {
      turnId,
      goalBoundary: 'external',
    });
    return { runId: turnId, ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  },
  // Cron: spawn a FRESH session (explore mode — no unapproved side effects) and
  // run the prompt there, so each fire is a first-class session + run.
  async createFreshRun(prompt: string, automationId: string) {
    const slug = await connectionStore.getDefault();
    const { connection, model } = await getReadyConnection(slug, undefined);
    const cwd = await resolveCurrentProjectRoot();
    const session = await createDesktopSession({
      cwd,
      backend: 'ai-sdk',
      llmConnectionSlug: connection.slug,
      model,
      permissionMode: 'explore',
      name: `Automation: ${prompt.slice(0, 32)}`,
      labels: ['automation', 'cron'],
    });
    emitSessionsChanged('created', session.id);
    await ensureSessionCanSend(session.id);
    const turnId = randomUUID();
    const iterator = runtime.sendMessage(session.id, {
      turnId, text: prompt, origin: { kind: 'automation', automationId },
    });
    const r = await streamEvents(session.id, iterator, {
      turnId,
      goalBoundary: 'external',
    });
    // Archive the fresh cron session after its run finalizes so recurring crons
    // do not accumulate an unbounded pile of active sessions. The session (with
    // its run/trace) is preserved under the archive, labelled automation/cron.
    try {
      await goalWiring.archiveSession(session.id, () => runtime.archive(session.id));
      desktopSessionSkillHosts.delete(session.id);
      emitSessionsChanged('archived', session.id);
    } catch {}
    return { runId: turnId, ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  },
});

// Load durable automations from disk on startup (fire-and-forget; errors are logged inside).
void automationWiring.loadDurableAutomations();

// Goal execution — autonomous turn-boundary continuation with an external
// evaluator (CC-style). Self-contained: no automation coupling (a goal is
// bounded by its own caps; a waiting goal re-checks via normal continuation).
const goalWiring = createMainGoalWiring({
  getDefaultConnectionSlug: () => connectionStore.getDefault(),
  getConnection: (slug) => connectionStore.get(slug),
  getSessionModel: async (sessionId) => {
    const header = await store.readHeader(sessionId);
    if (!header) return null;
    return { connectionSlug: header.llmConnectionSlug, model: header.model };
  },
  resolveConnectionSecret,
  buildSubscriptionModelFetch,
  getAIModel: (input) => getAIModel(input),
  buildProviderOptions: (connection, modelId) => buildProviderOptions(connection, modelId),
  getRecentMessages: async (sessionId) => {
    const messages = await runtime.getMessages(sessionId);
    return messages.slice(-10).map((m) => ({
      type: m.type,
      text: m.type === 'user' || m.type === 'assistant' ? m.text : undefined,
    }));
  },
  getTokenCount: async (sessionId) => {
    const messages = await runtime.getMessages(sessionId);
    let total = 0;
    for (const m of messages) {
      if (m.type === 'token_usage') total += (m.total ?? (m.input + m.output));
    }
    return total;
  },
  admitTurn: (sessionId, text) => {
    const whenIdle = sessionActivities.whenIdle(sessionId);
    if (whenIdle) return { kind: 'busy', whenIdle };
    const reservation = sessionActivities.reserve(sessionId);
    const turnId = randomUUID();
    return {
      kind: 'prepared',
      turnId,
      start: async (): Promise<GoalTurnOutcome> => {
        try {
          await ensureSessionCanSend(sessionId);
          const iterator = runtime.sendMessage(sessionId, { turnId, text });
          return (await streamEvents(sessionId, iterator, {
            turnId,
            goalBoundary: 'coordinator',
            activity: reservation,
          })).outcome;
        } catch (error) {
          reservation.release();
          return {
            kind: 'errored',
            turnId,
            reason: `Goal continuation could not start: ${errorMessage(error)}`,
          };
        }
      },
    };
  },
  // Surface every goal transition to the renderer so an active autonomous loop
  // is visible (badge + clear affordance) — never a silent token burn.
  onGoalChange: (goal) => emitSessionsChanged('goal-change', goal.sessionId),
  listActionableTaskKeys: async (sessionId) => {
    const tasks = await taskLedgerStore.list(sessionId, {
      includeTerminal: false,
      includeArchived: false,
    });
    return filterModelVisibleTaskLedgerTasks(tasks)
      .filter((task) => task.status === 'pending' || task.status === 'in_progress')
      .map((task) => task.key);
  },
  recordTaskGateDecision: async (trace) => {
    const runs = await runStore.listSessionRuns(trace.sessionId);
    const run = runs.find((candidate) => candidate.turnId === trace.turnId);
    if (!run) return;
    await runStore.appendEvent(trace.sessionId, run.runId, {
      type: 'task_gate_decided',
      id: randomUUID(),
      runId: run.runId,
      sessionId: trace.sessionId,
      turnId: trace.turnId,
      ts: Date.now(),
      message: `Task gate: ${trace.decision}`,
      data: {
        goalId: trace.goalId,
        decision: trace.decision,
        taskKeys: trace.taskKeys,
      },
    });
  },
});

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
// Resolve a session's backend host at Skill invocation time. The fallback is
// the binding-derived Desktop surface created after the product tool catalog
// is assembled below.
const desktopSessionSkillHosts = new Map<string, HostCapabilities>();
const resolveDesktopSkillHost: HostCapabilitiesResolver = ({ sessionId }) =>
  desktopSessionSkillHosts.get(sessionId) ?? desktopHostCapabilities;
// Window is created hidden for E2E and visual-smoke runs so it never steals
// focus. Derived from the same isE2e gate as userData/fake-backend so the
// hidden-window switch stays in lockstep with the rest of the E2E isolation.
// MAKA_E2E_SHOW_WINDOW opts back into a visible window where there is no
// focus to steal (CI under xvfb): hidden windows only get ~1fps compositor
// BeginFrames on Linux, which stalls content-visibility inflation and any
// frame-paced E2E protocol (measured in the scroll-geometry climb: 38 frames
// over 31s). The E2E harness sets it, not the workflow — see fixtures.ts.
const startHidden = (Boolean(visualSmokeFixture) || isIsolatedE2e)
  && process.env.MAKA_E2E_SHOW_WINDOW !== '1';
let onMainWindowClose = (): void => {};
const mainWindowController = createMainWindowController({
  workspaceRoot,
  visualSmokeFixture,
  settingsStore,
  startHidden,
  onClose: () => onMainWindowClose(),
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
const safeSendToRenderer = mainWindowController.send;
taskLedgerStore.subscribe((event) => safeSendToRenderer('tasks:changed', event));
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
    void streamEvents(sessionId, iterator, {
      turnId,
      goalBoundary: 'external',
    });
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
const shellRuns = new ShellRunProcessManager({
  store: shellRunStore,
  newId: randomUUID,
  now: Date.now,
  onShellRunUpdate: (update) => {
    safeSendToRenderer('shell-runs:update', update);
  },
});
const {
  persistToolArtifacts,
  snapshotReadImage,
  persistArchivedToolResult,
  readArchivedToolResult,
} = createToolArtifactPersistence({ artifactStore, storeReadImage, safeSendToRenderer });

const {
  riveTools,
  officeTools,
  browserTools,
  computerUse,
  computerUseOverlay,
  computerUseTools,
  agentTeamLeadTools,
  desktopHostCapabilities,
  builtinTools,
  toolAvailability,
  childAgentTools,
} = assembleDesktopTools({
  isComputerUseRealModelE2e,
  workspaceRoot,
  taskLedgerStore,
  taskLedgerWiring,
  automationWiring,
  goalWiring,
  agentMailboxStore,
  settingsStore,
  shellRuns,
  snapshotReadImage,
  getWorkspacePrivacyContext,
  resolveDesktopSkillHost,
});
// Cursor-overlay teardown assigns a module-scoped `let`, so it stays in main.ts.
onMainWindowClose = () => computerUseOverlay.destroyAll();
const systemPromptService = createSystemPromptMainService({
  settingsStore,
  workspaceRoot,
  localMemory,
  taskLedger: taskLedgerStore,
  goalManager: goalWiring.manager,
  hostCapabilities: desktopHostCapabilities,
});
let lookupPricing = buildPricingLookup();
// Track the last status fields that affect persisted diagnostics. The reason
// is part of the key because a running bridge can remain degraded while a
// newer, more useful failure replaces the previous one.
const previousBotStatus = new Map<BotProvider, Pick<BotStatus, 'readiness' | 'reason'>>();
let botIncoming: ReturnType<typeof createBotIncomingMainService>;
// Single authority for the "current project root" selection, shared across the
// app/window, git, workspace-search, workspace-instructions, and session-entry
// IPC surfaces. botIncoming, automation cron runs, and quick-chat read the
// current selection through the thin `resolveCurrentProjectRoot` adapter below.
const projectRootController = createProjectRootController({
  lastProjectPathFile: join(workspaceRoot, 'last-project-path.json'),
  fallbackRoots: () => [process.cwd(), app.getAppPath()],
});
const resolveCurrentProjectRoot: () => Promise<string> = () => projectRootController.current();
const resolveProjectRootForContext = (sessionId: unknown): Promise<string> =>
  resolveProjectContextRoot(sessionId, {
    currentProjectRoot: resolveCurrentProjectRoot,
    readSessionCwd: async (id) => (await store.readHeader(id)).cwd,
  });
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
    const previous = previousBotStatus.get(status.platform);
    previousBotStatus.set(status.platform, {
      readiness: status.readiness,
      reason: status.reason,
    });
    const update = deriveBotStatusPersistenceUpdate(previous, status);
    if (update) {
      void settingsStore.update({
        botChat: {
          channels: {
            [status.platform]: {
              ...update,
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

function modelSupportsVision(connection: LlmConnection, model: string): boolean {
  return resolveModelVisionSupport(connection.providerType, connection.models, model);
}

backends.register('ai-sdk', async (ctx) => {
  // MCP is optional. A corrupt mcp.json remains visible in the MCP module,
  // but must not prevent builtin-only conversations from creating a backend.
  await ensureMcpReady().catch(() => {});
  const { connection, apiKey, model } = await getReadyConnection(ctx.header.llmConnectionSlug, ctx.header.model);
  const modelFetch = buildSubscriptionModelFetch(connection, ctx.sessionId, model);
  const memoryPromptSnapshot = await systemPromptService.buildLocalMemoryPromptFragment();
  const supportsVision = modelSupportsVision(connection, model);
  const candidateTools = isComputerUseRealModelE2e
    ? computerUseTools
    : ctx.tools
      ? [...ctx.tools]
      : [...builtinTools, ...buildMcpTools(mcpManager)];
  const candidateToolAvailability = isComputerUseRealModelE2e
    ? { economy: false, groups: [] }
    : toolAvailability;
  // Expert-team lead: a main session (ctx.tools undefined) labeled
  // `mode:expert-team:<teamId>` gets the team-bound expert_dispatch tool.
  // Child turns receive scoped `ctx.tools` and inherit the label, but must NOT
  // get expert_dispatch — members cannot spawn nested teams.
  const expertTeamId = ctx.tools ? undefined : expertTeamIdFromLabels(ctx.header.labels);
  const expertDispatchTool = expertTeamId
    ? buildExpertDispatchToolForTeamId(expertTeamId, { taskLedger: taskLedgerStore })
    : undefined;
  const agentTeam = ctx.agentTeam ?? (expertTeamId
    ? { role: 'lead' as const, teamId: expertTeamId, agentId: 'lead' }
    : undefined);
  const backendTools = computerUseToolsForModel(
    candidateTools,
    computerUseTools,
    supportsVision,
  );
  const backendToolAvailability = computerUseAvailabilityForModel(
    candidateToolAvailability,
    supportsVision,
  );
  const backendToolNames = new Set([
    ...backendTools.map((tool) => tool.name),
    ...(expertDispatchTool ? [expertDispatchTool.name, ...agentTeamLeadTools.map((tool) => tool.name)] : []),
  ]);
  const backendCapabilities = new Set<string>();
  for (const [capability, tools] of [
    ['rive', riveTools],
    ['office', officeTools],
    ['browser', browserTools],
    ['computer_use', computerUseTools],
  ] as const) {
    if (tools.some((tool) => backendToolNames.has(tool.name))) backendCapabilities.add(capability);
  }
  const backendSkillHost: HostCapabilities = {
    toolNames: backendToolNames,
    capabilities: backendCapabilities,
  };
  // Child backends share the parent sessionId but intentionally have a
  // narrower tool surface. They do not receive the Desktop Skill tool, so
  // they must not overwrite the parent session's resolver entry.
  if (!ctx.tools) desktopSessionSkillHosts.set(ctx.sessionId, backendSkillHost);

  return new AiSdkBackend({
    sessionId: ctx.sessionId,
    header: { ...ctx.header, model },
    appendMessage: ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
    connection,
    apiKey: apiKey ?? '',
    modelId: model,
    permissionEngine,
    modelFactory: (input) => getAIModel({ ...input, fetch: modelFetch }),
    tools: expertDispatchTool
      ? [...backendTools, expertDispatchTool, ...agentTeamLeadTools]
      : backendTools,
    agentTeam,
    toolAvailability: backendToolAvailability,
    spawnChildAgent: (input) => runtime.spawnChildAgent(ctx.sessionId, input),
    listChildAgents: () => runtime.listChildAgents(ctx.sessionId),
    readChildAgentOutput: (input) => runtime.readChildAgentOutput(ctx.sessionId, input),
    providerOptions: buildProviderOptions(connection, model, ctx.header.thinkingLevel),
    contextBudget: buildDefaultContextBudgetPolicy(connection, {
      name: 'desktop-default-history-budget',
      modelId: model,
    }),
    systemPrompt: ({ cwd }) => systemPromptService.buildBackendSystemPrompt(ctx.header, cwd, {
      memoryFragment: memoryPromptSnapshot,
      childInstruction: ctx.systemPrompt,
      skillBudget: { contextWindow: resolveSelectedModelContextWindow(connection, model) },
      host: backendSkillHost,
    }),
    turnTailPrompt: ({ cwd, sessionId }) => systemPromptService.buildTurnTailPrompt(cwd, sessionId),
    shellRunContextSummary: ctx.shellRunContextSummary,
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
    ...(runtimePersistence.runtimeCommitStore
      ? { runtimeCommitSink: runtimePersistence.runtimeCommitStore }
      : {}),
    supportsVision,
    loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
    loadHistoryCompactCheckpoint: ctx.loadHistoryCompactCheckpoint,
    summarizeHistoryCompact: buildLlmHistorySummarizer({
      // Reuse the same connection/model the session already drives, so the
      // summary stays consistent with the model that will consume it.
      resolveModel: () =>
        getAIModel({ connection, apiKey: apiKey ?? '', modelId: model, fetch: modelFetch }),
      providerOptions: buildProviderOptions(connection, model, ctx.header.thinkingLevel),
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
    recordHistoryCompactCheckpoint: ctx.recordHistoryCompactCheckpoint,
    loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
    recordActiveFullCompactBlock: ctx.recordActiveFullCompactBlock,
    recordSemanticCompactBlock: ctx.recordSemanticCompactBlock,
    newId: randomUUID,
    now: Date.now,
  });
});

backends.register('fake', (ctx) =>
  new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store, appendMessage: ctx.appendMessage }),
);

// E2E: also route 'ai-sdk' (requested by sessions:create and quickChat:start)
// through the deterministic fake backend, so no session-creation path can
// escape the E2E seam and hit a real provider. Registered after the real
// ai-sdk factory to override it (BackendRegistry uses last-write-wins).
// Production builds never set MAKA_E2E.
if (isE2e) {
  backends.register('ai-sdk', (ctx) =>
    new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store, appendMessage: ctx.appendMessage }),
  );
}

const runtime = new SessionManager({
  store,
  runStore,
  runtimeEventStore,
  ...(runtimePersistence.runtimeCommitStore
    ? { toolBoundaryProtocol: runtimePersistence.runtimeCommitStore.toolBoundaryProtocol }
    : {}),
  shellRuns,
  backends,
  childTools: childAgentTools,
  safeBoundaryResumeEnabled: process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME === '1',
  onContinuationLifecycleEvent: (event) => {
    console.info('[runtime-resume]', JSON.stringify(event));
  },
  inspectContinuationSafety: createLocalContinuationSafetyInspector({
    readSessionCwd: async (sessionId) => (await store.readHeader(sessionId)).cwd,
    listAvailableToolNames: async () => [
      ...builtinTools.map((tool) => tool.name),
      'expert_dispatch',
    ],
    hasPendingBackgroundOperations: async (sessionId) => {
      const [shellUpdates, runs] = await Promise.all([
        shellRuns.listSessionUpdates(sessionId),
        runStore.listSessionRuns(sessionId),
      ]);
      return (
        shellUpdates.some((update) => update.result.status === 'running') ||
        runs.some(
          (run) =>
            run.parentRunId !== undefined &&
            ['created', 'running', 'waiting_permission'].includes(run.status),
        )
      );
    },
  }),
  listArtifactsForTurn: async (sessionId, turnId) =>
    (await artifactStore.list(sessionId)).filter((artifact) =>
      artifact.turnId === turnId && artifact.status !== 'deleted'
    ),
  cleanupHistoryCompactArtifacts: async (input) => {
    await cleanupLegacyHistoryCompactArtifacts({
      ...input,
      artifactStore,
      onDiagnostic: (diagnostic) => console.warn('[history-compact-cleanup]', diagnostic),
    });
  },
  generateSessionTitle: async ({ sessionId, header, sourceText }) => {
    const { connection, apiKey, model } = await getReadyConnection(header.llmConnectionSlug, header.model);
    return generateRuntimeSessionTitle({
      model: getAIModel({
        connection,
        apiKey: apiKey ?? '',
        modelId: model,
        fetch: buildSubscriptionModelFetch(connection, sessionId, model),
      }),
      providerOptions: buildProviderOptions(connection, model),
      sourceText,
    });
  },
  onSessionTitleChanged: (sessionId) => emitSessionsChanged('renamed', sessionId),
  newId: randomUUID,
  now: Date.now,
});
let settingsIpc: SettingsIpcHandle | undefined;
let mcpToolSnapshot = JSON.stringify(mcpManager.tools());
mcpManager.onChange(() => {
  safeSendToRenderer('mcp:changed', mcpManager.statuses());
  const nextSnapshot = JSON.stringify(mcpManager.tools());
  if (nextSnapshot === mcpToolSnapshot) return;
  mcpToolSnapshot = nextSnapshot;
  void runtime.refreshIdleBackends().catch((error) => {
    console.warn('[mcp] failed to refresh backend tool snapshots:', error);
  });
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
  createSession: createDesktopSession,
  botRegistry,
  getCurrentProjectRoot: () => resolveCurrentProjectRoot(),
  getDefaultConnectionSlug: () => connectionStore.getDefault(),
  getReadyConnection,
  readSessionHeader: async (sessionId) => {
    try {
      return await store.readHeader(sessionId);
    } catch (error) {
      throw sessionLifecycleErrorFromReadFailure(error) ?? error;
    }
  },
  ensureSessionCanSend,
  emitSessionsChanged,
  runAgentTurn: ({ sessionId, iterator, turnId, onEvent }) => streamEvents(sessionId, iterator, {
    turnId,
    goalBoundary: 'external',
    observeEvent: onEvent,
  }),
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

function registerIpc(): void {
  const currentProjectRoot = resolveCurrentProjectRoot;
  registerMcpIpcMain({
    ipcMain,
    store: mcpConfigStore,
    manager: mcpManager,
    ensureReady: ensureMcpReady,
    refreshIdleBackends: () => runtime.refreshIdleBackends(),
    emitChanged: (statuses) => safeSendToRenderer('mcp:changed', statuses),
  });

  registerAppIpc({
    mainWindowController,
    projectRoot: projectRootController,
    getSessionProjectRoot: async (sessionId) => (await store.readHeader(sessionId)).cwd,
    getProjectRoot: resolveProjectRootForContext,
    workspaceRoot,
    buildInfo,
    visualSmokeFixture,
  });
  registerMemoryIpc({ localMemory });
  registerConfigIpc({ connectionStore, settingsStore, credentialStore, workspaceRoot });
  registerNotificationsIpc({ settingsStore, mainWindowController, e2e: isE2e });
  registerWorkspaceInstructionsIpc({ getCurrentProjectRoot: currentProjectRoot });
  registerWorkspaceResourcesIpc({
    workspaceRoot,
    artifactStore,
    mainWindowController,
    sendToRenderer: safeSendToRenderer,
  });
  registerWorkspaceSearchIpc({ getProjectRoot: resolveProjectRootForContext });
  registerGitIpc({ getProjectRoot: resolveProjectRootForContext });
  registerPlanReminderIpc({ planReminders, getWorkspacePrivacyContext });
  registerSessionsIpc({
    runtime,
    store,
    taskLedgerStore,
    goalWiring,
    automationManager: automationWiring.manager,
    computerUseOverlay,
    computerUseTools,
    artifactStore,
    attachmentApprovals,
    settingsStore,
    connectionStore,
    mainWindowController,
    visualSmokeFixture,
    emitSessionsChanged,
    ensureSessionCanSend,
    invalidateSessionBindings: (sessionId) => botIncoming.invalidateSessionBindings(sessionId),
    clearSkillHost: (sessionId) => desktopSessionSkillHosts.delete(sessionId),
    ensureSessionWorkspaceAvailable,
    createSession: createDesktopSession,
    getReadyConnection,
    streamEvents,
    getCurrentProjectRoot: currentProjectRoot,
    getWorkspacePrivacyContext,
    canCreateFakeSession: canCreateFakeSessionFromRenderer,
  });
  registerSubscriptionIpc({
    connectionStore,
    claudeSubscription,
    openAiCodex,
    githubCopilotSubscription,
    cursorSubscription,
    antigravitySubscription,
    isClaudeSubscriptionAuthenticatedState,
    isOpenAiCodexAuthenticatedState,
    syncClaudeSubscriptionConnection,
    syncOpenAiCodexConnection,
    syncGitHubCopilotConnection,
    emitConnectionListChanged,
  });
  registerWebSearchIpc({ settingsStore, getWorkspacePrivacyContext });
  registerBrowserIpc({ mainWindowController });
  registerConnectionsIpc({
    connectionStore,
    credentialStore,
    syncOAuthModelConnections,
    resolveConnectionSecret,
    hasConnectionSecret,
    emitConnectionListChanged,
  });
  registerOnboardingIpc({ onboardingService });
  registerSessionEntryIpc({
    runtime,
    getReadyConnection,
    getCurrentProjectRoot: currentProjectRoot,
    getOnboardingState: async () => (await onboardingService.getSnapshot()).state,
    emitSessionsChanged,
    ensureSessionCanSend,
    createSession: createDesktopSession,
    streamEvents,
    quickChatStart: (input) => handleQuickChatStart(input, currentProjectRoot),
  });
  registerPermissionsIpc({
    settingsStore,
    connectionStore,
    telemetryRepo,
    botRegistry,
    getComputerUseCapabilityInput: computerUseCapabilityInput,
  });
  settingsIpc = registerSettingsIpc({
    settingsStore,
    botRegistry,
    normalizeSettingsPatch,
    applySettingsRuntimeEffects,
    ...(visualSmokeFixture?.scenario === 'settings-bots'
      ? {
          botOnboardingAdapters: createVisualSmokeBotOnboardingAdapters(),
          botOnboardingApplySettingsRuntimeEffects: async () => undefined,
          // The fixture no-ops runtime effects, so no real bridge starts.
          // Report the onboarded channel as running to demonstrate the
          // successful "connected" path (the P0-3 warning path is covered by
          // bot-onboarding-main.test.ts).
          botOnboardingReadChannelStatus: () => ({ running: true }),
        }
      : {}),
  });
  registerGatewayIpc({ openGateway });
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

const { normalizeSettingsPatch, applySettingsRuntimeEffects, handleExternalSettingsChange } =
  createSettingsRuntimeEffects({
    settingsStore,
    botRegistry,
    openGateway,
    keepSystemAwake,
    runtime,
    safeSendToRenderer,
    emitSessionsChanged,
  });

function streamEvents(
  sessionId: string,
  iterator: AsyncIterable<SessionEvent>,
  options: StreamEventsOptions,
): Promise<StreamEventsResult> {
  let userAppendBroadcasted = false;
  const turnId = options.turnId;
  const started = startDesktopSessionTurn({
    sessionId,
    events: iterator,
    turnId,
    goalBoundary: options.goalBoundary,
    activities: sessionActivities,
    ...(options.activity ? { activity: options.activity } : {}),
    beginExternalTurn: (externalSessionId, externalTurnId) =>
      goalWiring.coordinator.beginExternalTurn(externalSessionId, externalTurnId),
    onEvent: (event) => {
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
        computerUseOverlay.clearForSession(sessionId);
        computerUseTools.clearSession(sessionId);
      }
      options.observeEvent?.(event);
    },
    onStreamError: (error) => {
      const event = {
        type: 'error',
        id: randomUUID(),
        turnId,
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
      computerUseOverlay.clearForSession(sessionId);
      computerUseTools.clearSession(sessionId);
    },
    onDrained: () => {
      emitSessionsChanged('message-appended', sessionId);
    },
  });
  if (started.kind === 'unavailable') throw new Error(started.reason);
  return started.completion.then((outcome) => {
    const failureReason = outcome.kind === 'errored' || outcome.kind === 'suspended'
      ? outcome.reason
      : undefined;
    return {
      turnId,
      ok: outcome.kind === 'completed',
      ...(failureReason ? { error: failureReason } : {}),
      outcome,
    };
  });
}

function isStatusChangingSessionEvent(event: SessionEvent): boolean {
  return event.type === 'permission_request' ||
    event.type === 'permission_decision_ack' ||
    event.type === 'complete' ||
    event.type === 'abort' ||
    event.type === 'error';
}

function isTurnStatusChangingSessionEvent(event: SessionEvent): boolean {
  return event.type === 'complete' || event.type === 'abort' || event.type === 'error';
}

async function ensureSessionCanSend(sessionId: string): Promise<void> {
  const header = await readAvailableSessionHeader(sessionId);
  let result: Awaited<ReturnType<typeof ensureSessionCanSendOrRebind>>;
  try {
    result = await ensureSessionCanSendOrRebind(sessionId, header, {
      readyConnectionDeps,
      getDefaultSlug: () => connectionStore.getDefault(),
      listConnectionSlugs: async () => (await connectionStore.list()).map((connection) => connection.slug),
      updateSession: (_sessionId, patch) => runtime.updateSession(_sessionId, {
        ...patch,
        status: 'active',
        blockedReason: undefined,
        statusUpdatedAt: Date.now(),
      }),
    });
  } catch (error) {
    if (isSessionLifecycleError(error)) throw error;
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

async function readAvailableSessionHeader(sessionId: string) {
  let header;
  try {
    header = await store.readHeader(sessionId);
  } catch (error) {
    const lifecycleError = sessionLifecycleErrorFromReadFailure(error);
    if (lifecycleError) throw lifecycleError;
    throw error;
  }
  assertSessionCanSendFromHeader(header);
  await assertSessionWorkspaceAvailable(header.cwd);
  return header;
}

async function ensureSessionWorkspaceAvailable(sessionId: string): Promise<void> {
  await readAvailableSessionHeader(sessionId);
}

async function createDesktopSession(input: CreateSessionInput) {
  await assertSessionWorkspaceAvailable(input.cwd);
  return runtime.createSession(input);
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
      return createDesktopSession({
        cwd: await getCurrentProjectRoot(),
        backend: 'ai-sdk',
        llmConnectionSlug: ready.connection.slug,
        model: ready.model,
        permissionMode,
        name: input.mode === 'deep_research' ? 'Deep Research' : DEFAULT_SESSION_NAME,
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
      void streamEvents(sessionId, iterator, {
        turnId,
        goalBoundary: 'external',
      });
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

async function recoverInterruptedSessionsOnStartup(): Promise<void> {
  try {
    await runtime.recoverInterruptedSessions();
    if (process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME !== '1') return;
    for (const session of await runtime.listSessions()) {
      const plan = await runtime.planLatestAuthoritativeSafeBoundaryContinuation(session.id);
      if (!plan.continuation) continue;
      const iterator = runtime.resumeSafeBoundaryContinuation(plan.continuation);
      void streamEvents(session.id, iterator, {
        turnId: plan.continuation.turnId,
        goalBoundary: 'none',
      });
    }
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
    if (process.env.MAKA_VISUAL_SMOKE_FIXTURE || isIsolatedE2e) {
      // PR-VISUAL-SMOKE-HEADLESS: hide the dock icon so the spawned
      // Electron runs as an accessory app — no dock bounce, and it
      // never becomes frontmost / steals focus from the developer's
      // active window during a capture run or an E2E run.
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

  // Credential migration is the one startup phase that must finish before an
  // interactive window exists: OAuth logout is otherwise able to race the
  // one-shot legacy import. The work is local and normally a missing-file
  // check; all non-critical startup below still runs behind the first paint.
  // The renderer's first
  // IPC calls (session enumeration, settings read, connection listing)
  // all read from stores that are initialized synchronously at module load,
  // so they succeed regardless of whether background startup has
  // settled. Any state that background startup mutates is pushed to the
  // renderer via the existing `sessions:changed` / `connections:event`
  // / `settings:bots:statusChanged` channels, so the UI converges lazily.
  // Visual-smoke fixture mode wipes and reseeds the whole workspace
  // (`rm -rf` first). That wipe must finish BEFORE the window opens and
  // before background startup touches the workspace: createWindow reads
  // the settings store, and a concurrent wipe lands inside the store's
  // read-or-create write (mkdir → tmp → rename), rejecting createWindow
  // so the window never appears. Fixture runs trade first-paint latency
  // for determinism by definition; production launches skip this await.
  if (visualSmokeFixture) {
    console.log(`[visual-smoke] scenario=${visualSmokeFixture.scenario} workspace=${workspaceRoot}`);
    await seedVisualSmokeFixture({ workspaceRoot, fixture: visualSmokeFixture, credentialStore });
  }
  await runCredentialStartup();
  app.on('second-instance', focusOrCreateMainWindow);
  app.on('activate', focusOrCreateMainWindow);
  const backgroundStartup = runBackgroundStartup();
  await mainWindowController.createWindow();
  // Keep the process alive until background work settles so schedulers
  // / bridges aren't torn down mid-start by a fast window-all-closed.
  await backgroundStartup;
});

async function runCredentialStartup(): Promise<void> {
  // One-time migration of credentials.json off Electron safeStorage so
  // the pure-Node runtime can read it (issue #32). Runs before any
  // credential read/write below; failure is non-fatal (legacy file is
  // left intact and later credential reads fail closed with guidance).
  try {
    await migrateLegacyCredentials(workspaceRoot, safeStorage);
  } catch (error) {
    console.error('[credentials] migration off safeStorage failed; legacy file left intact:', error);
  }
  // One-shot import of pre-#1125 safeStorage-encrypted OAuth token
  // files into the shared CredentialStore, which is the only token
  // authority from here on. Best-effort like the migration above:
  // files that cannot be decrypted are left intact for a later start.
  try {
    const userDataDir = app.getPath('userData');
    const reports = await importLegacyOAuthTokenFiles({
      credentialStore,
      decryptor: safeStorage,
      files: [
        { slug: 'claude-subscription', filePath: join(userDataDir, '.claude_subscription_token') },
        { slug: 'codex-subscription', filePath: join(userDataDir, '.codex_subscription_token') },
        { slug: 'cursor-subscription', filePath: join(userDataDir, '.cursor_subscription_token') },
        { slug: 'antigravity-subscription', filePath: join(userDataDir, '.antigravity_subscription_token') },
      ],
    });
    for (const report of reports) {
      const log = report.outcome === 'failed' ? console.error : console.log;
      log(`[credentials] legacy OAuth token file for ${report.slug}: ${report.outcome}`, report.error ?? '');
    }
  } catch (error) {
    console.error('[credentials] legacy OAuth token import failed; files left intact:', error);
  }
}

/**
 * Non-critical startup work that must NOT block the first window paint.
 *
 * `setActiveProxy` must be applied before any network-bearing step
 * (`botRegistry.applySettings`, `openGateway.sync`); pricing depends on
 * `telemetryRepo.load()`. Everything here is best-effort and logged on
 * failure — none of it should prevent the user from seeing and interacting
 * with the app shell.
 */
async function runBackgroundStartup(): Promise<void> {
  // Visual-smoke seeding happens synchronously in `whenReady` before the
  // window opens (see there for why); only the real bootstrap runs here.
  if (!visualSmokeFixture) {
    await ensureBootstrapConnection();
  }
  const settings = await settingsStore.get();
  setActiveProxy(toContractNetworkSettings(settings.network).proxy);
  // Re-hold the power-save blocker at launch if the user left it enabled, so
  // scheduled tasks survive machine sleep across restarts.
  keepSystemAwake.apply(settings.system.keepSystemAwake);
  await telemetryRepo.load();
  lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
  await recoverInterruptedSessionsOnStartup();
  await botRegistry.applySettings(settings.botChat);
  await openGateway.sync(settings.openGateway);
  await planReminders.refreshTimers();
  dailyReview.startScheduler();
  configWatcher = startConfigFileWatcher(workspaceRoot, {
    onConnectionsChanged: () => emitConnectionListChanged(),
    onSettingsChanged: () => void handleExternalSettingsChange(),
  });
  automationWiring.scheduler.start();
}

app.on('window-all-closed', () => {
  computerUseOverlay.destroyAll();
  if (process.platform !== 'darwin') app.quit();
});

let beforeQuitCleanupComplete = false;
let beforeQuitCleanupStarted = false;

app.on('before-quit', (event) => {
  if (beforeQuitCleanupComplete) return;
  event.preventDefault();
  if (beforeQuitCleanupStarted) return;
  beforeQuitCleanupStarted = true;
  void runBeforeQuitCleanup().finally(() => {
    beforeQuitCleanupComplete = true;
    app.quit();
  });
});

async function runBeforeQuitCleanup(): Promise<void> {
  automationWiring.scheduler.dispose();
  goalWiring.coordinator.dispose();
  goalWiring.manager.dispose();
  configWatcher?.stop();
  planReminders.stopTimers();
  dailyReview.stopScheduler();
  settingsIpc?.dispose();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => computerUseOverlay.destroyAll()),
    Promise.resolve().then(() => computerUse.backend?.dispose?.()),
    botRegistry.stopAll(),
    openGateway.stop(),
    Promise.resolve(mainWindowController.disposeBrowserViews()),
    shellRuns.terminateAll(),
    mcpManager.close(),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') console.error('[shutdown] cleanup failed:', result.reason);
  }
  runtimePersistence.close();
}

function computerUseCapabilityInput() {
  const serviceState = computerUse.backend?.serviceState?.();
  return {
    backendId: computerUse.backendId,
    health: computerUseServiceHealth(computerUse.backendId, serviceState),
  };
}
