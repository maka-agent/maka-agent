import type { PlanReminder, SessionSummary } from '@maka/core';
import type { NavSelection } from './nav-selection.js';
import { SessionHistoryList, type SessionHistoryStatusGroup, type SessionRowActions } from './session-history-list.js';
import { SessionSidebarFooter, SessionSidebarNav } from './session-sidebar-nav.js';
import { Segmented } from './primitives/segmented.js';
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from './primitives/menu.js';
import { Button as UiButton } from './ui.js';
import { ListTodo } from './icons.js';
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
  childSessionsByParentId?: ReadonlyMap<string, readonly SessionSummary[]>;
  viewMode?: SessionViewMode;
  onViewModeChange?: (mode: SessionViewMode) => void;
  onSelectSession(sessionId: string): void;
  onSelect(selection: NavSelection): void;
  onOpenSettings(): void;
  onNew(): void;
  rowActions?: SessionRowActions;
  sidebarCollapsed?: boolean;
  /**
   * EXPERIMENT (subtraction variant, issue #1433): 'subtracted' slims the
   * primary nav (see SessionSidebarNav) and moves the status/project
   * grouping control into a compact icon menu. Storybook material only.
   */
  chrome?: 'default' | 'subtracted';
  /** Storybook-only sidebar alternatives for the #1433 shape study. */
  studyVariant?: 'current' | 'extensions-hub' | 'compact-grouping' | 'balanced' | 'minimal';
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
        chrome={props.chrome}
        studyVariant={props.studyVariant}
      />
      {showSessionNavigation && onViewModeChange && props.chrome !== 'subtracted' && !['compact-grouping', 'balanced', 'minimal'].includes(props.studyVariant ?? '') && (
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
      {showSessionNavigation && onViewModeChange && (props.chrome === 'subtracted' || ['compact-grouping', 'balanced', 'minimal'].includes(props.studyVariant ?? '')) && (
        <div className="maka-view-mode-toggle maka-view-mode-toggle-icon">
          <span className="maka-session-list-heading">{copy.title}</span>
          <Menu>
            <MenuTrigger
              render={<UiButton variant="quiet" size="icon-sm" />}
              type="button"
              aria-label={copy.groupingAriaLabel}
              title={copy.groupingAriaLabel}
            >
              <ListTodo size={15} aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuRadioGroup value={viewMode} onValueChange={(mode) => onViewModeChange(mode as SessionViewMode)}>
                <MenuRadioItem value="status">{copy.groupByStatus}</MenuRadioItem>
                <MenuRadioItem value="project">{copy.groupByProject}</MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </div>
      )}
      <SessionHistoryList
        sessions={props.sessions}
        activeId={props.activeId}
        streamingSessionIds={props.streamingSessionIds}
        staleSessionIds={props.staleSessionIds}
        groupVariant={viewMode === 'project' ? 'project' : 'status'}
        statusGroups={statusGroups}
        childSessionsByParentId={props.childSessionsByParentId}
        onSelectSession={props.onSelectSession}
        rowActions={props.rowActions}
      />
      {props.studyVariant !== 'minimal' && <SessionSidebarFooter onOpenSettings={props.onOpenSettings} />}
    </aside>
  );
}
