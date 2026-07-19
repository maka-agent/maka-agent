import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { ipcMain } from 'electron';
import {
  DEFAULT_SESSION_NAME,
  isPermissionMode,
  isThinkingLevel,
  sanitizeTaskLedgerTask,
  thinkingVariantsForModel,
} from '@maka/core';
import type {
  CreateSessionInput,
  SessionEvent,
  SessionChangedEvent,
  SessionChangedReason,
  SessionListFilter,
  StoredMessage,
  ThinkingLevel,
} from '@maka/core';
import type { ProviderType } from '@maka/core/llm-connections';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';
import type { SessionManager } from '@maka/runtime';
import type { createArtifactStore, createSessionStore } from '@maka/storage';
import type { ConnectionStore, SettingsStore } from '@maka/storage';
import { runThreadSearch } from './search/thread-search.js';
import { resolveSessionSend } from './session-send-resolve.js';
import { resizeImageForAttachment } from './attachment-resize-native.js';
import { releaseBrowserSession } from './browser/session.js';
import { sessionReadMessagesFailureMessage } from './session-read-error-copy.js';
import { resolveDefaultPermissionMode } from './permission-mode-default.js';
import {
  normalizePermissionResponse,
  normalizeRegenerateTurnInput,
  normalizeSessionSendCommand,
  normalizeStopSessionInput,
  normalizeUserQuestionResponse,
} from './permission-response-guard.js';
import { getVisualSmokeState, type resolveVisualSmokeFixture } from './visual-smoke-fixture.js';
import type { requireReadyConnection } from './chat-readiness.js';
import type { MainTaskLedgerWiring } from './task-ledger-wiring.js';
import type { MainGoalWiring } from './goal-wiring.js';
import type { MainAutomationWiring } from './automation-wiring.js';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';
import type { createMainWindowController } from './main-window.js';
import { handleBranchFromTurn } from './session-branch.js';

type SessionStore = ReturnType<typeof createSessionStore>;
type ArtifactStore = ReturnType<typeof createArtifactStore>;
type MainWindowController = ReturnType<typeof createMainWindowController>;
type VisualSmokeFixture = ReturnType<typeof resolveVisualSmokeFixture>;

/** The per-session cleanup subset of the cursor-overlay controller. */
interface SessionOverlayCleanup {
  clearForSession(sessionId: string): void;
}
/** The per-session cleanup subset of the computer-use tool group. */
interface SessionToolCleanup {
  clearSession(sessionId: string): void;
}

export interface SessionsIpcDeps {
  runtime: SessionManager;
  store: SessionStore;
  taskLedgerStore: MainTaskLedgerWiring['store'];
  goalWiring: MainGoalWiring;
  automationManager: MainAutomationWiring['manager'];
  computerUseOverlay: SessionOverlayCleanup;
  computerUseTools: SessionToolCleanup;
  artifactStore: ArtifactStore;
  attachmentApprovals: AttachmentApprovalRegistry;
  settingsStore: SettingsStore;
  connectionStore: ConnectionStore;
  mainWindowController: MainWindowController;
  visualSmokeFixture: VisualSmokeFixture;
  emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, 'connectionSlug' | 'modelId'>,
  ) => void;
  ensureSessionCanSend: (sessionId: string) => Promise<void>;
  invalidateSessionBindings?: (sessionId: string) => void;
  ensureSessionWorkspaceAvailable: (sessionId: string) => Promise<void>;
  createSession: (input: CreateSessionInput) => ReturnType<SessionManager['createSession']>;
  getReadyConnection: (
    slug: string | null | undefined,
    model?: string,
  ) => ReturnType<typeof requireReadyConnection>;
  streamEvents: (
    sessionId: string,
    iterator: AsyncIterable<SessionEvent>,
    options: {
      turnId: string;
      goalBoundary: 'external' | 'none';
    },
  ) => Promise<{ turnId: string; ok: boolean; error?: string }>;
  getCurrentProjectRoot: () => Promise<string>;
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
  canCreateFakeSession: () => boolean;
}

function latestStoredMessageTs(messages: readonly StoredMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (Number.isFinite(message.ts)) latest = latest === undefined ? message.ts : Math.max(latest, message.ts);
  }
  return latest;
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

export function registerSessionsIpc(deps: SessionsIpcDeps): void {
  const {
    runtime,
    store,
    taskLedgerStore,
    goalWiring,
    automationManager,
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
    invalidateSessionBindings,
    ensureSessionWorkspaceAvailable,
    createSession,
    getReadyConnection,
    streamEvents,
    getWorkspacePrivacyContext,
    canCreateFakeSession,
  } = deps;
  const currentProjectRoot = deps.getCurrentProjectRoot;

  ipcMain.handle('shell-runs:list', (_event, sessionId: string) => runtime.listShellRunUpdates(sessionId));
  ipcMain.handle('tasks:list', async (_event, sessionId: string) => {
    const tasks = await taskLedgerStore.list(sessionId, {
      includeTerminal: true,
      includeArchived: false,
      classifyResumeTrust: true,
      ...(visualSmokeFixture ? { now: getVisualSmokeState(visualSmokeFixture)?.now ?? Date.now() } : {}),
    });
    return tasks.map(sanitizeTaskLedgerTask);
  });
  ipcMain.handle('sessions:list', (_event, filter?: SessionListFilter) => runtime.listSessions(filter));
  ipcMain.handle('sessions:create', async (_event, input?: Partial<CreateSessionInput>) => {
    const cwd = input?.cwd ?? (await currentProjectRoot());
    if (input?.backend === 'fake') {
      if (!canCreateFakeSession()) {
        throw new Error('FakeBackend sessions are only available in development.');
      }
      const session = await createSession({
        cwd,
        backend: 'fake',
        llmConnectionSlug: input.llmConnectionSlug ?? 'fake',
        model: input.model ?? 'fake-model',
        permissionMode: input.permissionMode ?? (await resolveDefaultPermissionMode(() => settingsStore.get())),
        name: input.name ?? DEFAULT_SESSION_NAME,
        labels: input.labels,
      });
      emitSessionsChanged('created', session.id);
      return session;
    }

    const requestedSlug = input?.llmConnectionSlug ?? (await connectionStore.getDefault());
    const { connection, model } = await getReadyConnection(requestedSlug, input?.model);
    const thinkingLevel = normalizeSupportedSessionThinkingLevel(input?.thinkingLevel, connection.providerType, model);

    const session = await createSession({
      cwd,
      backend: 'ai-sdk',
      llmConnectionSlug: connection.slug,
      model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      permissionMode: input?.permissionMode ?? (await resolveDefaultPermissionMode(() => settingsStore.get())),
      name: input?.name ?? DEFAULT_SESSION_NAME,
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
  // Goal kill-switch surface: the renderer reads the active goal to badge a
  // session running an autonomous loop, and clears it to stop the loop. `get`
  // returns null when no goal is set; `clear` settles it (continuation stops
  // after the current turn). Both are pure local state, so no permission gate.
  ipcMain.handle('goal:get', (_event, sessionId: string) => goalWiring.manager.get(sessionId) ?? null);
  ipcMain.handle('goal:clear', (_event, sessionId: string) => {
    goalWiring.clearGoal(sessionId);
  });
  // PR-SEARCH-2: local thread search. Renderer-facing channel; the pure
  // helper in `./search/thread-search.ts` enforces all gates (G1 snippet
  // redaction, G2 fake-backend exclude, G4 caps, G5 case-fold + NFC,
  // G9 tool_result scan cap, G10 system/meta exclusion). The helper
  // receives the runtime via DI so unit tests stay Electron-agnostic.
  // We deliberately do NOT log the request body — query text never enters
  // telemetry.
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
    computerUseOverlay.clearForSession(sessionId);
    computerUseTools.clearSession(sessionId);
    await runtime.stopSession(sessionId, normalizeStopSessionInput(input));
    emitSessionsChanged('status-change', sessionId);
    emitSessionsChanged('turn-status-change', sessionId);
    emitSessionsChanged('message-appended', sessionId);
  });
  ipcMain.handle('sessions:respondToPermission', async (_event, sessionId: string, response) => {
    const normalized = normalizePermissionResponse(response);
    if (normalized.decision === 'allow') {
      await ensureSessionWorkspaceAvailable(sessionId);
    }
    return runtime.respondToPermission(sessionId, normalized);
  });
  ipcMain.handle('sessions:respondToUserQuestion', async (_event, sessionId: string, response) => {
    const normalized = normalizeUserQuestionResponse(response);
    await ensureSessionWorkspaceAvailable(sessionId);
    return runtime.respondToUserQuestion(sessionId, normalized);
  });
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
    void streamEvents(sessionId, iterator, { turnId, goalBoundary: 'external' });
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
  ipcMain.handle('sessions:compact', async (_event, sessionId: string) => {
    await ensureSessionCanSend(sessionId);
    const turnId = randomUUID();
    void streamEvents(sessionId, runtime.compactSession(sessionId, { turnId }), {
      turnId,
      goalBoundary: 'none',
    });
  });
  ipcMain.handle('sessions:regenerateTurn', async (_event, sessionId: string, input: unknown) => {
    await ensureSessionCanSend(sessionId);
    const normalized = normalizeRegenerateTurnInput(input);
    const turnId = normalized.turnId ?? randomUUID();
    void streamEvents(sessionId, runtime.regenerateTurn(sessionId, { ...normalized, turnId }), {
      turnId,
      goalBoundary: 'external',
    });
  });
  ipcMain.handle('sessions:branchFromTurn', async (_event, sessionId: string, input: unknown) => {
    return handleBranchFromTurn(sessionId, input, {
      ensureSessionWorkspaceAvailable,
      branchFromTurn: (id, normalized) => runtime.branchFromTurn(id, normalized),
      emitCreated: (id) => emitSessionsChanged('created', id),
    });
  });
  ipcMain.handle('sessions:archive', async (_event, sessionId: string) => {
    computerUseOverlay.clearForSession(sessionId);
    computerUseTools.clearSession(sessionId);
    await goalWiring.archiveSession(sessionId, () => runtime.archive(sessionId));
    invalidateSessionBindings?.(sessionId);
    // An archived conversation is no longer shown: drop its browser connection
    // and view so it does not keep a live Chromium page in the background.
    await releaseBrowserSession(sessionId);
    // Stop autonomous polling heartbeats tied to the session. Goal ownership is
    // revoked transactionally with the archive above.
    automationManager.removeAllForSession(sessionId);
    emitSessionsChanged('archived', sessionId);
  });
  ipcMain.handle('sessions:unarchive', async (_event, sessionId: string) => {
    await goalWiring.unarchiveSession(sessionId, () => runtime.unarchive(sessionId));
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
    computerUseOverlay.clearForSession(sessionId);
    computerUseTools.clearSession(sessionId);
    await goalWiring.removeSession(sessionId, () => runtime.remove(sessionId));
    invalidateSessionBindings?.(sessionId);
    // Drop the conversation's browser connection and destroy its view (no-op
    // if it never opened one). releaseBrowserSession disposes the view via the
    // host, covering both agent-driven and hand-opened views.
    await releaseBrowserSession(sessionId);
    // Stop autonomous polling heartbeats tied to the session. Goal ownership is
    // revoked transactionally with the removal above.
    automationManager.removeAllForSession(sessionId);
    emitSessionsChanged('deleted', sessionId);
  });
}
