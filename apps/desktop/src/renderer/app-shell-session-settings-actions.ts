import type { ChatDefaultPermissionMode, LlmConnection, PermissionMode, SessionSummary, ThinkingLevel } from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import { permissionModeDescriptions } from './app-shell-copy';
import { saveComposerDefaults } from './composer-defaults';

type RefBox<T> = { current: T };
type BooleanRecordUpdater = (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;

type ToastApi = {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

export interface AppShellSessionSettingsActions {
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setSessionModel(input: { llmConnectionSlug: string; model: string }): Promise<void>;
  setSessionThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
}

export function createAppShellSessionSettingsActions(deps: {
  activeIdRef: RefBox<string | undefined>;
  connections: readonly LlmConnection[];
  pendingPermissionModeChangesRef: RefBox<Set<string>>;
  pendingSessionModelChangesRef: RefBox<Set<string>>;
  refreshSessions: () => Promise<SessionSummary[]>;
  sessionsRef: RefBox<SessionSummary[]>;
  setDefaultPermissionMode: (mode: ChatDefaultPermissionMode) => void;
  setPendingPermissionModeBySession: BooleanRecordUpdater;
  setPendingSessionModelBySession: BooleanRecordUpdater;
  setSessions: (updater: (current: SessionSummary[]) => SessionSummary[]) => void;
  toastApi: ToastApi;
}): AppShellSessionSettingsActions {
  const {
    activeIdRef,
    connections,
    pendingPermissionModeChangesRef,
    pendingSessionModelChangesRef,
    refreshSessions,
    sessionsRef,
    setDefaultPermissionMode,
    setPendingPermissionModeBySession,
    setPendingSessionModelBySession,
    setSessions,
    toastApi,
  } = deps;

  function omitSessionKey<T>(current: Record<string, T>, sessionId: string): Record<string, T> {
    if (!(sessionId in current)) return current;
    const next = { ...current };
    delete next[sessionId];
    return next;
  }

  async function setPermissionMode(mode: PermissionMode) {
    if (mode === 'explore') return;
    const sessionId = activeIdRef.current;
    const pendingKey = sessionId ?? '__global_permission_mode__';
    if (pendingPermissionModeChangesRef.current.has(pendingKey)) return;

    pendingPermissionModeChangesRef.current.add(pendingKey);
    if (sessionId) setPendingPermissionModeBySession((current) => ({ ...current, [sessionId]: true }));
    try {
      const result = await window.maka.settings.update({ chatDefaults: { permissionMode: mode } });
      const nextMode = result.settings.chatDefaults.permissionMode;
      setDefaultPermissionMode(nextMode);
      setSessions((prev) => prev.map((session) => ({ ...session, permissionMode: nextMode })));
      toastApi.success(`已切到 ${permissionModeLabels[nextMode]}`, permissionModeDescriptions[nextMode]);
      await refreshSessions();
    } catch (error) {
      toastApi.error(
        '切换权限模式失败',
        generalizedErrorMessageChinese(error, '权限模式暂时无法切换，请稍后重试。'),
      );
    } finally {
      pendingPermissionModeChangesRef.current.delete(pendingKey);
      if (sessionId) setPendingPermissionModeBySession((current) => omitSessionKey(current, sessionId));
    }
  }

  async function setSessionModel(input: { llmConnectionSlug: string; model: string }) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    if (pendingSessionModelChangesRef.current.has(sessionId)) return;
    pendingSessionModelChangesRef.current.add(sessionId);
    setPendingSessionModelBySession((current) => ({ ...current, [sessionId]: true }));
    try {
      const next = await window.maka.sessions.setModel(sessionId, input);
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      const connection = connections.find((entry) => entry.slug === next.llmConnectionSlug);
      if (activeIdRef.current === sessionId) {
        toastApi.success(
          '已切换当前会话模型',
          `${connection?.name ?? next.llmConnectionSlug} · ${next.model}`,
        );
      }
      saveComposerDefaults({ model: input });
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error('切换模型失败', generalizedErrorMessageChinese(error, '模型暂时无法切换，请稍后重试。'));
      }
    } finally {
      pendingSessionModelChangesRef.current.delete(sessionId);
      setPendingSessionModelBySession((current) => omitSessionKey(current, sessionId));
    }
  }

  async function setSessionThinkingLevel(level: ThinkingLevel | undefined) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const current = sessionsRef.current.find((session) => session.id === sessionId);
    if (current && current.thinkingLevel === level) return;
    try {
      const next = await window.maka.sessions.setThinkingLevel(sessionId, level);
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      if (activeIdRef.current === sessionId) {
        toastApi.success('已更新思考级别', level ? thinkingLevelLabels[level] : '默认');
      }
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error('切换思考级别失败', generalizedErrorMessageChinese(error, '思考级别暂时无法切换，请稍后重试。'));
      }
    }
  }

  return {
    setPermissionMode,
    setSessionModel,
    setSessionThinkingLevel,
  };
}

const permissionModeLabels: Record<ChatDefaultPermissionMode, string> = {
  ask: '询问权限',
  execute: '自动执行',
  bypass: '跳过确认',
};

const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: '关',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};
