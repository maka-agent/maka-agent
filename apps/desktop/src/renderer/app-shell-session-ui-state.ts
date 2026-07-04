import { useCallback, useReducer, useRef } from 'react';
import type { SessionEventStreamSnapshot } from '@maka/core';
import type { AssistantStreamSlot, PermissionQueues, ToolActivityItem } from '@maka/ui';

type StateUpdater<T> = (updater: (current: T) => T) => void;

export interface AppShellSessionUiState {
  messageLoadErrorBySession: Record<string, string>;
  messageRetryPendingBySession: Record<string, boolean>;
  stopPendingBySession: Record<string, boolean>;
  streamingBySession: Record<string, AssistantStreamSlot>;
  thinkingBySession: Record<string, string>;
  thinkingTruncatedBySession: Record<string, boolean>;
  liveToolsBySession: Record<string, ToolActivityItem[]>;
  permissionBySession: PermissionQueues;
  sessionEventHealthBySession: Record<string, SessionEventStreamSnapshot>;
  pendingPermissionModeBySession: Record<string, boolean>;
  pendingSessionModelBySession: Record<string, boolean>;
}

type AppShellSessionUiStateMapKey = keyof AppShellSessionUiState;

type UpdateMapAction<K extends AppShellSessionUiStateMapKey = AppShellSessionUiStateMapKey> = {
  [Key in K]: {
    type: 'update-map';
    key: Key;
    updater: (current: AppShellSessionUiState[Key]) => AppShellSessionUiState[Key];
  };
}[K];

type ReplaceStateAction = {
  type: 'replace-state';
  state: AppShellSessionUiState;
};

type AppShellSessionUiStateAction =
  | ReplaceStateAction
  | UpdateMapAction
  | {
    type: 'clear-session';
    sessionId: string;
  };

export function createInitialAppShellSessionUiState(): AppShellSessionUiState {
  return {
    messageLoadErrorBySession: {},
    messageRetryPendingBySession: {},
    stopPendingBySession: {},
    streamingBySession: {},
    thinkingBySession: {},
    thinkingTruncatedBySession: {},
    liveToolsBySession: {},
    permissionBySession: {},
    sessionEventHealthBySession: {},
    pendingPermissionModeBySession: {},
    pendingSessionModelBySession: {},
  };
}

function omitSessionKey<T>(current: Record<string, T>, sessionId: string): Record<string, T> {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
}

function updateMap<K extends AppShellSessionUiStateMapKey>(
  state: AppShellSessionUiState,
  key: K,
  updater: (current: AppShellSessionUiState[K]) => AppShellSessionUiState[K],
): AppShellSessionUiState {
  const current = state[key];
  const next = updater(current);
  if (next === current) return state;
  return { ...state, [key]: next };
}

function clearAppShellSessionUiStateForSession(
  state: AppShellSessionUiState,
  sessionId: string,
): AppShellSessionUiState {
  let nextState = state;

  nextState = updateMap(nextState, 'messageLoadErrorBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'messageRetryPendingBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'stopPendingBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'streamingBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'thinkingBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'thinkingTruncatedBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'liveToolsBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'permissionBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'sessionEventHealthBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'pendingPermissionModeBySession', (current) => omitSessionKey(current, sessionId));
  nextState = updateMap(nextState, 'pendingSessionModelBySession', (current) => omitSessionKey(current, sessionId));

  return nextState;
}

export function appShellSessionUiStateReducer(
  state: AppShellSessionUiState,
  action: AppShellSessionUiStateAction,
): AppShellSessionUiState {
  switch (action.type) {
    case 'replace-state':
      return action.state;
    case 'clear-session':
      return clearAppShellSessionUiStateForSession(state, action.sessionId);
    case 'update-map':
      switch (action.key) {
        case 'messageLoadErrorBySession':
          return updateMap(state, action.key, action.updater);
        case 'messageRetryPendingBySession':
          return updateMap(state, action.key, action.updater);
        case 'stopPendingBySession':
          return updateMap(state, action.key, action.updater);
        case 'streamingBySession':
          return updateMap(state, action.key, action.updater);
        case 'thinkingBySession':
          return updateMap(state, action.key, action.updater);
        case 'thinkingTruncatedBySession':
          return updateMap(state, action.key, action.updater);
        case 'liveToolsBySession':
          return updateMap(state, action.key, action.updater);
        case 'permissionBySession':
          return updateMap(state, action.key, action.updater);
        case 'sessionEventHealthBySession':
          return updateMap(state, action.key, action.updater);
        case 'pendingPermissionModeBySession':
          return updateMap(state, action.key, action.updater);
        case 'pendingSessionModelBySession':
          return updateMap(state, action.key, action.updater);
      }
  }
}

export function useAppShellSessionUiState() {
  const initialStateRef = useRef<AppShellSessionUiState | null>(null);
  if (!initialStateRef.current) initialStateRef.current = createInitialAppShellSessionUiState();

  const stateRef = useRef<AppShellSessionUiState>(initialStateRef.current);
  // Event handlers need same-frame reads after state setters run.
  const streamingBySessionRef = useRef<Record<string, AssistantStreamSlot>>(stateRef.current.streamingBySession);
  const sessionEventHealthBySessionRef =
    useRef<Record<string, SessionEventStreamSnapshot>>(stateRef.current.sessionEventHealthBySession);
  const [state, baseDispatch] = useReducer(appShellSessionUiStateReducer, stateRef.current);

  const replaceState = useCallback((next: AppShellSessionUiState) => {
    stateRef.current = next;
    streamingBySessionRef.current = next.streamingBySession;
    sessionEventHealthBySessionRef.current = next.sessionEventHealthBySession;
    baseDispatch({ type: 'replace-state', state: next });
  }, []);

  const dispatch = useCallback((action: Exclude<AppShellSessionUiStateAction, ReplaceStateAction>) => {
    const next = appShellSessionUiStateReducer(stateRef.current, action);
    if (next === stateRef.current) return;
    replaceState(next);
  }, [replaceState]);

  const setMessageLoadErrorBySession = useCallback<StateUpdater<Record<string, string>>>(
    (updater) => dispatch({ type: 'update-map', key: 'messageLoadErrorBySession', updater }),
    [dispatch],
  );
  const setMessageRetryPendingBySession = useCallback<StateUpdater<Record<string, boolean>>>(
    (updater) => dispatch({ type: 'update-map', key: 'messageRetryPendingBySession', updater }),
    [dispatch],
  );
  const setStopPendingBySession = useCallback<StateUpdater<Record<string, boolean>>>(
    (updater) => dispatch({ type: 'update-map', key: 'stopPendingBySession', updater }),
    [dispatch],
  );
  const setStreamingBySession = useCallback<StateUpdater<Record<string, AssistantStreamSlot>>>(
    (updater) => dispatch({ type: 'update-map', key: 'streamingBySession', updater }),
    [dispatch],
  );
  const setThinkingBySession = useCallback<StateUpdater<Record<string, string>>>(
    (updater) => dispatch({ type: 'update-map', key: 'thinkingBySession', updater }),
    [dispatch],
  );
  const setThinkingTruncatedBySession = useCallback<StateUpdater<Record<string, boolean>>>(
    (updater) => dispatch({ type: 'update-map', key: 'thinkingTruncatedBySession', updater }),
    [dispatch],
  );
  const setLiveToolsBySession = useCallback<StateUpdater<Record<string, ToolActivityItem[]>>>(
    (updater) => dispatch({ type: 'update-map', key: 'liveToolsBySession', updater }),
    [dispatch],
  );
  const setPermissionBySession = useCallback<StateUpdater<PermissionQueues>>(
    (updater) => dispatch({ type: 'update-map', key: 'permissionBySession', updater }),
    [dispatch],
  );
  const setSessionEventHealthBySession =
    useCallback<StateUpdater<Record<string, SessionEventStreamSnapshot>>>(
      (updater) => dispatch({ type: 'update-map', key: 'sessionEventHealthBySession', updater }),
      [dispatch],
    );
  const setPendingPermissionModeBySession = useCallback<StateUpdater<Record<string, boolean>>>(
    (updater) => dispatch({ type: 'update-map', key: 'pendingPermissionModeBySession', updater }),
    [dispatch],
  );
  const setPendingSessionModelBySession = useCallback<StateUpdater<Record<string, boolean>>>(
    (updater) => dispatch({ type: 'update-map', key: 'pendingSessionModelBySession', updater }),
    [dispatch],
  );
  const clearSessionUiState = useCallback((sessionId: string) => {
    dispatch({ type: 'clear-session', sessionId });
  }, [dispatch]);

  return {
    state,
    streamingBySessionRef,
    sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setStopPendingBySession,
    setStreamingBySession,
    setThinkingBySession,
    setThinkingTruncatedBySession,
    setLiveToolsBySession,
    setPermissionBySession,
    setSessionEventHealthBySession,
    setPendingPermissionModeBySession,
    setPendingSessionModelBySession,
    clearSessionUiState,
  };
}
