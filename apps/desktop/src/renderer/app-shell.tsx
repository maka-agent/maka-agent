import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  ChatDefaultPermissionMode,
  PermissionMode,
  PlanReminder,
  SessionSummary,
  SettingsSection,
  ThemePalette,
  ThemePreference,
} from '@maka/core';
import { generalizedErrorMessageChinese, hasSettledInitialOnboarding } from '@maka/core';
import {
  AutomationsPage,
  ChatView,
  Composer,
  PermissionPrompt,
  UserQuestionPrompt,
  DailyReviewPage,
  type ComposerHandle,
  type MakaUriDest,
  MakaUriContext,
  type NavSelection,
  SessionListPanel,
  SkillsPage,
  type SessionViewMode,
  type TurnFooterActionMeta,
  useToast,
  activeInteractionFor,
} from '@maka/ui';
import { useKeyboardHelp } from './keyboard-help';
import { useCommandPalette } from './command-palette';
import { OnboardingHero } from './OnboardingHero';
import { FirstRunChecklist } from './FirstRunChecklist';
import { useOnboardingSnapshot } from './use-onboarding-snapshot';
import type { OnboardingSnapshot } from '../global';
import { ProviderLogo } from './settings/provider-display';
import { ProviderBrandMark } from './settings/provider-brand-marks';
// Artifact pane + embedded browser panel are only mounted for sessions
// that actually have artifacts / a live browser view. Loading them lazily
// keeps their (heavy) code out of the initial chunk so first paint of the
// chat shell is not blocked on parsing them.
const ArtifactPane = lazy(() => import('./artifact-pane').then((m) => ({ default: m.ArtifactPane })));
const BrowserPanel = lazy(() => import('./browser-panel').then((m) => ({ default: m.BrowserPanel })));

function BrowserPanelFallback() {
  return (
    <div className="maka-browser-panel" role="status" aria-busy="true" aria-label="正在加载嵌入式浏览器">
      <div className="maka-lazy-fallback" data-surface="panel">正在加载嵌入式浏览器…</div>
    </div>
  );
}
import { useSessionGoal } from './use-session-goal';
import { deriveStaleSessionIds } from './stale-sessions';
import { deriveProjectGroups } from './session-project-grouping';
import { deriveSessionStatusGroups } from './session-status-grouping';
import {
  presentSessionStatus,
  sessionStatusAriaLabel,
} from './session-status-presentation';
import { deriveAppShellTurnViewModel } from './app-shell-turn-view-model';
import { readScrollMotionBehavior } from './scroll-motion-policy';
import { deriveBranchBanner } from './branch-banner';
import { applyTheme, applyThemePalette, applyUiLocale } from './theme';
import { safeLocalStorageSet } from './browser-storage';
import { filterSessions, readNavSelection } from './nav-selection';
import {
  readSessionListCollapsed,
  readSessionListWidth,
  SESSION_LIST_COLLAPSED_WIDTH,
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
} from './session-list-layout';
import {
  modelSetupToastCopy,
} from './model-connection-errors';
import { basenameFromPath } from './app-shell-copy';
import type { AppShellCommandListOptions } from './app-shell-command-actions';
import { AppShellTopbarActions, AppShellWorkspaceTopActions } from './app-shell-chrome-actions';
import { AppShellOverlays } from './app-shell-overlays';
import { createAppShellDailyReviewBridge } from './app-shell-daily-review-bridge';
import { useAppShellModuleData } from './use-module-data';
import { useAppShellProjectContext } from './use-project-context';
import { createAppShellSessionEventHandlers } from './app-shell-session-events';
import { createAppShellVisualSmokeActions } from './app-shell-visual-smoke';
import { createAppShellChatActions } from './app-shell-chat-actions';
import { createAppShellTurnActions } from './app-shell-turn-actions';
import { createAppShellLayoutActions } from './app-shell-layout-actions';
import { createAppShellQuickChatActions } from './app-shell-quick-chat-actions';
import { createAppShellDailyReviewActions } from './app-shell-daily-review-actions';
import { createAppShellSessionRowActions } from './app-shell-session-row-actions';
import { createAppShellSessionSettingsActions } from './app-shell-session-settings-actions';
import { createAppShellStopAction } from './app-shell-stop-action';
import {
  useActiveSessionEvents,
  useAppShellBootstrapSubscriptions,
  useAppShellHostEffects,
  useAppShellPersistenceEffects,
  useAppShellNavRefSync,
  useSessionEventHealthPolling,
  useShellRunUpdates,
  useSettledSessionTransientReconcile,
} from './app-shell-effects';
import { loadComposerDefaults, saveComposerDefaults } from './composer-defaults';
import { useKeyedPendingRegistry } from './use-pending-action-registry';
import { useAppShellComposerAttachments } from './use-app-shell-composer-attachments';
import { useAppShellSessionWorkspace } from './use-app-shell-session-workspace';
import { useShellConnections } from './use-shell-connections';
import { useShellChatModel } from './use-shell-chat-model';
import { useShellLiveTurn } from './use-shell-live-turn';
import { useSessionTasks } from './use-session-tasks';

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
};

/**
 * Grace period before the committed-history fallback force-settles a draining
 * assistant stream slot. Comfortably past the smoother's completion drain
 * budget (600ms, smooth-stream.ts DEFAULT_COMPLETE_FLUSH_BUDGET_MS) so the
 * primary `onStreamingSettled` signal always wins in the healthy path and the
 * visible tail is never cut mid-typewriter.
 */
const SETTLE_FALLBACK_GRACE_MS = 1000;

export function AppShell({
  initialOnboardingSnapshot = null,
}: {
  /** Pre-mount snapshot prefetched by main.tsx — see prefetchOnboardingSnapshot. */
  initialOnboardingSnapshot?: OnboardingSnapshot | null;
} = {}) {
  const toastApi = useToast();
  const {
    sessions,
    sessionsRef,
    setSessions,
    refreshSessions,
    seedSessions,
    upsertSessionSummary,
    markSessionRunningOptimistic,
    markSessionReadLocally,
    activeId,
    activeIdRef,
    bootstrapSelectionLease,
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    messages,
    setMessages,
    messageLoadPending,
    setMessageLoadPending,
    messageRetryPendingRef,
    stopPendingRef,
    sessionUiState,
    liveTurnBySessionRef,
    sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setStopPendingBySession,
    setLiveTurnBySession,
    setShellRunUpdatesBySession,
    setInteractionBySession,
    setSessionEventHealthBySession,
    setPendingPermissionModeBySession,
    setPendingSessionModelBySession,
    clearTurnTransientState,
  } = useAppShellSessionWorkspace(toastApi);
  const attachmentDraftKey = activeId ?? 'new-session';
  const sessionTasks = useSessionTasks(activeId);
  const {
    pendingAttachments,
    pickAttachments,
    attachFilePaths,
    removeAttachment,
    clearSubmittedAttachments,
  } = useAppShellComposerAttachments({ draftKey: attachmentDraftKey, toastApi });
  // P3: session ids with a live embedded-browser view. The right-side
  // BrowserPanel mounts only for these, so ordinary chats reserve no space.
  const [liveBrowserSessionIds, setLiveBrowserSessionIds] = useState<string[]>([]);
  const [navSelection, setNavSelection] = useState<NavSelection>(() => readNavSelection());
  const navSelectionRef = useRef<NavSelection>(navSelection);
  const {
    messageLoadErrorBySession,
    messageRetryPendingBySession,
    stopPendingBySession,
    liveTurnBySession,
    shellRunUpdatesBySession,
    interactionBySession,
    sessionEventHealthBySession,
    pendingPermissionModeBySession,
    pendingSessionModelBySession,
  } = sessionUiState;
  // PR-MEMORY-VISIBILITY-INDICATOR-0: surface a small pill in the
  // chat header when xuan's MEMORY.md is being injected into the
  // agent's system prompt (PR-MEMORY-PROMPT-INJECT-0). Refreshed
  // when activeId changes (we re-fetch on every chat switch) and
  // whenever the Settings modal closes (the user may have toggled
  // the agentReadEnabled switch).
  const [memoryActive, setMemoryActive] = useState(false);
  const {
    connections,
    defaultConnection,
    setConnections,
    setDefaultConnection,
    refreshConnections,
    handleConnectionEvent,
  } = useShellConnections({ toastApi });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequestedSection, setSettingsRequestedSection] = useState<SettingsSection | undefined>(undefined);
  const [settingsProviderCatalogOpen, setSettingsProviderCatalogOpen] = useState(false);
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [themePalette, setThemePalette] = useState<ThemePalette>('default');
  const [userLabel, setUserLabel] = useState<string>('');
  // Settings → 通用 → 默认权限模式 — DISPLAY-ONLY mirror. The composer's
  // picker shows it before the user makes a per-session choice; the actual
  // authority for a new session's mode is main.ts's sessions:create fallback
  // (the renderer omits permissionMode unless the user explicitly picked),
  // so a stale value here can briefly mislabel the chip but never changes
  // which mode a session is created with.
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<ChatDefaultPermissionMode>('ask');
  // Persisted composer defaults seed the empty-state model, project path, and
  // recent workspace history so the home view is populated before the async
  // `app:info` round-trip completes on mount.
  const persistedComposerDefaults = loadComposerDefaults();
  const [helpOpen, closeHelp, openHelp] = useKeyboardHelp();
  const [paletteOpen, openPalette, closePalette] = useCommandPalette();
  // Search modal state. Sidebar `搜索` opens the real thread-search
  // modal; result selection below can also hand ChatView a turn anchor
  // so the hit is visible after session navigation.
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  // Funnel bridge: query handed from the palette's 查看全部结果 row into the
  // search modal. Topbar opens reset it so a plain open starts blank.
  const [searchModalInitialQuery, setSearchModalInitialQuery] = useState('');
  const [searchScrollTarget, setSearchScrollTarget] = useState<{
    sessionId: string;
    turnId: string;
    nonce: number;
  } | null>(null);
  const [viewMode, setViewMode] = useState<SessionViewMode>('status');
  function closeSearchModal(options?: { restoreFocus?: boolean }) {
    setSearchModalOpen(false);
    if (options?.restoreFocus === false) return;
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>('[data-maka-search-trigger="true"]')
        ?.focus({ preventScroll: true });
    });
  }
  const composerRef = useRef<ComposerHandle>(null);
  const rendererMountedRef = useRef(true);
  // Active autonomous goal for the current session drives the header
  // kill-switch pill (visible indicator + one-click clear).
  const activeGoal = useSessionGoal(activeId);
  const activeLiveTurn = activeId ? liveTurnBySession[activeId] : undefined;
  // Set of session ids whose backend / connection is no longer usable —
  // drives the sidebar "已过期" pill (PR108g, paired with the PR108e chat
  // header banner). Derivation is pure (see `stale-sessions.ts`) so the
  // classifier is testable without a DOM.
  const staleSessionIds = useMemo(
    () =>
      deriveStaleSessionIds({
        sessions,
        knownConnectionSlugs: new Set(connections.map((connection) => connection.slug)),
      }),
    [sessions, connections],
  );
  // Status-grouped sidebar. The `chats`
  // filter shows sessions grouped by SessionStatus (Pinned →
  // Running → Waiting → Blocked → Active → Review → Done → Archived);
  // `aborted` is dropped. Pinned (flagged) sessions float to the top
  // in their own group, preserving the PR48 pin-floats behavior.
  const visibleSessions = useMemo(() => filterSessions(sessions, navSelection), [sessions, navSelection]);
  const sessionStatusGroups = useMemo(
    () => deriveSessionStatusGroups(visibleSessions, { pinFirst: true }),
    [visibleSessions],
  );
  const sessionProjectGroups = useMemo(() => deriveProjectGroups(visibleSessions), [visibleSessions]);
  const sessionListGroups = viewMode === 'project' ? sessionProjectGroups : sessionStatusGroups;
  const activeSessionEventHealth = activeId ? sessionEventHealthBySession[activeId] : undefined;
  // PR-DAILY-REVIEW-MVP-0: bridge for the main Daily Review module.
  // Memoized so the panel's `useEffect` cleanup keys
  // off a stable reference instead of refetching on every render.
  const dailyReviewBridge = useMemo(() => createAppShellDailyReviewBridge(connections), [connections]);
  const {
    appendDailyReviewMarkdown,
    copyDailyReviewMarkdown,
    saveDailyReviewMarkdown,
  } = createAppShellDailyReviewActions({
    composerRef,
    toastApi,
  });
  const activeInteraction = activeInteractionFor(interactionBySession, activeId);
  const activePermission = activeInteraction?.type === 'permission_request' ? activeInteraction : undefined;
  const activeQuestion = activeInteraction?.type === 'user_question_request' ? activeInteraction : undefined;
  const activeSession = sessions.find((session) => session.id === activeId);
  // Live-turn projection of the active session: streaming/thinking slices, the
  // sidebar pulse set, the in-flight tool signal, and the #646 turn-wait cues
  // all live in useShellLiveTurn (pure derivation of the live projection).
  // `activeLiveTurn` itself stays here — a source-slice contract pins its
  // declaration to app-shell.tsx — and is passed in.
  const {
    activeShellRunUpdates,
    activeStreaming,
    activeStreamingComplete,
    activeStreamingLive,
    activeStreamingMessageId,
    activeThinking,
    streamingSessionIds,
    liveTools,
    hasInFlightLiveTools,
    turnInFlight,
    sessionAwaitingModel,
    showProcessingIndicator,
    showContinuingIndicator,
  } = useShellLiveTurn({
    activeId,
    activeLiveTurn,
    liveTurnBySession,
    shellRunUpdatesBySession,
    activeSession,
  });
  // Surface a credential-lifecycle alert directly in the chat header when
  // the active session's connection is in `needs_reauth` / `error` or has
  // been deleted entirely. We skip the async hasSecret fetch here — the
  // chat header is a hint surface; AccountSettingsPage remains the
  // authoritative detailed view. The model/thinking selection + both
  // chat-header alerts live in useShellChatModel (pure derivation of the
  // connection list + active session); openSettingsSection is injected so
  // the connection alert can wrap the derived click target.
  const {
    chatModelChoices,
    activeConnection,
    activeConnectionLabel,
    activeModel,
    activeModelLabel,
    activeThinkingLevels,
    activeThinkingLevel,
    newChatModel,
    newChatModelLabel,
    newChatThinkingLevels,
    newChatThinkingLevel,
    validPendingNewChatModel,
    setPendingNewChatModel,
    pendingNewChatThinkingLevel,
    setPendingNewChatThinkingLevel,
    chatConnectionAlert,
    chatEventStreamAlert,
  } = useShellChatModel({
    connections,
    defaultConnection,
    activeSession,
    activeSessionEventHealth,
    persistedComposerDefaults,
    openSettingsSection,
  });
  const newChatProviderType = newChatModel
    ? connections.find((connection) => connection.slug === newChatModel.llmConnectionSlug)?.providerType
    : undefined;

  // PR109d-b: turn footer actions per turn. Derived from the
  // materialized turn list (status + lineage descendants) + pending
  // mask. Per @kenji PR109d review: pending state prevents double-click
  // duplicate sibling turns by disabling the action button between
  // click and `sessions:changed turn-status-change` arriving.
  // The four de-dup registries (turn-footer actions, session-row actions,
  // per-session permission-mode / model changes) all share the same keyed-Set
  // shape; see useKeyedPendingRegistry. Only the turn-footer registry mirrors
  // into React state (drives the disabled mask) and arms a 5s auto-clear
  // fallback timer; the other three stay ref-only and clear in their action's
  // `finally`.
  const turnActionRegistry = useKeyedPendingRegistry({ trackState: true, autoClearMs: 5000 });
  const pendingTurnActions = turnActionRegistry.keys;
  const sessionRowActionRegistry = useKeyedPendingRegistry();
  const permissionModeChangeRegistry = useKeyedPendingRegistry();
  const sessionModelChangeRegistry = useKeyedPendingRegistry();
  const pendingKeyOf = (sessionId: string, turnId: string, actionId: TurnFooterActionMeta['id']) =>
    `${sessionId}:${turnId}:${actionId}`;
  function omitSessionKey<T>(current: Record<string, T>, sessionId: string): Record<string, T> {
    if (!(sessionId in current)) return current;
    const next = { ...current };
    delete next[sessionId];
    return next;
  }

  function addPendingSessionAction(
    sessionId: string,
    pendingRef: { current: Set<string> },
    setPendingBySession: (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void,
  ): boolean {
    if (pendingRef.current.has(sessionId)) return false;
    pendingRef.current.add(sessionId);
    setPendingBySession((current) => ({ ...current, [sessionId]: true }));
    return true;
  }

  function clearPendingSessionAction(
    sessionId: string,
    pendingRef: { current: Set<string> },
    setPendingBySession: (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void,
  ): void {
    if (!pendingRef.current.has(sessionId)) return;
    pendingRef.current.delete(sessionId);
    setPendingBySession((current) => omitSessionKey(current, sessionId));
  }

  function clearSessionRendererState(sessionId: string): void {
    clearOwnedSessionState(sessionId);
    turnActionRegistry.clearForSession(sessionId);
    permissionModeChangeRegistry.keysRef.current.delete(sessionId);
    sessionModelChangeRegistry.keysRef.current.delete(sessionId);
  }

  const sessionRowActionHandlers = createAppShellSessionRowActions({
    activeIdRef,
    clearSessionRendererState,
    pendingSessionRowActionsRef: sessionRowActionRegistry.keysRef,
    refreshSessions,
    sessionsRef,
    setActiveId,
    setMessages,
    toastApi,
  });
  const sessionRowActionHandlersRef = useRef(sessionRowActionHandlers);
  sessionRowActionHandlersRef.current = sessionRowActionHandlers;
  const sessionRowActions = useMemo<NonNullable<Parameters<typeof SessionListPanel>[0]['rowActions']>>(
    () => ({
      onToggleFlag: (sessionId, next) => sessionRowActionHandlersRef.current.flagSession(sessionId, next),
      onArchive: (sessionId) => sessionRowActionHandlersRef.current.archiveSession(sessionId),
      onUnarchive: (sessionId) => sessionRowActionHandlersRef.current.unarchiveSession(sessionId),
      onRename: (sessionId, name) => sessionRowActionHandlersRef.current.renameSession(sessionId, name),
      onDelete: (sessionId) => sessionRowActionHandlersRef.current.deleteSession(sessionId),
    }),
    [],
  );

  const {
    setPermissionMode,
    setSessionModel,
    setSessionThinkingLevel,
  } = createAppShellSessionSettingsActions({
    activeIdRef,
    connections,
    pendingPermissionModeChangesRef: permissionModeChangeRegistry.keysRef,
    pendingSessionModelChangesRef: sessionModelChangeRegistry.keysRef,
    refreshSessions,
    sessionsRef,
    setDefaultPermissionMode,
    setPendingPermissionModeBySession,
    setPendingSessionModelBySession,
    setSessions,
    toastApi,
  });

  const {
    turnFooterActionsByTurn,
    turnFailedReasonLabels,
    turnFailedRecoveryLabels,
    turnLineageBadgesByTurn,
  } = useMemo(
    () => deriveAppShellTurnViewModel({
      activeId,
      messages,
      pendingTurnActions,
      pendingKeyOf,
    }),
    [activeId, messages, pendingTurnActions],
  );

  // PR109e-e: click handler for lineage badge → scroll target turn into
  // view. Avoids pulling a separate ref-tracker: relies on the
  // `data-turn-id` attribute the renderer already sets on each TurnView.
  //
  // @kenji PR109e review + @xuan PR109f follow-up: scrollIntoView with
  // `behavior: 'smooth'` must respect both reduced-motion AND the
  // visual-smoke capture entry (PR-IR-02). @xuan confirmed on main that
  // visual-smoke always writes `data-maka-visual-smoke="true"` but
  // `data-maka-reduced-motion="true"` is only set on the reduced
  // variant — so the visual-smoke attribute is the broader signal for
  // "deterministic capture, no animations". Three triggers collapse to
  // `auto`:
  //   1. `data-maka-reduced-motion="true"` — PR-IR-04 reduced variant
  //   2. `data-maka-visual-smoke="true"` — PR-IR-02 any capture
  //   3. `prefers-reduced-motion: reduce` — OS-level user preference
  function handleLineageBadgeClick(targetTurnId: string): void {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-turn-id="${CSS.escape(targetTurnId)}"]`);
      if (!el || !('scrollIntoView' in el)) return;
      (el as HTMLElement).scrollIntoView({
        behavior: readScrollMotionBehavior(),
        block: 'center',
      });
    });
  }

  function openSessionInChat(sessionId: string, turnId?: string): void {
    setNavSelection({ section: 'sessions', filter: 'chats' });
    setActiveId(sessionId);
    if (turnId) {
      setSearchScrollTarget({ sessionId, turnId, nonce: Date.now() });
    } else {
      setSearchScrollTarget(null);
    }
  }

  /* PR-FE-BUG-HUNT-0 (kenji bug-hunt 2026-06-24): SearchModal +
     CommandPalette callbacks used to be inline arrows in JSX, so
     their identity churned on every App re-render. SearchModal's
     debounce effect lists `searchThread` in its dep array; during a
     turn stream `App` re-renders many times per second and the
     180ms timeout was torn down + restarted on every render, so it
     never reached its `setTimeout` fire — search was effectively
     dead while a stream was active. Same root cause for the palette
     selection effect that resets keyboard highlight on every deps
     change. Stable refs + memos keep the timers alive. */
  const openSessionInChatRef = useRef(openSessionInChat);
  openSessionInChatRef.current = openSessionInChat;
  const searchModalDeps = useMemo(
    () => ({ searchThread: (request: Parameters<typeof window.maka.search.thread>[0]) => window.maka.search.thread(request) }),
    [],
  );
  const searchModalOnNavigate = useCallback((sessionId: string, turnId?: string) => {
    openSessionInChatRef.current(sessionId, turnId);
  }, []);
  const paletteOnSelectSession = useCallback((sessionId: string, turnId?: string) => {
    openSessionInChatRef.current(sessionId, turnId);
  }, []);
  const paletteOnOpenSearchModal = useCallback((query: string) => {
    setSearchModalInitialQuery(query);
    setSearchModalOpen(true);
  }, []);
  /** 技能页 使用: jump to the chat view and seed the composer with a skill
   *  invocation. Same human-in-the-loop rule as maka://compose — we never
   *  auto-send; the user finishes the sentence and presses Enter. */
  const useSkillInChat = useCallback((_skillId: string, skillName: string) => {
    setNavSelection({ section: 'sessions', filter: 'chats' });
    const seed = () => {
      composerRef.current?.setText(`使用 ${skillName} 技能：`);
      composerRef.current?.focus();
    };
    if (activeIdRef.current) {
      window.requestAnimationFrame(seed);
      return;
    }
    void createSession().then(() => window.requestAnimationFrame(seed));
  }, []);
  const sessionListSelectSession = useCallback((sessionId: string) => {
    openSessionInChatRef.current(sessionId);
  }, []);

  // PR109b: chat header lifecycle status badge. Hidden for `active`
  // (default) to avoid badge noise on healthy sessions. Every other
  // status — including `aborted` per @kenji review — surfaces a badge
  // so the user knows the session's settled lifecycle position.
  // Blocked also pulls the generalized blocked-reason copy into the
  // tooltip without exposing the raw enum identifier.
  const chatSessionStatusBadge = useMemo(() => {
    if (!activeSession) return undefined;
    const status = activeSession.status;
    if (status === 'active') return undefined;
    const presentation = presentSessionStatus(status);
    const tooltip =
      status === 'blocked'
        ? sessionStatusAriaLabel(status, activeSession.blockedReason)
        : presentation.label;
    return {
      status,
      label: presentation.label,
      tone: presentation.tone,
      tooltip,
    };
  }, [activeSession?.id, activeSession?.status, activeSession?.blockedReason]);

  // PR109f: branched session banner. When the active session was
  // created via `sessions:branchFromTurn`, its `parentSessionId` is
  // set; render a banner above the chat surface so the user knows
  // they're in a derived conversation and can jump back to the parent.
  //
  // v1 intentionally omits the fromAbortedTurn hint because checking
  // it requires loading the parent's full message log. The session
  // banner stays at "分自 ${parentName}" until parent-message
  // preloading lands; "从中断前" is only surfaced in the aborted
  // turn's branch footer tooltip where the active turn status is known.
  const branchBanner = useMemo(
    () => deriveBranchBanner(activeSession, sessions),
    [activeSession?.parentSessionId, sessions],
  );

  function handleBranchBannerClick(parentSessionId: string): void {
    openSessionInChat(parentSessionId);
  }

  const activeSessionForView: SessionSummary | undefined = activeSession ?? (activeId ? {
    id: activeId,
    name: '新建对话',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'default',
    model: 'fake-model',
    // Transient placeholder while the real SessionSummary loads --
    // matches the configured default so the composer doesn't flash a
    // hardcoded value before the real session data settles.
    permissionMode: defaultPermissionMode,
  } : undefined);
  const activeMessageLoading = Boolean(activeId && messageLoadPending);
  // PR110c: OnboardingState is now the single source of truth for
  // first-run UI. The renderer never re-derives provider readiness;
  // `useOnboardingSnapshot()` pulls the derived state from the main
  // process (PR110a + PR110b contract) and reactively invalidates on
  // `sessions:changed` + `connections:event`. The hero renders only
  // when sessions.length === 0; any session (including archived /
  // aborted) takes over with the existing chat surface.
  const onboarding = useOnboardingSnapshot(initialOnboardingSnapshot);
  const [quickChatPending, setQuickChatPending] = useState(false);
  const quickChatPendingRef = useRef(false);
  const { handleQuickChatSubmit } = createAppShellQuickChatActions({
    activeIdRef,
    captureComposerImportOwner,
    composerRef,
    isShellSurfaceOwnerActive,
    openSessionInChat,
    quickChatPendingRef,
    refreshOnboarding: onboarding.refresh,
    refreshSessions,
    setQuickChatPending,
    toastApi,
  });
  const onboardingState = onboarding.snapshot?.state;
  const onboardingSettled = hasSettledInitialOnboarding(onboarding.snapshot?.milestones ?? []);
  // Seed sessions from the onboarding snapshot on first load — the snapshot
  // already fetches the session list + connections internally, so separate
  // `sessions:list` / `connections:list` / `getDefault` IPCs are redundant.
  // This lets the UI show the sidebar + model picker immediately on first load.
  const initialSnapshotSeededRef = useRef(false);
  const mountedSnapshotSeededRef = useRef(false);
  const bootstrapFallbackStartedRef = useRef(false);
  // useLayoutEffect, NOT useEffect: the snapshot render flips
  // `isOnboardingLoading` off while `sessions` is still []. A passive
  // effect seeds sessions AFTER the browser paints that frame, so users
  // with history saw a one-frame flash of the empty-state hero (the
  // "配置页闪了一下" startup flash). Layout effects run before paint,
  // so the seeded sessions and the un-gated frame commit together.
  useLayoutEffect(() => {
    // Snapshot IPC failed — the seed path will never run, so fall back
    // to the classic boot pull or the sidebar stays empty forever.
    if (
      onboarding.error &&
      !initialOnboardingSnapshot &&
      !onboarding.firstMountedSnapshot &&
      !bootstrapFallbackStartedRef.current
    ) {
      bootstrapFallbackStartedRef.current = true;
      void bootstrapSessions();
      void refreshConnections();
      return;
    }
    let snapshot: OnboardingSnapshot | null = null;
    let releaseSelectionLease = false;
    if (!initialSnapshotSeededRef.current && initialOnboardingSnapshot) {
      initialSnapshotSeededRef.current = true;
      snapshot = initialOnboardingSnapshot;
    } else if (
      !bootstrapFallbackStartedRef.current &&
      !mountedSnapshotSeededRef.current &&
      onboarding.firstMountedSnapshot
    ) {
      mountedSnapshotSeededRef.current = true;
      snapshot = onboarding.firstMountedSnapshot;
      releaseSelectionLease = true;
    }
    if (!snapshot) return;
    // Seed sessions. Display normalization MUST run here too — this is
    // a third renderer state entry alongside commitSessions /
    // upsertSessionSummary (#452): without it, legacy blocked/unknown
    // sessions flash an 已阻塞 group on first paint until the first
    // refreshSessions() overwrites the seed.
    const next = seedSessions(snapshot.sessions);
    bootstrapSelectionLease.reconcile(next);
    // Seed connections — avoids separate connections:list + getDefault IPCs
    setConnections(snapshot.connections);
    setDefaultConnection(snapshot.defaultSlug);
    if (releaseSelectionLease) bootstrapSelectionLease.release();
  }, [initialOnboardingSnapshot, onboarding.firstMountedSnapshot, onboarding.error]);
  // PR110c (@kenji review): suppress hero AND the fallback EmptyChatHero
  // while the initial snapshot is in flight. Otherwise sessions.length===0
  // + snapshot===null flashes the prompt-suggestion EmptyChatHero before
  // the state-routed OnboardingHero mounts.
  const isOnboardingLoading = sessions.length === 0 && onboardingState === undefined && !onboardingSettled;
  const showOnboardingHero =
    sessions.length === 0 && !onboardingSettled && onboardingState !== undefined && onboardingState.kind !== 'ready_with_history';
  const onboardingComposerHidden = isOnboardingLoading || (showOnboardingHero && onboardingState !== undefined);
  const [sessionListWidth, setSessionListWidth] = useState(() => readSessionListWidth());
  const [sessionListCollapsed, setSessionListCollapsed] = useState(() => readSessionListCollapsed());
  const { startColumnResize, onResizeHandleKeyDown } = createAppShellLayoutActions({
    sessionListCollapsed,
    sessionListWidth,
    setSessionListWidth,
  });

  function isAutomationsSurfaceActive(): boolean {
    return navSelectionRef.current.section === 'automations';
  }

  function isSkillsSurfaceActive(): boolean {
    return navSelectionRef.current.section === 'skills';
  }

  function isDailyReviewSurfaceActive(): boolean {
    return navSelectionRef.current.section === 'daily-review';
  }

  const {
    skills,
    managedSkillSources,
    bundledSkillCatalog,
    planReminders,
    refreshPlanReminders,
    createPlanReminder,
    updatePlanReminder,
    togglePlanReminder,
    triggerPlanReminderNow,
    snoozePlanReminder,
    clearPlanReminderRunHistory,
    deletePlanReminder,
    refreshSkills,
    refreshManagedSkillSources,
    refreshBundledSkillCatalog,
    createSkillTemplate,
    importManagedSkillSource,
    installManagedSkill,
    installBundledSkill,
    previewManagedSkillUpdate,
    updateManagedSkill,
    setSkillEnabled,
    deleteSkill,
    openSkill,
  } = useAppShellModuleData({
    isSkillsSurfaceActive,
    isAutomationsSurfaceActive,
    toastApi,
  });

  const {
    appInfo,
    branchList,
    branchPending,
    recentProjectPaths,
    projectPickerPending,
    projectPickerPendingRef,
    projectPickerRequestRef,
    refreshAppInfo,
    selectProjectDirectory,
    selectRecentProjectDirectory,
    openProjectFolder,
    openWorkspaceFolder,
    openSkillsFolder,
    listGitBranches,
    checkoutGitBranch,
  } = useAppShellProjectContext({
    persistedComposerDefaults,
    rendererMountedRef,
    toastApi,
  });

  const { applyVisualSmokeFixture } = createAppShellVisualSmokeActions({
    openPalette,
    openSettingsSection,
    refreshSessions,
    setActiveId,
    setLiveBrowserSessionIds,
    setLiveTurnBySession,
    setNavSelection,
    setInteractionBySession,
    setSearchModalOpen,
    setSessionListCollapsed,
    setThemePref,
  });

  const {
    send,
    respondToPermission,
    respondToUserQuestion,
    refreshMessages,
    retryMessages,
  } = createAppShellChatActions({
    activeIdRef,
    addPendingSessionAction,
    captureComposerImportOwner,
    clearPendingSessionAction,
    isNewChatSendSurfaceActive,
    markSessionReadLocally,
    markSessionRunningOptimistic,
    messageRetryPendingRef,
    refreshSessions,
    setActiveId,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setMessages,
    setNavSelection,
    setLiveTurnBySession,
    setInteractionBySession,
    showModelSetupToast,
    toastApi,
    upsertSessionSummary,
    validPendingNewChatModel,
    pendingNewChatThinkingLevel: newChatThinkingLevel ?? null,
  });

  const { handleTurnFooterAction } = createAppShellTurnActions({
    activeIdRef,
    addPendingTurnAction: turnActionRegistry.addKey,
    clearPendingTurnAction: turnActionRegistry.clearKey,
    openSessionInChat,
    pendingKeyOf,
    refreshMessages,
    refreshSessions,
    setMessages,
    toastApi,
    upsertSessionSummary,
  });

  async function sendWithAttachments(text: string): Promise<boolean | void> {
    if (text.trim() === '/compact') {
      if (activeId) await window.maka.sessions.compact(activeId);
      return true;
    }
    const pending = pendingAttachments.length > 0 ? pendingAttachments : undefined;
    const ok = await send(text, pending);
    if (ok !== false && pending) clearSubmittedAttachments(pending);
    return ok;
  }

  const stop = createAppShellStopAction({
    activeIdRef,
    addPendingSessionAction,
    clearPendingSessionAction,
    setStopPendingBySession,
    stopPendingRef,
    toastApi,
  });

  const { handleEvent, reconcilePersistedMessages, settleAssistantStreaming } = createAppShellSessionEventHandlers({
    activeIdRef,
    liveTurnBySessionRef,
    refreshMessages,
    refreshSessions,
    setLiveTurnBySession,
    setInteractionBySession,
    showModelSetupToast,
    toastApi,
    notifyRunEnded: ({ kind, sessionId, body }) => {
      const title = sessionsRef.current.find((session) => session.id === sessionId)?.name;
      // Best-effort: swallow any main-side failure so a missed banner
      // never surfaces as an unhandled promise rejection.
      void window.maka.notifications.runEnded({ kind, title, body }).catch(() => {});
    },
  });

  // Tool/thinking evidence may survive its event-triggered refresh, including
  // between steps of one running turn. Reconcile from durable evidence whenever
  // either side changes, so old output stays on its original tool instead of
  // joining the next batch, without deleting text that the smoother still owns.
  const reconcilePersistedMessagesEffect = useEffectEvent(reconcilePersistedMessages);
  useEffect(() => {
    if (!activeId) return;
    reconcilePersistedMessagesEffect(activeId, messages);
  }, [activeId, activeLiveTurn, messages]);

  // Streaming-settle handoff, FALLBACK path only. The primary settle signal
  // is the bubble's own `onStreamingSettled` (ChatView below): it fires once
  // the smoother has DISPLAYED the final text (catchingUp === false), so the
  // user watches the tail type out before the live section swaps for the
  // committed turn. This effect used to settle immediately when the committed
  // assistant message appeared in `messages` — which lands mid-drain and cut
  // the visible tail, snapping the last characters in with the swap. It now
  // waits out a grace period comfortably past the smoother's completion drain
  // budget (600ms): in the normal path `onStreamingSettled` clears the slot
  // first and the delayed settle no-ops on its phase guard. The fallback stays
  // because a stuck slot would otherwise hide the committed answer forever
  // (`streamingMessageId` suppresses it while draining).
  useEffect(() => {
    if (!activeId || !activeStreamingComplete || !activeStreamingMessageId) return;
    const committedAssistantArrived = messages.some((message) => message.type === 'assistant' && message.id === activeStreamingMessageId);
    if (!committedAssistantArrived) return;
    const timer = window.setTimeout(() => {
      void settleAssistantStreaming(activeId, activeStreamingMessageId);
    }, SETTLE_FALLBACK_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [activeId, activeStreamingComplete, activeStreamingMessageId, messages, settleAssistantStreaming]);

  const hasModalOpen = helpOpen || paletteOpen || searchModalOpen;

  useAppShellNavRefSync({
    navSelection,
    navSelectionRef,
  });
  useAppShellHostEffects({
    activeId,
    hasModalOpen,
    setLiveBrowserSessionIds,
  });
  useAppShellBootstrapSubscriptions({
    activeIdRef,
    applyVisualSmokeFixture,
    bootstrapSessions,
    clearPendingTurnActionsForSession: turnActionRegistry.clearForSession,
    clearSessionRendererState,
    createSession,
    handleConnectionEvent,
    openSettings,
    pendingPermissionModeChangesRef: permissionModeChangeRegistry.keysRef,
    pendingSessionModelChangesRef: sessionModelChangeRegistry.keysRef,
    pendingTurnActionTimersRef: turnActionRegistry.timersRef,
    pendingTurnActionsRef: turnActionRegistry.keysRef,
    projectPickerPendingRef,
    projectPickerRequestRef,
    refreshAppInfo,
    refreshConnections,
    refreshMemoryActive,
    refreshMessages,
    refreshPlanReminders,
    refreshShellSettings,
    refreshSkills,
    refreshManagedSkillSources,
    refreshBundledSkillCatalog,
    refreshSessions,
    rendererMountedRef,
    setActiveId,
    setMessages,
    setNavSelection,
    setSessionEventHealthBySession,
    toastApi,
  });
  useAppShellPersistenceEffects({
    navSelection,
    sessionListCollapsed,
    sessionListWidth,
    themePalette,
    themePref,
  });
  useActiveSessionEvents({
    activeId,
    activeIdRef,
    handleEvent,
    markSessionReadLocally,
    setMessageLoadErrorBySession,
    setMessageLoadPending,
    setMessages,
    setSessionEventHealthBySession,
    toastApi,
  });
  useShellRunUpdates({ activeId, setShellRunUpdatesBySession });
  useSessionEventHealthPolling({
    activeId,
    activeInteraction,
    activeSession,
    activeStreamingLive,
    hasInFlightLiveTools,
    refreshMessages,
    refreshSessions,
    sessionEventHealthBySessionRef,
    setSessionEventHealthBySession,
  });
  useSettledSessionTransientReconcile({
    activeId,
    sessions,
    liveTurnBySessionRef,
    clearTurnTransientState,
  });

  function captureComposerImportOwner(): ComposerImportOwner {
    return {
      sessionId: activeIdRef.current,
      navSection: navSelectionRef.current.section,
    };
  }

  function isComposerImportOwnerActive(owner: ComposerImportOwner): boolean {
    return owner.navSection === 'sessions'
      && navSelectionRef.current.section === 'sessions'
      && activeIdRef.current === owner.sessionId;
  }

  function isNewChatSendSurfaceActive(owner: ComposerImportOwner): boolean {
    return owner.navSection === 'sessions'
      && owner.sessionId === undefined
      && navSelectionRef.current.section === 'sessions'
      && activeIdRef.current === undefined;
  }

  function isShellSurfaceOwnerActive(owner: ComposerImportOwner): boolean {
    return navSelectionRef.current.section === owner.navSection
      && activeIdRef.current === owner.sessionId;
  }

  async function refreshShellSettings() {
    try {
      const next = await window.maka.settings.get();
      const smoke = await window.maka.visualSmoke.getState();
      const pref = smoke?.theme ?? next.appearance?.theme ?? 'auto';
      const palette = next.appearance?.palette ?? 'default';
      const name = next.personalization?.displayName ?? '';
      // PR-LANG-PREF-0: apply persisted UI locale preference to
      // `<html data-maka-locale>` BEFORE first paint of any
      // locale-aware surface. `'auto'` clears the explicit attribute
      // and uses the Chinese-first product fallback.
      const uiLocale = next.personalization?.uiLocale ?? 'auto';
      applyUiLocale(uiLocale);
      setThemePref(pref);
      setThemePalette(palette);
      setUserLabel(name);
      setDefaultPermissionMode(next.chatDefaults?.permissionMode ?? 'ask');
      applyTheme(pref);
      applyThemePalette(palette);
    } catch (error) {
      toastApi.error('载入外观设置失败', generalizedErrorMessageChinese(error, '外观设置暂时无法载入，请稍后重试。'));
    }
  }

  async function bootstrapSessions() {
    const next = await refreshSessions();
    bootstrapSelectionLease.reconcile(next);
    bootstrapSelectionLease.release();
  }

  async function createSession() {
    startNewSession();
    setNavSelection({ section: 'sessions', filter: 'chats' });
    setSearchScrollTarget(null);
    // New-task affordances reset to the empty-state composer; move focus
    // there so the user can start typing immediately.
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openPlanReminderForm() {
    setNavSelection({ section: 'automations' });
    closePalette();
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLInputElement>('[data-maka-plan-title-input="true"]')
        ?.focus({ preventScroll: false });
    });
  }

  async function refreshMemoryActive(failureTitle = '刷新本地记忆状态失败') {
    try {
      const next = await window.maka.memory.getState();
      setMemoryActive(next.agentReadEnabled && next.status === 'ok' && next.content.trim().length > 0);
    } catch (error) {
      toastApi.error(failureTitle, generalizedErrorMessageChinese(error, '本地记忆状态暂时无法刷新，请稍后重试。'));
    }
  }

  function openSettings() {
    setSettingsProviderCatalogOpen(false);
    setSettingsOpen(true);
  }

  /**
   * PR-UI-RENDER-2 — single chokepoint for the Markdown internal-URI
   * router. Receives a typed `MakaUriDest` from the link override in
   * `<Markdown>` and dispatches to the existing app navigation
   * surfaces:
   *
   *   - `kind: 'settings'` → `openSettingsSection(section)` (existing
   *     Settings modal jump, persisted via localStorage).
   *   - `kind: 'compose'` → write text into the composer via
   *     `composerRef.current.setText(...)` and focus it. We do NOT
   *     auto-submit the prompt; the user still presses Enter. That
   *     keeps an injected `maka://compose?text=ransfer my keys...`
   *     from sending without a human in the loop.
   *
   * No other cases exist today by design — the parser only emits
   * these two discriminants. If a new variant is added in `MakaUriDest`,
   * TypeScript's exhaustiveness check below trips and a new branch
   * must be wired here with corresponding fixture and journey coverage.
   */
  function dispatchMakaUri(dest: MakaUriDest) {
    switch (dest.kind) {
      case 'settings':
        openSettingsSection(dest.section);
        return;
      case 'compose':
        composerRef.current?.setText(dest.text);
        composerRef.current?.focus();
        return;
      default: {
        const _exhaustive: never = dest;
        return _exhaustive;
      }
    }
  }

  /**
   * Opens Settings and jumps directly to the named section. Writes the section
   * to localStorage (so the next cold-open lands there too) and threads it
   * through `requestedSection` so an already-open Settings modal switches
   * tabs without close/reopen.
   */
  function openSettingsSection(section: SettingsSection) {
    safeLocalStorageSet('maka-settings-section-v1', section);
    setSettingsRequestedSection(section);
    setSettingsProviderCatalogOpen(false);
    setSettingsOpen(true);
  }

  function openProviderCatalog() {
    safeLocalStorageSet('maka-settings-section-v1', 'models');
    setSettingsRequestedSection('models');
    setSettingsProviderCatalogOpen(true);
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
    setSettingsProviderCatalogOpen(false);
    // PR110c: re-pull onboarding snapshot when the user closes the
    // Settings modal — they may have just configured a default
    // connection or supplied a credential. Existing connections /
    // sessions events cover most state changes, but a settings-only
    // write (e.g. defaultSlug picked) may not always fire one.
    onboarding.refresh();
    // PR-MEMORY-VISIBILITY-INDICATOR-0: same recompute path for the
    // chat-header memory pill — user may have just flipped the
    // agentReadEnabled switch.
    void refreshMemoryActive();
    // PR-DEFAULT-PERMISSION-MODE-0: the General page writes
    // chatDefaults.permissionMode through its own settings-surface.tsx
    // state, which app-shell.tsx never sees live. Re-read it here so a
    // change takes effect for the next new chat without requiring an
    // app restart. New-chat creation can't happen while Settings is open
    // anyway, so a close-time refresh is timely enough (unlike theme,
    // which needs to apply instantly and has its own onThemeChange wire).
    void window.maka.settings.get().then((next) => {
      setDefaultPermissionMode(next.chatDefaults?.permissionMode ?? 'ask');
    }).catch(() => {});
  }

  function showModelSetupToast(description: string, reason?: string) {
    const copy = modelSetupToastCopy(reason, description);
    toastApi.toast({
      title: copy.title,
      description: copy.description,
      variant: 'error',
      duration: 8000,
      action: {
        label: '打开设置 · 模型',
        onClick: () => openSettingsSection('models'),
      },
    });
    openSettingsSection('models');
  }

  const activeMessageLoadError = activeId ? messageLoadErrorBySession[activeId] : undefined;
  const homeSurfaceActive =
    navSelection.section === 'sessions'
    && messages.length === 0
    && activeStreaming.length === 0
    && activeThinking.length === 0
    && liveTools.length === 0
    && !activeMessageLoadError;
  const commandOptions: AppShellCommandListOptions = {
    activeId,
    activePermissionMode: activeSessionForView?.permissionMode,
    connections,
    defaultConnection,
    dailyReviewBridge,
    messages,
    sessions,
    themePref,
    visibleSessions,
    captureComposerImportOwner,
    closePalette,
    composerRef,
    createSession,
    handleQuickChatSubmit,
    isComposerImportOwnerActive,
    openHelp,
    openPlanReminderForm,
    openProjectFolder,
    openSessionInChat,
    openSettings,
    openSettingsSection,
    openSkillsFolder,
    openWorkspaceFolder,
    refreshConnections,
    saveDailyReviewMarkdown,
    setNavSelection,
    setPermissionMode,
    setThemePref,
    toastApi,
  };

  return (
    <div className="appFrame agents-layout-root" data-agents-page>
      <div
        className="app maka-shell-2col agents-layout-body"
        aria-hidden={hasModalOpen ? 'true' : undefined}
        inert={hasModalOpen ? true : undefined}
        data-modal-background-hidden={hasModalOpen ? 'true' : undefined}
        data-sidebar-state={sessionListCollapsed ? 'collapsed' : 'expanded'}
        style={{
          '--maka-session-list-width': `${sessionListCollapsed ? SESSION_LIST_COLLAPSED_WIDTH : sessionListWidth}px`,
          '--maka-resize-handle-width': '0px',
        } as CSSProperties}
      >
        <AppShellTopbarActions
          sidebarCollapsed={sessionListCollapsed}
          onOpenSearchModal={() => {
            setSearchModalInitialQuery('');
            setSearchModalOpen(true);
          }}
          onCollapseSidebar={() => setSessionListCollapsed(true)}
          onExpandSidebar={() => setSessionListCollapsed(false)}
          onCreateSession={createSession}
        />
        <div
          className="maka-panel maka-panel-list maka-floating-panel"
          aria-hidden={sessionListCollapsed ? 'true' : undefined}
          inert={sessionListCollapsed ? true : undefined}
        >
          <SessionListPanel
            selection={navSelection}
            sessions={visibleSessions}
            activeId={activeId}
            planReminders={planReminders}
            streamingSessionIds={streamingSessionIds}
            staleSessionIds={staleSessionIds}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            statusGroups={sessionListGroups}
            onSelect={setNavSelection}
            onSelectSession={sessionListSelectSession}
            onOpenSettings={openSettings}
            onNew={createSession}
            rowActions={sessionRowActions}
            sidebarCollapsed={sessionListCollapsed}
          />
        </div>
        <div
          className="maka-resize-handle"
          role="separator"
          aria-label={sessionListCollapsed ? '侧边栏已收起' : '调整对话列表宽度'}
          aria-orientation="vertical"
          aria-valuemin={SESSION_LIST_EXPANDED_MIN_WIDTH}
          aria-valuemax={SESSION_LIST_EXPANDED_MAX_WIDTH}
          aria-valuenow={sessionListWidth}
          aria-hidden={sessionListCollapsed ? 'true' : undefined}
          tabIndex={sessionListCollapsed ? -1 : 0}
          onPointerDown={startColumnResize}
          onKeyDown={onResizeHandleKeyDown}
        />
        <div
          className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
          data-sidebar-state={sessionListCollapsed ? 'collapsed' : 'expanded'}
          data-agents-view={
            navSelection.section === 'automations'
              ? 'cron'
              : navSelection.section === 'skills'
                ? 'skills'
                : navSelection.section === 'sessions'
                  ? 'im_hub'
                  : navSelection.section
          }
        >
          <AppShellWorkspaceTopActions
            onOpenFeedback={() => openSettingsSection('about')}
            onOpenPalette={openPalette}
            onOpenHelp={openHelp}
            onOpenHealth={() => openSettingsSection('health')}
          />
          {/* PR-UI-RENDER-2: install the internal-URI dispatcher
              for any Markdown rendered inside ChatView (assistant
              answers, thinking panels, streaming bubbles). Wrapping
              at the detail-panel level keeps the provider scoped to
              the chat surface — Markdown rendered elsewhere (e.g.
              About settings) doesn't auto-route maka:// links,
              which is correct: those surfaces shouldn't be a
              navigation entry point. */}
          <MakaUriContext.Provider value={dispatchMakaUri}>
          <div className="maka-detail-with-artifacts">
            <div className="mainColumn" data-home-surface={homeSurfaceActive ? 'true' : undefined}>
              {navSelection.section === 'skills' ? (
                <SkillsPage
                  skills={skills}
                  planReminders={planReminders}
                  onRefreshSkills={() => refreshSkills()}
                  onRefreshManagedSkillSources={() => refreshManagedSkillSources()}
                  onCreateSkillTemplate={() => createSkillTemplate()}
                  onOpenSkill={(skillId) => openSkill(skillId)}
                  onUseSkill={useSkillInChat}
                  onOpenSkillsFolder={() => openSkillsFolder()}
                  managedSkillSources={managedSkillSources}
                  onImportManagedSkillSource={() => importManagedSkillSource()}
                  onInstallManagedSkill={(sourceId) => installManagedSkill(sourceId)}
                  bundledSkillCatalog={bundledSkillCatalog}
                  onRefreshBundledSkillCatalog={() => refreshBundledSkillCatalog()}
                  onInstallBundledSkill={(id) => installBundledSkill(id)}
                  onPreviewManagedSkillUpdate={(skillId) => previewManagedSkillUpdate(skillId)}
                  onUpdateManagedSkill={(skillId, options) => updateManagedSkill(skillId, options)}
                  onSetSkillEnabled={(skillId, enabled) => setSkillEnabled(skillId, enabled)}
                  onDeleteSkill={(skillId) => deleteSkill(skillId)}
                />
              ) : navSelection.section === 'automations' ? (
                <AutomationsPage
                  skills={skills}
                  reminders={planReminders}
                  onRefresh={() => refreshPlanReminders({ shouldShowError: isAutomationsSurfaceActive })}
                  onCreate={(input) => createPlanReminder(input)}
                  onUpdate={(id, patch) => updatePlanReminder(id, patch)}
                  onToggle={(id, enabled) => togglePlanReminder(id, enabled)}
                  onTriggerNow={(id) => triggerPlanReminderNow(id)}
                  onSnooze={(id) => snoozePlanReminder(id)}
                  onClearRunHistory={(id) => clearPlanReminderRunHistory(id)}
                  onDelete={(id) => deletePlanReminder(id)}
                />
              ) : navSelection.section === 'daily-review' ? (
                <DailyReviewPage
                  bridge={dailyReviewBridge}
                  onSelectSession={openSessionInChat}
                  onCopyMarkdown={(input) => copyDailyReviewMarkdown(input, { shouldShowFeedback: isDailyReviewSurfaceActive })}
                  onAppendMarkdown={appendDailyReviewMarkdown}
                  onSaveMarkdown={(input) => saveDailyReviewMarkdown(input, { shouldShowFeedback: isDailyReviewSurfaceActive })}
                />
              ) : (
              <ChatView
                messages={messages}
                liveTurn={activeLiveTurn}
                shellRunUpdates={activeShellRunUpdates}
                messageLoading={activeMessageLoading}
                processingIndicator={showProcessingIndicator}
                continuingIndicator={showContinuingIndicator}
                onStreamingSettled={activeId ? (messageId) => settleAssistantStreaming(activeId, messageId) : undefined}
                activeSession={activeSessionForView}
                activeConnectionLabel={activeConnectionLabel}
                activeModelLabel={activeModelLabel}
                activeProviderType={activeConnection?.providerType}
                renderProviderMark={(type) => <ProviderLogo type={type} compact />}
                modelChoices={chatModelChoices}
                modelChangePending={activeId ? pendingSessionModelBySession[activeId] === true : false}
                onModelChange={(input) => setSessionModel(input)}
                userLabel={userLabel}
                memoryActive={memoryActive}
                onOpenMemorySettings={() => openSettingsSection('memory')}
                connectionAlert={chatConnectionAlert}
                eventStreamAlert={chatEventStreamAlert}
                goalIndicator={activeGoal ? {
                  condition: activeGoal.condition,
                  status: activeGoal.status,
                  iterations: activeGoal.iterations,
                  maxIterations: activeGoal.maxIterations,
                  onClear: () => { void window.maka.goal.clear(activeGoal.sessionId); },
                } : undefined}
                taskLedger={activeId ? {
                  tasks: sessionTasks.tasks,
                  loading: sessionTasks.loading,
                  error: sessionTasks.error,
                  onRetry: sessionTasks.retry,
                } : undefined}
                messageLoadError={activeId ? messageLoadErrorBySession[activeId] : undefined}
                messageLoadRetryPending={activeId ? messageRetryPendingBySession[activeId] === true : false}
                onRetryMessages={activeId ? () => void retryMessages(activeId) : undefined}
                sessionStatusBadge={chatSessionStatusBadge}
                turnFooterActionsByTurn={turnFooterActionsByTurn}
                onTurnFooterAction={handleTurnFooterAction}
                turnFailedReasonLabels={turnFailedReasonLabels}
                turnFailedRecoveryLabels={turnFailedRecoveryLabels}
                turnLineageBadgesByTurn={turnLineageBadgesByTurn}
                onLineageBadgeClick={handleLineageBadgeClick}
                scrollTargetTurn={
                  activeId && searchScrollTarget?.sessionId === activeId
                    ? { turnId: searchScrollTarget.turnId, nonce: searchScrollTarget.nonce }
                    : undefined
                }
                scrollBehavior={readScrollMotionBehavior()}
                branchBanner={branchBanner}
                onBranchBannerClick={handleBranchBannerClick}
                emptyOverride={
                  showOnboardingHero && onboardingState ? (
                    <div className="maka-onboarding-stack">
                      <OnboardingHero
                        state={onboardingState}
                        onOpenSettings={(section) => {
                          if (section) openSettingsSection(section);
                          else openSettings();
                        }}
                        onBrowseProviders={openProviderCatalog}
                        onQuickChatSubmit={handleQuickChatSubmit}
                        quickChatPending={quickChatPending}
                        connections={connections}
                        onRefreshConnections={refreshConnections}
                        onSkip={async () => {
                          try {
                            await window.maka.onboarding.setMilestone('initial_onboarding', 'skipped');
                            onboarding.refresh();
                          } catch (error) {
                            toastApi.error('跳过失败', generalizedErrorMessageChinese(error, '请稍后重试。'));
                          }
                        }}
                      />
                      {onboardingState.kind === 'ready_empty' && (
                        <FirstRunChecklist
                          onOpenSettingsSection={(section) => openSettingsSection(section)}
                          onOpenSidebarModule={(target) => {
                            setNavSelection({ section: target });
                          }}
                          onStartPlanReminder={openPlanReminderForm}
                        />
                      )}
                    </div>
                  ) : isOnboardingLoading ? (
                    // @kenji review: render a no-op skeleton while the
                    // first snapshot resolves so EmptyChatHero doesn't
                    // flash. Use an aria-busy live region so screen
                    // readers know something is loading.
                    <div
                      className="maka-onboarding-loading"
                      role="status"
                      aria-busy="true"
                      aria-label="加载中"
                    />
                  ) : undefined
                }
                onNew={createSession}
                onPromptSuggestion={(prompt) => composerRef.current?.appendText(prompt)}
              />
              )}
              <div className="maka-composer-interaction-slot">
                {activePermission && (
                  <PermissionPrompt
                    request={activePermission}
                    onRespond={respondToPermission}
                    onStop={stop}
                    stopPending={activeId ? stopPendingBySession[activeId] === true : false}
                  />
                )}
                {activeQuestion && (
                  <UserQuestionPrompt
                    request={activeQuestion}
                    onRespond={respondToUserQuestion}
                    onStop={stop}
                    stopPending={activeId ? stopPendingBySession[activeId] === true : false}
                  />
                )}
              </div>
              <Composer
                ref={composerRef}
                hidden={navSelection.section !== 'sessions' || onboardingComposerHidden || Boolean(activeInteraction)}
                draftKey={activeId ?? 'new-session'}
                // #646: Stop must be available for the WHOLE turn — the moment the
                // user most wants to interrupt is a long wait with nothing on
                // screen (first token, or a slow provider's step-to-step lull).
                // Drive Stop off `turnInFlight` (armed at send, cleared at the
                // terminal event), not the wait indicators, so it never blinks out
                // in a mid-turn gap. But `turnInFlight` alone goes STALE: the event
                // stream only follows `activeId`, so a session whose turn completes
                // while backgrounded never receives its terminal event and keeps its
                // arm. Gate on `sessionAwaitingModel` (status === 'running', kept
                // truthful for backgrounded sessions by sessions:changed and made
                // synchronous at send by markSessionRunningOptimistic) so returning
                // to such a session shows Send, not a stuck Stop that hides it.
                // `activeStreamingLive` is folded in defensively for the rare replay
                // where the arm was over-cleared.
                streaming={(sessionAwaitingModel && turnInFlight) || activeStreamingLive}
                // #646: in the first-token wait (Stop up, nothing streams yet) the
                // hint reads "Maka 正在处理…"; in a mid-turn lull it reads the calm
                // "Maka 继续中…". Both are mutually exclusive with activeStreamingLive.
                processing={showProcessingIndicator && !activeStreamingLive}
                continuing={showContinuingIndicator && !activeStreamingLive}
                onSend={sendWithAttachments}
                onStop={stop}
                stopPending={activeId ? stopPendingBySession[activeId] === true : false}
                pendingAttachments={pendingAttachments}
                onRemoveAttachment={removeAttachment}
                onPickAttachments={pickAttachments}
                onAttachFilePaths={attachFilePaths}
                modelLabel={
                  activeModelLabel
                  ?? newChatModelLabel
                  ?? undefined
                }
                activeSession={activeSessionForView}
                activeConnectionLabel={activeConnectionLabel}
                activeModel={activeModel}
                activeModelLabel={activeModelLabel}
                activeProviderType={activeConnection?.providerType}
                modelChoices={chatModelChoices}
                renderProviderMark={(type) => <ProviderBrandMark type={type} />}
                modelChangePending={activeId ? pendingSessionModelBySession[activeId] === true : false}
                onModelChange={(input) => setSessionModel(input)}
                activeThinkingLevels={activeThinkingLevels}
                activeThinkingLevel={activeThinkingLevel}
                onThinkingLevelChange={(level) => setSessionThinkingLevel(level)}
                newChatModel={newChatModel}
                newChatProviderType={newChatProviderType}
                onPickNewChatModel={(input) => {
                  setPendingNewChatModel(input);
                  saveComposerDefaults({ model: input });
                }}
                newChatThinkingLevels={newChatThinkingLevels}
                newChatThinkingLevel={newChatThinkingLevel}
                onNewChatThinkingLevelChange={(level) => setPendingNewChatThinkingLevel(level ?? null)}
                onOpenModelSettings={() => openSettingsSection('models')}
                workspacePicker={{
                  label: appInfo ? basenameFromPath(appInfo.projectPath) : undefined,
                  branch: appInfo?.projectGit.branch,
                  pending: projectPickerPending,
                  recentWorkspaces: recentProjectPaths,
                  onOpen: () => {
                    void selectProjectDirectory();
                  },
                  onSelect: (path: string) => {
                    void selectRecentProjectDirectory(path);
                  },
                }}
                branchPicker={
                  appInfo?.projectGit.isGitRepo
                    ? {
                        branch: appInfo.projectGit.branch ?? null,
                        pending: branchPending,
                        branches: branchList?.branches ?? [],
                        onOpen: () => {
                          void listGitBranches();
                        },
                        onSelect: (branch: string) => {
                          void checkoutGitBranch(branch);
                        },
                      }
                    : undefined
                }
                permissionMode={defaultPermissionMode}
                permissionModePending={activeId ? pendingPermissionModeBySession[activeId] === true : false}
                permissionModeDisabledReason={
                  activeId && pendingPermissionModeBySession[activeId] === true
                    ? '权限模式正在切换，完成后再继续操作。'
                    : activeStreamingLive
                      ? '当前对话正在流式输出，等结束后再切换权限模式。'
                      : activeId && activeSessionForView?.status === 'running'
                        ? '当前对话正在运行，等结束后再切换权限模式。'
                        : activeId && activeSessionForView?.status === 'waiting_for_user'
                          ? '当前有工具调用正在等待确认，处理后再切换权限模式。'
                          : undefined
                }
                onPermissionModeChange={(mode) => setPermissionMode(mode)}
              />
            </div>
            {activeId && liveBrowserSessionIds.includes(activeId) && (
              <Suspense fallback={<BrowserPanelFallback />}>
                <BrowserPanel sessionId={activeId} hidden={hasModalOpen} />
              </Suspense>
            )}
            <Suspense fallback={null}>
              <ArtifactPane sessionId={activeId} />
            </Suspense>
          </div>
          </MakaUriContext.Provider>
        </div>
      </div>
      <AppShellOverlays
        settingsOpen={settingsOpen}
        connections={connections}
        defaultConnection={defaultConnection}
        refreshConnections={refreshConnections}
        closeSettings={closeSettings}
        themePref={themePref}
        setThemePref={setThemePref}
        themePalette={themePalette}
        setThemePalette={setThemePalette}
        setUserLabel={setUserLabel}
        settingsRequestedSection={settingsRequestedSection}
        settingsProviderCatalogOpen={settingsProviderCatalogOpen}
        onOpenDailyReview={() => {
          closeSettings();
          setNavSelection({ section: 'daily-review' });
        }}
        onOpenSettingsSession={(sessionId) => {
          closeSettings();
          openSessionInChat(sessionId);
        }}
        helpOpen={helpOpen}
        closeHelp={closeHelp}
        searchModalOpen={searchModalOpen}
        searchModalInitialQuery={searchModalInitialQuery}
        closeSearchModal={closeSearchModal}
        searchModalDeps={searchModalDeps}
        searchModalOnNavigate={searchModalOnNavigate}
        paletteOpen={paletteOpen}
        closePalette={closePalette}
        paletteOnSelectSession={paletteOnSelectSession}
        paletteOnOpenSearchModal={paletteOnOpenSearchModal}
        commandOptions={commandOptions}
      />
    </div>
  );
}
