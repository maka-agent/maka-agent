import { useRef, useState } from 'react';
import type { StoredMessage } from '@maka/core';
import { useAppShellSessionUiState } from './app-shell-session-ui-state';
import { useAppShellSessionList } from './use-app-shell-session-list';

type ToastApi = {
  error(title: string, description?: string): void;
};

export function useAppShellSessionWorkspace(toastApi: ToastApi) {
  const sessionList = useAppShellSessionList(toastApi);
  const sessionUi = useAppShellSessionUiState();
  const [activeId, setActiveIdState] = useState<string | undefined>();
  const activeIdRef = useRef<string | undefined>(undefined);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [messageLoadPending, setMessageLoadPending] = useState(false);
  const messageRetryPendingRef = useRef<Set<string>>(new Set());
  const stopPendingRef = useRef<Set<string>>(new Set());

  function setActiveId(next: string | undefined): void {
    // Clear here, not in the read effect: a layout-effect clear would wipe an
    // optimistic first message before the first paint.
    if (!next) {
      setMessageLoadPending(false);
    } else if (next !== activeIdRef.current) {
      setMessages([]);
      setMessageLoadPending(true);
    }
    activeIdRef.current = next;
    setActiveIdState(next);
  }

  function startNewSession(): void {
    setActiveId(undefined);
    setMessages([]);
  }

  function clearOwnedSessionState(sessionId: string): void {
    messageRetryPendingRef.current.delete(sessionId);
    stopPendingRef.current.delete(sessionId);
    sessionUi.clearSessionUiState(sessionId);
  }

  return {
    ...sessionList,
    activeId,
    activeIdRef,
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    messages,
    setMessages,
    messageLoadPending,
    setMessageLoadPending,
    messageRetryPendingRef,
    stopPendingRef,
    sessionUiState: sessionUi.state,
    liveTurnBySessionRef: sessionUi.liveTurnBySessionRef,
    sessionEventHealthBySessionRef: sessionUi.sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession: sessionUi.setMessageLoadErrorBySession,
    setMessageRetryPendingBySession: sessionUi.setMessageRetryPendingBySession,
    setStopPendingBySession: sessionUi.setStopPendingBySession,
    setLiveTurnBySession: sessionUi.setLiveTurnBySession,
    setPermissionBySession: sessionUi.setPermissionBySession,
    setSessionEventHealthBySession: sessionUi.setSessionEventHealthBySession,
    setPendingPermissionModeBySession: sessionUi.setPendingPermissionModeBySession,
    setPendingSessionModelBySession: sessionUi.setPendingSessionModelBySession,
    clearTurnTransientState: sessionUi.clearTurnTransientState,
  };
}
