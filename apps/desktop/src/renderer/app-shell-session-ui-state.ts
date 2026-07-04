import { useReducer, useRef } from 'react';
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

const SESSION_UI_MAP_KEYS = [
  'messageLoadErrorBySession',
  'messageRetryPendingBySession',
  'stopPendingBySession',
  'streamingBySession',
  'thinkingBySession',
  'thinkingTruncatedBySession',
  'liveToolsBySession',
  'permissionBySession',
  'sessionEventHealthBySession',
  'pendingPermissionModeBySession',
  'pendingSessionModelBySession',
] as const satisfies readonly AppShellSessionUiStateMapKey[];

type MissingSessionUiMapKey = Exclude<AppShellSessionUiStateMapKey, typeof SESSION_UI_MAP_KEYS[number]>;
const allSessionUiMapsAreListed: Record<MissingSessionUiMapKey, never> = {};
void allSessionUiMapsAreListed;

export function createInitialAppShellSessionUiState(): AppShellSessionUiState {
  return Object.fromEntries(SESSION_UI_MAP_KEYS.map((key) => [key, {}])) as unknown as AppShellSessionUiState;
}

function omitSessionKey<K extends AppShellSessionUiStateMapKey>(
  current: AppShellSessionUiState[K],
  sessionId: string,
): AppShellSessionUiState[K] {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete (next as Record<string, unknown>)[sessionId];
  return next as AppShellSessionUiState[K];
}

function updateAppShellSessionUiStateMap<K extends AppShellSessionUiStateMapKey>(
  state: AppShellSessionUiState,
  key: K,
  updater: (current: AppShellSessionUiState[K]) => AppShellSessionUiState[K],
): AppShellSessionUiState {
  const current = state[key];
  const next = updater(current);
  if (next === current) return state;
  return { ...state, [key]: next };
}

function clearSessionUiStateMap<K extends AppShellSessionUiStateMapKey>(
  state: AppShellSessionUiState,
  key: K,
  sessionId: string,
): AppShellSessionUiState {
  return updateAppShellSessionUiStateMap(state, key, (current) => omitSessionKey(current, sessionId));
}

export function clearAppShellSessionUiStateForSession(
  state: AppShellSessionUiState,
  sessionId: string,
): AppShellSessionUiState {
  let nextState = state;
  for (const key of SESSION_UI_MAP_KEYS) {
    nextState = clearSessionUiStateMap(nextState, key, sessionId);
  }
  return nextState;
}

export function createAppShellSessionUiStateController(
  initialState: AppShellSessionUiState = createInitialAppShellSessionUiState(),
  onChange: (state: AppShellSessionUiState) => void = () => {},
) {
  let currentState = initialState;
  const streamingBySessionRef = { current: currentState.streamingBySession };
  const sessionEventHealthBySessionRef = { current: currentState.sessionEventHealthBySession };

  function replaceState(next: AppShellSessionUiState): void {
    if (next === currentState) return;
    currentState = next;
    streamingBySessionRef.current = next.streamingBySession;
    sessionEventHealthBySessionRef.current = next.sessionEventHealthBySession;
    onChange(next);
  }

  function updateMap<K extends AppShellSessionUiStateMapKey>(
    key: K,
    updater: (current: AppShellSessionUiState[K]) => AppShellSessionUiState[K],
  ): void {
    const nextMap = updater(currentState[key]);
    const latestState = currentState;
    if (nextMap === latestState[key]) return;
    replaceState({ ...latestState, [key]: nextMap });
  }

  function createMapSetter<K extends AppShellSessionUiStateMapKey>(key: K): StateUpdater<AppShellSessionUiState[K]> {
    return (updater) => updateMap(key, updater);
  }

  return {
    getState: () => currentState,
    streamingBySessionRef,
    sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession: createMapSetter('messageLoadErrorBySession'),
    setMessageRetryPendingBySession: createMapSetter('messageRetryPendingBySession'),
    setStopPendingBySession: createMapSetter('stopPendingBySession'),
    setStreamingBySession: createMapSetter('streamingBySession'),
    setThinkingBySession: createMapSetter('thinkingBySession'),
    setThinkingTruncatedBySession: createMapSetter('thinkingTruncatedBySession'),
    setLiveToolsBySession: createMapSetter('liveToolsBySession'),
    setPermissionBySession: createMapSetter('permissionBySession'),
    setSessionEventHealthBySession: createMapSetter('sessionEventHealthBySession'),
    setPendingPermissionModeBySession: createMapSetter('pendingPermissionModeBySession'),
    setPendingSessionModelBySession: createMapSetter('pendingSessionModelBySession'),
    clearSessionUiState: (sessionId: string) => {
      replaceState(clearAppShellSessionUiStateForSession(currentState, sessionId));
    },
  };
}

export function useAppShellSessionUiState() {
  const [, forceRender] = useReducer((version: number) => version + 1, 0);
  const controllerRef = useRef<ReturnType<typeof createAppShellSessionUiStateController> | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = createAppShellSessionUiStateController(
      createInitialAppShellSessionUiState(),
      () => forceRender(),
    );
  }

  const controller = controllerRef.current;

  return {
    state: controller.getState(),
    streamingBySessionRef: controller.streamingBySessionRef,
    sessionEventHealthBySessionRef: controller.sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession: controller.setMessageLoadErrorBySession,
    setMessageRetryPendingBySession: controller.setMessageRetryPendingBySession,
    setStopPendingBySession: controller.setStopPendingBySession,
    setStreamingBySession: controller.setStreamingBySession,
    setThinkingBySession: controller.setThinkingBySession,
    setThinkingTruncatedBySession: controller.setThinkingTruncatedBySession,
    setLiveToolsBySession: controller.setLiveToolsBySession,
    setPermissionBySession: controller.setPermissionBySession,
    setSessionEventHealthBySession: controller.setSessionEventHealthBySession,
    setPendingPermissionModeBySession: controller.setPendingPermissionModeBySession,
    setPendingSessionModelBySession: controller.setPendingSessionModelBySession,
    clearSessionUiState: controller.clearSessionUiState,
  };
}
