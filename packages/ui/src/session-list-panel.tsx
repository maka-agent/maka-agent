import type { PlanReminder, SessionSummary } from '@maka/core';
import type { NavSelection } from './nav-selection.js';
import { SessionHistoryList, type SessionHistoryStatusGroup, type SessionRowActions } from './session-history-list.js';
import { SessionSidebarFooter, SessionSidebarNav } from './session-sidebar-nav.js';
import { Segmented } from './primitives/segmented.js';

export type SessionViewMode = 'status' | 'project';

export function SessionListPanel(props: {
  selection: NavSelection;
  sessions: SessionSummary[];
  activeId?: string;
  planReminders?: PlanReminder[];
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  statusGroups?: ReadonlyArray<SessionHistoryStatusGroup>;
  viewMode?: SessionViewMode;
  onViewModeChange?: (mode: SessionViewMode) => void;
  onSelectSession(sessionId: string): void;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  onNew(): void;
  rowActions?: SessionRowActions;
  sidebarCollapsed?: boolean;
}) {
  const {
    viewMode = 'status',
    onViewModeChange,
    statusGroups,
  } = props;

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
      {onViewModeChange && (
        <div className="maka-view-mode-toggle">
          {/* Shared segmented primitive — same control family as the
              daily-review range tabs. The previous hand-rolled buttons
              referenced tokens that don't exist in maka-tokens
              (--surface-secondary etc.), rendering an invisible chrome. */}
          <Segmented
            value={viewMode}
            options={[['status', '按状态'], ['project', '按项目']]}
            onChange={(mode) => onViewModeChange(mode)}
            ariaLabel="会话分组方式"
            className="maka-view-mode-segmented"
          />
        </div>
      )}
      <SessionHistoryList
        sessions={props.sessions}
        activeId={props.activeId}
        streamingSessionIds={props.streamingSessionIds}
        staleSessionIds={props.staleSessionIds}
        groupVariant={viewMode === 'project' ? 'project' : 'status'}
        statusGroups={statusGroups}
        onSelectSession={props.onSelectSession}
        rowActions={props.rowActions}
      />
      <SessionSidebarFooter onOpenSettings={props.onOpenSettings} />
    </aside>
  );
}
