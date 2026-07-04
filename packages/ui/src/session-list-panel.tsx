import type { PlanReminder, SessionSummary } from '@maka/core';
import type { NavSelection } from './nav-selection.js';
import { SessionHistoryList, type SessionHistoryStatusGroup, type SessionRowActions } from './session-history-list.js';
import { SessionSidebarFooter, SessionSidebarNav } from './session-sidebar-nav.js';

export function SessionListPanel(props: {
  selection: NavSelection;
  sessions: SessionSummary[];
  activeId?: string;
  planReminders?: PlanReminder[];
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  statusGroups?: ReadonlyArray<SessionHistoryStatusGroup>;
  onSelectSession(sessionId: string): void;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  onNew(): void;
  rowActions?: SessionRowActions;
  sidebarCollapsed?: boolean;
}) {
  return (
    <aside
      className="maka-session-panel agents-sidebar"
      aria-label="对话列表"
      data-collapsed={props.sidebarCollapsed ? 'true' : undefined}
    >
      <header className="maka-session-panel-header">
        <div className="maka-sidebar-drag-strip" />
      </header>
      <SessionSidebarNav
        selection={props.selection}
        planReminders={props.planReminders}
        onSelect={props.onSelect}
        onNew={props.onNew}
      />
      <SessionHistoryList
        sessions={props.sessions}
        activeId={props.activeId}
        streamingSessionIds={props.streamingSessionIds}
        staleSessionIds={props.staleSessionIds}
        statusGroups={props.statusGroups}
        onSelectSession={props.onSelectSession}
        rowActions={props.rowActions}
      />
      <SessionSidebarFooter onOpenSettings={props.onOpenSettings} />
    </aside>
  );
}
