import {
  CircleGauge,
  Grid3X3,
  HelpCircle,
  MessageCircleQuestion,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  SquarePen,
} from '@maka/ui/icons';
import { Button as UiButton, Menu, MenuItem, MenuPopup, MenuTrigger, Tooltip, TooltipContent, TooltipTrigger, useUiLocale } from '@maka/ui';
import { getShellCopy } from './locales/shell-copy';

export function AppShellTopbarActions(props: {
  sidebarCollapsed: boolean;
  onOpenSearchModal(): void;
  onCollapseSidebar(): void;
  onExpandSidebar(): void;
  onCreateSession(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  return (
    <div
      className={`maka-shell-topbar-rail ${props.sidebarCollapsed ? 'is-collapsed' : 'is-expanded'}`}
      aria-label={copy.windowActions}
    >
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          data-maka-search-trigger="true"
          onClick={props.onOpenSearchModal}
          aria-label={copy.searchConversations}
        >
          <Search aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{copy.searchConversations}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          onClick={props.sidebarCollapsed ? props.onExpandSidebar : props.onCollapseSidebar}
          aria-label={props.sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
          aria-expanded={!props.sidebarCollapsed}
        >
          {props.sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </TooltipTrigger>
        <TooltipContent>{props.sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}</TooltipContent>
      </Tooltip>
      {props.sidebarCollapsed && (
        <Tooltip>
          <TooltipTrigger
            render={<UiButton variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-titlebar-action"
            onClick={props.onCreateSession}
            aria-label={copy.newTask}
          >
            <SquarePen aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{copy.newTask}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function AppShellWorkspaceTopActions(props: {
  workbarAvailable: boolean;
  workbarCollapsed: boolean;
  onToggleWorkbar(): void;
  onOpenFeedback(): void;
  onOpenPalette(): void;
  onOpenHelp(): void;
  onOpenHealth(): void;
  /**
   * EXPERIMENT (subtraction variant, issue #1433): 'subtracted' keeps only
   * the workbar toggle persistent and folds feedback / palette / help /
   * health into one overflow menu. Storybook discussion material only.
   */
  chrome?: 'default' | 'subtracted';
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  const workbarLabel = props.workbarCollapsed ? copy.expandWorkbar : copy.collapseWorkbar;

  if (props.chrome === 'subtracted') {
    return (
      <div className="maka-workspace-top-actions" role="toolbar" aria-label={copy.workspaceActions}>
        <Menu>
          <MenuTrigger
            render={<UiButton variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-titlebar-action"
            aria-label={copy.workspaceActions}
          >
            <MoreHorizontal aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={props.onOpenFeedback}>{copy.feedback}</MenuItem>
            <MenuItem onClick={props.onOpenPalette}>{copy.openCommandPalette}</MenuItem>
            <MenuItem onClick={props.onOpenHelp}>{copy.openHelp}</MenuItem>
            <MenuItem onClick={props.onOpenHealth}>{copy.openHealth}</MenuItem>
          </MenuPopup>
        </Menu>
        {props.workbarAvailable && (
          <Tooltip>
            <TooltipTrigger
              render={<UiButton variant="quiet" size="icon-sm" />}
              type="button"
              className="maka-titlebar-action"
              onClick={props.onToggleWorkbar}
              aria-label={workbarLabel}
              aria-expanded={!props.workbarCollapsed}
            >
              {props.workbarCollapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
            </TooltipTrigger>
            <TooltipContent>{workbarLabel}</TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  return (
    <div className="maka-workspace-top-actions" role="toolbar" aria-label={copy.workspaceActions}>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          onClick={props.onOpenFeedback}
          aria-label={copy.feedback}
        >
          <MessageCircleQuestion aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{copy.feedbackTooltip}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          onClick={props.onOpenPalette}
          aria-label={copy.openCommandPalette}
        >
          <Grid3X3 aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{copy.openCommandPalette}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          onClick={props.onOpenHelp}
          aria-label={copy.openHelp}
        >
          <HelpCircle aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{copy.openHelp}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          onClick={props.onOpenHealth}
          aria-label={copy.openHealth}
        >
          <CircleGauge aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{copy.openHealth}</TooltipContent>
      </Tooltip>
      {props.workbarAvailable && (
        <Tooltip>
          <TooltipTrigger
            render={<UiButton variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-titlebar-action"
            onClick={props.onToggleWorkbar}
            aria-label={workbarLabel}
            aria-expanded={!props.workbarCollapsed}
          >
            {props.workbarCollapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
          </TooltipTrigger>
          <TooltipContent>{workbarLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
