import type { PlanReminder, SessionSummary } from '@maka/core';
import type { NavSelection } from './nav-selection.js';
import { SessionHistoryList, type SessionHistoryStatusGroup, type SessionRowActions } from './session-history-list.js';
import { SessionSidebarFooter, SessionSidebarNav } from './session-sidebar-nav.js';
import { cn } from './ui.js';
import { FolderOpen, Grid3X3 } from './icons.js';

export type SessionViewMode = 'status' | 'project';

export interface ProjectGroup {
  projectPath: string;
  label: string;
  sessions: SessionSummary[];
}

export function SessionListPanel(props: {
  selection: NavSelection;
  sessions: SessionSummary[];
  activeId?: string;
  planReminders?: PlanReminder[];
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  statusGroups?: ReadonlyArray<SessionHistoryStatusGroup>;
  projectGroups?: ReadonlyArray<ProjectGroup>;
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
    projectGroups,
    statusGroups,
    sessions,
  } = props;

  let groups: ReadonlyArray<SessionHistoryStatusGroup>;

  if (viewMode === 'project' && projectGroups) {
    groups = projectGroups.map((g) => ({
      id: g.projectPath || '__ungrouped__',
      label: g.label,
      sessions: g.sessions,
      collapsible: true,
      defaultExpanded: true,
    }));
  } else if (statusGroups) {
    groups = statusGroups;
  } else {
    // Fallback: treat all sessions as a single group.
    groups = [{
      id: 'all',
      label: '',
      sessions: sessions as SessionSummary[],
      collapsible: false,
      defaultExpanded: true,
    }];
  }

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
          <button
            className={cn('maka-view-mode-btn', viewMode === 'status' && 'active')}
            onClick={() => onViewModeChange('status')}
            title="按状态分组"
          >
            <Grid3X3 size={14} />
            <span>按状态</span>
          </button>
          <button
            className={cn('maka-view-mode-btn', viewMode === 'project' && 'active')}
            onClick={() => onViewModeChange('project')}
            title="按项目分组"
          >
            <FolderOpen size={14} />
            <span>按项目</span>
          </button>
        </div>
      )}
      <SessionHistoryList
        sessions={props.sessions}
        activeId={props.activeId}
        streamingSessionIds={props.streamingSessionIds}
        staleSessionIds={props.staleSessionIds}
        statusGroups={groups}
        onSelectSession={props.onSelectSession}
        rowActions={props.rowActions}
      />
      <SessionSidebarFooter onOpenSettings={props.onOpenSettings} />
    </aside>
  );
}
