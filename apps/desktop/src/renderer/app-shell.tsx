import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  ChatDefaultPermissionMode,
  ConnectionEvent,
  LlmConnection,
  PermissionMode,
  PlanReminder,
  SessionSummary,
  SettingsSection,
  StoredMessage,
  ThemePalette,
  ThemePreference,
  ThinkingLevel,
} from '@maka/core';
import { generalizedErrorMessageChinese, hasSettledInitialOnboarding, thinkingVariantsForModel, attachmentKindFromMimeType, guessMimeFromName } from '@maka/core';
import {
  type ChatHeaderAlert,
  type ChatModelChoice,
  ChatView,
  Composer,
  type ComposerHandle,
  type MakaUriDest,
  MakaUriContext,
  type NavSelection,
	  SessionListPanel,
	  type SessionViewMode,
	  type SkillEntry,
  type TurnFooterActionMeta,
  useToast,
  activePermissionFor,
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
import { deriveChatHeaderAlert } from './chat-header-alert';
import { deriveStaleSessionIds } from './stale-sessions';
import { deriveProjectGroups } from './session-project-grouping';
import { deriveSessionStatusGroups } from './session-status-grouping';
import {
  normalizeSessionSummaryForDisplay,
  presentSessionStatus,
  sessionStatusAriaLabel,
} from './session-status-presentation';
import { deriveAppShellTurnViewModel } from './app-shell-turn-view-model';
import { readScrollMotionBehavior } from './scroll-motion-policy';
import { deriveBranchBanner } from './branch-banner';
import { pickCatalogDefaultChatModel } from './model-catalog-choices';
import { applyTheme, applyThemePalette, applyUiLocale } from './theme';
import { hasInFlightToolActivity } from './session-event-health';
import { safeLocalStorageSet } from './browser-storage';
import { applyLocalSessionRead, applySessionReadOverrides, createSessionListRefresher, type SessionListRefresher, type SessionReadBoundaries } from './session-read-state';
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
import { buildChatModelChoices, chatModelChoiceLabel, normalizeActiveChatModel } from './chat-model-selection';
import { basenameFromPath } from './app-shell-copy';
import type { AppShellCommandListOptions } from './app-shell-command-actions';
import { AppShellTopbarActions, AppShellWorkspaceTopActions } from './app-shell-chrome-actions';
import { AppShellOverlays } from './app-shell-overlays';
import { createAppShellDailyReviewBridge } from './app-shell-daily-review-bridge';
import { createAppShellPlanActions } from './app-shell-plan-actions';
import { createAppShellProjectActions, type RendererAppInfo } from './app-shell-project-actions';
import { createAppShellSkillActions } from './app-shell-skill-actions';
import { createAppShellSessionEventHandlers } from './app-shell-session-events';
import { createAppShellVisualSmokeActions } from './app-shell-visual-smoke';
import { createAppShellChatActions, type PendingAttachment } from './app-shell-chat-actions';
import { appendPending, clearPending, removePending, selectPending, type PendingByKey } from './app-shell-pending-attachments';
import { createAppShellTurnActions } from './app-shell-turn-actions';
import { createAppShellLayoutActions } from './app-shell-layout-actions';
import { createAppShellQuickChatActions } from './app-shell-quick-chat-actions';
import { createAppShellDailyReviewActions } from './app-shell-daily-review-actions';
import { createAppShellSessionRowActions } from './app-shell-session-row-actions';
import { createAppShellSessionSettingsActions } from './app-shell-session-settings-actions';
import { createAppShellStopAction } from './app-shell-stop-action';
import { useAppShellSessionUiState } from './app-shell-session-ui-state';
import {
  useActiveSessionEvents,
  useAppShellBootstrapSubscriptions,
  useAppShellHostEffects,
  useAppShellPersistenceEffects,
  useAppShellRefSync,
  useSessionEventHealthPolling,
} from './app-shell-effects';
import { loadComposerDefaults, saveComposerDefaults } from './composer-defaults';

function connectionsEqual(a: LlmConnection[], b: LlmConnection[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].slug !== b[i].slug || a[i].updatedAt !== b[i].updatedAt) return false;
  }
  return true;
}

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
};

function approvalToPending(file: { approvalId: string; name: string; mimeType?: string; size: number }): PendingAttachment {
  const mimeType = file.mimeType ?? guessMimeFromName(file.name);
  return {
    displayName: file.name,
    mimeType,
    kind: attachmentKindFromMimeType(mimeType, file.name),
    size: file.size,
    source: { type: 'approval', approvalId: file.approvalId, name: file.name },
  };
}

function fileToPending(file: File): PendingAttachment {
  const mimeType = file.type || undefined;
  return {
    displayName: file.name,
    mimeType,
    kind: attachmentKindFromMimeType(mimeType ?? '', file.name),
    size: file.size,
    source: { type: 'file', file },
  };
}

export function AppShell({
  initialOnboardingSnapshot = null,
}: {
  /** Pre-mount snapshot prefetched by main.tsx — see prefetchOnboardingSnapshot. */
  initialOnboardingSnapshot?: OnboardingSnapshot | null;
} = {}) {
  const toastApi = useToast();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const sessionReadBoundariesRef = useRef<SessionReadBoundaries>({});
  const sessionListRefresherRef = useRef<SessionListRefresher | null>(null);
  if (!sessionListRefresherRef.current) {
    sessionListRefresherRef.current = createSessionListRefresher({
      listSessions: () => window.maka.sessions.list(),
      readBoundaries: () => sessionReadBoundariesRef.current,
      currentSessions: () => sessionsRef.current,
      commitSessions: (next) => {
        // Display normalization at the state boundary: non-actionable
        // blocked (missing terminal bookkeeping) reads as an ordinary
        // resumable session everywhere in the renderer.
        const displayNext = next.map(normalizeSessionSummaryForDisplay);
        sessionsRef.current = displayNext;
        setSessions(displayNext);
      },
      onError: (error) => {
        toastApi.error('刷新会话列表失败', generalizedErrorMessageChinese(error, '刷新会话列表失败，请稍后重试。'));
      },
    });
  }
  const [activeId, setActiveIdState] = useState<string | undefined>();
  const [pendingByKey, setPendingByKey] = useState<PendingByKey<PendingAttachment>>({});
  const attachmentDraftKey = activeId ?? 'new-session';
  const pendingAttachments = selectPending(pendingByKey, attachmentDraftKey);
  // P3: session ids with a live embedded-browser view. The right-side
  // BrowserPanel mounts only for these, so ordinary chats reserve no space.
  const [liveBrowserSessionIds, setLiveBrowserSessionIds] = useState<string[]>([]);
  const [navSelection, setNavSelection] = useState<NavSelection>(() => readNavSelection());
  const navSelectionRef = useRef<NavSelection>(navSelection);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [messageLoadPending, setMessageLoadPending] = useState(false);
  const messageRetryPendingRef = useRef<Set<string>>(new Set());
  const stopPendingRef = useRef<Set<string>>(new Set());
  const {
    state: sessionUiState,
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
  } = useAppShellSessionUiState();
  const {
    messageLoadErrorBySession,
    messageRetryPendingBySession,
    stopPendingBySession,
    streamingBySession,
    thinkingBySession,
    thinkingTruncatedBySession,
    liveToolsBySession,
    permissionBySession,
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
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultConnection, setDefaultConnection] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequestedSection, setSettingsRequestedSection] = useState<SettingsSection | undefined>(undefined);
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
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [planReminders, setPlanReminders] = useState<PlanReminder[]>([]);
  // Persisted composer defaults seed the empty-state model, project path, and
  // recent workspace history so the home view is populated before the async
  // `app:info` round-trip completes on mount.
  const persistedComposerDefaults = loadComposerDefaults();
  const [pendingNewChatModel, setPendingNewChatModel] = useState<{ llmConnectionSlug: string; model: string } | null>(
    persistedComposerDefaults?.model ?? null,
  );
  // Permission mode is renderer-only, scoped to one new-chat decision.
  // It must NOT persist across reloads — persisted permission would
  // silently inherit a previous session's mode (e.g. auto-edit) after
  // restart with no visible signal, which is a safety regression.
  // The single authority is main.ts's Settings → 通用 default. See
  // session-status-presentation.test.ts for the contract.
  const [pendingNewChatPermissionMode, setPendingNewChatPermissionMode] = useState<PermissionMode | null>(null);
  const [appInfo, setAppInfo] = useState<RendererAppInfo | null>(
    persistedComposerDefaults?.projectPath
      ? { projectPath: persistedComposerDefaults.projectPath, projectGit: { isGitRepo: false } }
      : null,
  );
  const [branchList, setBranchList] = useState<{ branches: string[]; current?: string } | null>(null);
  const [branchPending, setBranchPending] = useState(false);
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>(
    persistedComposerDefaults?.recentProjectPaths ?? [],
  );
  const [projectPickerPending, setProjectPickerPending] = useState(false);
  const [helpOpen, closeHelp, openHelp] = useKeyboardHelp();
  const [paletteOpen, openPalette, closePalette] = useCommandPalette();
  // Search modal state. Sidebar `搜索` opens the real thread-search
  // modal; result selection below can also hand ChatView a turn anchor
  // so the hit is visible after session navigation.
  const [searchModalOpen, setSearchModalOpen] = useState(false);
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
  const activeIdRef = useRef<string | undefined>(undefined);
  const rendererMountedRef = useRef(true);
  const projectPickerPendingRef = useRef(false);
  const projectPickerRequestRef = useRef(0);
  const activeStreamingSlot = activeId ? streamingBySession[activeId] : undefined;
  const activeStreaming = activeStreamingSlot?.text ?? '';
  const activeStreamingTruncated = activeStreamingSlot?.truncated === true;
  const activeStreamingComplete = activeStreamingSlot?.phase === 'draining';
  const activeStreamingLive = activeStreaming.length > 0 && activeStreamingSlot?.phase === 'streaming';
  const activeStreamingMessageId = activeStreamingComplete ? activeStreamingSlot?.messageId : undefined;
  const activeThinking = activeId ? thinkingBySession[activeId] ?? '' : '';
  const activeThinkingTruncated = activeId ? thinkingTruncatedBySession[activeId] === true : false;
  // Set of session ids with a live streaming delta — drives the sidebar
  // pulse indicator. Recomputed on every streamingBySession change; cheap
  // since the underlying map only has at most a handful of entries.
  const streamingSessionIds = useMemo(
    () => new Set(Object.entries(streamingBySession).flatMap(([id, slot]) => (slot.text && slot.phase === 'streaming' ? [id] : []))),
    [streamingBySession],
  );
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
  // PR109b: status-grouped sidebar (design-system §9.8). The `chats`
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
  const liveTools = useMemo(() => (activeId ? liveToolsBySession[activeId] ?? [] : []), [activeId, liveToolsBySession]);
  const hasInFlightLiveTools = useMemo(() => hasInFlightToolActivity(liveTools), [liveTools]);
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
  const activePermission = activePermissionFor(permissionBySession, activeId);
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeConnection = activeSession
    ? connections.find((connection) => connection.slug === activeSession.llmConnectionSlug)
    : undefined;
  const defaultConnectionEntry = defaultConnection
    ? connections.find((connection) => connection.slug === defaultConnection)
    : undefined;
  const chatModelChoices = useMemo<ChatModelChoice[]>(
    () => buildChatModelChoices(connections),
    [connections],
  );
  // Home / empty-state composer: which model the next NEW chat starts with.
  // Null = follow the default connection; a pick overrides it (sticky until
  // changed) and is forwarded to sessions.create in `send()`. Renderer-only —
  // it never mutates the persisted Settings · 模型 default.
  const [pendingNewChatThinkingLevel, setPendingNewChatThinkingLevel] = useState<ThinkingLevel | null>(null);
  // A pick only stays in effect while it is still an offered choice. If the user
  // later disables/removes that connection or model, fall back to the default so
  // the home chip never shows — nor sends — a model that no longer exists.
  const validPendingNewChatModel =
    pendingNewChatModel &&
    chatModelChoices.some(
      (c) => c.connectionSlug === pendingNewChatModel.llmConnectionSlug && c.model === pendingNewChatModel.model,
    )
      ? pendingNewChatModel
      : null;
  const catalogDefaultNewChatModel = defaultConnectionEntry
    ? pickCatalogDefaultChatModel(defaultConnectionEntry)
    : undefined;
  const newChatModel = validPendingNewChatModel ?? catalogDefaultNewChatModel;
  const activeConnectionLabel = activeSession?.backend === 'fake'
    ? '本地模拟连接'
    : activeConnection?.name ?? activeSession?.llmConnectionSlug;
  const activeModel = activeSession?.backend === 'fake'
    ? undefined
    : normalizeActiveChatModel(activeSession, activeConnection, chatModelChoices);
  const activeModelLabel = activeSession?.backend === 'fake'
    ? undefined
    : chatModelChoiceLabel(chatModelChoices, activeSession?.llmConnectionSlug, activeModel);
  const activeThinkingLevels = useMemo(
    () => (activeConnection && activeModel) ? thinkingVariantsForModel(activeConnection.providerType, activeModel) : [],
    [activeConnection, activeModel],
  );
  // Only surface a stored level when the current model still supports it;
  // if the model changed (setModel clears it) or the catalog reconfigured so
  // the level is no longer offered, the chip falls back to 默认 instead of
  // advertising a level the runtime would silently drop. The runtime's
  // `buildProviderOptions` is the wire-level guard; this keeps the UI honest.
  const activeThinkingLevel =
    activeSession?.thinkingLevel && activeThinkingLevels.includes(activeSession.thinkingLevel)
      ? activeSession.thinkingLevel
      : undefined;
  const newChatThinkingLevels = useMemo(
    () => {
      if (!newChatModel) return [];
      const c = connections.find((entry) => entry.slug === newChatModel.llmConnectionSlug);
      return c ? thinkingVariantsForModel(c.providerType, newChatModel.model) : [];
    },
    [newChatModel, connections],
  );
  const newChatThinkingLevel = pendingNewChatThinkingLevel && newChatThinkingLevels.includes(pendingNewChatThinkingLevel)
    ? pendingNewChatThinkingLevel
    : undefined;
  const newChatModelLabel = chatModelChoiceLabel(chatModelChoices, newChatModel?.llmConnectionSlug, newChatModel?.model);

  // Surface a credential-lifecycle alert directly in the chat header when
  // the active session's connection is in `needs_reauth` / `error` or has
  // been deleted entirely. We skip the async hasSecret fetch here — the
  // chat header is a hint surface; AccountSettingsPage remains the
  // authoritative detailed view.
  // Cheap renderer-side "is the default connection plausibly ready" check —
  // used to decide whether a stale session can be silent-rebound on send
  // (xuan's send-path rebind requires a ready default) or whether the user
  // has to fix Settings first. We can't verify `hasSecret` synchronously
  // here without an extra IPC round-trip; backend remains authoritative if
  // the secret is missing — it will surface `missing_api_key` reason at
  // send time. For banner copy purposes, "default exists + enabled" is
  // enough.
  const defaultConnectionReady = useMemo(() => {
    if (!defaultConnection) return false;
    const entry = connections.find((connection) => connection.slug === defaultConnection);
    return entry?.enabled === true;
  }, [defaultConnection, connections]);

  // Banner derivation is a pure function (see `chat-header-alert.ts`); we
  // wrap the returned `onClickTarget` here with the Settings-jump action.
  const chatConnectionAlert = useMemo<ChatHeaderAlert | undefined>(() => {
    const derived = deriveChatHeaderAlert({
      backend: activeSession?.backend,
      hasActiveConnection: Boolean(activeConnection),
      defaultConnectionReady,
      lastTestStatus: activeConnection?.lastTestStatus,
    });
    if (!derived) return undefined;
    const target = derived.onClickTarget;
    return {
      tone: derived.tone,
      label: derived.label,
      ...(derived.tooltip ? { tooltip: derived.tooltip } : {}),
      onClick: () => openSettingsSection(target),
    };
    // openSettingsSection is stable enough for our purposes — main.tsx
    // doesn't depend on it changing, and including it would force the
    // effect to re-create on every render due to its function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSession?.id,
    activeSession?.backend,
    activeConnection?.slug,
    activeConnection?.lastTestStatus,
    defaultConnectionReady,
  ]);

  const chatEventStreamAlert = useMemo<ChatHeaderAlert | undefined>(() => {
    if (activeSessionEventHealth?.status !== 'stale') return undefined;
    return {
      tone: 'warning',
      label: '事件流恢复中',
      tooltip: '当前对话的实时事件需要刷新，Maka 正在从本地会话记录恢复。',
    };
  }, [activeSessionEventHealth?.status]);

  // PR109d-b: turn footer actions per turn. Derived from the
  // materialized turn list (status + lineage descendants) + pending
  // mask. Per @kenji PR109d review: pending state prevents double-click
  // duplicate sibling turns by disabling the action button between
  // click and `sessions:changed turn-status-change` arriving.
  const [pendingTurnActions, setPendingTurnActions] = useState<Set<string>>(() => new Set());
  const pendingTurnActionsRef = useRef<Set<string>>(new Set());
  const pendingTurnActionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingSessionRowActionsRef = useRef<Set<string>>(new Set());
  const pendingPermissionModeChangesRef = useRef<Set<string>>(new Set());
  const pendingSessionModelChangesRef = useRef<Set<string>>(new Set());
  const pendingKeyOf = (sessionId: string, turnId: string, actionId: TurnFooterActionMeta['id']) =>
    `${sessionId}:${turnId}:${actionId}`;
  function addPendingTurnAction(key: string): boolean {
    if (pendingTurnActionsRef.current.has(key)) return false;
    pendingTurnActionsRef.current.add(key);
    setPendingTurnActions(new Set(pendingTurnActionsRef.current));
    const timeoutHandle = setTimeout(() => clearPendingTurnAction(key), 5000);
    pendingTurnActionTimersRef.current.set(key, timeoutHandle);
    return true;
  }
  function clearPendingTurnAction(key: string): void {
    if (!pendingTurnActionsRef.current.has(key)) return;
    pendingTurnActionsRef.current.delete(key);
    const timeoutHandle = pendingTurnActionTimersRef.current.get(key);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    pendingTurnActionTimersRef.current.delete(key);
    setPendingTurnActions(new Set(pendingTurnActionsRef.current));
  }
  function clearPendingTurnActionsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of Array.from(pendingTurnActionsRef.current)) {
      if (key.startsWith(prefix)) clearPendingTurnAction(key);
    }
  }
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
    messageRetryPendingRef.current.delete(sessionId);
    stopPendingRef.current.delete(sessionId);
    clearPendingTurnActionsForSession(sessionId);
    pendingPermissionModeChangesRef.current.delete(sessionId);
    pendingSessionModelChangesRef.current.delete(sessionId);
    clearSessionUiState(sessionId);
  }

  const sessionRowActionHandlers = createAppShellSessionRowActions({
    activeIdRef,
    clearSessionRendererState,
    pendingSessionRowActionsRef,
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
    pendingPermissionModeChangesRef,
    pendingSessionModelChangesRef,
    refreshSessions,
    sessionsRef,
    setPendingPermissionModeBySession,
    setPendingNewChatPermissionMode,
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
      liveTools,
      pendingTurnActions,
      pendingKeyOf,
    }),
    [activeId, messages, liveTools, pendingTurnActions],
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
    // hardcoded value before the real session data (or its own
    // pendingNewChatPermissionMode fallback) supersedes it.
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
  const seededRef = useRef(false);
  // useLayoutEffect, NOT useEffect: the snapshot render flips
  // `isOnboardingLoading` off while `sessions` is still []. A passive
  // effect seeds sessions AFTER the browser paints that frame, so users
  // with history saw a one-frame flash of the empty-state hero (the
  // "配置页闪了一下" startup flash). Layout effects run before paint,
  // so the seeded sessions and the un-gated frame commit together.
  useLayoutEffect(() => {
    // Snapshot IPC failed — the seed path will never run, so fall back
    // to the classic boot pull or the sidebar stays empty forever.
    if (onboarding.error && !onboarding.snapshot && !seededRef.current) {
      seededRef.current = true;
      void bootstrapSessions();
      void refreshConnections();
      return;
    }
    const snapshot = onboarding.snapshot;
    if (!snapshot || seededRef.current) return;
    seededRef.current = true;
    // Seed sessions. Display normalization MUST run here too — this is
    // a third renderer state entry alongside commitSessions /
    // upsertSessionSummary (#452): without it, legacy blocked/unknown
    // sessions flash an 已阻塞 group on first paint until the first
    // refreshSessions() overwrites the seed.
    if (snapshot.sessions.length > 0) {
      const next = applySessionReadOverrides(snapshot.sessions, sessionReadBoundariesRef.current)
        .map(normalizeSessionSummaryForDisplay);
      sessionsRef.current = next;
      setSessions(next);
      if (!activeIdRef.current && next[0]?.lastMessageAt) setActiveId(next[0].id);
    }
    // Seed connections — avoids separate connections:list + getDefault IPCs
    if (snapshot.connections.length > 0) {
      setConnections(snapshot.connections);
      setDefaultConnection(snapshot.defaultSlug);
    }
  }, [onboarding.snapshot, onboarding.error]);
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
    refreshPlanReminders,
    createPlanReminder,
    updatePlanReminder,
    togglePlanReminder,
    triggerPlanReminderNow,
    snoozePlanReminder,
    clearPlanReminderRunHistory,
    deletePlanReminder,
  } = createAppShellPlanActions({
    getPlanReminders: () => planReminders,
    isAutomationsSurfaceActive,
    setPlanReminders,
    toastApi,
  });

  const {
    refreshAppInfo,
    selectProjectDirectory,
    selectRecentProjectDirectory,
    openProjectFolder,
    openWorkspaceFolder,
    openSkillsFolder,
    listGitBranches,
    checkoutGitBranch,
  } = createAppShellProjectActions({
    projectPickerPendingRef,
    projectPickerRequestRef,
    rendererMountedRef,
    setAppInfo,
    setProjectPickerPending,
    setBranchPending,
    setBranchList,
    setRecentProjectPaths,
    recentProjectPaths,
    toastApi,
  });

  const {
    refreshSkills,
    createSkillTemplate,
    openSkill,
  } = createAppShellSkillActions({
    isSkillsSurfaceActive,
    setSkills,
    toastApi,
  });

  const { applyVisualSmokeFixture } = createAppShellVisualSmokeActions({
    openPalette,
    openSettingsSection,
    refreshSessions,
    setActiveId,
    setLiveToolsBySession,
    setNavSelection,
    setPermissionBySession,
    setSearchModalOpen,
    setSessionListCollapsed,
    setStreamingBySession,
    setThemePref,
    setThinkingBySession,
  });

  const {
    send,
    respondToPermission,
    refreshMessages,
    retryMessages,
  } = createAppShellChatActions({
    activeIdRef,
    addPendingSessionAction,
    captureComposerImportOwner,
    clearPendingSessionAction,
    isNewChatSendSurfaceActive,
    markSessionReadLocally,
    messageRetryPendingRef,
    refreshSessions,
    setActiveId,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setMessages,
    setNavSelection,
    showModelSetupToast,
    toastApi,
    upsertSessionSummary,
    pendingNewChatPermissionMode,
    setPendingNewChatPermissionMode,
    validPendingNewChatModel,
    pendingNewChatThinkingLevel: newChatThinkingLevel ?? null,
  });

  const { handleTurnFooterAction } = createAppShellTurnActions({
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
  });

  async function pickAttachments(): Promise<void> {
    try {
      const result = await window.maka.attachments.pickFiles();
      if (!result.ok) return;
      setPendingByKey((map) => appendPending(map, attachmentDraftKey, result.files.map(approvalToPending)));
    } catch (error) {
      toastApi.error('添加附件失败', generalizedErrorMessageChinese(error, '请稍后重试。'));
    }
  }

  async function attachFilePaths(files: File[]): Promise<void> {
    if (files.length === 0) return;
    setPendingByKey((map) => appendPending(map, attachmentDraftKey, files.map(fileToPending)));
  }

  function removeAttachment(index: number): void {
    setPendingByKey((map) => removePending(map, attachmentDraftKey, index));
  }

  async function sendWithAttachments(text: string): Promise<boolean | void> {
    if (text.trim() === '/compact') {
      if (activeId) await window.maka.sessions.compact(activeId);
      return true;
    }
    const pending = pendingAttachments.length > 0 ? pendingAttachments : undefined;
    const ok = await send(text, pending);
    if (ok !== false) setPendingByKey((map) => clearPending(map, attachmentDraftKey));
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

  const { handleEvent, settleAssistantStreaming } = createAppShellSessionEventHandlers({
    activeIdRef,
    refreshMessages,
    refreshSessions,
    setLiveToolsBySession,
    setPermissionBySession,
    setStreamingBySession,
    setThinkingBySession,
    setThinkingTruncatedBySession,
    showModelSetupToast,
    streamingBySessionRef,
    toastApi,
  });

  useEffect(() => {
    if (!activeId || !activeStreamingComplete || !activeStreamingMessageId) return;
    const committedAssistantArrived = messages.some((message) => message.type === 'assistant' && message.id === activeStreamingMessageId);
    if (!committedAssistantArrived) return;
    void settleAssistantStreaming(activeId, activeStreamingMessageId);
  }, [activeId, activeStreamingComplete, activeStreamingMessageId, messages, settleAssistantStreaming]);

  const hasModalOpen = Boolean(activePermission) || helpOpen || paletteOpen || searchModalOpen;

  useAppShellRefSync({
    activeId,
    activeIdRef,
    navSelection,
    navSelectionRef,
    sessions,
    sessionsRef,
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
    clearPendingTurnActionsForSession,
    clearSessionRendererState,
    handleConnectionEvent,
    openSettings,
    pendingPermissionModeChangesRef,
    pendingSessionModelChangesRef,
    pendingTurnActionTimersRef,
    pendingTurnActionsRef,
    projectPickerPendingRef,
    projectPickerRequestRef,
    refreshAppInfo,
    refreshConnections,
    refreshMemoryActive,
    refreshMessages,
    refreshPlanReminders,
    refreshShellSettings,
    refreshSkills,
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
  useSessionEventHealthPolling({
    activeId,
    activePermission,
    activeSession,
    activeStreamingLive,
    hasInFlightLiveTools,
    refreshMessages,
    refreshSessions,
    sessionEventHealthBySessionRef,
    setSessionEventHealthBySession,
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

  async function refreshSessions(): Promise<SessionSummary[]> {
    return sessionListRefresherRef.current!.refresh();
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

  function upsertSessionSummary(session: SessionSummary): void {
    setSessions((current) => {
      const next = [
        normalizeSessionSummaryForDisplay(session),
        ...current.filter((entry) => entry.id !== session.id),
      ];
      sessionsRef.current = next;
      return next;
    });
  }

  function markSessionReadLocally(sessionId: string, readMessages: readonly StoredMessage[]): void {
    setSessions((current) => {
      const next = applyLocalSessionRead(sessionReadBoundariesRef.current, current, sessionId, readMessages);
      sessionsRef.current = next;
      return next;
    });
  }

  async function bootstrapSessions() {
    const next = await refreshSessions();
    if (!activeIdRef.current && next[0] && next[0].lastMessageAt) setActiveId(next[0].id);
  }

  async function refreshConnections() {
    try {
      const [next, nextDefault] = await Promise.all([
        window.maka.connections.list(),
        window.maka.connections.getDefault(),
      ]);
      setConnections((prev) => connectionsEqual(prev, next) ? prev : next);
      setDefaultConnection(nextDefault);
    } catch (error) {
      toastApi.error('刷新模型连接失败', generalizedErrorMessageChinese(error, '模型连接暂时无法刷新，请稍后重试。'));
    }
  }

  async function createSession() {
    setActiveId(undefined);
    setNavSelection({ section: 'sessions', filter: 'chats' });
    setSearchScrollTarget(null);
    setMessageLoadPending(false);
    setMessages([]);
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

  function handleConnectionEvent(event: ConnectionEvent) {
    switch (event.type) {
      case 'connection_list_changed':
        void refreshConnections();
        break;
    }
  }

  function openSettings() {
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
   * must be wired here (and in smoke.md Path 17).
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
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
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
          onOpenSearchModal={() => setSearchModalOpen(true)}
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
              <ChatView
                messages={messages}
                messageLoading={activeMessageLoading}
                streamingText={activeStreaming}
                streamingComplete={activeStreamingComplete}
                streamingMessageId={activeStreamingMessageId}
                onStreamingSettled={activeId ? () => settleAssistantStreaming(activeId, activeStreamingMessageId) : undefined}
                streamingTruncated={activeStreamingTruncated}
                thinkingText={activeThinking}
                thinkingTruncated={activeThinkingTruncated}
                tools={liveTools}
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
                mode={navSelection.section}
                connectionAlert={chatConnectionAlert}
                eventStreamAlert={chatEventStreamAlert}
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
                skills={skills}
                onRefreshSkills={() => refreshSkills()}
                onCreateSkillTemplate={() => createSkillTemplate()}
                onOpenSkill={(skillId) => openSkill(skillId)}
                onOpenSkillsFolder={() => openSkillsFolder()}
                planReminders={planReminders}
                onRefreshPlanReminders={() => refreshPlanReminders({ shouldShowError: isAutomationsSurfaceActive })}
                onCreatePlanReminder={(input) => createPlanReminder(input)}
                onUpdatePlanReminder={(id, patch) => updatePlanReminder(id, patch)}
                onTogglePlanReminder={(id, enabled) => togglePlanReminder(id, enabled)}
                onTriggerPlanReminderNow={(id) => triggerPlanReminderNow(id)}
                onSnoozePlanReminder={(id) => snoozePlanReminder(id)}
                onClearPlanReminderRunHistory={(id) => clearPlanReminderRunHistory(id)}
                onDeletePlanReminder={(id) => deletePlanReminder(id)}
                dailyReviewBridge={dailyReviewBridge}
                onSelectSession={openSessionInChat}
                onCopyDailyReviewMarkdown={(input) => copyDailyReviewMarkdown(input, { shouldShowFeedback: isDailyReviewSurfaceActive })}
                onAppendDailyReviewMarkdown={appendDailyReviewMarkdown}
                onSaveDailyReviewMarkdown={(input) => saveDailyReviewMarkdown(input, { shouldShowFeedback: isDailyReviewSurfaceActive })}
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
              <Composer
                ref={composerRef}
                hidden={navSelection.section !== 'sessions' || onboardingComposerHidden}
                draftKey={activeId ?? 'new-session'}
                disabled={Boolean(activePermission)}
                streaming={activeStreamingLive}
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
                modelChoices={chatModelChoices}
                renderProviderMark={(type) => <ProviderBrandMark type={type} />}
                modelChangePending={activeId ? pendingSessionModelBySession[activeId] === true : false}
                onModelChange={(input) => setSessionModel(input)}
                activeThinkingLevels={activeThinkingLevels}
                activeThinkingLevel={activeThinkingLevel}
                onThinkingLevelChange={(level) => setSessionThinkingLevel(level)}
                newChatModel={newChatModel}
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
                permissionMode={activeSessionForView?.permissionMode ?? pendingNewChatPermissionMode ?? defaultPermissionMode}
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
        activePermission={activePermission}
        respondToPermission={respondToPermission}
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
        closeSearchModal={closeSearchModal}
        searchModalDeps={searchModalDeps}
        searchModalOnNavigate={searchModalOnNavigate}
        paletteOpen={paletteOpen}
        closePalette={closePalette}
        paletteOnSelectSession={paletteOnSelectSession}
        commandOptions={commandOptions}
      />
    </div>
  );
}
