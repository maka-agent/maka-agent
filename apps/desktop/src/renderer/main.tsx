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
  StoredMessage,
  ThemePreference,
  UiDensity,
} from '@maka/core';
import {
  ChatView,
  Composer,
  type ComposerHandle,
  type NavSelection,
  PermissionDialog,
  SessionListPanel,
  ToastProvider,
  useToast,
  type ToolActivityItem,
} from '@maka/ui';
import { SettingsModal } from './settings/SettingsModal';
import { ErrorBoundary } from './error-boundary';
import { KeyboardHelpModal, useKeyboardHelp } from './keyboard-help';
import { CommandPalette, buildCommandList, useCommandPalette } from './command-palette';
import { OnboardingHero } from './OnboardingHero';
import { ProviderLogo } from './settings/ProvidersPanel';
import { applyDensity, applyTheme } from './theme';
import './styles.css';

const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';

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
  const [navSelection, setNavSelection] = useState<NavSelection>({ section: 'sessions', filter: 'chats' });
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [streamingBySession, setStreamingBySession] = useState<Record<string, string>>({});
  const [liveToolsBySession, setLiveToolsBySession] = useState<Record<string, ToolActivityItem[]>>({});
  const [permissionBySession, setPermissionBySession] = useState<Record<string, PermissionRequestEvent | undefined>>({});
  const [connections, setConnections] = useState<LlmConnection[]>([]);
  const [defaultConnection, setDefaultConnection] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [density, setDensity] = useState<UiDensity>('comfortable');
  const [userLabel, setUserLabel] = useState<string>('');
  const [helpOpen, closeHelp] = useKeyboardHelp();
  const [paletteOpen, openPalette, closePalette] = useCommandPalette();
  const composerRef = useRef<ComposerHandle>(null);
  const activeStreaming = activeId ? streamingBySession[activeId] ?? '' : '';
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
  const activeSessionForView: SessionSummary | undefined = activeSession ?? (activeId ? {
    id: activeId,
    name: 'New Chat',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
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
    const unsubscribeConnections = window.maka.connections.subscribeEvents(handleConnectionEvent);
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
      unsubscribeOpenSettings();
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

  async function refreshSessions() {
    const next = await window.maka.sessions.list();
    setSessions(next);
    if (!activeId && next[0] && next[0].lastMessageAt) setActiveId(next[0].id);
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

  async function send(text: string): Promise<boolean> {
    try {
      if (!activeId) {
        const session = await window.maka.sessions.create({
          permissionMode: 'ask',
          name: text.slice(0, 42) || 'New Chat',
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
        showModelSetupToast(cleanErrorMessage(error));
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
          showModelSetupToast(cleanEventMessage(event.message));
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

  function closeSettings() {
    setSettingsOpen(false);
  }

  function showModelSetupToast(description: string) {
    toastApi.toast({
      title: '未配置真实模型',
      description,
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
            onSelect={setNavSelection}
            onSelectSession={setActiveId}
            onOpenSettings={openSettings}
            onNew={createSession}
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
          aria-label="Resize chat list"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={420}
          aria-valuenow={sessionListWidth}
          tabIndex={0}
          onPointerDown={startColumnResize}
          onKeyDown={onResizeHandleKeyDown}
        />
        <div className="maka-panel maka-panel-detail maka-floating-panel">
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
              onSend={send}
              onStop={stop}
            />
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
            onSelectSession: setActiveId,
            onNewChat: () => void createSession(),
            onOpenSettings: openSettings,
            onOpenShortcuts: () => {
              // useKeyboardHelp() exposes only close; trigger via window event
              // simulation by dispatching a `?` keypress on the document.
              window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
            },
            onSetTheme: setThemePref,
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

function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return cleanEventMessage(raw);
}

function cleanEventMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(`${NO_REAL_CONNECTION_CODE}: `, '');
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
