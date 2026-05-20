import { StrictMode, useEffect, useMemo, useState, type CSSProperties, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ConnectionEvent,
  LlmConnection,
  PermissionRequestEvent,
  PermissionResponse,
  SessionEvent,
  SessionSummary,
  StoredMessage,
} from '@maka/core';
import {
  ChatView,
  Composer,
  type NavSelection,
  PermissionDialog,
  SessionListPanel,
  type ToolActivityItem,
} from '@maka/ui';
import { SettingsModal } from './settings/SettingsModal';
import './styles.css';

function App() {
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
  const activeStreaming = activeId ? streamingBySession[activeId] ?? '' : '';
  const liveTools = useMemo(() => (activeId ? liveToolsBySession[activeId] ?? [] : []), [activeId, liveToolsBySession]);
  const activePermission = activeId ? permissionBySession[activeId] : undefined;
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeSessionForView: SessionSummary | undefined = activeSession ?? (activeId ? {
    id: activeId,
    name: 'New Chat',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'default',
  } : undefined);
  const visibleSessions = useMemo(() => filterSessions(sessions, navSelection), [sessions, navSelection]);
  const sessionCounts = useMemo(() => countSessions(sessions), [sessions]);
  const [sessionListWidth, setSessionListWidth] = useState(() => readSessionListWidth());

  useEffect(() => {
    void refreshSessions();
    void refreshConnections();
    const unsubscribeConnections = window.maka.connections.subscribeEvents(handleConnectionEvent);
    const unsubscribeOpenSettings = window.maka.appWindow.subscribeOpenSettings(openSettings);
    function onKeyDown(event: KeyboardEvent) {
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

  async function send(text: string) {
    if (!activeId) {
      const session = await window.maka.sessions.create({
        permissionMode: 'ask',
        name: text.slice(0, 42) || 'New Chat',
      });
      setActiveId(session.id);
      await refreshSessions();
      await window.maka.sessions.send(session.id, { type: 'send', turnId: crypto.randomUUID(), text });
      return;
    }
    await window.maka.sessions.send(activeId, { type: 'send', turnId: crypto.randomUUID(), text });
    await refreshMessages(activeId);
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
          />
        </div>
        <div
          className="maka-resize-handle"
          role="separator"
          aria-label="Resize chat list"
          onPointerDown={startColumnResize}
        />
        <div className="maka-panel maka-panel-detail maka-floating-panel">
          <div className="mainColumn">
            <ChatView
              messages={messages}
              streamingText={activeStreaming}
              tools={liveTools}
              activeSession={activeSessionForView}
              mode={navSelection.section}
              onNew={createSession}
            />
            <Composer
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
        />
      )}
    </div>
  );
}

function readSessionListWidth(): number {
  const stored = Number(localStorage.getItem('maka-chat-list-width-v1'));
  if (Number.isFinite(stored) && stored > 0) return clamp(stored, 240, 420);
  return 320;
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
    <App />
  </StrictMode>,
);
