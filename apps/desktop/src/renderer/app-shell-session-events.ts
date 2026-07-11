import type { SessionEvent, StoredMessage } from '@maka/core';
import {
  applyLiveTurnEvent,
  clearPermissions,
  dequeuePermission,
  dequeuePermissionByToolUseId,
  enqueuePermission,
  reconcileTerminalLiveTurn,
  settleLiveTurnStep,
  type LiveTurnProjection,
  type PermissionQueues,
} from '@maka/ui';
import type { RefreshMessagesOptions } from './app-shell-chat-actions.js';
import {
  isNoRealConnectionEvent,
  noRealConnectionReasonFromEvent,
  noRealConnectionSetupDescription,
  sessionEventErrorMessage,
} from './model-connection-errors.js';

type RefBox<T> = { current: T };
type StateUpdater<T> = (updater: (current: T) => T) => void;

type ToastApi = {
  error(title: string, description?: string): void;
};

export interface AppShellSessionEventHandlers {
  handleEvent(sessionId: string, event: SessionEvent): void;
  reconcilePersistedMessages(sessionId: string, messages: readonly StoredMessage[]): void;
  settleAssistantStreaming(sessionId: string, messageId?: string): Promise<void>;
}

export function createAppShellSessionEventHandlers(options: {
  activeIdRef: RefBox<string | undefined>;
  liveTurnBySessionRef: RefBox<Record<string, LiveTurnProjection>>;
  refreshMessages: (sessionId: string, options?: RefreshMessagesOptions) => Promise<boolean>;
  refreshSessions: () => Promise<unknown>;
  setLiveTurnBySession: StateUpdater<Record<string, LiveTurnProjection>>;
  setPermissionBySession: StateUpdater<PermissionQueues>;
  showModelSetupToast: (description: string, reason?: string) => void;
  toastApi: ToastApi;
  notifyRunEnded?: (payload: { kind: 'completed' | 'errored'; sessionId: string; body?: string }) => void;
}): AppShellSessionEventHandlers {
  const {
    activeIdRef,
    liveTurnBySessionRef,
    refreshMessages,
    refreshSessions,
    setLiveTurnBySession,
    setPermissionBySession,
    showModelSetupToast,
    toastApi,
    notifyRunEnded,
  } = options;

  function updateLiveTurn(sessionId: string, event: SessionEvent): void {
    setLiveTurnBySession((current) => {
      const nextProjection = applyLiveTurnEvent(current[sessionId], event);
      if (nextProjection === current[sessionId]) return current;
      const next = { ...current };
      if (nextProjection) next[sessionId] = nextProjection;
      else delete next[sessionId];
      return next;
    });
  }

  function settleLiveStep(sessionId: string, stepId: string): void {
    setLiveTurnBySession((current) => {
      const projection = current[sessionId];
      if (!projection) return current;
      const settled = settleLiveTurnStep(projection, stepId);
      if (settled === projection) return current;
      const next = { ...current };
      if (settled) next[sessionId] = settled;
      else delete next[sessionId];
      return next;
    });
  }

  async function settleAssistantStreaming(sessionId: string, messageId?: string): Promise<void> {
    const projection = liveTurnBySessionRef.current[sessionId];
    if (!projection || !messageId) return;
    const step = projection.steps.find((candidate) => candidate.stepId === messageId);
    if (!step?.text?.complete) return;
    const refreshed = await refreshMessages(sessionId, { requiredAssistantMessageId: messageId }).catch(() => false);
    if (!refreshed) return;
    settleLiveStep(sessionId, messageId);
  }

  function reconcilePersistedMessages(sessionId: string, messages: readonly StoredMessage[]): void {
    setLiveTurnBySession((current) => {
      const projection = current[sessionId];
      if (!projection) return current;
      const reconciled = reconcileTerminalLiveTurn(projection, messages);
      if (reconciled === projection) return current;
      const next = { ...current };
      if (reconciled) next[sessionId] = reconciled;
      else delete next[sessionId];
      return next;
    });
  }

  function terminalRefreshOptions(projection: LiveTurnProjection | undefined): RefreshMessagesOptions | undefined {
    const messageId = [...(projection?.steps ?? [])].reverse().find((step) => step.text)?.stepId;
    return messageId ? { requiredAssistantMessageId: messageId } : undefined;
  }

  function handleEvent(sessionId: string, event: SessionEvent): void {
    const before = liveTurnBySessionRef.current[sessionId];
    updateLiveTurn(sessionId, event);

    switch (event.type) {
      case 'text_complete':
        void refreshMessages(sessionId, { requiredAssistantMessageId: event.messageId }).catch(() => false);
        break;
      case 'permission_request':
        setPermissionBySession((current) => enqueuePermission(current, sessionId, event));
        break;
      case 'permission_decision_ack':
        setPermissionBySession((current) => dequeuePermission(current, sessionId, event.requestId));
        break;
      case 'tool_result':
        setPermissionBySession((current) => dequeuePermissionByToolUseId(current, sessionId, event.toolUseId));
        void refreshMessages(sessionId);
        break;
      case 'error':
        setPermissionBySession((current) => clearPermissions(current, sessionId));
        if (activeIdRef.current === sessionId) {
          if (isNoRealConnectionEvent(event)) {
            const reason = noRealConnectionReasonFromEvent(event);
            showModelSetupToast(noRealConnectionSetupDescription(reason), reason);
          } else {
            toastApi.error('对话出错', sessionEventErrorMessage(event));
          }
        }
        notifyRunEnded?.({ kind: 'errored', sessionId, body: sessionEventErrorMessage(event) });
        void refreshSessions();
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      case 'abort':
        setPermissionBySession((current) => clearPermissions(current, sessionId));
        void refreshSessions();
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      case 'complete': {
        if (event.stopReason !== 'permission_handoff') {
          setPermissionBySession((current) => clearPermissions(current, sessionId));
          if (event.stopReason === 'end_turn' || event.stopReason === 'max_tokens') {
            const body = [...(before?.steps ?? [])].reverse().find((step) => step.text?.text)?.text?.text;
            notifyRunEnded?.({ kind: 'completed', sessionId, body });
          }
        }
        void refreshSessions();
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      }
      default:
        break;
    }
  }

  return { handleEvent, reconcilePersistedMessages, settleAssistantStreaming };
}
