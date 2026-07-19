import {
  CircleGauge,
  Grid3X3,
  HelpCircle,
  MessageCircleQuestion,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  SquarePen,
} from '@maka/ui/icons';
import { Button as UiButton, Tooltip, TooltipContent, TooltipTrigger, useUiLocale } from '@maka/ui';
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
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  const workbarLabel = props.workbarCollapsed ? copy.expandWorkbar : copy.collapseWorkbar;

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
