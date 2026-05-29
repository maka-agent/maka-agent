import { StrictMode, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ConnectionEvent,
  LlmConnection,
  PermissionMode,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  QuickChatMode,
  PermissionRequestEvent,
  PermissionResponse,
  SessionEventStreamSnapshot,
  SessionEvent,
  SessionSummary,
  SettingsSection,
  StoredMessage,
  TextFileImportPreflightFailureReason,
  ThemePalette,
  ThemePreference,
  UiDensity,
} from '@maka/core';
import { MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES, preflightDroppedTextFilesForPromptImport } from '@maka/core';
import {
  applyAssistantDelta,
  applyThinkingComplete,
  applyThinkingDelta,
  applyToolOutputChunk,
  type ChatHeaderAlert,
  ChatView,
  Composer,
  type ComposerHandle,
  deriveTurnLineageMap,
  type MakaUriDest,
  MakaUriContext,
  materializeTurns,
  type NavSelection,
  PermissionDialog,
  redactSecrets,
  SearchModal,
  SessionListPanel,
  type SkillEntry,
  ToastProvider,
  type TurnFooterActionMeta,
  type TurnLineageBadge,
  useToast,
  type ToolActivityItem,
  type ToolOutputChunk,
  formatDailyReviewMarkdown,
} from '@maka/ui';
import { SettingsModal } from './settings/SettingsModal';
import { ErrorBoundary } from './error-boundary';
import { KeyboardHelpModal, useKeyboardHelp } from './keyboard-help';
import { CommandPalette, buildCommandList, useCommandPalette } from './command-palette';
import { OnboardingHero } from './OnboardingHero';
import { FirstRunChecklist } from './FirstRunChecklist';
import {
  FIRST_RUN_TASK_SUGGESTION_MILESTONES,
  type FirstRunTaskSuggestionId,
} from './first-run-task-suggestions';
import { useOnboardingSnapshot } from './use-onboarding-snapshot';
import { ProviderLogo } from './settings/ProvidersPanel';
import { ArtifactPane } from './artifact-pane';
import { deriveChatHeaderAlert } from './chat-header-alert';
import { deriveStaleSessionIds } from './stale-sessions';
import { deriveSessionStatusGroups } from './session-status-grouping';
import {
  deriveFailedTurnRecovery,
  describeTurnErrorClass,
  presentSessionStatus,
  sessionStatusAriaLabel,
} from './session-status-presentation';
import { deriveTurnFooterActions } from './turn-footer-actions';
import { readScrollMotionBehavior } from './scroll-motion-policy';
import { deriveBranchBanner } from './branch-banner';
import { applyDensity, applyTheme, applyThemePalette, applyUiLocale } from './theme';
import { openPathActionLabel, openPathFailureCopy } from './open-path';
import {
  createSessionEventStreamSubscription,
  evaluateSessionEventStreamSnapshot,
  recordSessionEventStreamChange,
  recordSessionEventStreamEvent,
} from './session-event-health';
import './styles.css';

const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';
const NO_REAL_CONNECTION_REASON_RE = /NO_REAL_CONNECTION:([a-z_]+): /;

interface RendererAppInfo {
  projectPath: string;
  projectGit: { isGitRepo: boolean; branch?: string };
}

function basenameFromPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  const name = trimmed.split(/[\\/]/).filter(Boolean).pop();
  return name || trimmed || '当前项目';
}

function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}

function AppShell() {
  const toastApi = useToast();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [navSelection, setNavSelection] = useState<NavSelection>(() => readNavSelection());
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  // PR-UI-Cx fixup v2 (@kenji msg 3c01e901 Blocker 2): combined
  // per-session assistant streaming state. The `text` + `truncated`
  // pair lives in a SINGLE useState so the `text_delta` handler can
  // produce both fields from one functional updater — no
  // cross-mutation between updaters, no closure-variable hack.
  // `truncated` is monotonic per-session: once flipped to `true`
  // within a streaming turn, stays true until `clearStreaming`
  // resets the slot.
  type AssistantStreamSlot = { text: string; truncated: boolean };
  const [streamingBySession, setStreamingBySession] = useState<Record<string, AssistantStreamSlot>>({});
  /**
   * PR-UI-LAYOUT-42 (@kenji reference renderer audit, external docs/12-renderer.md §15.3):
   * The reference design displays Anthropic-style `reasoning_content`
   * (extended thinking) in a collapsible "Reasoning" panel above the
   * assistant answer. Maka already emits `ThinkingDeltaEvent` / `ThinkingCompleteEvent`
   * from `@ai-sdk/anthropic` (events.ts:76-88) but the renderer drops
   * them on the floor — users with thinking models see nothing while
   * the model is reasoning. This map accumulates thinking text per
   * session so the chat surface can render the panel below the
   * existing streaming text.
   */
  const [thinkingBySession, setThinkingBySession] = useState<Record<string, string>>({});
  // PR-UI-C0 review fixup (@kenji msg 7885a347): per-session monotonic
  // truncated flag for the thinking buffer. Flipped to `true` when
  // `applyThinkingDelta` / `applyThinkingComplete` drops content
  // (per-delta cap or per-session total cap). Stays true until the
  // panel collapses via `clearStreaming(sessionId)` — same lifecycle
  // as `thinkingBySession[sessionId]`. The `<ReasoningPanel>` reads
  // it via the `truncated` prop to render the "已截断" pill.
  const [thinkingTruncatedBySession, setThinkingTruncatedBySession] = useState<Record<string, boolean>>({});
  // PR-UI-Cx (@kenji msg 94b0063d → fixup v2 msg 3c01e901):
  // `streamingTruncatedBySession` is now inlined into the combined
  // `streamingBySession[sessionId].truncated` slot above. See the
  // type definition near `useState<Record<string, AssistantStreamSlot>>`.
  // PR-MEMORY-VISIBILITY-INDICATOR-0: surface a small pill in the
  // chat header when xuan's MEMORY.md is being injected into the
  // agent's system prompt (PR-MEMORY-PROMPT-INJECT-0). Refreshed
  // when activeId changes (we re-fetch on every chat switch) and
  // whenever the Settings modal closes (the user may have toggled
  // the agentReadEnabled switch).
  const [memoryActive, setMemoryActive] = useState(false);
  const [liveToolsBySession, setLiveToolsBySession] = useState<Record<string, ToolActivityItem[]>>({});
  const [permissionBySession, setPermissionBySession] = useState<Record<string, PermissionRequestEvent | undefined>>({});
  const [sessionEventHealthBySessionState, setSessionEventHealthBySessionState] =
    useState<Record<string, SessionEventStreamSnapshot>>({});
  const sessionEventHealthBySessionRef = useRef<Record<string, SessionEventStreamSnapshot>>({});
  const sessionEventHealthBySession = sessionEventHealthBySessionState;
  function setSessionEventHealthBySession(
    updater: (current: Record<string, SessionEventStreamSnapshot>) => Record<string, SessionEventStreamSnapshot>,
  ): void {
    setSessionEventHealthBySessionState((current) => {
      const next = updater(current);
      sessionEventHealthBySessionRef.current = next;
      return next;
    });
  }
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultConnection, setDefaultConnection] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequestedSection, setSettingsRequestedSection] = useState<SettingsSection | undefined>(undefined);
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [density, setDensity] = useState<UiDensity>('comfortable');
  const [themePalette, setThemePalette] = useState<ThemePalette>('default');
  const [userLabel, setUserLabel] = useState<string>('');
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [planReminders, setPlanReminders] = useState<PlanReminder[]>([]);
  const [appInfo, setAppInfo] = useState<RendererAppInfo | null>(null);
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
  const composerRef = useRef<ComposerHandle>(null);
  const activeIdRef = useRef<string | undefined>(undefined);
  const activeStreamingSlot = activeId ? streamingBySession[activeId] : undefined;
  const activeStreaming = activeStreamingSlot?.text ?? '';
  const activeStreamingTruncated = activeStreamingSlot?.truncated === true;
  const activeThinking = activeId ? thinkingBySession[activeId] ?? '' : '';
  const activeThinkingTruncated = activeId ? thinkingTruncatedBySession[activeId] === true : false;
  // Set of session ids with a live streaming delta — drives the sidebar
  // pulse indicator. Recomputed on every streamingBySession change; cheap
  // since the underlying map only has at most a handful of entries.
  const streamingSessionIds = useMemo(
    () => new Set(Object.entries(streamingBySession).flatMap(([id, slot]) => (slot.text ? [id] : []))),
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
  const sessionStatusGroups = useMemo(
    () => deriveSessionStatusGroups(sessions, { pinFirst: true }),
    [sessions],
  );
  const liveTools = useMemo(() => (activeId ? liveToolsBySession[activeId] ?? [] : []), [activeId, liveToolsBySession]);
  const activeSessionEventHealth = activeId ? sessionEventHealthBySession[activeId] : undefined;
  // PR-DAILY-REVIEW-MVP-0: bridge for the main Daily Review module.
  // Memoized so the panel's `useEffect` cleanup keys
  // off a stable reference instead of refetching on every render.
  const dailyReviewBridge = useMemo(
    () => ({
      async fetchDay(offsetDays: number, daySpan?: number) {
        const result = await window.maka.dailyReview.day(offsetDays, daySpan);
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
    }),
    [],
  );
  const activePermission = activeId ? permissionBySession[activeId] : undefined;
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeConnection = activeSession
    ? connections.find((connection) => connection.slug === activeSession.llmConnectionSlug)
    : undefined;
  const activeConnectionLabel = activeSession?.backend === 'fake'
    ? '本地模拟连接'
    : activeConnection?.name ?? activeSession?.llmConnectionSlug;
  const activeModelLabel = activeSession?.backend === 'fake'
    ? undefined
    : activeSession?.model ?? activeConnection?.defaultModel;

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

  // PR109e: per-turn auxiliary view-model. Combines:
  //  - footer actions (PR109d) — status + lineage + pending
  //  - failed reason label (PR109e-d) — errorClass → Chinese via
  //    describeTurnErrorClass, NEVER exposes raw enum
  //  - lineage badges (PR109e-e) — forward "重试自 turn X" on the new
  //    turn + reverse "已重试 → turn Y" on the origin, derived from
  //    deriveTurnLineageMap (which already exists in @maka/ui).
  const {
    turnFooterActionsByTurn,
    turnFailedReasonLabels,
    turnFailedRecoveryLabels,
    turnLineageBadgesByTurn,
  } = useMemo(() => {
    const turnsForLineage = materializeTurns(messages, liveTools);
    const lineage = deriveTurnLineageMap(turnsForLineage);
    const turnsById = new Map(turnsForLineage.map((t) => [t.turnId, t]));
    const shortId = (turnId: string) => turnId.slice(0, 6);
    const footer: Record<string, ReadonlyArray<TurnFooterActionMeta>> = {};
    const failedLabels: Record<string, string> = {};
    const failedRecoveryLabels: Record<string, string> = {};
    const badges: Record<string, TurnLineageBadge[]> = {};
    for (const turn of turnsForLineage) {
      const lineageEntry = lineage.get(turn.turnId);
      const pendingForTurn = new Set<TurnFooterActionMeta['id']>();
      for (const id of ['retry', 'regenerate', 'branch', 'copy'] as const) {
        if (activeId && pendingTurnActions.has(pendingKeyOf(activeId, turn.turnId, id))) {
          pendingForTurn.add(id);
        }
      }
      footer[turn.turnId] = deriveTurnFooterActions({
        status: turn.status,
        hasContent: Boolean(turn.assistant?.text && turn.assistant.text.trim().length > 0),
        ...(lineageEntry?.retriedToTurnId ? { alreadyRetried: true } : {}),
        ...(lineageEntry?.regeneratedToTurnId ? { alreadyRegenerated: true } : {}),
        ...(pendingForTurn.size > 0 ? { pendingActions: pendingForTurn } : {}),
      });
      if (turn.status === 'failed') {
        failedLabels[turn.turnId] = describeTurnErrorClass(turn.errorClass);
        failedRecoveryLabels[turn.turnId] = deriveFailedTurnRecovery({
          errorClass: turn.errorClass,
          partialOutputRetained: turn.partialOutputRetained,
          toolActivityCount: turn.tools.length,
          erroredToolCount: turn.tools.filter((tool) => tool.status === 'errored').length,
        }).label;
      }
      const turnBadges: TurnLineageBadge[] = [];
      // Forward badges — pointing back at the origin
      if (turn.retriedFromTurnId && turnsById.has(turn.retriedFromTurnId)) {
        turnBadges.push({
          id: `forward-retry-${turn.turnId}`,
          label: `重试自 turn ${shortId(turn.retriedFromTurnId)}`,
          tooltip: `这是对上一轮回答的重试`,
          targetTurnId: turn.retriedFromTurnId,
          direction: 'forward',
        });
      }
      if (turn.regeneratedFromTurnId && turnsById.has(turn.regeneratedFromTurnId)) {
        turnBadges.push({
          id: `forward-regen-${turn.turnId}`,
          label: `重新生成自 turn ${shortId(turn.regeneratedFromTurnId)}`,
          tooltip: `保留旧回答，重新生成的并行回答`,
          targetTurnId: turn.regeneratedFromTurnId,
          direction: 'forward',
        });
      }
      // Reverse badges — pointing at descendants (derived map)
      if (lineageEntry?.retriedToTurnId && turnsById.has(lineageEntry.retriedToTurnId)) {
        turnBadges.push({
          id: `reverse-retry-${turn.turnId}`,
          label: `已重试 → turn ${shortId(lineageEntry.retriedToTurnId)}`,
          tooltip: `跳转到对此回答的重试`,
          targetTurnId: lineageEntry.retriedToTurnId,
          direction: 'reverse',
        });
      }
      if (lineageEntry?.regeneratedToTurnId && turnsById.has(lineageEntry.regeneratedToTurnId)) {
        turnBadges.push({
          id: `reverse-regen-${turn.turnId}`,
          label: `已重新生成 → turn ${shortId(lineageEntry.regeneratedToTurnId)}`,
          tooltip: `跳转到对此回答的重新生成`,
          targetTurnId: lineageEntry.regeneratedToTurnId,
          direction: 'reverse',
        });
      }
      if (turnBadges.length > 0) badges[turn.turnId] = turnBadges;
    }
    return {
      turnFooterActionsByTurn: footer,
      turnFailedReasonLabels: failedLabels,
      turnFailedRecoveryLabels: failedRecoveryLabels,
      turnLineageBadgesByTurn: badges,
    };
  }, [activeId, messages, liveTools, pendingTurnActions]);

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

  async function handleTurnFooterAction(
    turnId: string,
    actionId: TurnFooterActionMeta['id'],
  ): Promise<void> {
    if (!activeId) return;
    if (actionId === 'copy') return; // handled in-component
    const sessionId = activeId;
    const key = pendingKeyOf(sessionId, turnId, actionId);
    // Ref-backed guard blocks same-frame double clicks before React has
    // committed the disabled state. State alone is too late here because
    // retry/regenerate IPC returns after starting the stream asynchronously.
    if (!addPendingTurnAction(key)) return;
    try {
      if (actionId === 'retry') {
        await window.maka.sessions.retryTurn(sessionId, { sourceTurnId: turnId });
        toastApi.info('已发起重试', '正在生成新的一轮回答');
      } else if (actionId === 'regenerate') {
        await window.maka.sessions.regenerateTurn(sessionId, { sourceTurnId: turnId });
        toastApi.info('已发起重新生成', '保留旧回答，生成新的并行回答');
      } else if (actionId === 'branch') {
        const newSession = await window.maka.sessions.branchFromTurn(sessionId, { sourceTurnId: turnId });
        await refreshSessions();
        setActiveId(newSession.id);
        clearPendingTurnAction(key);
        toastApi.success('已创建分支', `新会话 ${newSession.name}`);
      }
    } catch (error) {
      clearPendingTurnAction(key);
      toastApi.error('操作失败', cleanErrorMessage(error));
    }
  }

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
    setActiveId(parentSessionId);
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
    permissionMode: 'ask',
  } : undefined);
  const visibleSessions = useMemo(() => filterSessions(sessions, navSelection), [sessions, navSelection]);
  const sessionCounts = useMemo(() => countSessions(sessions), [sessions]);
  // PR110c: OnboardingState is now the single source of truth for
  // first-run UI. The renderer never re-derives provider readiness;
  // `useOnboardingSnapshot()` pulls the derived state from the main
  // process (PR110a + PR110b contract) and reactively invalidates on
  // `sessions:changed` + `connections:event`. The hero renders only
  // when sessions.length === 0; any session (including archived /
  // aborted) takes over with the existing chat surface.
  const onboarding = useOnboardingSnapshot();
  const [quickChatPending, setQuickChatPending] = useState(false);
  const onboardingState = onboarding.snapshot?.state;
  // PR110c (@kenji review): suppress hero AND the fallback EmptyChatHero
  // while the initial snapshot is in flight. Otherwise sessions.length===0
  // + snapshot===null flashes the prompt-suggestion EmptyChatHero before
  // the state-routed OnboardingHero mounts.
  const isOnboardingLoading = sessions.length === 0 && onboardingState === undefined;
  const showOnboardingHero =
    sessions.length === 0 && onboardingState !== undefined && onboardingState.kind !== 'ready_with_history';
  const [sessionListWidth, setSessionListWidth] = useState(() => readSessionListWidth());

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    void refreshSessions();
    void refreshConnections();
    void window.maka.app.info().then((next) => {
      setAppInfo({ projectPath: next.projectPath, projectGit: next.projectGit });
    }).catch(() => setAppInfo(null));
    // Pull the persisted theme preference (auto/light/dark) and apply it
    // before any first paint settles. If settings are unreadable we leave the
    // default `auto` which still produces a correct result.
    void window.maka.memory.getState().then((next) => {
      setMemoryActive(next.agentReadEnabled && next.status === 'ok' && next.content.trim().length > 0);
    }).catch(() => setMemoryActive(false));
    void window.maka.settings.get().then((next) => {
      const pref = next.appearance?.theme ?? 'auto';
      const den = next.appearance?.density ?? 'comfortable';
      const palette = next.appearance?.palette ?? 'default';
      const name = next.personalization?.displayName ?? '';
      // PR-LANG-PREF-0: apply persisted UI locale preference to
      // `<html data-maka-locale>` BEFORE first paint of any
      // locale-aware surface. `'auto'` clears the attribute so
      // `detectUiLocale()` falls through to `navigator.language`.
      const uiLocale = next.personalization?.uiLocale ?? 'auto';
      applyUiLocale(uiLocale);
      setThemePref(pref);
      setDensity(den);
      setThemePalette(palette);
      setUserLabel(name);
      applyTheme(pref);
      applyDensity(den);
      applyThemePalette(palette);
    });
    void refreshSkills();
    void refreshPlanReminders();
    void applyVisualSmokeFixture();
    const unsubscribeConnections = window.maka.connections.subscribeEvents(handleConnectionEvent);
    const unsubscribeSessionChanges = window.maka.sessions.subscribeChanges((event) => {
      void refreshSessions();
      if (event.sessionId) {
        setSessionEventHealthBySession((current) => {
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
        clearPendingTurnActionsForSession(event.sessionId);
      }
      if (event.reason === 'rebound') {
        const modelSuffix = event.modelId ? ` · ${event.modelId}` : '';
        toastApi.info('已切换到默认模型', `原会话使用的连接已不可用${modelSuffix}`);
      }
      if (event.reason === 'deleted' && event.sessionId === activeIdRef.current) {
        setActiveId(undefined);
        setMessages([]);
        setStreamingBySession((current) => {
          const next = { ...current };
          delete next[event.sessionId!];
          return next;
        });
        setLiveToolsBySession((current) => {
          const next = { ...current };
          delete next[event.sessionId!];
          return next;
        });
        setPermissionBySession((current) => {
          const next = { ...current };
          delete next[event.sessionId!];
          return next;
        });
        setSessionEventHealthBySession((current) => {
          const next = { ...current };
          delete next[event.sessionId!];
          return next;
        });
      }
    });
    const unsubscribeOpenSettings = window.maka.appWindow.subscribeOpenSettings(openSettings);
    const unsubscribePlanChanges = window.maka.plans.subscribeChanges(() => {
      void refreshPlanReminders();
    });
    const unsubscribePlanDue = window.maka.plans.subscribeDue((reminder) => {
      void refreshPlanReminders();
      toastApi.toast({
        title: '计划提醒',
        description: reminder.title,
        variant: 'info',
        duration: 8000,
        action: {
          label: '查看计划',
          onClick: () => setNavSelection({ section: 'automations' }),
        },
      });
    });
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        openSettings();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unsubscribeConnections();
      unsubscribeSessionChanges();
      unsubscribeOpenSettings();
      unsubscribePlanChanges();
      unsubscribePlanDue();
      for (const timeoutHandle of pendingTurnActionTimersRef.current.values()) {
        clearTimeout(timeoutHandle);
      }
      pendingTurnActionTimersRef.current.clear();
      pendingTurnActionsRef.current.clear();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Keep <html class="dark"> in sync with the active preference. The Settings
  // modal also calls applyTheme on local change so the effect is immediate,
  // but this keeps the listener for 'auto' alive at the app level.
  useEffect(() => {
    const unsubscribe = applyTheme(themePref);
    return unsubscribe;
  }, [themePref]);

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  // PR-THEME-APPLY-AND-DONE-POLISH-0 (WAWQAQ msg `dec85e5b`): re-apply the
  // palette data attribute whenever the persisted setting changes, so
  // switching themes in Settings is immediately visible. Previously the
  // attribute was only set once at mount, so a palette change required a
  // restart before the new colors took effect.
  useEffect(() => {
    applyThemePalette(themePalette);
  }, [themePalette]);

  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    const subscribedAt = Date.now();
    setSessionEventHealthBySession((current) => ({
      ...current,
      [activeId]: createSessionEventStreamSubscription({ sessionId: activeId, now: subscribedAt }),
    }));
    void window.maka.sessions.readMessages(activeId).then((next) => {
      if (!disposed) setMessages(next);
    });
    const unsubscribe = window.maka.sessions.subscribeEvents(activeId, (event) => {
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

  useEffect(() => {
    if (!activeId) return;
    const hasLiveActivity = activeStreaming.length > 0 || liveTools.length > 0 || Boolean(activePermission);
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
  }, [activeId, activeSession?.status, activeStreaming.length, liveTools.length, activePermission?.requestId]);

  useEffect(() => {
    localStorage.setItem('maka-chat-list-width-v1', String(sessionListWidth));
  }, [sessionListWidth]);

  // Persist sidebar nav selection so the app remembers what bucket the user
  // had open (Chats / Pinned / Archived / Skills) across restarts. Strict
  // localStorage availability check — Vite dev sometimes runs through a
  // worker where it isn't defined.
  useEffect(() => {
    try {
      localStorage.setItem('maka-nav-selection-v1', JSON.stringify(navSelection));
    } catch {
      /* localStorage unavailable */
    }
  }, [navSelection]);

  async function refreshSessions() {
    const next = await window.maka.sessions.list();
    setSessions(next);
    if (!activeId && next[0] && next[0].lastMessageAt) setActiveId(next[0].id);
  }

  async function applyVisualSmokeFixture() {
    const state = await window.maka.visualSmoke.getState();
    if (!state) return;
    if (state.now) {
      // Fixture-only clock freeze: screenshot baselines should not drift
      // because relative timestamps or fetched-at labels crossed a minute
      // boundary between two runs. Real users never receive a visual
      // smoke state, so their Date API remains untouched.
      Date.now = () => state.now!;
    }
    document.documentElement.setAttribute('data-maka-visual-smoke', 'true');
    if (state.streamingBySession) {
      // PR-UI-Cx fixup v2: `VisualSmokeState.streamingBySession` is a
      // `Record<string, string>` (fixture-side contract; can stay
      // simple since fixtures are pre-canned safe text). Map each
      // entry into the combined `AssistantStreamSlot` shape on
      // hydration. `truncated: false` because fixture text is
      // explicitly authored and never exceeds caps.
      const seed = state.streamingBySession;
      setStreamingBySession((current) => {
        const next = { ...current };
        for (const [sid, text] of Object.entries(seed)) {
          next[sid] = { text, truncated: false };
        }
        return next;
      });
    }
    if (state.thinkingBySession) {
      // PR-UI-LAYOUT-42: mirror streamingBySession init pattern so
      // visual smoke fixtures can seed the ReasoningPanel mid-stream
      // and capture a deterministic screenshot of the live state.
      setThinkingBySession((current) => ({ ...current, ...state.thinkingBySession }));
    }
    if (state.permissionBySession) {
      setPermissionBySession((current) => ({ ...current, ...state.permissionBySession }));
    }
    if (state.liveToolsBySession) {
      setLiveToolsBySession((current) => ({ ...current, ...state.liveToolsBySession }));
    }
    // PR-IR-01b: theme override applied BEFORE the persisted user pref so
    // the screenshot variant matches `<theme>-<viewport>-<motion>.png`
    // exactly. `applyTheme` writes both the React state + the `.dark` class
    // on the html element. Real users never hit this branch because
    // `state` is null without `MAKA_VISUAL_SMOKE_FIXTURE`.
    if (state.theme) {
      applyTheme(state.theme);
      setThemePref(state.theme);
    }
    // PR-IR-04: apply reduced-motion attribute when the fixture asks for it.
    // The matching CSS rule in styles.css collapses all animations to
    // ~0.01ms so the screenshot pipeline can capture a reduced-motion
    // variant without depending on the host OS accessibility setting.
    // Real users never reach this code path (visualSmoke.getState returns
    // null without MAKA_VISUAL_SMOKE_FIXTURE).
    if (state.reducedMotion) {
      document.documentElement.setAttribute('data-maka-reduced-motion', 'true');
    }
    // PR-UI-VISUAL-SMOKE-LOCALE: lock the UI locale BEFORE
    // `refreshSessions()` resolves and BEFORE any locale-dependent
    // content (EmptyChatHero / Composer / OnboardingHero quickChat)
    // enters the React tree — all of those gate on sessions /
    // connection state which load inside this same effect. The
    // attribute is attached to `<html>` so `detectUiLocale()` reads
    // the deterministic value on every subsequent render. The
    // AppShell initial mount already ran when this effect fires,
    // but that initial mount renders no locale-aware copy yet
    // (it's a loading shell), so there's no observable host-locale
    // leak in the captured baseline. See @kenji review
    // @msg 7b96e182.
    if (state.locale) {
      document.documentElement.setAttribute('data-maka-visual-smoke-locale', state.locale);
    }
    // PR-UI-VISUAL-SMOKE-TIMEZONE (@kenji msg 45486cdf): mirror the
    // locale attribute pattern. When `MAKA_VISUAL_SMOKE_TIMEZONE` is
    // set and validates against `Intl.DateTimeFormat`, the IANA name
    // lands on `<html>` so any date / time formatting helper can
    // opt in by reading `document.documentElement.dataset.makaVisualSmokeTz`.
    // The attribute alone is the contract; per-call timezone
    // consumption is up to individual formatters as they migrate.
    if (state.timezone) {
      document.documentElement.setAttribute('data-maka-visual-smoke-tz', state.timezone);
    }
    await refreshSessions();
    if (state.activeSessionId) {
      setActiveId(state.activeSessionId);
    }
    if (state.openSettingsSection) {
      openSettingsSection(state.openSettingsSection);
    }
    // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2): when
    // the fixture sets `searchModalOpen`, auto-open the sidebar
    // Search modal so the screenshot pipeline captures the modal
    // shell deterministically. Real users never reach this branch
    // (visualSmoke.getState returns null without MAKA_VISUAL_SMOKE_FIXTURE).
    if (state.searchModalOpen) {
      setSearchModalOpen(true);
    }
    if (state.sidebarSection === 'automations') {
      setNavSelection({ section: 'automations' });
    } else if (state.sidebarSection === 'skills') {
      setNavSelection({ section: 'skills' });
    } else if (state.sidebarSection === 'daily-review') {
      setNavSelection({ section: 'daily-review' });
    } else if (state.sidebarSection === 'sessions') {
      setNavSelection({ section: 'sessions', filter: 'chats' });
    }
    // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
    // kenji `b3d156e9`): when the fixture sets `focusActiveRow`,
    // focus the active row's button after the next paint so the
    // row's `:focus-within` triggers and the `.maka-list-row-actions`
    // overlay becomes visible. The auto-capture then shows the
    // actions cluster against the slim row, proving the time meta
    // + unread dot are hidden underneath (no overlap with the
    // action icons — the bug WAWQAQ flagged). Two RAFs let React
    // commit the active selection before we query the DOM.
    if (state.focusActiveRow) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const activeRowButton = document.querySelector<HTMLButtonElement>(
            '.maka-list-row[data-active="true"] .maka-list-row-main',
          );
          activeRowButton?.focus({ preventScroll: true });
        });
      });
    }
    // PR-IR-01: when MAKA_VISUAL_SMOKE_AUTO_CAPTURE is set, snap a
    // screenshot once the fixture has settled and the renderer has
    // committed. We wait two RAFs + a small idle delay so async layout
    // (Settings modal mount, sidebar group rendering, etc.) finishes
    // before the capture lands. The driver script reads the stdout
    // marker emitted from main and kills the subprocess after.
    if (state.autoCaptureVariant) {
      const variant = state.autoCaptureVariant;
      // Two RAFs + 400ms idle is the same pattern Chromium uses for
      // settled layout in DevTools "Capture full size screenshot" —
      // gives @starting-style + fonts + late-stream IPC time to flush.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(async () => {
            // Keep screenshot baselines free of focus rings / caret blink.
            // Interaction-specific focus behavior is covered by node tests
            // and manual smoke paths; auto-capture should measure layout.
            //
            // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 exception (WAWQAQ
            // msg `5dd1c348`): when the fixture asks for a focused
            // active row (e.g. the `sidebar-row-actions-visible`
            // scenario, which proves the action overlay doesn't
            // overlap the time meta), the blur step would defeat the
            // whole point of the capture. Skip the blur in that
            // narrow case; other captures still get a clean (focusless)
            // baseline.
            if (!state.focusActiveRow && document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
            if ('fonts' in document) {
              await document.fonts.ready;
            }
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                void window.maka.visualSmoke.capture({ scenario: state.scenario, variant });
              });
            });
          }, 400);
        });
      });
    }
  }

  // Hover-action callbacks for SessionListPanel. Each one calls the
  // corresponding IPC and then refreshes the session list so the sidebar
  // reflects the new state immediately.
  async function flagSession(sessionId: string, flagged: boolean) {
    await window.maka.sessions.setFlagged(sessionId, flagged);
    await refreshSessions();
  }
  async function archiveSession(sessionId: string) {
    await window.maka.sessions.archive(sessionId);
    if (activeId === sessionId) setActiveId(undefined);
    await refreshSessions();
  }
  async function unarchiveSession(sessionId: string) {
    await window.maka.sessions.unarchive(sessionId);
    await refreshSessions();
  }
  async function renameSession(sessionId: string, name: string) {
    await window.maka.sessions.rename(sessionId, name);
    await refreshSessions();
  }
  async function setPermissionMode(mode: PermissionMode) {
    if (!activeId) return;
    const current = sessions.find((session) => session.id === activeId);
    if (!current || current.permissionMode === mode) return;
    try {
      const next = await window.maka.sessions.setPermissionMode(activeId, mode);
      // Patch the session in-place so the chat header reflects the new mode
      // immediately without waiting for a full list refresh.
      setSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
      const labels: Record<PermissionMode, string> = {
        explore: '只读模式',
        ask: '确认模式',
        execute: '执行模式',
      };
      toastApi.success(`已切到 ${labels[mode]}`, modeDescriptions[mode]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toastApi.error('切换权限模式失败', message);
    }
  }

  async function deleteSession(sessionId: string) {
    const session = sessions.find((entry) => entry.id === sessionId);
    const name = session?.name ?? 'this chat';
    const ok = await toastApi.confirm({
      title: `删除 "${name}"`,
      description: '会话和全部消息会从磁盘上永久移除。该操作不可撤销。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    await window.maka.sessions.remove(sessionId);
    if (activeId === sessionId) setActiveId(undefined);
    await refreshSessions();
    toastApi.success(`已删除 ${name}`);
  }

  async function refreshConnections() {
    const [next, nextDefault] = await Promise.all([
      window.maka.connections.list(),
      window.maka.connections.getDefault(),
    ]);
    setConnections(next);
    setDefaultConnection(nextDefault);
  }

  async function refreshPlanReminders() {
    try {
      const next = await window.maka.plans.list();
      setPlanReminders(next);
    } catch {
      setPlanReminders([]);
    }
  }

  async function createPlanReminder(input: { title: string; note?: string; runAt: number; recurrence?: PlanReminderRecurrence; cronExpression?: string; delivery?: PlanReminderDeliveryTarget }) {
    try {
      await window.maka.plans.create(input);
      await refreshPlanReminders();
      toastApi.success('已创建计划提醒', input.title);
    } catch (error) {
      toastApi.error('创建计划失败', cleanErrorMessage(error));
    }
  }

  async function updatePlanReminder(id: string, patch: { title?: string; note?: string; runAt?: number; recurrence?: PlanReminderRecurrence; cronExpression?: string; delivery?: PlanReminderDeliveryTarget; enabled?: boolean }) {
    try {
      await window.maka.plans.update(id, patch);
      await refreshPlanReminders();
      toastApi.success('已保存计划提醒', patch.title);
    } catch (error) {
      toastApi.error('保存计划失败', cleanErrorMessage(error));
    }
  }

  async function togglePlanReminder(id: string, enabled: boolean) {
    try {
      await window.maka.plans.setEnabled(id, enabled);
      await refreshPlanReminders();
      toastApi.success(enabled ? '已启用提醒' : '已暂停提醒');
    } catch (error) {
      toastApi.error('更新计划失败', cleanErrorMessage(error));
    }
  }

  async function triggerPlanReminderNow(id: string) {
    const reminder = planReminders.find((entry) => entry.id === id);
    try {
      await window.maka.plans.triggerNow(id);
      await refreshPlanReminders();
      toastApi.success('已触发计划提醒', reminder?.title);
    } catch (error) {
      toastApi.error('触发计划失败', cleanErrorMessage(error));
    }
  }

  async function snoozePlanReminder(id: string) {
    const reminder = planReminders.find((entry) => entry.id === id);
    try {
      await window.maka.plans.snooze(id);
      await refreshPlanReminders();
      toastApi.success('已延后 10 分钟', reminder?.title);
    } catch (error) {
      toastApi.error('延后计划失败', cleanErrorMessage(error));
    }
  }

  async function clearPlanReminderRunHistory(id: string) {
    const reminder = planReminders.find((entry) => entry.id === id);
    const ok = await toastApi.confirm({
      title: `清空 "${reminder?.title ?? '计划提醒'}" 的执行记录`,
      description: '计划本身会保留；只清空最近执行记录和最近状态。',
      confirmLabel: '清空记录',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    try {
      await window.maka.plans.clearRunHistory(id);
      await refreshPlanReminders();
      toastApi.success('已清空执行记录', reminder?.title);
    } catch (error) {
      toastApi.error('清空记录失败', cleanErrorMessage(error));
    }
  }

  async function deletePlanReminder(id: string) {
    const reminder = planReminders.find((entry) => entry.id === id);
    const ok = await toastApi.confirm({
      title: `删除 "${reminder?.title ?? '计划提醒'}"`,
      description: '该提醒和最近执行记录会被删除。该操作不可撤销。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    try {
      await window.maka.plans.delete(id);
      await refreshPlanReminders();
      toastApi.success('已删除计划提醒');
    } catch (error) {
      toastApi.error('删除计划失败', cleanErrorMessage(error));
    }
  }

  async function createSession() {
    setActiveId(undefined);
    setNavSelection({ section: 'sessions', filter: 'chats' });
    setMessages([]);
    setStreamingBySession({});
    setLiveToolsBySession({});
    setPermissionBySession({});
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

  // Open the workspace's skills/ directory in Finder via the IPC allowlist.
  // Earlier we silently dropped the structured failure result; surface it
  // so missing-skills-dir / open-failed don't look like the button did nothing.
  async function refreshSkills() {
    const next = await window.maka.skills.list().catch(() => []);
    setSkills(next);
  }

  async function createSkillTemplate() {
    const result = await window.maka.skills.createStarter();
    if (!result.ok) {
      toastApi.error('无法创建示例技能', createSkillFailureCopy(result.reason));
      return;
    }
    await refreshSkills();
    toastApi.success('已创建示例技能', `${result.skill.id}/SKILL.md 已放到工作区 skills 目录。`);
    const openResult = await window.maka.skills.open(result.skill.id, 'file');
    if (!openResult.ok) {
      toastApi.error('无法打开示例技能', openSkillFailureCopy(openResult.reason));
    }
  }

  async function openSkillsFolder() {
    const result = await window.maka.app.openPath('skills');
    if (!result.ok) {
      toastApi.error(`无法打开${openPathActionLabel('skills')}`, openPathFailureCopy(result.reason));
    }
  }

  async function openSkill(skillId: string) {
    const result = await window.maka.skills.open(skillId, 'file');
    if (!result.ok) {
      toastApi.error('无法打开 Skill', openSkillFailureCopy(result.reason));
    }
  }

  async function openProjectFolder() {
    const result = await window.maka.app.openPath('project');
    if (!result.ok) {
      toastApi.error(`无法打开${openPathActionLabel('project')}`, openPathFailureCopy(result.reason));
    }
  }

  function createSkillFailureCopy(reason: 'blocked_path' | 'already_exists' | 'write_failed'): string {
    if (reason === 'blocked_path') return 'skills 目录不是普通工作区目录，已阻止写入。';
    if (reason === 'already_exists') return '示例技能编号已占满，请先整理 skills 目录。';
    return '写入 skills 目录失败，请检查工作区权限。';
  }

  function openSkillFailureCopy(
    reason: 'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' | 'open_failed',
  ): string {
    if (reason === 'invalid_id') return 'Skill 名称不在允许范围内。';
    if (reason === 'missing') return '没有找到对应的 SKILL.md。';
    if (reason === 'blocked_path') return 'Skill 路径不在工作区 skills 目录内，已阻止打开。';
    if (reason === 'not_file') return '目标不是一个可打开的 SKILL.md 文件。';
    if (reason === 'not_directory') return '目标不是一个可打开的目录。';
    return '系统打开文件失败。';
  }

  async function send(text: string): Promise<boolean> {
    try {
      if (!activeId) {
        const session = await window.maka.sessions.create({
          permissionMode: 'ask',
          name: text.slice(0, 42) || '新建对话',
        });
        setActiveId(session.id);
        await refreshSessions();
        await window.maka.sessions.send(session.id, { type: 'send', turnId: crypto.randomUUID(), text });
        return true;
      }
      await window.maka.sessions.send(activeId, { type: 'send', turnId: crypto.randomUUID(), text });
      await refreshMessages(activeId);
      return true;
    } catch (error) {
      if (isNoRealConnectionError(error)) {
        showModelSetupToast(cleanErrorMessage(error), noRealConnectionReasonFromError(error));
      } else {
        toastApi.error('发送失败', cleanErrorMessage(error));
      }
      return false;
    }
  }

  async function importTextFilePrompt(): Promise<string | undefined> {
    const result = await window.maka.context.importTextFile();
    if (!result.ok) {
      if (result.reason !== 'cancelled') toastApi.error('导入文本失败', result.message);
      return undefined;
    }
    toastApi.success('已导入文本文件', `${result.name}${result.truncated ? ' · 已截断' : ''}`);
    return result.prompt;
  }

  async function importTextFileIntoComposer() {
    const prompt = await importTextFilePrompt();
    if (!prompt) return;
    composerRef.current?.appendText(prompt);
  }

  function droppedTextFilePreflightFailureCopy(reason: TextFileImportPreflightFailureReason): string {
    switch (reason) {
      case 'missing':
        return '没有可导入的文本文件。';
      case 'too-large':
        return '文件过大；请先截取需要讨论的部分。';
      case 'too-many-files':
        return '一次最多导入 5 个文本文件。';
      case 'unsupported-type':
        return '只支持直接导入文本文件；Office 文档请用 Office 文档工具或对应技能处理。';
    }
  }

  async function buildDroppedTextFilePreflightInputs(files: File[]) {
    return Promise.all(files.map(async (file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
      sampleBytes: new Uint8Array(await file.slice(0, MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES).arrayBuffer()),
    })));
  }

  async function importDroppedTextFilesPrompt(files: File[]): Promise<string | undefined> {
    if (files.length === 0) return;
    try {
      const preflightInputs = await buildDroppedTextFilePreflightInputs(files);
      const preflight = preflightDroppedTextFilesForPromptImport(preflightInputs);
      if (!preflight.ok) {
        toastApi.error('导入文本失败', droppedTextFilePreflightFailureCopy(preflight.reason));
        return undefined;
      }
      const payloads = await Promise.all(files.map(async (file) => ({
        name: file.name,
        size: file.size,
        type: file.type,
        text: await file.text(),
      })));
      const result = await window.maka.context.importDroppedTextFiles(payloads);
      if (!result.ok) {
        toastApi.error('导入文本失败', result.message);
        return undefined;
      }
      toastApi.success('已导入文本文件', `${result.name}${result.truncated ? ' · 已截断' : ''}`);
      return result.prompt;
    } catch (error) {
      toastApi.error('导入文本失败', cleanErrorMessage(error));
      return undefined;
    }
  }

  async function importDroppedTextFilesIntoComposer(files: File[]) {
    const prompt = await importDroppedTextFilesPrompt(files);
    if (!prompt) return;
    composerRef.current?.appendText(prompt);
  }

  async function importFolderOutlinePrompt(): Promise<string | undefined> {
    const result = await window.maka.context.importFolderOutline();
    if (!result.ok) {
      if (result.reason !== 'cancelled') toastApi.error('导入目录失败', result.message);
      return undefined;
    }
    toastApi.success('已导入文件夹目录', `${result.name} · ${result.entries} 项${result.truncated ? ' · 已截断' : ''}`);
    return result.prompt;
  }

  async function importFolderOutlineIntoComposer() {
    const prompt = await importFolderOutlinePrompt();
    if (!prompt) return;
    composerRef.current?.appendText(prompt);
  }

  async function stop() {
    if (activeId) await window.maka.sessions.stop(activeId, { source: 'stop_button' });
  }

  async function respondToPermission(response: PermissionResponse) {
    if (!activeId) return;
    await window.maka.sessions.respondToPermission(activeId, response);
  }

  async function refreshMessages(sessionId: string) {
    const next = await window.maka.sessions.readMessages(sessionId);
    if (activeIdRef.current === sessionId) {
      setMessages(next);
    }
  }

  function clearStreaming(sessionId: string) {
    // PR-UI-Cx fixup v2 (@kenji msg 3c01e901 Blocker 2): the
    // combined-state shape means clearing the streaming buffer +
    // truncated flag is ONE functional update on `streamingBySession`,
    // not two separate setStates that could observably race.
    setStreamingBySession((current) => {
      const prev = current[sessionId];
      if (!prev || (prev.text === '' && prev.truncated === false)) return current;
      return { ...current, [sessionId]: { text: '', truncated: false } };
    });
    // PR-UI-LAYOUT-42: thinking is part of the same streaming turn —
    // any clearStreaming caller (abort / error / complete) means the
    // turn is done, so the Reasoning panel should also collapse.
    setThinkingBySession((current) => ({ ...current, [sessionId]: '' }));
    // PR-UI-C0 review fixup: also clear the truncated flag so the
    // "已截断" pill doesn't stick around after the panel collapses.
    // Next turn's thinking starts with a fresh `false` flag and the
    // helper will re-set it if caps fire again.
    setThinkingTruncatedBySession((current) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function handleEvent(sessionId: string, event: SessionEvent) {
    switch (event.type) {
      case 'text_delta': {
        // PR-UI-Cx (@kenji msg 94b0063d / cd09bcac / fixup v2 3c01e901):
        // assistant `text_delta` chokepoint. The pure
        // `applyAssistantDelta` helper from `@maka/ui/assistant-stream`
        // is the single trust-boundary point for:
        //   1. per-delta `redactSecrets` BEFORE state,
        //   2. per-delta cap (tail-keep single misbehaving multi-MB
        //      delta with a marker),
        //   3. CROSS-DELTA `redactSecrets` on the freshly-appended
        //      candidate — catches secrets that span delta seams
        //      (e.g. `"Authorization: Bearer sk-"` + `"abcdef..."`).
        //   4. per-session total cap (head-keep + trailing marker —
        //      assistant text is read top-down).
        //
        // raw `event.text` only flows through the helper input; it
        // never enters state un-redacted or un-capped.
        //
        // Combined state shape (fixup v2): a single
        // `AssistantStreamSlot = { text, truncated }` lets us
        // produce both fields from one functional updater without
        // cross-mutating outer locals or chaining setStates. The
        // `truncated` flag is monotonic per-session — once true,
        // stays true until `clearStreaming`.
        setStreamingBySession((current) => {
          const prevSlot = current[sessionId];
          const prevText = prevSlot?.text ?? '';
          const applied = applyAssistantDelta(prevText, event.text);
          const nextTruncated = (prevSlot?.truncated ?? false) || applied.truncated;
          // Avoid a re-render when nothing materially changed (e.g.
          // a non-string `event.text` defensively dropped by the
          // helper, no truncated change).
          if (
            prevSlot !== undefined &&
            prevSlot.text === applied.text &&
            prevSlot.truncated === nextTruncated
          ) {
            return current;
          }
          return {
            ...current,
            [sessionId]: { text: applied.text, truncated: nextTruncated },
          };
        });
        break;
      }
      case 'text_complete':
        clearStreaming(sessionId);
        void refreshMessages(sessionId);
        break;
      case 'thinking_delta':
        // PR-UI-LAYOUT-42 / C0 review fixup (@kenji msg 7885a347):
        // Anthropic extended-thinking stream. The pure
        // `applyThinkingDelta` helper from `@maka/ui/thinking-stream`
        // is the single chokepoint for:
        //   1. secondary `redactSecrets` BEFORE state (thinking can
        //      echo prompts / env / tool stderr / pasted credentials;
        //      raw text must not enter React state),
        //   2. per-delta cap (tail-keep a single misbehaving multi-MB
        //      delta with a truncation marker),
        //   3. per-session total cap (tail-keep most recent reasoning
        //      so the user sees the current chain of thought, not the
        //      start of an old run).
        // The renderer also tracks a per-session monotonic
        // `outputTruncated`-style flag so the `ReasoningPanel` header
        // can show a "已截断" pill.
        setThinkingBySession((current) => {
          const prev = current[sessionId] ?? '';
          const applied = applyThinkingDelta(prev, event.text);
          if (applied.truncated) {
            setThinkingTruncatedBySession((flags) =>
              flags[sessionId] ? flags : { ...flags, [sessionId]: true },
            );
          }
          return { ...current, [sessionId]: applied.text };
        });
        break;
      case 'thinking_complete':
        // PR-UI-LAYOUT-42 / C0 review fixup: final thinking block —
        // ProviderEvent's `text` is the FULL final reasoning string,
        // so we replace rather than append (still through the
        // redaction + cap chokepoint via `applyThinkingComplete`).
        // Keep visible until `text_complete` collapses the panel via
        // `clearStreaming`; this avoids the flicker between "thinking
        // done" and "answer streaming".
        setThinkingBySession((current) => {
          const applied = applyThinkingComplete(event.text);
          // PR-UI-C0 review nit #1 (@kenji msg 68ca6bc7): `complete`
          // is the replace path — the final payload is the source of
          // truth. If earlier deltas triggered the cap but the final
          // complete fits clean, the `已截断` pill should reset to
          // match reality, not remain monotonically true. Overwrite
          // the per-session truncated flag with `applied.truncated`.
          setThinkingTruncatedBySession((flags) => {
            if ((flags[sessionId] === true) === applied.truncated) return flags;
            if (applied.truncated) {
              return { ...flags, [sessionId]: true };
            }
            const next = { ...flags };
            delete next[sessionId];
            return next;
          });
          return { ...current, [sessionId]: applied.text };
        });
        break;
      case 'tool_start':
        upsertTool(sessionId, event.toolUseId, {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          displayName: event.displayName,
          intent: event.intent,
          status: 'pending',
          args: event.args,
        });
        break;
      case 'tool_output_delta':
        // PR-UI-12 (@yuejing 2026-05-22): consume PR-REAL-4 typed
        // streaming. We dedupe by `seq` (per-toolCallId monotonic from
        // runtime) and insert in sorted order, so out-of-order delivery
        // or `tool_result`-vs-delta races repair without flicker.
        // Runtime already redacts secrets at chunk granularity; the
        // renderer still runs a secondary redaction/cap pass inside
        // `appendToolOutputChunk` before text reaches React state.
        appendToolOutputChunk(sessionId, event.toolUseId, {
          seq: event.seq,
          stream: event.stream,
          text: event.chunk,
          redacted: event.redacted,
          createdAt: event.createdAt,
        });
        break;
      case 'permission_request':
        setPermissionBySession((current) => ({ ...current, [sessionId]: event }));
        upsertTool(sessionId, event.toolUseId, {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          status: 'waiting_permission',
          args: event.args,
        });
        break;
      case 'permission_decision_ack':
        setPermissionBySession((current) => {
          const active = current[sessionId];
          if (!active || active.requestId !== event.requestId) return current;
          return { ...current, [sessionId]: undefined };
        });
        upsertTool(sessionId, event.toolUseId, {
          toolUseId: event.toolUseId,
          status: event.decision === 'allow' ? 'running' : 'errored',
        });
        break;
      case 'tool_result':
        upsertTool(sessionId, event.toolUseId, {
          toolUseId: event.toolUseId,
          status: event.isError ? 'errored' : 'completed',
          result: event.content,
          durationMs: event.durationMs,
        });
        void refreshMessages(sessionId);
        break;
      case 'error':
        clearStreaming(sessionId);
        setPermissionBySession((current) => ({ ...current, [sessionId]: undefined }));
        if (isNoRealConnectionEvent(event)) {
          showModelSetupToast(cleanEventMessage(event.message), noRealConnectionReasonFromEvent(event));
        } else {
          toastApi.error('对话出错', event.message);
        }
        markInFlightToolsInterrupted(sessionId);
        void refreshSessions();
        void refreshMessages(sessionId);
        break;
      case 'abort':
        clearStreaming(sessionId);
        setPermissionBySession((current) => ({ ...current, [sessionId]: undefined }));
        markInFlightToolsInterrupted(sessionId);
        void refreshSessions();
        void refreshMessages(sessionId);
        break;
      case 'complete':
        if (event.stopReason !== 'permission_handoff') {
          clearStreaming(sessionId);
        }
        void refreshSessions();
        void refreshMessages(sessionId);
        break;
      default:
        break;
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
    try {
      localStorage.setItem('maka-settings-section-v1', section);
    } catch {
      /* localStorage unavailable; fall back to whatever section the modal picks */
    }
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
    void window.maka.memory.getState().then((next) => {
      setMemoryActive(
        next.agentReadEnabled
        && next.status === 'ok'
        && next.content.trim().length > 0,
      );
    }).catch(() => setMemoryActive(false));
  }

  /**
   * PR110c: Quick Chat handler. Wires the OnboardingHero's
   * `ready_empty` composer to the `quickChat:start` IPC.
   *
   * The discriminated-union result is handled here so the hero stays
   * presentational:
   *   - `{ ok: true; sessionId }` → setActiveId. The OnboardingHero
   *     unmounts automatically as soon as sessions.length > 0
   *     (which fires after the refresh).
   *   - `{ ok: false; reason: 'setup_required' }` → the onboarding
   *     snapshot will be invalidated by the subsequent sessions/
   *     connections event, but call `refresh()` defensively so the
   *     hero re-routes immediately in race scenarios.
   *   - `{ ok: false; reason: 'send_failed' }` → surface the
   *     generalized Chinese message via toast. The session may have
   *     been created already, so we also call `refreshSessions()`.
   */
  async function handleQuickChatSubmit(prompt: string, mode?: QuickChatMode): Promise<void> {
    if (quickChatPending) return;
    setQuickChatPending(true);
    try {
      const result = await window.maka.quickChat.start({ prompt, mode });
      if (result.ok) {
        await refreshSessions();
        setActiveId(result.sessionId);
        // If the prompt was non-empty, the main process has already
        // started the send via the existing send path. If empty, we
        // just opened a fresh session; focus the composer so the
        // user can type without an extra click.
        if (!prompt.trim()) {
          composerRef.current?.focus();
        }
      } else if (result.reason === 'setup_required') {
        // Defensive re-pull; the upstream events should cover this.
        onboarding.refresh();
      } else {
        // send_failed — main already generalized the message.
        await refreshSessions();
        toastApi.error('开始对话失败', result.message);
      }
    } catch (error) {
      toastApi.error('开始对话失败', cleanErrorMessage(error));
    } finally {
      setQuickChatPending(false);
    }
  }

  async function dismissFirstRunTaskSuggestion(id: FirstRunTaskSuggestionId): Promise<void> {
    try {
      await window.maka.onboarding.setMilestone(FIRST_RUN_TASK_SUGGESTION_MILESTONES[id], 'skipped');
      onboarding.refresh();
    } catch (error) {
      toastApi.error('隐藏建议失败', cleanErrorMessage(error));
    }
  }

  async function restoreFirstRunTaskSuggestions(ids: ReadonlyArray<FirstRunTaskSuggestionId>): Promise<void> {
    try {
      for (const id of ids) {
        await window.maka.onboarding.clearMilestone(FIRST_RUN_TASK_SUGGESTION_MILESTONES[id]);
      }
      onboarding.refresh();
    } catch (error) {
      toastApi.error('恢复建议失败', cleanErrorMessage(error));
    }
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
        onClick: openSettings,
      },
    });
    openSettings();
  }

  function upsertTool(sessionId: string, toolUseId: string, patch: Partial<ToolActivityItem> & { toolUseId: string }) {
    setLiveToolsBySession((current) => {
      const list = current[sessionId] ?? [];
      const index = list.findIndex((item) => item.toolUseId === toolUseId);
      const base: ToolActivityItem =
        index >= 0
          ? list[index]!
          : {
              toolUseId,
              toolName: patch.toolName ?? 'Tool',
              status: 'pending',
              args: patch.args,
            };
      // PR-UI-12 fixup (@xuan review): never let `tool_start` arriving
      // AFTER an in-flight `tool_output_delta` regress a `running` item
      // back to `pending`. The delta itself already proved the tool is
      // live; the status dot must not lie. Keep `base.status` whenever
      // the incoming patch wants `pending` but we have output or are
      // already in a later state.
      const wantsPending = patch.status === 'pending';
      const hasOutput = (base.outputChunks?.length ?? 0) > 0;
      const isLaterStatus =
        base.status === 'running'
        || base.status === 'waiting_permission'
        || base.status === 'completed'
        || base.status === 'errored'
        || base.status === 'interrupted';
      const nextStatus = wantsPending && (hasOutput || isLaterStatus)
        ? base.status
        : patch.status ?? base.status;
      const nextItem: ToolActivityItem = { ...base, ...patch, status: nextStatus };
      const nextList = index >= 0 ? list.map((item, itemIndex) => (itemIndex === index ? nextItem : item)) : [...list, nextItem];
      return { ...current, [sessionId]: nextList };
    });
  }

  /**
   * PR-UI-12 fixup (@xuan post-signoff cleanup): shared helper for the
   * abort + error event paths. A turn-ending event leaves any tool
   * that was `pending` / `running` / `waiting_permission` orphaned
   * because the runtime won't emit a per-tool terminal `tool_result`
   * for it. Flip those tools to `interrupted` so the `ToolOutputStream`
   * header reads "已中断 · 已收到的输出", the live pulse stops, and
   * the `materializeTurns` merge `{...persisted, ...live}` doesn't
   * mask the persisted `interrupted` status with stale live state.
   *
   * Tools that already reached terminal (`completed` / `errored` /
   * `interrupted`) are left alone. Tools without buffer are still
   * flipped — the user shouldn't see a forever-spinning status dot
   * just because the tool happened to produce no streamed output.
   */
  function markInFlightToolsInterrupted(sessionId: string) {
    setLiveToolsBySession((current) => {
      const list = current[sessionId];
      if (!list || list.length === 0) return current;
      let changed = false;
      const nextList = list.map((tool) => {
        const isInFlight =
          tool.status === 'pending'
          || tool.status === 'running'
          || tool.status === 'waiting_permission';
        if (!isInFlight) return tool;
        changed = true;
        return { ...tool, status: 'interrupted' as const };
      });
      return changed ? { ...current, [sessionId]: nextList } : current;
    });
  }

  /**
   * PR-UI-12 — append a streamed chunk to a tool's output buffer.
   *
   * Invariants enforced here, not relied on from the event source:
   *  - Dedup by `seq` (per-toolCallId monotonic from runtime). If a
   *    seq already exists, we drop the incoming chunk — important on
   *    sessionEvents replays or main-process reconnects.
   *  - Sorted insert by `seq`. The runtime emits in-order, but
   *    `tool_result` racing against the last delta could land here
   *    after a flush, and renderer reconnect could deliver fragments
   *    out of order. Always keep the array sorted so React renders
   *    stable visual order.
   *  - **Secondary redaction** (PR-UI-12 fixup #2, @kenji A3 msg
   *    365ff8b9): chunk text runs through `redactSecrets` BEFORE
   *    landing in React state. The renderer does not trust upstream
   *    redaction alone — raw secrets must not reach state /
   *    DevTools / clipboard / future serialization paths.
   *  - **Per-chunk + per-tool caps** (same fixup): single oversize
   *    chunk is tail-truncated; per-tool count + total-char caps
   *    drop oldest chunks. Defense in depth against a runaway tool
   *    flooding the renderer.
   *  - If the tool doesn't exist yet in `liveToolsBySession`, we
   *    create a minimal `pending` entry. This covers the rare race
   *    where `tool_output_delta` arrives before `tool_start` is
   *    flushed to the renderer; we'd rather show output than drop it.
   *
   * All of the above lives in the pure helper `applyToolOutputChunk`
   * (`@maka/ui/tool-output-stream`) so the redaction + cap logic is
   * unit-tested without a renderer. This function is just the React
   * state plumbing around it.
   */
  function appendToolOutputChunk(sessionId: string, toolUseId: string, chunk: ToolOutputChunk) {
    setLiveToolsBySession((current) => {
      const list = current[sessionId] ?? [];
      const index = list.findIndex((item) => item.toolUseId === toolUseId);
      const base: ToolActivityItem =
        index >= 0
          ? list[index]!
          : { toolUseId, toolName: 'Tool', status: 'running', args: undefined };
      // PR-UI-12 review fixup #2 (@kenji A3 msg 365ff8b9):
      // `applyToolOutputChunk` is the single chokepoint for
      // - dedupe-by-seq
      // - sorted insertion
      // - SECONDARY REDACTION via `redactSecrets` (never trust the
      //   upstream redactor alone; raw text must not enter React state)
      // - per-chunk size cap (tail-keep + truncation marker)
      // - per-tool count + total-char caps (drop oldest)
      // The pure helper lives in `@maka/ui/tool-output-stream` so the
      // logic is testable without a renderer.
      const applied = applyToolOutputChunk(base.outputChunks, chunk);
      // Dedupe short-circuit: helper returned the same `chunks` array
      // reference, meaning the seq was already present. Skip the
      // re-render entirely if the tool item already exists; the only
      // observable change would be re-asserting `outputTruncated`,
      // which is monotonic so no-op.
      if (index >= 0 && applied.chunks === (base.outputChunks ?? [])) {
        return current;
      }
      const nextItem: ToolActivityItem = {
        ...base,
        outputChunks: applied.chunks,
        // Once `truncated` flips true we stick — a later non-truncated
        // chunk shouldn't make the UI claim the stream is now complete.
        outputTruncated: base.outputTruncated || applied.truncated,
        // Promote `pending` → `running` once we see live output, so the
        // status dot doesn't lie about activity.
        status: base.status === 'pending' ? 'running' : base.status,
      };
      const nextList =
        index >= 0
          ? list.map((item, itemIndex) => (itemIndex === index ? nextItem : item))
          : [...list, nextItem];
      return { ...current, [sessionId]: nextList };
    });
  }

  function startColumnResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const start = sessionListWidth;
    document.body.classList.add('isResizingColumns');

    function onMove(moveEvent: globalThis.PointerEvent) {
      const delta = moveEvent.clientX - startX;
      setSessionListWidth(clamp(start + delta, 240, 420));
    }

    function onUp() {
      document.body.classList.remove('isResizingColumns');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function onResizeHandleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keyboard-accessible separator (WAI-ARIA orientation=vertical convention):
    //   ArrowLeft  → -10 px       ArrowRight → +10 px
    //   Shift+Arrow → ±50 px       Home → min       End → max
    const SMALL = 10;
    const LARGE = 50;
    const MIN = 240;
    const MAX = 420;
    let next = sessionListWidth;
    switch (event.key) {
      case 'ArrowLeft':
        next = sessionListWidth - (event.shiftKey ? LARGE : SMALL);
        break;
      case 'ArrowRight':
        next = sessionListWidth + (event.shiftKey ? LARGE : SMALL);
        break;
      case 'Home':
        next = MIN;
        break;
      case 'End':
        next = MAX;
        break;
      default:
        return;
    }
    event.preventDefault();
    setSessionListWidth(clamp(next, MIN, MAX));
  }

  return (
    <div className="appFrame">
      <div
        className="app maka-shell-2col"
        style={{
          '--maka-session-list-width': `${sessionListWidth}px`,
        } as CSSProperties}
      >
        <div className="maka-panel maka-panel-list maka-floating-panel">
          <SessionListPanel
            selection={navSelection}
            sessionCounts={sessionCounts}
            sessions={visibleSessions}
            activeId={activeId}
            projectBadge={
              appInfo
                ? {
                    label: basenameFromPath(appInfo.projectPath),
                    path: appInfo.projectPath,
                    branch: appInfo.projectGit.branch,
                    onOpen: () => void openProjectFolder(),
                  }
                : undefined
            }
            skills={skills}
            onRefreshSkills={() => void refreshSkills()}
            onCreateSkillTemplate={() => void createSkillTemplate()}
            onOpenSkill={(skillId) => void openSkill(skillId)}
            planReminders={planReminders}
            streamingSessionIds={streamingSessionIds}
            staleSessionIds={staleSessionIds}
            statusGroups={sessionStatusGroups}
            onSelect={setNavSelection}
            onSelectSession={setActiveId}
            onOpenSettings={openSettings}
            onOpenUpdate={() => openSettingsSection('about')}
            onNew={createSession}
            onOpenSearchModal={() => setSearchModalOpen(true)}
            onCreatePlanReminder={(input) => void createPlanReminder(input)}
            onUpdatePlanReminder={(id, patch) => void updatePlanReminder(id, patch)}
            onTogglePlanReminder={(id, enabled) => void togglePlanReminder(id, enabled)}
            onTriggerPlanReminderNow={(id) => void triggerPlanReminderNow(id)}
            onSnoozePlanReminder={(id) => void snoozePlanReminder(id)}
            onClearPlanReminderRunHistory={(id) => void clearPlanReminderRunHistory(id)}
            onDeletePlanReminder={(id) => void deletePlanReminder(id)}
            onCopyDailyReviewMarkdown={async ({ markdown, label, summary }) => {
              try {
                await navigator.clipboard.writeText(markdown);
                toastApi.success(
                  `已复制${label}回顾`,
                  `${summary.totals.sessionCount} 个对话 · ${summary.totals.requestCount} 个请求`,
                );
              } catch (error) {
                toastApi.error('复制失败', error instanceof Error ? error.message : '剪贴板不可用');
              }
            }}
            dailyReviewBridge={dailyReviewBridge}
            rowActions={{
              onToggleFlag: (sessionId, next) => void flagSession(sessionId, next),
              onArchive: (sessionId) => void archiveSession(sessionId),
              onUnarchive: (sessionId) => void unarchiveSession(sessionId),
              onRename: (sessionId, name) => void renameSession(sessionId, name),
              onDelete: (sessionId) => void deleteSession(sessionId),
            }}
          />
        </div>
        <div
          className="maka-resize-handle"
          role="separator"
          aria-label="调整对话列表宽度"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={420}
          aria-valuenow={sessionListWidth}
          tabIndex={0}
          onPointerDown={startColumnResize}
          onKeyDown={onResizeHandleKeyDown}
        />
        <div className="maka-panel maka-panel-detail maka-floating-panel">
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
            <div className="mainColumn">
              <ChatView
                messages={messages}
                streamingText={activeStreaming}
                streamingTruncated={activeStreamingTruncated}
                thinkingText={activeThinking}
                thinkingTruncated={activeThinkingTruncated}
                tools={liveTools}
                activeSession={activeSessionForView}
                activeConnectionLabel={activeConnectionLabel}
                activeModelLabel={activeModelLabel}
                activeProviderType={activeConnection?.providerType}
                renderProviderMark={(type) => <ProviderLogo type={type} compact />}
                userLabel={userLabel}
                memoryActive={memoryActive}
                onOpenMemorySettings={() => openSettingsSection('memory')}
                mode={navSelection.section}
                connectionAlert={chatConnectionAlert}
                eventStreamAlert={chatEventStreamAlert}
                sessionStatusBadge={chatSessionStatusBadge}
                turnFooterActionsByTurn={turnFooterActionsByTurn}
                onTurnFooterAction={handleTurnFooterAction}
                turnFailedReasonLabels={turnFailedReasonLabels}
                turnFailedRecoveryLabels={turnFailedRecoveryLabels}
                turnLineageBadgesByTurn={turnLineageBadgesByTurn}
                onLineageBadgeClick={handleLineageBadgeClick}
                skills={skills}
                onRefreshSkills={() => void refreshSkills()}
                onCreateSkillTemplate={() => void createSkillTemplate()}
                onOpenSkill={(skillId) => void openSkill(skillId)}
                planReminders={planReminders}
                onCreatePlanReminder={(input) => void createPlanReminder(input)}
                onUpdatePlanReminder={(id, patch) => void updatePlanReminder(id, patch)}
                onTogglePlanReminder={(id, enabled) => void togglePlanReminder(id, enabled)}
                onTriggerPlanReminderNow={(id) => void triggerPlanReminderNow(id)}
                onSnoozePlanReminder={(id) => void snoozePlanReminder(id)}
                onClearPlanReminderRunHistory={(id) => void clearPlanReminderRunHistory(id)}
                onDeletePlanReminder={(id) => void deletePlanReminder(id)}
                dailyReviewBridge={dailyReviewBridge}
                onSelectSession={setActiveId}
                onCopyDailyReviewMarkdown={async ({ markdown, label, summary }) => {
                  try {
                    await navigator.clipboard.writeText(markdown);
                    toastApi.success(
                      `已复制${label}回顾`,
                      `${summary.totals.sessionCount} 个对话 · ${summary.totals.requestCount} 个请求`,
                    );
                  } catch (error) {
                    toastApi.error('复制失败', error instanceof Error ? error.message : '剪贴板不可用');
                  }
                }}
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
                        onQuickChatSubmit={(prompt, mode) => {
                          void handleQuickChatSubmit(prompt, mode);
                        }}
                        quickChatPending={quickChatPending}
                        connections={connections}
                        onRefreshConnections={refreshConnections}
                        onImportTextFile={importTextFilePrompt}
                        onImportFolderOutline={importFolderOutlinePrompt}
                        onImportDroppedTextFiles={importDroppedTextFilesPrompt}
                        onboardingMilestones={onboarding.snapshot?.milestones}
                        onDismissTaskSuggestion={dismissFirstRunTaskSuggestion}
                        onRestoreTaskSuggestions={restoreFirstRunTaskSuggestions}
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
                onPermissionModeChange={(mode) => void setPermissionMode(mode)}
              />
              <Composer
                ref={composerRef}
                hidden={navSelection.section !== 'sessions'}
                draftKey={activeId ?? 'new-session'}
                disabled={Boolean(activePermission)}
                streaming={activeStreaming.length > 0}
                onSend={send}
                onStop={stop}
                onImportTextFile={importTextFileIntoComposer}
                onImportDroppedTextFiles={importDroppedTextFilesIntoComposer}
                onImportFolderOutline={importFolderOutlineIntoComposer}
              />
            </div>
            <ArtifactPane sessionId={activeId} />
          </div>
          </MakaUriContext.Provider>
        </div>
      </div>
      {activePermission && (
        <PermissionDialog
          request={activePermission}
          onRespond={respondToPermission}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          connections={connections}
          defaultSlug={defaultConnection}
          onRefresh={refreshConnections}
          onClose={closeSettings}
          themePref={themePref}
          onThemeChange={setThemePref}
          density={density}
          onDensityChange={setDensity}
          themePalette={themePalette}
          onThemePaletteChange={setThemePalette}
          onUserLabelChange={setUserLabel}
          requestedSection={settingsRequestedSection}
          onOpenDailyReview={() => {
            closeSettings();
            setNavSelection({ section: 'daily-review' });
          }}
          onOpenSession={(sessionId) => {
            closeSettings();
            setActiveId(sessionId);
          }}
        />
      )}
      {helpOpen && <KeyboardHelpModal onClose={closeHelp} />}
      {/*
        PR-SIDEBAR-IA-0 Phase 3 P0 fixup (WAWQAQ msg `d53852ac`):
        SearchModal must be conditionally mounted, not always
        mounted with an internal `if (!open) return null`. Matches
        `KeyboardHelpModal` lifecycle pattern above and removes the
        hooks-before-early-return shape that React #310 punished
        in WAWQAQ's run.
      */}
      {/*
        PR-UX-POLISH-1 commit 5 (WAWQAQ msg `e0dbad11` + kenji msg
        `2844f64f` blocker #3): SearchModal is now wired to the real
        `window.maka.search.thread` IPC. Renderer never touches
        thread JSONL directly; the IPC enforces incognito gate +
        bounded scan + snippet redaction per `@maka/core/search`
        contract. Navigation is supplied via `onNavigateToSession`
        callback (no `maka://session` URI construction).
      */}
      {searchModalOpen && (
        <SearchModal
          onClose={() => setSearchModalOpen(false)}
          deps={{ searchThread: (request) => window.maka.search.thread(request) }}
          onNavigateToSession={(sessionId, turnId) => {
            setNavSelection({ section: 'sessions', filter: 'chats' });
            setActiveId(sessionId);
            if (turnId) {
              setSearchScrollTarget({ sessionId, turnId, nonce: Date.now() });
            } else {
              setSearchScrollTarget(null);
            }
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          onSelectSession={(sessionId, turnId) => {
            setNavSelection({ section: 'sessions', filter: 'chats' });
            setActiveId(sessionId);
            if (turnId) {
              setSearchScrollTarget({ sessionId, turnId, nonce: Date.now() });
            } else {
              setSearchScrollTarget(null);
            }
          }}
          commands={buildCommandList({
            sessions: visibleSessions,
            activeSessionId: activeId,
            themePref,
            connections,
            defaultSlug: defaultConnection,
            onSelectSession: setActiveId,
            onNewChat: () => void createSession(),
            onStartDeepResearch: () => void handleQuickChatSubmit('', 'deep_research'),
            onStartPlanReminder: openPlanReminderForm,
            onOpenSettings: openSettings,
            onOpenSettingsSection: (section) => openSettingsSection(section),
            // PR-UX-POLISH-1 commit 4 (WAWQAQ `e0dbad11` + kenji `2844f64f`):
            // use the openHelp callback returned by useKeyboardHelp directly,
            // instead of dispatching a synthetic KeyboardEvent. Same effect,
            // clearer intent, and avoids the foot-gun where a typed `?` in a
            // text input would be swallowed by the global keydown listener.
            onOpenShortcuts: openHelp,
            onSetTheme: setThemePref,
            onTestConnection: async (slug) => {
              try {
                const result = await window.maka.connections.test(slug);
                const conn = connections.find((c) => c.slug === slug);
                const name = conn?.name ?? slug;
                if (result.ok) {
                  toastApi.success(
                    `连接已验证 · ${name}`,
                    `延迟 ${result.latencyMs ?? '?'} ms${result.modelTested ? ' · ' + result.modelTested : ''}`,
                  );
                } else {
                  toastApi.error(`连接测试失败 · ${name}`, result.errorMessage ?? '未知错误');
                }
                await refreshConnections();
              } catch (error) {
                toastApi.error('测试出错', error instanceof Error ? error.message : String(error));
              }
            },
            onSetDefaultConnection: async (slug) => {
              try {
                await window.maka.connections.setDefault(slug);
                await refreshConnections();
                const conn = connections.find((c) => c.slug === slug);
                toastApi.success(`已设为默认 · ${conn?.name ?? slug}`);
              } catch (error) {
                toastApi.error('切换默认失败', error instanceof Error ? error.message : String(error));
              }
            },
            onOpenWorkspace: async () => {
              const result = await window.maka.app.openPath('workspace');
              if (!result.ok) {
                toastApi.error(`无法打开${openPathActionLabel('workspace')}`, openPathFailureCopy(result.reason));
              }
            },
            onOpenProjectFolder: () => openProjectFolder(),
            onOpenSkillsFolder: () => openSkillsFolder(),
            onSelectModule: (selection) => {
              setNavSelection(selection);
              closePalette();
            },
            onExportActiveConversation: async () => {
              if (!activeId) return;
              const session = sessions.find((s) => s.id === activeId);
              const markdown = renderConversationMarkdown(session?.name ?? '新建对话', messages);
              try {
                await navigator.clipboard.writeText(markdown);
                toastApi.success(
                  '已复制对话为 Markdown',
                  `${markdown.split('\n').length} 行 · 可粘贴到 Notion / Obsidian / GitHub`,
                );
              } catch {
                toastApi.error('复制失败', '剪贴板不可用');
              }
            },
            onSaveActiveConversationToFile: async () => {
              if (!activeId) return;
              const session = sessions.find((s) => s.id === activeId);
              const sessionName = session?.name ?? '新建对话';
              const markdown = renderConversationMarkdown(sessionName, messages);
              const now = new Date();
              const yyyy = now.getFullYear();
              const mm = String(now.getMonth() + 1).padStart(2, '0');
              const dd = String(now.getDate()).padStart(2, '0');
              // Make the filename mostly portable: collapse whitespace
              // and quote chars that some file pickers don't like.
              const sanitizedSession = sessionName
                .replace(/[\s ]+/g, '-')
                .replace(/["<>:|?*]/g, '')
                .slice(0, 80);
              const defaultName = `maka-${sanitizedSession}-${yyyy}-${mm}-${dd}.md`;
              try {
                const result = await window.maka.sessions.saveConversationToFile({ markdown, defaultName });
                if (result.ok) {
                  toastApi.success(
                    '已保存当前对话',
                    `${markdown.split('\n').length} 行 · 保存为 ${defaultName}`,
                  );
                } else if (result.reason === 'canceled') {
                  // User dismissed the dialog — no toast.
                } else if (result.reason === 'invalid_input') {
                  toastApi.error('保存失败', '导出内容无效');
                } else {
                  toastApi.error('保存失败', '无法写入选择的位置');
                }
              } catch (err) {
                toastApi.error(
                  '保存失败',
                  err instanceof Error ? err.message : '导出当前对话失败',
                );
              }
            },
            onOpenLocalMemoryFile: async () => {
              try {
                const result = await window.maka.memory.openFile();
                if (!result.ok) {
                  toastApi.error('无法打开 MEMORY.md', result.message);
                }
              } catch (err) {
                toastApi.error('打开失败', err instanceof Error ? err.message : '路径无效');
              }
            },
            onOpenWorkspaceInstructionsFile: async () => {
              try {
                // PR-CMD-PALETTE-OPEN-WORKSPACE-INSTRUCTIONS-0: open the
                // first available workspace instruction file. If none are
                // available, surface a hint so the user knows where to
                // create one rather than getting a silent no-op.
                const state = await window.maka.workspaceInstructions.getState();
                const available = state.files.find((f) => f.status === 'available');
                if (!available) {
                  toastApi.info(
                    '当前项目还没有项目指引',
                    '在 Settings · 记忆 里可以创建 AGENTS.md 或 CLAUDE.md',
                  );
                  return;
                }
                const result = await window.maka.workspaceInstructions.openFile(available.file);
                if (!result.ok) {
                  toastApi.error(`无法打开 ${available.file}`, result.message);
                }
              } catch (err) {
                toastApi.error('打开失败', err instanceof Error ? err.message : '路径无效');
              }
            },
            onSetPermissionMode: (mode) => void setPermissionMode(mode),
            activePermissionMode: activeSessionForView?.permissionMode,
            onCopyTodayDailyReview: async () => {
              try {
                const summary = await dailyReviewBridge.fetchDay(0, 1);
                const markdown = formatDailyReviewMarkdown(summary, '今天');
                await navigator.clipboard.writeText(markdown);
                toastApi.success(
                  '已复制今日回顾为 Markdown',
                  `${summary.totals.sessionCount} 个对话 · ${summary.totals.requestCount} 个请求`,
                );
              } catch (err) {
                toastApi.error(
                  '复制失败',
                  err instanceof Error ? err.message : '剪贴板或数据不可用',
                );
              }
            },
            onPasteTodayDailyReviewIntoComposer: async () => {
              try {
                const summary = await dailyReviewBridge.fetchDay(0, 1);
                const markdown = formatDailyReviewMarkdown(summary, '今天');
                composerRef.current?.setText(markdown);
              } catch (err) {
                toastApi.error(
                  '粘贴失败',
                  err instanceof Error ? err.message : '加载今日回顾失败',
                );
              }
            },
            onSaveTodayDailyReviewToFile: async () => {
              try {
                const summary = await dailyReviewBridge.fetchDay(0, 1);
                const markdown = formatDailyReviewMarkdown(summary, '今天');
                const localToday = new Date();
                const yyyy = localToday.getFullYear();
                const mm = String(localToday.getMonth() + 1).padStart(2, '0');
                const dd = String(localToday.getDate()).padStart(2, '0');
                const defaultName = `maka-daily-review-${yyyy}-${mm}-${dd}.md`;
                const result = await window.maka.dailyReview.saveMarkdownToFile({ markdown, defaultName });
                if (result.ok) {
                  toastApi.success(
                    '已保存今日回顾',
                    `${summary.totals.sessionCount} 个对话 · ${summary.totals.requestCount} 个请求`,
                  );
                } else if (result.reason === 'canceled') {
                  // User dismissed the dialog — no toast.
                } else if (result.reason === 'invalid_input') {
                  toastApi.error('保存失败', '导出内容无效');
                } else {
                  toastApi.error('保存失败', '无法写入选择的位置');
                }
              } catch (err) {
                toastApi.error(
                  '保存失败',
                  err instanceof Error ? err.message : '加载今日回顾失败',
                );
              }
            },
            onCopyEnvSummary: async () => {
              try {
                const info = await window.maka.app.info();
                const platformPretty =
                  info.platform === 'darwin'
                    ? 'macOS'
                    : info.platform === 'win32'
                      ? 'Windows'
                      : info.platform === 'linux'
                        ? 'Linux'
                        : info.platform;
                const buildLine =
                  info.buildMode === 'dev'
                    ? `- Build: dev${info.buildCommit ? ` @ ${info.buildCommit}` : ''}`
                    : '- Build: packaged';
                const summary = [
                  `**Maka** v${info.appVersion}`,
                  ``,
                  `- Electron: ${info.electronVersion}`,
                  `- Node: ${info.nodeVersion}`,
                  `- Chrome: ${info.chromeVersion}`,
                  `- Platform: ${platformPretty} ${info.osRelease}`,
                  `- Arch: ${info.arch}`,
                  buildLine,
                ].join('\n');
                await navigator.clipboard.writeText(summary);
                toastApi.success(
                  '已复制环境信息',
                  `Maka v${info.appVersion} · ${platformPretty} · ${info.arch}`,
                );
              } catch (err) {
                toastApi.error(
                  '复制失败',
                  err instanceof Error ? err.message : '剪贴板不可用',
                );
              }
            },
            onTestNetworkProxy: async () => {
              try {
                // PR-CMD-PALETTE-NETWORK-PROXY-TEST-0: surface the
                // proxy test result via toast so a user debugging a
                // connection issue does not need to open Settings →
                // 网络. `testNetworkProxy(undefined)` uses the
                // current persisted proxy config.
                const result = await window.maka.settings.testNetworkProxy(undefined);
                if (result.ok) {
                  const latency = result.latencyMs ? ` · ${result.latencyMs}ms` : '';
                  toastApi.success('网络代理测试通过', `${result.message}${latency}`);
                } else {
                  toastApi.error('网络代理测试失败', result.message);
                }
              } catch (err) {
                toastApi.error(
                  '测试失败',
                  err instanceof Error ? err.message : '网络代理测试异常',
                );
              }
            },
          })}
        />
      )}
    </div>
  );
}

const modeDescriptions: Record<PermissionMode, string> = {
  explore: '只读工具直通，写入或网络仍需确认。',
  ask: '所有敏感工具调用前都会停下来征求 allow / deny。',
  execute: '常见工具直通；只有破坏性操作仍然拦截。',
};

/**
 * Serialize a conversation to a Markdown document suitable for pasting into
 * Notion / Obsidian / GitHub. One section per turn: `## 你` header for the
 * user message, optional `### 工具调用` block enumerating tool calls + their
 * intent, `## Maka` for the assistant answer.
 *
 * Per @kenji's PR86 review, deliberate exclusions:
 * - **thinking block** is never included — that's model working notes, not
 *   the answer. If we ever add an "include thinking" toggle, it must be a
 *   separate opt-in.
 * - **token_usage / permission_decision / tool_result** rows dropped —
 *   operational records, not narrative.
 * - **tool intents** run through `redactSecrets` defensively in case a
 *   model-authored intent happens to echo a path / token.
 * - **assistant text** runs through `redactSecrets` defensively — backend
 *   already redacts at write-time, but a fresh AI-SDK error path that
 *   somehow lands a raw token in `text` shouldn't survive into a clipboard
 *   export that the user is going to paste somewhere public.
 * - **user text** left untouched (the user typed it, they own it).
 */
function renderConversationMarkdown(sessionName: string, messages: StoredMessage[]): string {
  const lines: string[] = [];
  lines.push(`# ${sessionName}`);
  lines.push('');
  lines.push(`*Exported ${new Date().toLocaleString()} from Maka.*`);
  lines.push('');

  // Group by turnId in encounter order so we preserve narrative flow.
  const turnOrder: string[] = [];
  const byTurn = new Map<string, StoredMessage[]>();
  for (const m of messages) {
    const tid = (m as { turnId?: string }).turnId ?? '__loose';
    if (!byTurn.has(tid)) {
      byTurn.set(tid, []);
      turnOrder.push(tid);
    }
    byTurn.get(tid)!.push(m);
  }

  for (const tid of turnOrder) {
    const turnMessages = byTurn.get(tid) ?? [];
    const user = turnMessages.find((m) => m.type === 'user');
    const assistant = turnMessages.find((m) => m.type === 'assistant');
    const toolCalls = turnMessages.filter((m) => m.type === 'tool_call');

    if (user) {
      lines.push('---');
      lines.push('');
      lines.push('## 你');
      lines.push('');
      lines.push((user as { text: string }).text);
      lines.push('');
    }

    if (toolCalls.length > 0) {
      lines.push('### 工具调用');
      lines.push('');
      for (const call of toolCalls) {
        const c = call as { toolName: string; intent?: string };
        const intent = c.intent ? redactSecrets(c.intent) : undefined;
        const intentSuffix = intent ? ` — ${intent}` : '';
        lines.push(`- \`${c.toolName}\`${intentSuffix}`);
      }
      lines.push('');
    }

    if (assistant) {
      lines.push('## Maka');
      lines.push('');
      // Defensive: backend redacts at write-time, but the export landing
      // in the user's clipboard is a high-risk surface — paste destinations
      // are external. Second-layer redaction is cheap insurance.
      lines.push(redactSecrets((assistant as { text: string }).text));
      lines.push('');
    }
  }

  return lines.join('\n').trim() + '\n';
}

function readNavSelection(): NavSelection {
  try {
    const raw = localStorage.getItem('maka-nav-selection-v1');
    if (!raw) return { section: 'sessions', filter: 'chats' };
    const parsed = JSON.parse(raw) as { section?: string; filter?: string };
    // PR-SIDEBAR-IA-0 Phase 2 fixup (xuan `94c7bf0f`): fail-closed.
    // `'search'` was briefly a `NavSelection.section` during the
    // Phase 2 initial commit; the fixup removes it because `搜索`
    // is now a modal trigger, not a section. An older localStorage
    // entry with `{section:'search'}` would otherwise leave the
    // app stuck on an invalid section. Reject anything that is not
    // in the current closed-enum.
    if (parsed.section === 'skills') return { section: 'skills' };
    if (parsed.section === 'automations') return { section: 'automations' };
    if (parsed.section === 'daily-review') return { section: 'daily-review' };
    if (
      parsed.section === 'sessions' &&
      (parsed.filter === 'chats' || parsed.filter === 'flagged' || parsed.filter === 'archived')
    ) {
      return parsed as NavSelection;
    }
  } catch {
    /* fall through */
  }
  return { section: 'sessions', filter: 'chats' };
}

function readSessionListWidth(): number {
  const stored = Number(localStorage.getItem('maka-chat-list-width-v1'));
  if (Number.isFinite(stored) && stored > 0) return clamp(stored, 240, 420);
  return 320;
}

function isNoRealConnectionError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.includes(NO_REAL_CONNECTION_CODE);
}

function isNoRealConnectionEvent(event: Extract<SessionEvent, { type: 'error' }>): boolean {
  return event.code === NO_REAL_CONNECTION_CODE || event.message.includes(NO_REAL_CONNECTION_CODE);
}

function noRealConnectionReasonFromError(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.match(NO_REAL_CONNECTION_REASON_RE)?.[1];
}

function noRealConnectionReasonFromEvent(event: Extract<SessionEvent, { type: 'error' }>): string | undefined {
  return event.reason ?? event.message.match(NO_REAL_CONNECTION_REASON_RE)?.[1];
}

function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return cleanEventMessage(raw);
}

function cleanEventMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(NO_REAL_CONNECTION_REASON_RE, '')
    .replace(`${NO_REAL_CONNECTION_CODE}: `, '');
}

function modelSetupToastCopy(reason: string | undefined, fallback: string): { title: string; description: string } {
  if (reason === 'connection_missing') {
    return {
      title: '连接已删除',
      description: '该会话依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。',
    };
  }
  return {
    title: '未配置真实模型',
    description: fallback,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function filterSessions(sessions: SessionSummary[], selection: NavSelection): SessionSummary[] {
  if (selection.section !== 'sessions') return [];
  switch (selection.filter) {
    case 'flagged':
      return sessions.filter((session) => session.isFlagged && !session.isArchived && session.lastMessageAt);
    case 'archived':
      return sessions.filter((session) => session.isArchived);
    case 'chats':
      return sessions.filter((session) => !session.isArchived && session.lastMessageAt);
  }
}

function countSessions(sessions: SessionSummary[]) {
  return {
    chats: sessions.filter((session) => !session.isArchived && session.lastMessageAt).length,
    flagged: sessions.filter((session) => session.isFlagged && !session.isArchived && session.lastMessageAt).length,
    archived: sessions.filter((session) => session.isArchived).length,
  };
}

// Apply the cached theme before React mounts so dark-theme users don't get
// a brief light-mode flash while settings.json loads. We persist the resolved
// theme to localStorage on every change (theme.ts), and this entry point
// reads it synchronously before the first paint. This is the standard
// "FOUC prevention via inline-script" pattern, but here it runs in the same
// JS bundle as the rest of the renderer so we don't need to relax the CSP
// `script-src 'self'` rule.
try {
  const cached = localStorage.getItem('maka-theme-v1');
  const isDark =
    cached === 'dark' ||
    (cached !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (isDark) {
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  } else {
    document.documentElement.style.colorScheme = 'light';
  }
} catch {
  /* localStorage unavailable; fall back to default light theme */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
