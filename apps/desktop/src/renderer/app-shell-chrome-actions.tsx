import { CircleGauge, Grid3X3, HelpCircle, MessageCircleQuestion, PanelLeftOpen, Search, SquarePen } from '@maka/ui/icons';
import { Button as UiButton } from '@maka/ui';

export function AppShellCollapsedTopbarActions(props: {
  onOpenSearchModal(): void;
  onExpandSidebar(): void;
  onCreateSession(): void;
}) {
  return (
    <div className="maka-collapsed-topbar-actions">
      <UiButton
        className="maka-collapsed-topbar-button"
        variant="quiet"
        size="icon-sm"
        type="button"
        onClick={props.onOpenSearchModal}
        aria-label="搜索对话"
        title="搜索对话"
      >
        <Search size={16} strokeWidth={1.65} aria-hidden="true" />
      </UiButton>
      <UiButton
        className="maka-collapsed-topbar-button"
        variant="quiet"
        size="icon-sm"
        type="button"
        onClick={props.onExpandSidebar}
        aria-label="展开侧边栏"
        title="展开侧边栏"
      >
        <PanelLeftOpen size={16} strokeWidth={1.65} aria-hidden="true" />
      </UiButton>
      <UiButton
        className="maka-collapsed-topbar-button"
        variant="quiet"
        size="icon-sm"
        type="button"
        onClick={props.onCreateSession}
        aria-label="新任务"
        title="新任务"
      >
        <SquarePen size={16} strokeWidth={1.65} aria-hidden="true" />
      </UiButton>
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
      <UiButton
        className="maka-workspace-icon-action"
        variant="quiet"
        size="icon-sm"
        type="button"
        onClick={props.onOpenFeedback}
        aria-label="问题反馈"
        title="问题反馈 · 打开关于与环境信息"
      >
        <MessageCircleQuestion size={15} strokeWidth={1.7} aria-hidden="true" />
      </UiButton>
      <UiButton
        className="maka-workspace-icon-action"
        variant="quiet"
        size="icon-sm"
        type="button"
        onClick={props.onOpenPalette}
        aria-label="打开命令面板"
        title="打开命令面板"
      >
        <Grid3X3 size={15} strokeWidth={1.7} aria-hidden="true" />
      </UiButton>
      <UiButton
        className="maka-workspace-icon-action"
        variant="quiet"
        size="icon-sm"
        type="button"
        onClick={props.onOpenHelp}
        aria-label="打开帮助"
        title="打开帮助"
      >
        <HelpCircle size={15} strokeWidth={1.7} aria-hidden="true" />
      </UiButton>
      <UiButton
        className="maka-workspace-icon-action"
        variant="quiet"
        size="icon-sm"
        type="button"
        onClick={props.onOpenHealth}
        aria-label="打开健康中心"
        title="打开健康中心"
      >
        <CircleGauge size={15} strokeWidth={1.7} aria-hidden="true" />
      </UiButton>
    </div>
  );
}
