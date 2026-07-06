import type { PermissionMode, PermissionResponse, SessionSummary, StoredMessage, ThinkingLevel } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import type { NavSelection } from '@maka/ui';
import { messageRefreshErrorMessage } from './app-shell-copy.js';
import { preflightAttachmentItems } from './attachment-preflight.js';

export type PendingAttachment = {
  displayName: string;
  mimeType?: string;
  kind: import('@maka/core').AttachmentRef['kind'];
  size: number;
  source: { type: 'approval'; approvalId: string; name: string } | { type: 'file'; file: File };
};
import {
  isNoRealConnectionError,
  noRealConnectionReasonFromError,
  noRealConnectionSetupDescription,
} from './model-connection-errors.js';

const USER_MESSAGE_VISIBLE_TIMEOUT_MS = 1_200;
const USER_MESSAGE_VISIBLE_POLL_MS = 40;
const COMMITTED_ASSISTANT_SETTLE_DELAYS_MS = [120, 360] as const;

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
};

type RefBox<T> = { current: T };
type BooleanRecordUpdater = (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;
type MessageListUpdater = (next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[])) => void;
type MessageLoadErrorUpdater = (updater: (current: Record<string, string>) => Record<string, string>) => void;

type PendingNewChatModel = {
  llmConnectionSlug: string;
  model: string;
} | null;

type PendingNewChatPermissionMode = PermissionMode | null;

type PendingNewChatThinkingLevel = ThinkingLevel | null;

type ToastApi = {
  error(title: string, description?: string): void;
};

export interface RefreshMessagesOptions {
  requiredAssistantMessageId?: string;
}

function hasAssistantMessage(messages: readonly StoredMessage[], messageId: string): boolean {
  return messages.some((message) => message.type === 'assistant' && message.id === messageId);
}

async function readMessagesForRefresh(
  sessionId: string,
  options: RefreshMessagesOptions = {},
): Promise<{ messages: StoredMessage[]; settled: boolean }> {
  const requiredMessageId = options.requiredAssistantMessageId;
  if (!requiredMessageId) {
    return { messages: await window.maka.sessions.readMessages(sessionId), settled: true };
  }

  let lastError: unknown;
  let lastMessages: StoredMessage[] | undefined;
  for (let attempt = 0; attempt <= COMMITTED_ASSISTANT_SETTLE_DELAYS_MS.length; attempt += 1) {
    try {
      const messages = await window.maka.sessions.readMessages(sessionId);
      if (hasAssistantMessage(messages, requiredMessageId)) {
        return { messages, settled: true };
      }
      lastMessages = messages;
    } catch (error) {
      lastError = error;
    }
    const delayMs = COMMITTED_ASSISTANT_SETTLE_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }
  if (lastMessages) return { messages: lastMessages, settled: false };
  throw lastError;
}

export interface AppShellChatActions {
  send(text: string, pending?: readonly PendingAttachment[]): Promise<boolean>;
  respondToPermission(response: PermissionResponse): Promise<void>;
  refreshMessages(sessionId: string, options?: RefreshMessagesOptions): Promise<boolean>;
  retryMessages(sessionId: string): Promise<void>;
}

function toIngestItems(pending: readonly PendingAttachment[]): RendererIngestInput[] {
  return pending.map((p) =>
    p.source.type === 'approval'
      ? { approvalId: p.source.approvalId, name: p.source.name, ...(p.mimeType ? { mimeType: p.mimeType } : {}) }
      : { file: p.source.file },
  );
}

export function createAppShellChatActions(deps: {
  activeIdRef: RefBox<string | undefined>;
  addPendingSessionAction: (
    sessionId: string,
    pendingRef: RefBox<Set<string>>,
    setPendingBySession: BooleanRecordUpdater,
  ) => boolean;
  captureComposerImportOwner: () => ComposerImportOwner;
  clearPendingSessionAction: (
    sessionId: string,
    pendingRef: RefBox<Set<string>>,
    setPendingBySession: BooleanRecordUpdater,
  ) => void;
  isNewChatSendSurfaceActive: (owner: ComposerImportOwner) => boolean;
  markSessionReadLocally: (sessionId: string, readMessages: readonly StoredMessage[]) => void;
  messageRetryPendingRef: RefBox<Set<string>>;
  pendingNewChatPermissionMode: PendingNewChatPermissionMode;
  setPendingNewChatPermissionMode: (mode: PendingNewChatPermissionMode) => void;
  refreshSessions: () => Promise<SessionSummary[]>;
  setActiveId: (sessionId: string | undefined) => void;
  setMessageLoadErrorBySession: MessageLoadErrorUpdater;
  setMessageRetryPendingBySession: BooleanRecordUpdater;
  setMessages: MessageListUpdater;
  setNavSelection: (selection: NavSelection) => void;
  showModelSetupToast: (description: string, reason?: string) => void;
  toastApi: ToastApi;
  upsertSessionSummary: (session: SessionSummary) => void;
  validPendingNewChatModel: PendingNewChatModel;
  pendingNewChatThinkingLevel: PendingNewChatThinkingLevel;
}): AppShellChatActions {
  const {
    activeIdRef,
    addPendingSessionAction,
    captureComposerImportOwner,
    clearPendingSessionAction,
    isNewChatSendSurfaceActive,
    markSessionReadLocally,
    messageRetryPendingRef,
    pendingNewChatPermissionMode,
    refreshSessions,
    setActiveId,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setMessages,
    setNavSelection,
    setPendingNewChatPermissionMode,
    showModelSetupToast,
    toastApi,
    upsertSessionSummary,
    validPendingNewChatModel,
    pendingNewChatThinkingLevel,
  } = deps;

  function optimisticUserMessage(
    turnId: string,
    text: string,
    attachments: readonly import('@maka/core').AttachmentRef[] = [],
  ): StoredMessage {
    return {
      type: 'user',
      id: `optimistic-user-${turnId}`,
      turnId,
      ts: Date.now(),
      text,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    };
  }

  function showOptimisticUserMessage(
    sessionId: string,
    turnId: string,
    text: string,
    attachments: readonly import('@maka/core').AttachmentRef[] = [],
    options: { replaceCurrentMessages?: boolean } = {},
  ): void {
    if (activeIdRef.current !== sessionId) return;
    setMessageLoadErrorBySession((current) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setMessages((current) => {
      if (current.some((message) => message.type === 'user' && message.turnId === turnId)) return current;
      const next = optimisticUserMessage(turnId, text, attachments);
      return options.replaceCurrentMessages ? [next] : [...current, next];
    });
  }

  function removeOptimisticUserMessage(sessionId: string, turnId: string): void {
    if (activeIdRef.current !== sessionId) return;
    setMessages((current) => current.filter((message) => message.id !== `optimistic-user-${turnId}`));
  }

  async function send(text: string, pending?: readonly PendingAttachment[]): Promise<boolean> {
    const initialSessionId = activeIdRef.current;
    const newChatOwner = initialSessionId ? null : captureComposerImportOwner();
    let optimisticSessionId: string | undefined;
    let optimisticTurnId: string | undefined;
    try {
      const turnId = crypto.randomUUID();
      if (!initialSessionId) {
        if (pending && pending.length > 0) preflightAttachmentItems(pending);
        const session = await window.maka.sessions.create({
          // Only send permissionMode when the user explicitly picked one in
          // the composer. Omitting it lets main.ts's sessions:create resolve
          // the configured chatDefaults.permissionMode as the single
	          // authority — a renderer-side copy of the default can be stale
          // (e.g. before the mount-time settings load resolves on a cold
          // start), which would silently override the configured setting.
          ...(pendingNewChatPermissionMode ? { permissionMode: pendingNewChatPermissionMode } : {}),
          name: text.slice(0, 42) || '新建对话',
          ...(validPendingNewChatModel
            ? { llmConnectionSlug: validPendingNewChatModel.llmConnectionSlug, model: validPendingNewChatModel.model }
            : {}),
          ...(pendingNewChatThinkingLevel ? { thinkingLevel: pendingNewChatThinkingLevel } : {}),
        });
        setPendingNewChatPermissionMode(null);
        upsertSessionSummary(session);
        optimisticSessionId = session.id;
        optimisticTurnId = turnId;
        const attachmentItems = pending && pending.length > 0 ? toIngestItems(pending) : undefined;
        const sendResult = await window.maka.sessions.send(session.id, { type: 'send', turnId, text, ...(attachmentItems ? { attachmentItems } : {}) });
        if (newChatOwner && isNewChatSendSurfaceActive(newChatOwner)) {
          setNavSelection({ section: 'sessions', filter: 'chats' });
          setActiveId(session.id);
          showOptimisticUserMessage(session.id, turnId, text, sendResult.attachments, { replaceCurrentMessages: true });
        }
        if (activeIdRef.current === session.id) {
          await refreshMessagesUntilTurn(session.id, turnId);
        }
        await refreshSessions();
        return true;
      }
      const sessionId = initialSessionId;
      optimisticSessionId = sessionId;
      optimisticTurnId = turnId;
      const attachmentItems = pending && pending.length > 0 ? toIngestItems(pending) : undefined;
      const sendResult = await window.maka.sessions.send(sessionId, { type: 'send', turnId, text, ...(attachmentItems ? { attachmentItems } : {}) });
      showOptimisticUserMessage(sessionId, turnId, text, sendResult.attachments);
      await refreshMessagesUntilTurn(sessionId, turnId);
      return true;
    } catch (error) {
      if (optimisticSessionId && optimisticTurnId) {
        removeOptimisticUserMessage(optimisticSessionId, optimisticTurnId);
      }
      const feedbackSessionId = optimisticSessionId ?? initialSessionId;
      const sendStillOwnsCurrentSurface = feedbackSessionId
        ? activeIdRef.current === feedbackSessionId
        : newChatOwner
          ? isNewChatSendSurfaceActive(newChatOwner)
          : activeIdRef.current === initialSessionId;
      if (!sendStillOwnsCurrentSurface) return false;
      if (isNoRealConnectionError(error)) {
        const reason = noRealConnectionReasonFromError(error);
        showModelSetupToast(noRealConnectionSetupDescription(reason), reason);
      } else {
        toastApi.error('发送失败', generalizedErrorMessageChinese(error, '消息暂时无法发送，请稍后重试。'));
      }
      return false;
    }
  }

  async function respondToPermission(response: PermissionResponse) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    try {
      await window.maka.sessions.respondToPermission(sessionId, response);
    } catch (error) {
      // Same fire-and-forget call site as stop(), wrap so a failed
      // permission response (main process busy / session dropped)
      // surfaces instead of dying as UnhandledPromiseRejection.
      if (activeIdRef.current === sessionId) toastApi.error('响应失败', generalizedErrorMessageChinese(error, '会话操作失败，请稍后重试。'));
    }
  }

  async function refreshMessages(sessionId: string, options: RefreshMessagesOptions = {}): Promise<boolean> {
    try {
      const result = await readMessagesForRefresh(sessionId, options);
      const next = result.messages;
      if (activeIdRef.current === sessionId) {
        markSessionReadLocally(sessionId, next);
        setMessages(next);
        setMessageLoadErrorBySession((current) => {
          if (!current[sessionId]) return current;
          const updated = { ...current };
          delete updated[sessionId];
          return updated;
        });
      }
      return result.settled;
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        const message = messageRefreshErrorMessage(error);
        setMessageLoadErrorBySession((current) => ({ ...current, [sessionId]: message }));
        toastApi.error('刷新对话失败', message);
      }
      return false;
    }
  }
  async function retryMessages(sessionId: string) {
    if (!addPendingSessionAction(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession)) return;
    try {
      await refreshMessages(sessionId);
    } finally {
      clearPendingSessionAction(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession);
    }
  }

  async function refreshMessagesUntilTurn(sessionId: string, turnId: string): Promise<void> {
    const deadline = Date.now() + USER_MESSAGE_VISIBLE_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      // PR-FE-BUG-HUNT-4 (kenji bug-hunt 2026-06-24 LOW): bail if the
      // user navigated away from the session this poll was started for.
      // Previously the loop kept burning IPC bandwidth for the full
      // 1200ms after a session switch (the setState was gated, but the
      // readMessages call still fired every 40ms). Now we stop the
      // polling cycle itself.
      if (activeIdRef.current !== sessionId) return;
      try {
        const next = await window.maka.sessions.readMessages(sessionId);
        if (activeIdRef.current !== sessionId) return;
        const hasSentUserTurn = next.some((message) => message.type === 'user' && message.turnId === turnId);
        if (hasSentUserTurn) {
          markSessionReadLocally(sessionId, next);
          setMessages(next);
          return;
        }
      } catch {
        // Keep the current visible messages while the bounded retry loop
        // waits for the async send path to persist the first user message.
      }
      await new Promise((resolve) => window.setTimeout(resolve, USER_MESSAGE_VISIBLE_POLL_MS));
    }
    if (activeIdRef.current === sessionId) {
      await refreshMessages(sessionId);
    }
  }

  return {
    send,
    respondToPermission,
    refreshMessages,
    retryMessages,
  };
}
