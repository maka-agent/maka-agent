import type { LlmConnection, PermissionMode, SessionSummary, ThinkingLevel } from '@maka/core';
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
  setPendingPermissionModeBySession: BooleanRecordUpdater;
  setPendingNewChatPermissionMode: (mode: PermissionMode | null) => void;
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
    setPendingPermissionModeBySession,
    setPendingNewChatPermissionMode,
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
    const sessionId = activeIdRef.current;
    if (!sessionId) {
      setPendingNewChatPermissionMode(mode);
      return;
    }
    if (pendingPermissionModeChangesRef.current.has(sessionId)) return;
    const current = sessionsRef.current.find((session) => session.id === sessionId);
    if (!current || current.permissionMode === mode) return;
    pendingPermissionModeChangesRef.current.add(sessionId);
    setPendingPermissionModeBySession((current) => ({ ...current, [sessionId]: true }));
    try {
      const next = await window.maka.sessions.setPermissionMode(sessionId, mode);
      // Patch the session in-place so the chat header reflects the new mode
      // immediately without waiting for a full list refresh.
      if (activeIdRef.current === sessionId) {
        setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      }
      const labels: Record<PermissionMode, string> = {
        explore: '只读模式',
        ask: '询问权限',
        execute: '自动执行',
        bypass: '跳过确认',
      };
      if (activeIdRef.current === sessionId) toastApi.success(`已切到 ${labels[mode]}`, permissionModeDescriptions[mode]);
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        toastApi.error(
          '切换权限模式失败',
          generalizedErrorMessageChinese(error, '权限模式暂时无法切换，请稍后重试。'),
        );
      }
    } finally {
      pendingPermissionModeChangesRef.current.delete(sessionId);
      setPendingPermissionModeBySession((current) => {
        if (!(sessionId in current)) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
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
      // Sync the global default so a subsequent "新任务" inherits this pick.
      saveComposerDefaults({ model: input });
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === sessionId) toastApi.error('切换模型失败', generalizedErrorMessageChinese(error, '模型暂时无法切换，请稍后重试。'));
    } finally {
      pendingSessionModelChangesRef.current.delete(sessionId);
      setPendingSessionModelBySession((current) => omitSessionKey(current, sessionId));
    }
  }

  const thinkingLevelLabels: Record<ThinkingLevel, string> = {
    off: '关',
    minimal: '最小',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
  };

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
