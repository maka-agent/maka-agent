import { StrictMode, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ConnectionEvent,
  LlmConnection,
  PermissionMode,
  PermissionRequestEvent,
  PermissionResponse,
  SessionEvent,
  SessionSummary,
  SettingsSection,
  StoredMessage,
  ThemePreference,
  UiDensity,
} from '@maka/core';
import {
  type ChatHeaderAlert,
  ChatView,
  Composer,
  type ComposerHandle,
  deriveTurnLineageMap,
  materializeTurns,
  type NavSelection,
  PermissionDialog,
  redactSecrets,
  SessionListPanel,
  type SkillEntry,
  ToastProvider,
  type TurnFooterActionMeta,
  type TurnLineageBadge,
  useToast,
  type ToolActivityItem,
} from '@maka/ui';
import { SettingsModal } from './settings/SettingsModal';
import { ErrorBoundary } from './error-boundary';
import { KeyboardHelpModal, useKeyboardHelp } from './keyboard-help';
import { CommandPalette, buildCommandList, useCommandPalette } from './command-palette';
import { OnboardingHero } from './OnboardingHero';
import { ProviderLogo } from './settings/ProvidersPanel';
import { ArtifactPane } from './artifact-pane';
import { deriveChatHeaderAlert } from './chat-header-alert';
import { deriveStaleSessionIds } from './stale-sessions';
import { deriveSessionStatusGroups } from './session-status-grouping';
import {
  describeTurnErrorClass,
  presentSessionStatus,
  sessionStatusAriaLabel,
} from './session-status-presentation';
import { deriveTurnFooterActions } from './turn-footer-actions';
import { applyDensity, applyTheme } from './theme';
import { openPathActionLabel, openPathFailureCopy } from './open-path';
import './styles.css';

const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';
const NO_REAL_CONNECTION_REASON_RE = /NO_REAL_CONNECTION:([a-z_]+): /;

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
  const [streamingBySession, setStreamingBySession] = useState<Record<string, string>>({});
  const [liveToolsBySession, setLiveToolsBySession] = useState<Record<string, ToolActivityItem[]>>({});
  const [permissionBySession, setPermissionBySession] = useState<Record<string, PermissionRequestEvent | undefined>>({});
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultConnection, setDefaultConnection] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequestedSection, setSettingsRequestedSection] = useState<SettingsSection | undefined>(undefined);
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [density, setDensity] = useState<UiDensity>('comfortable');
  const [userLabel, setUserLabel] = useState<string>('');
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [helpOpen, closeHelp] = useKeyboardHelp();
  const [paletteOpen, openPalette, closePalette] = useCommandPalette();
  const composerRef = useRef<ComposerHandle>(null);
  const activeIdRef = useRef<string | undefined>(undefined);
  const activeStreaming = activeId ? streamingBySession[activeId] ?? '' : '';
  // Set of session ids with a live streaming delta — drives the sidebar
  // pulse indicator. Recomputed on every streamingBySession change; cheap
  // since the underlying map only has at most a handful of entries.
  const streamingSessionIds = useMemo(
    () => new Set(Object.entries(streamingBySession).flatMap(([id, text]) => (text ? [id] : []))),
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
  const activePermission = activeId ? permissionBySession[activeId] : undefined;
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeConnection = activeSession
    ? connections.find((connection) => connection.slug === activeSession.llmConnectionSlug)
    : undefined;
  const activeConnectionLabel = activeSession?.backend === 'fake'
    ? 'Fake backend'
    : activeConnection?.name ?? activeSession?.llmConnectionSlug;
  // SessionSummary doesn't carry the resolved model (it lives on the header
  // and isn't surfaced through the IPC `sessions:list`), so fall back to the
  // connection's default model for display purposes.
  const activeModelLabel = activeSession?.backend === 'fake' ? undefined : activeConnection?.defaultModel;

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
    turnLineageBadgesByTurn,
  } = useMemo(() => {
    const turnsForLineage = materializeTurns(messages, liveTools);
    const lineage = deriveTurnLineageMap(turnsForLineage);
    const turnsById = new Map(turnsForLineage.map((t) => [t.turnId, t]));
    const shortId = (turnId: string) => turnId.slice(0, 6);
    const footer: Record<string, ReadonlyArray<TurnFooterActionMeta>> = {};
    const failedLabels: Record<string, string> = {};
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
      turnLineageBadgesByTurn: badges,
    };
  }, [activeId, messages, liveTools, pendingTurnActions]);

  // PR109e-e: click handler for lineage badge → scroll target turn into
  // view. Avoids pulling a separate ref-tracker: relies on the
  // `data-turn-id` attribute the renderer already sets on each TurnView.
  function handleLineageBadgeClick(targetTurnId: string): void {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-turn-id="${CSS.escape(targetTurnId)}"]`);
      if (el && 'scrollIntoView' in el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
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
    permissionMode: 'ask',
  } : undefined);
  const visibleSessions = useMemo(() => filterSessions(sessions, navSelection), [sessions, navSelection]);
  const sessionCounts = useMemo(() => countSessions(sessions), [sessions]);
  // Aligns with @kenji's provider-onboarding-invariants 3-state taxonomy:
  // `ready` when at least one enabled connection exists, `needs_onboarding`
  // otherwise. We treat any-enabled as "ready" — backend (xuan) is the
  // authoritative check on secret + model validity; this gate just decides
  // which hero to show on an empty chat.
  const needsOnboarding = useMemo(
    () => !connections.some((connection) => connection.enabled),
    [connections],
  );
  const [sessionListWidth, setSessionListWidth] = useState(() => readSessionListWidth());

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    void refreshSessions();
    void refreshConnections();
    // Pull the persisted theme preference (auto/light/dark) and apply it
    // before any first paint settles. If settings are unreadable we leave the
    // default `auto` which still produces a correct result.
    void window.maka.settings.get().then((next) => {
      const pref = next.appearance?.theme ?? 'auto';
      const den = next.appearance?.density ?? 'comfortable';
      const name = next.personalization?.displayName ?? '';
      setThemePref(pref);
      setDensity(den);
      setUserLabel(name);
      applyTheme(pref);
      applyDensity(den);
    });
    void window.maka.skills.list().then(setSkills).catch(() => setSkills([]));
    void applyVisualSmokeFixture();
    const unsubscribeConnections = window.maka.connections.subscribeEvents(handleConnectionEvent);
    const unsubscribeSessionChanges = window.maka.sessions.subscribeChanges((event) => {
      void refreshSessions();
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
      }
    });
    const unsubscribeOpenSettings = window.maka.appWindow.subscribeOpenSettings(openSettings);
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

  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    void window.maka.sessions.readMessages(activeId).then((next) => {
      if (!disposed) setMessages(next);
    });
    const unsubscribe = window.maka.sessions.subscribeEvents(activeId, (event) => {
      handleEvent(activeId, event);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [activeId]);

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
      setStreamingBySession((current) => ({ ...current, ...state.streamingBySession }));
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
    await refreshSessions();
    if (state.activeSessionId) {
      setActiveId(state.activeSessionId);
    }
    if (state.openSettingsSection) {
      openSettingsSection(state.openSettingsSection);
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
            if (document.activeElement instanceof HTMLElement) {
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

  async function createSession() {
    setActiveId(undefined);
    setNavSelection({ section: 'sessions', filter: 'chats' });
    setMessages([]);
    setStreamingBySession({});
    setLiveToolsBySession({});
    setPermissionBySession({});
  }

  // Open the workspace's skills/ directory in Finder via the IPC allowlist.
  // Earlier we silently dropped the structured failure result; surface it
  // so missing-skills-dir / open-failed don't look like the button did nothing.
  async function openSkillsFolder() {
    const result = await window.maka.app.openPath('skills');
    if (!result.ok) {
      toastApi.error(`无法打开${openPathActionLabel('skills')}`, openPathFailureCopy(result.reason));
    }
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

  async function stop() {
    if (activeId) await window.maka.sessions.stop(activeId);
  }

  async function respondToPermission(response: PermissionResponse) {
    if (!activeId) return;
    await window.maka.sessions.respondToPermission(activeId, response);
  }

  async function refreshMessages(sessionId: string) {
    setMessages(await window.maka.sessions.readMessages(sessionId));
  }

  function handleEvent(sessionId: string, event: SessionEvent) {
    switch (event.type) {
      case 'text_delta':
        setStreamingBySession((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? '') + event.text,
        }));
        break;
      case 'text_complete':
        setStreamingBySession((current) => ({ ...current, [sessionId]: '' }));
        void refreshMessages(sessionId);
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
        if (isNoRealConnectionEvent(event)) {
          showModelSetupToast(cleanEventMessage(event.message), noRealConnectionReasonFromEvent(event));
        } else {
          toastApi.error('对话出错', event.message);
        }
        void refreshSessions();
        void refreshMessages(sessionId);
        break;
      case 'abort':
      case 'complete':
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
      const nextItem = { ...base, ...patch };
      const nextList = index >= 0 ? list.map((item, itemIndex) => (itemIndex === index ? nextItem : item)) : [...list, nextItem];
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
            skills={skills}
            streamingSessionIds={streamingSessionIds}
            staleSessionIds={staleSessionIds}
            statusGroups={sessionStatusGroups}
            onSelect={setNavSelection}
            onSelectSession={setActiveId}
            onOpenSettings={openSettings}
            onNew={createSession}
            onOpenSkillFolder={() => void openSkillsFolder()}
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
          <div className="maka-detail-with-artifacts">
            <div className="mainColumn">
              <ChatView
                messages={messages}
                streamingText={activeStreaming}
                tools={liveTools}
                activeSession={activeSessionForView}
                activeConnectionLabel={activeConnectionLabel}
                activeModelLabel={activeModelLabel}
                activeProviderType={activeConnection?.providerType}
                renderProviderMark={(type) => <ProviderLogo type={type} compact />}
                userLabel={userLabel}
                mode={navSelection.section}
                connectionAlert={chatConnectionAlert}
                sessionStatusBadge={chatSessionStatusBadge}
                turnFooterActionsByTurn={turnFooterActionsByTurn}
                onTurnFooterAction={handleTurnFooterAction}
                turnFailedReasonLabels={turnFailedReasonLabels}
                turnLineageBadgesByTurn={turnLineageBadgesByTurn}
                onLineageBadgeClick={handleLineageBadgeClick}
                emptyOverride={needsOnboarding ? (
                  <OnboardingHero
                    onOpenSettings={() => setSettingsOpen(true)}
                    onUseAnyway={() => composerRef.current?.focus()}
                  />
                ) : undefined}
                onNew={createSession}
                onPromptSuggestion={(prompt) => composerRef.current?.setText(prompt)}
                onPermissionModeChange={(mode) => void setPermissionMode(mode)}
              />
              <Composer
                ref={composerRef}
                hidden={navSelection.section !== 'sessions'}
                disabled={Boolean(activePermission)}
                streaming={activeStreaming.length > 0}
                onSend={send}
                onStop={stop}
              />
            </div>
            <ArtifactPane sessionId={activeId} />
          </div>
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
          onUserLabelChange={setUserLabel}
          requestedSection={settingsRequestedSection}
        />
      )}
      {helpOpen && <KeyboardHelpModal onClose={closeHelp} />}
      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          commands={buildCommandList({
            sessions: visibleSessions,
            activeSessionId: activeId,
            themePref,
            connections,
            defaultSlug: defaultConnection,
            onSelectSession: setActiveId,
            onNewChat: () => void createSession(),
            onOpenSettings: openSettings,
            onOpenSettingsSection: (section) => openSettingsSection(section),
            onOpenShortcuts: () => {
              // useKeyboardHelp() exposes only close; trigger via window event
              // simulation by dispatching a `?` keypress on the document.
              window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
            },
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
            onOpenSkillsFolder: () => openSkillsFolder(),
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
    const parsed = JSON.parse(raw) as NavSelection;
    if (parsed.section === 'skills') return { section: 'skills' };
    if (
      parsed.section === 'sessions' &&
      (parsed.filter === 'chats' || parsed.filter === 'flagged' || parsed.filter === 'archived')
    ) {
      return parsed;
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
