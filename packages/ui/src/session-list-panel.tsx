import type { PlanReminder, SessionSummary } from '@maka/core';
import type { NavSelection } from './nav-selection.js';
import { SessionHistoryList, type SessionHistoryStatusGroup, type SessionRowActions } from './session-history-list.js';
import { SessionSidebarFooter, SessionSidebarNav } from './session-sidebar-nav.js';
import { Segmented } from './primitives/segmented.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

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
  const copy = getConversationCopy(useUiLocale()).sessions;
  const {
    viewMode = 'status',
    onViewModeChange,
    statusGroups,
  } = props;
  const showSessionNavigation = props.selection.section === 'sessions';

  return (
    <aside
      className="maka-session-panel agents-sidebar"
      aria-label={copy.listAriaLabel}
      data-collapsed={props.sidebarCollapsed ? 'true' : undefined}
      data-content={showSessionNavigation ? 'sessions' : 'module'}
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
      {showSessionNavigation && onViewModeChange && (
        <div className="maka-view-mode-toggle">
          {/* Shared segmented primitive — same control family as the
              daily-review range tabs. The previous hand-rolled buttons
              referenced tokens that don't exist in maka-tokens
              (--surface-secondary etc.), rendering an invisible chrome. */}
          <Segmented
            value={viewMode}
            options={[['status', copy.groupByStatus], ['project', copy.groupByProject]]}
            onChange={(mode) => onViewModeChange(mode)}
            ariaLabel={copy.groupingAriaLabel}
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
