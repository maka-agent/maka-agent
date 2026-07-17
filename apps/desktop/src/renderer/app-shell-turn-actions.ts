import type { SessionSummary, StoredMessage, UiLocale } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import type { TurnFooterActionMeta } from '@maka/ui';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';

type RefBox<T> = { current: T };
type MessageListUpdater = (next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[])) => void;

type ToastApi = {
  info(title: string, description?: string): void;
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

export interface AppShellTurnActions {
  handleTurnFooterAction(turnId: string, actionId: TurnFooterActionMeta['id']): Promise<void>;
}

export function createAppShellTurnActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  addPendingTurnAction: (key: string) => boolean;
  clearPendingTurnAction: (key: string) => void;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  pendingKeyOf: (sessionId: string, turnId: string, actionId: TurnFooterActionMeta['id']) => string;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshSessions: () => Promise<SessionSummary[]>;
  setMessages: MessageListUpdater;
  toastApi: ToastApi;
  upsertSessionSummary: (session: SessionSummary) => void;
}): AppShellTurnActions {
  const {
    uiLocale,
    activeIdRef,
    addPendingTurnAction,
    clearPendingTurnAction,
    openSessionInChat,
    pendingKeyOf,
    refreshMessages,
    refreshSessions,
    setMessages,
    toastApi,
    upsertSessionSummary,
  } = deps;

  async function handleTurnFooterAction(turnId: string, actionId: TurnFooterActionMeta['id']): Promise<void> {
    if (actionId === 'copy') return; // handled in-component
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const key = pendingKeyOf(sessionId, turnId, actionId);
    // Ref-backed guard blocks same-frame double clicks before React has
    // committed the disabled state. State alone is too late here because
    // retry/regenerate IPC returns after starting the stream asynchronously.
    if (!addPendingTurnAction(key)) return;
    try {
      if (actionId === 'regenerate') {
        await window.maka.sessions.regenerateTurn(sessionId, {
          sourceTurnId: turnId,
        });
        if (activeIdRef.current === sessionId) toastApi.info('已发起重新生成', '正在生成新的一轮回答');
      } else if (actionId === 'branch') {
        const newSession = await window.maka.sessions.branchFromTurn(sessionId, { sourceTurnId: turnId });
        upsertSessionSummary(newSession);
        if (activeIdRef.current === sessionId) {
          openSessionInChat(newSession.id);
          setMessages([]);
          await refreshMessages(newSession.id);
          toastApi.success('已创建分支', `新会话 ${newSession.name}`);
        }
        await refreshSessions();
      }
    } catch (error) {
      if (activeIdRef.current !== sessionId) return;
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error('操作失败', generalizedErrorMessageChinese(error, '对话操作失败，请稍后重试。'));
      }
    } finally {
      clearPendingTurnAction(key);
    }
  }

  return { handleTurnFooterAction };
}
