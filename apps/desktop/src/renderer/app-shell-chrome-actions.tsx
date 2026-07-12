import { CircleGauge, Grid3X3, HelpCircle, MessageCircleQuestion, PanelLeftClose, PanelLeftOpen, Search, SquarePen } from '@maka/ui/icons';
import { Button as UiButton, Tooltip, TooltipContent, TooltipTrigger } from '@maka/ui';

export function AppShellTopbarActions(props: {
  sidebarCollapsed: boolean;
  onOpenSearchModal(): void;
  onCollapseSidebar(): void;
  onExpandSidebar(): void;
  onCreateSession(): void;
}) {
  return (
    <div
      className={`maka-shell-topbar-rail ${props.sidebarCollapsed ? 'is-collapsed' : 'is-expanded'}`}
      aria-label="窗口快捷操作"
    >
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-shell-topbar-button"
          data-maka-search-trigger="true"
          onClick={props.onOpenSearchModal}
          aria-label="搜索对话"
        >
          <Search aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>搜索对话</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-shell-topbar-button"
          onClick={props.sidebarCollapsed ? props.onExpandSidebar : props.onCollapseSidebar}
          aria-label={props.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-expanded={!props.sidebarCollapsed}
        >
          {props.sidebarCollapsed ? (
            <PanelLeftOpen aria-hidden="true" />
          ) : (
            <PanelLeftClose aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipContent>{props.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}</TooltipContent>
      </Tooltip>
      {props.sidebarCollapsed && (
        <Tooltip>
          <TooltipTrigger
            render={<UiButton variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-shell-topbar-button"
            onClick={props.onCreateSession}
            aria-label="新任务"
          >
            <SquarePen aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>新任务</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function AppShellWorkspaceTopActions(props: {
  onOpenFeedback(): void;
  onOpenPalette(): void;
  onOpenHelp(): void;
  onOpenHealth(): void;
}) {
  return (
    <div className="maka-workspace-top-actions" role="toolbar" aria-label="工作区辅助操作">
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-workspace-icon-action"
          onClick={props.onOpenFeedback}
          aria-label="问题反馈"
        >
          <MessageCircleQuestion aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>问题反馈 · 打开关于与环境信息</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-workspace-icon-action"
          onClick={props.onOpenPalette}
          aria-label="打开命令面板"
        >
          <Grid3X3 aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>打开命令面板</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-workspace-icon-action"
          onClick={props.onOpenHelp}
          aria-label="打开帮助"
        >
          <HelpCircle aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>打开帮助</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-workspace-icon-action"
          onClick={props.onOpenHealth}
          aria-label="打开健康中心"
        >
          <CircleGauge aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>打开健康中心</TooltipContent>
      </Tooltip>
    </div>
  );
}