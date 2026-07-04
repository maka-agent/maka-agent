import { useEffect, useRef } from 'react';
import type {
  ConnectionEvent,
  PlanReminder,
  SessionEvent,
  SessionEventStreamSnapshot,
  SessionSummary,
  PermissionRequestEvent,
  StoredMessage,
  ThemePalette,
  ThemePreference,
} from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import type { NavSelection, PermissionQueues } from '@maka/ui';
import { messageReadErrorMessage } from './app-shell-copy';
import { applyTheme, applyThemePalette } from './theme';
import { safeLocalStorageSet } from './browser-storage';
import {
  createSessionEventStreamSubscription,
  evaluateSessionEventStreamSnapshot,
  recordSessionEventStreamChange,
  recordSessionEventStreamEvent,
} from './session-event-health';

type RefBox<T> = { current: T };
type SessionEventHealthUpdater = (
  updater: (current: Record<string, SessionEventStreamSnapshot>) => Record<string, SessionEventStreamSnapshot>,
) => void;

type ToastApi = {
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
  toast(options: {
    title: string;
    description?: string;
    variant?: 'info' | 'error' | 'success' | 'warning';
    duration?: number;
    action?: { label: string; onClick: () => void };
  }): void;
};

// Long-lived subscriptions below mount once; their callbacks read this ref so
// AppShell handlers can change across renders without resubscribing.
function useLatestRef<T>(value: T): RefBox<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useAppShellRefSync(options: {
  activeId: string | undefined;
  activeIdRef: RefBox<string | undefined>;
  navSelection: NavSelection;
  navSelectionRef: RefBox<NavSelection>;
  sessions: SessionSummary[];
  sessionsRef: RefBox<SessionSummary[]>;
}) {
  useEffect(() => {
    options.activeIdRef.current = options.activeId;
  }, [options.activeId]);

  useEffect(() => {
    options.navSelectionRef.current = options.navSelection;
  }, [options.navSelection]);

  useEffect(() => {
    options.sessionsRef.current = options.sessions;
  }, [options.sessions]);
}

export function useAppShellHostEffects(options: {
  activeId: string | undefined;
  hasModalOpen: boolean;
  setLiveBrowserSessionIds: (sessionIds: string[]) => void;
}) {
  // Tag the document with the host OS so glass-material CSS rules
  // (sidebar vibrancy passthrough — see notes/reference-atlas.md §1 + §12.1)
  // can light up only on macOS, where `BrowserWindow({ vibrancy: 'sidebar' })`
  // paints the native blur material behind the renderer. Other platforms
  // keep their opaque chrome since vibrancy is a no-op there.
  useEffect(() => {
    let cancelled = false;
    void window.maka.app.info().then((info) => {
      if (cancelled) return;
      document.documentElement.setAttribute('data-os', info.platform);
    }).catch(() => {
      /* swallow — leaves data-os unset, CSS falls back to opaque chrome */
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // P3 embedded browser: track which sessions have a live view (panel mounts
  // only for those) and tell main which session this window shows (so it can
  // validate browser:* IPC targets).
  useEffect(() => {
    const off = window.maka.browser.onLive((payload) => options.setLiveBrowserSessionIds(payload.sessionIds));
    return off;
  }, []);

  useEffect(() => {
    window.maka.browser.setActiveSession(options.activeId ?? null);
  }, [options.activeId]);

  useEffect(() => {
    void window.maka.appWindow.setTitlebarControlsVisible(!options.hasModalOpen).catch(() => {});
    return () => {
      void window.maka.appWindow.setTitlebarControlsVisible(true).catch(() => {});
    };
  }, [options.hasModalOpen]);
}

export function useAppShellPersistenceEffects(options: {
  navSelection: NavSelection;
  sessionListCollapsed: boolean;
  sessionListWidth: number;
  themePalette: ThemePalette;
  themePref: ThemePreference;
}) {
  // Keep <html class="dark"> in sync with the active preference. The Settings
  // modal also calls applyTheme on local change so the effect is immediate,
  // but this keeps the listener for 'auto' alive at the app level.
  useEffect(() => {
    const unsubscribe = applyTheme(options.themePref);
    return unsubscribe;
  }, [options.themePref]);

  // PR-THEME-APPLY-AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): re-apply the
  // palette data attribute whenever the persisted setting changes, so
  // switching themes in Settings is immediately visible. Previously the
  // attribute was only set once at mount, so a palette change required a
  // restart before the new colors took effect.
  useEffect(() => {
    applyThemePalette(options.themePalette);
  }, [options.themePalette]);

  // PR-FE-BUG-HUNT-5 (kenji bug-hunt 2026-06-24 LOW): pointer drag on
  // the sidebar resizer fires `setSessionListWidth` on every move
  // event — at ~60Hz over a long drag, that's a couple hundred
  // localStorage writes for a single resize gesture. The setting
  // converges to the user's final width at rest; intermediate
  // values aren't load-bearing. 200ms trailing debounce keeps the
  // last-render value in storage without flushing every pixel.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      safeLocalStorageSet('maka-chat-list-width-v1', String(options.sessionListWidth));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [options.sessionListWidth]);

  useEffect(() => {
    safeLocalStorageSet('maka-chat-list-collapsed-v1', options.sessionListCollapsed ? 'true' : 'false');
  }, [options.sessionListCollapsed]);

  // Persist sidebar nav selection so the app remembers what bucket the user
  // had open (Chats / Pinned / Archived / Skills) across restarts. Strict
  // localStorage availability check — Vite dev sometimes runs through a
  // worker where it isn't defined.
  useEffect(() => {
    safeLocalStorageSet('maka-nav-selection-v1', JSON.stringify(options.navSelection));
  }, [options.navSelection]);
}

export function useAppShellBootstrapSubscriptions(options: {
  activeIdRef: RefBox<string | undefined>;
  applyVisualSmokeFixture: () => Promise<void>;
  bootstrapSessions: () => Promise<void>;
  clearPendingTurnActionsForSession: (sessionId: string) => void;
  clearSessionRendererState: (sessionId: string) => void;
  handleConnectionEvent: (event: ConnectionEvent) => void;
  openSettings: () => void;
  pendingPermissionModeChangesRef: RefBox<Set<string>>;
  pendingSessionModelChangesRef: RefBox<Set<string>>;
  pendingTurnActionTimersRef: RefBox<Map<string, ReturnType<typeof setTimeout>>>;
  pendingTurnActionsRef: RefBox<Set<string>>;
  projectPickerPendingRef: RefBox<boolean>;
  projectPickerRequestRef: RefBox<number>;
  refreshAppInfo: () => Promise<void>;
  refreshConnections: () => Promise<void>;
  refreshMemoryActive: (failureTitle?: string) => Promise<void>;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshPlanReminders: (options?: { shouldShowError?: () => boolean }) => Promise<void>;
  refreshShellSettings: () => Promise<void>;
  refreshSkills: (options?: { shouldShowError?: () => boolean }) => Promise<void>;
  refreshSessions: () => Promise<SessionSummary[]>;
  rendererMountedRef: RefBox<boolean>;
  setActiveId: (sessionId: string | undefined) => void;
  setMessages: (messages: StoredMessage[]) => void;
  setNavSelection: (selection: NavSelection) => void;
  setSessionEventHealthBySession: SessionEventHealthUpdater;
  toastApi: ToastApi;
}) {
  const latestOptionsRef = useLatestRef(options);

  useEffect(() => {
    const latest = latestOptionsRef.current;
    // Critical data: sessions + connections are seeded from the onboarding
    // snapshot (see AppShell useEffect above).  `refreshShellSettings` is
    // waited because it drives theme + locale before first paint settles.
    // Everything else is fire-and-forget on a rAF to keep the critical
    // render path as short as possible.
    void latest.refreshShellSettings();
    // Non-critical: defer to next frame so the first paint isn't blocked.
    requestAnimationFrame(() => {
      const latest = latestOptionsRef.current;
      void latest.refreshAppInfo();
      void latest.refreshMemoryActive('载入本地记忆状态失败');
      void latest.refreshSkills();
      void latest.refreshPlanReminders();
      void latest.applyVisualSmokeFixture();
    });
    const unsubscribeConnections = window.maka.connections.subscribeEvents((event) => {
      latestOptionsRef.current.handleConnectionEvent(event);
    });
    const unsubscribeSessionChanges = window.maka.sessions.subscribeChanges((event) => {
      const latest = latestOptionsRef.current;
      void latest.refreshSessions();
      if (event.sessionId) {
        latest.setSessionEventHealthBySession((current) => {
          const previous = current[event.sessionId!];
          if (!previous) return current;
          return {
            ...current,
            [event.sessionId!]: recordSessionEventStreamChange(previous, event.ts),
          };
        });
      }
      if (
        event.sessionId &&
        (event.reason === 'turn-status-change' || event.reason === 'message-appended' || event.reason === 'deleted')
      ) {
        latest.clearPendingTurnActionsForSession(event.sessionId);
      }
      const changedSessionId = event.sessionId;
      if (event.reason === 'message-appended' && changedSessionId && changedSessionId === latest.activeIdRef.current) {
        void latest.refreshMessages(changedSessionId);
      }
      if (event.reason === 'rebound') {
        const modelSuffix = event.modelId ? ` · ${event.modelId}` : '';
        latest.toastApi.info('已切换到默认模型', `原会话使用的连接已不可用${modelSuffix}`);
      }
      if (event.reason === 'deleted' && event.sessionId && event.sessionId === latest.activeIdRef.current) {
        const deletedSessionId = event.sessionId;
        latest.setActiveId(undefined);
        latest.setMessages([]);
        latest.clearSessionRendererState(deletedSessionId);
      }
    });
    const unsubscribeOpenSettings = window.maka.appWindow.subscribeOpenSettings(() => {
      latestOptionsRef.current.openSettings();
    });
    const unsubscribePlanChanges = window.maka.plans.subscribeChanges(() => {
      void latestOptionsRef.current.refreshPlanReminders();
    });
    const unsubscribePlanDue = window.maka.plans.subscribeDue((reminder: PlanReminder) => {
      const latest = latestOptionsRef.current;
      void latest.refreshPlanReminders();
      latest.toastApi.toast({
        title: '计划提醒',
        description: reminder.title,
        variant: 'info',
        duration: 8000,
        action: {
          label: '查看定时任务',
          onClick: () => latestOptionsRef.current.setNavSelection({ section: 'automations' }),
        },
      });
    });
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        latestOptionsRef.current.openSettings();
      }
    }
    latest.rendererMountedRef.current = true;
    window.addEventListener('keydown', onKeyDown);
    return () => {
      const latest = latestOptionsRef.current;
      latest.rendererMountedRef.current = false;
      latest.projectPickerRequestRef.current += 1;
      latest.projectPickerPendingRef.current = false;
      unsubscribeConnections();
      unsubscribeSessionChanges();
      unsubscribeOpenSettings();
      unsubscribePlanChanges();
      unsubscribePlanDue();
      for (const timeoutHandle of latest.pendingTurnActionTimersRef.current.values()) {
        clearTimeout(timeoutHandle);
      }
      latest.pendingTurnActionTimersRef.current.clear();
      latest.pendingTurnActionsRef.current.clear();
      latest.pendingPermissionModeChangesRef.current.clear();
      latest.pendingSessionModelChangesRef.current.clear();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

export function useActiveSessionEvents(options: {
  activeId: string | undefined;
  activeIdRef: RefBox<string | undefined>;
  handleEvent: (sessionId: string, event: SessionEvent) => void;
  markSessionReadLocally: (sessionId: string, readMessages: readonly StoredMessage[]) => void;
  setMessageLoadErrorBySession: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setMessages: (messages: StoredMessage[]) => void;
  setSessionEventHealthBySession: SessionEventHealthUpdater;
  toastApi: Pick<ToastApi, 'error'>;
}) {
  const latestOptionsRef = useLatestRef(options);
  const activeId = options.activeId;

  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    const subscribedAt = Date.now();
    const latest = latestOptionsRef.current;
    const {
      setMessageLoadErrorBySession,
      setMessages,
      setSessionEventHealthBySession,
    } = latest;
    setMessages([]);
    setMessageLoadErrorBySession((current) => {
      if (!current[activeId]) return current;
      const next = { ...current };
      delete next[activeId];
      return next;
    });
    setSessionEventHealthBySession((current) => ({
      ...current,
      [activeId]: createSessionEventStreamSubscription({ sessionId: activeId, now: subscribedAt }),
    }));
    void window.maka.sessions.readMessages(activeId)
      .then((next) => {
        const { activeIdRef, markSessionReadLocally, setMessages } = latestOptionsRef.current;
        if (!disposed && activeIdRef.current === activeId) {
          markSessionReadLocally(activeId, next);
          setMessages(next);
        }
      })
      .catch((error) => {
        const { activeIdRef, setMessageLoadErrorBySession, toastApi } = latestOptionsRef.current;
        if (!disposed && activeIdRef.current === activeId) {
          const message = messageReadErrorMessage(error);
          setMessageLoadErrorBySession((current) => ({ ...current, [activeId]: message }));
          toastApi.error('读取对话失败', message);
        }
      });
    const unsubscribe = window.maka.sessions.subscribeEvents(activeId, (event) => {
      const { handleEvent, setSessionEventHealthBySession } = latestOptionsRef.current;
      setSessionEventHealthBySession((current) => {
        const previous = current[activeId];
        if (!previous) return current;
        return { ...current, [activeId]: recordSessionEventStreamEvent(previous, Date.now()) };
      });
      handleEvent(activeId, event);
    });
    return () => {
      disposed = true;
      unsubscribe();
      const { setSessionEventHealthBySession } = latestOptionsRef.current;
      setSessionEventHealthBySession((current) => {
        const previous = current[activeId];
        if (!previous) return current;
        return {
          ...current,
          [activeId]: {
            ...previous,
            status: 'closed',
            checkedAt: Date.now(),
            staleSince: undefined,
          },
        };
      });
    };
  }, [activeId]);
}

export function useSessionEventHealthPolling(options: {
  activeId: string | undefined;
  activePermission: PermissionRequestEvent | undefined;
  activeSession: SessionSummary | undefined;
  activeStreaming: string;
  hasInFlightLiveTools: boolean;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshSessions: () => Promise<SessionSummary[]>;
  sessionEventHealthBySessionRef: RefBox<Record<string, SessionEventStreamSnapshot>>;
  setSessionEventHealthBySession: SessionEventHealthUpdater;
}) {
  const {
    activeId,
    activePermission,
    activeSession,
    activeStreaming,
    hasInFlightLiveTools,
    refreshMessages,
    refreshSessions,
    sessionEventHealthBySessionRef,
    setSessionEventHealthBySession,
  } = options;

  useEffect(() => {
    if (!activeId) return;
    const hasLiveActivity = activeStreaming.length > 0 || hasInFlightLiveTools || Boolean(activePermission);
    const evaluate = () => {
      const result = evaluateSessionEventStreamSnapshot({
        previous: sessionEventHealthBySessionRef.current[activeId],
        now: Date.now(),
        sessionStatus: activeSession?.status,
        hasLiveActivity,
      });
      if (!result.snapshot) return;
      setSessionEventHealthBySession((current) => ({
        ...current,
        [activeId]: result.snapshot!,
      }));
      if (result.shouldRefresh) {
        void refreshSessions();
        void refreshMessages(activeId);
      }
    };
    evaluate();
    const interval = window.setInterval(evaluate, 5_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') evaluate();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeId, activeSession?.status, activeStreaming.length, hasInFlightLiveTools, activePermission?.requestId]);
}
