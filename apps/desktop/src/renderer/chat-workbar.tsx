import { lazy, Suspense } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { SessionWorkbarTab } from './session-workbar-layout';
import { SESSION_WORKBAR_MAX_WIDTH, SESSION_WORKBAR_MIN_WIDTH } from './session-workbar-layout';

// The session workbar owns the task ledger, embedded browser, and artifact
// preview. Keep the combined auxiliary surface out of the first chat paint.
const SessionWorkbar = lazy(() => import('./session-workbar').then((m) => ({ default: m.SessionWorkbar })));

function SessionWorkbarFallback() {
  return (
    <aside className="maka-session-workbar" role="status" aria-busy="true" aria-label="正在加载会话工作栏">
      <div className="maka-lazy-fallback" data-surface="panel">正在加载会话工作栏…</div>
    </aside>
  );
}

/**
 * The artifacts column of the sessions surface (issue #1043): the workbar
 * resize handle plus the lazy-mounted SessionWorkbar (task ledger, embedded
 * browser, artifact pane). AppShell renders this conditionally - only beside
 * an active session inside the sessions module - so it is not part of the
 * always-mounted chat surface.
 */
interface ChatWorkbarProps {
  activeId: string;
  browserLive: boolean;
  hidden: boolean;
  width: number;
  activeTab: SessionWorkbarTab;
  onActiveTabChange: (tab: SessionWorkbarTab) => void;
  onDismiss: () => void;
  startWorkbarResize: (event: PointerEvent<HTMLDivElement>) => void;
  onWorkbarResizeHandleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export function ChatWorkbar({
  activeId,
  browserLive,
  hidden,
  width,
  activeTab,
  onActiveTabChange,
  onDismiss,
  startWorkbarResize,
  onWorkbarResizeHandleKeyDown,
}: ChatWorkbarProps) {
  return (
    <>
      <div
        className="maka-workbar-resize-handle"
        role="separator"
        aria-label="调整会话工作栏宽度"
        aria-orientation="vertical"
        aria-valuemin={SESSION_WORKBAR_MIN_WIDTH}
        aria-valuemax={SESSION_WORKBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startWorkbarResize}
        onKeyDown={onWorkbarResizeHandleKeyDown}
      />
      <Suspense fallback={<SessionWorkbarFallback />}>
        <SessionWorkbar
          key={activeId}
          sessionId={activeId}
          browserLive={browserLive}
          hidden={hidden}
          width={width}
          onDismiss={onDismiss}
          activeTab={activeTab}
          onActiveTabChange={onActiveTabChange}
        />
      </Suspense>
    </>
  );
}
