import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionBlockedReason, SessionStatus, SessionSummary } from '@maka/core';
import { SessionListPanel } from '../src/session-list-panel.js';

const NOW = Date.now();

const meta = {
  title: 'Product/Sidebar Session List',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type SessionListPanelProps = Parameters<typeof SessionListPanel>[0];
type StatusGroup = NonNullable<SessionListPanelProps['statusGroups']>[number];

const noop = () => undefined;

function makeSession(input: {
  id: string;
  name: string;
  status?: SessionStatus;
  blockedReason?: SessionBlockedReason;
  lastMessageAt?: number;
  isFlagged?: boolean;
  isArchived?: boolean;
  hasUnread?: boolean;
  backend?: SessionSummary['backend'];
  llmConnectionSlug?: string;
}): SessionSummary {
  const status = input.status ?? 'active';
  const isArchived = input.isArchived ?? status === 'archived';
  return {
    id: input.id,
    name: input.name,
    isFlagged: input.isFlagged ?? false,
    isArchived,
    labels: [],
    hasUnread: input.hasUnread ?? false,
    status,
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    ...(input.lastMessageAt !== undefined ? { lastMessageAt: input.lastMessageAt } : {}),
    backend: input.backend ?? 'ai-sdk',
    llmConnectionSlug: input.llmConnectionSlug ?? 'zai-live',
    model: 'glm-4.7',
    permissionMode: 'ask',
  };
}

const rowActions: NonNullable<SessionListPanelProps['rowActions']> = {
  onToggleFlag: noop,
  onArchive: noop,
  onUnarchive: noop,
  onRename: noop,
  onDelete: noop,
};

function panelProps(input: {
  sessions: SessionSummary[];
  activeId?: string;
  statusGroups?: StatusGroup[];
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  sidebarCollapsed?: boolean;
}): SessionListPanelProps {
  return {
    selection: { section: 'sessions', filter: 'chats' },
    sessions: input.sessions,
    ...(input.activeId ? { activeId: input.activeId } : {}),
    ...(input.statusGroups ? { statusGroups: input.statusGroups } : {}),
    ...(input.streamingSessionIds ? { streamingSessionIds: input.streamingSessionIds } : {}),
    ...(input.staleSessionIds ? { staleSessionIds: input.staleSessionIds } : {}),
    ...(input.sidebarCollapsed ? { sidebarCollapsed: input.sidebarCollapsed } : {}),
    onSelectSession: noop,
    onSelect: noop,
    onOpenSettings: noop,
    onNew: noop,
    rowActions,
  };
}

function StoryFrame(props: {
  children: ReactNode;
  width?: number;
  height?: number;
  focusActiveRow?: boolean;
  openActiveRowMenu?: boolean;
}) {
  const { children, width = 240, height = 680, focusActiveRow = false, openActiveRowMenu = false } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusActiveRow && !openActiveRowMenu) return;
    let menuTimeout: number | undefined;
    const focusTimeout = window.setTimeout(() => {
      const activeRow = ref.current?.querySelector<HTMLElement>('.maka-list-row[data-active="true"]');
      activeRow?.querySelector<HTMLButtonElement>('.maka-list-row-main')?.focus({ preventScroll: true });
      if (openActiveRowMenu) {
        menuTimeout = window.setTimeout(() => {
          activeRow?.querySelector<HTMLButtonElement>('[aria-label="对话操作"]')?.click();
        }, 0);
      }
    }, 0);
    return () => {
      window.clearTimeout(focusTimeout);
      if (menuTimeout !== undefined) window.clearTimeout(menuTimeout);
    };
  }, [focusActiveRow, openActiveRowMenu]);

  return (
    <div
      ref={ref}
      data-maka-visual-smoke="true"
      style={{
        background: 'var(--surface-canvas)',
        height,
        overflow: 'hidden',
        width,
      }}
    >
      {children}
    </div>
  );
}

const coreSessions = [
  makeSession({
    id: 'session-running',
    name: '生成本周 benchmark 对比表',
    status: 'running',
    lastMessageAt: NOW - 2 * 60 * 1000,
  }),
  makeSession({
    id: 'session-active',
    name: 'Harbor adapter metadata 对齐',
    lastMessageAt: NOW - 18 * 60 * 1000,
    hasUnread: true,
  }),
  makeSession({
    id: 'session-stale',
    name: '旧连接里的模型选择',
    lastMessageAt: NOW - 42 * 60 * 1000,
    backend: 'fake',
    llmConnectionSlug: 'removed-connection',
  }),
  makeSession({
    id: 'session-pinned',
    name: 'PR #390 Storybook polish tracking',
    lastMessageAt: NOW - 76 * 60 * 1000,
    isFlagged: true,
  }),
];

const statusSessions = [
  makeSession({
    id: 'status-running',
    name: '运行中的工具链检查',
    status: 'running',
    lastMessageAt: NOW - 1 * 60 * 1000,
  }),
  makeSession({
    id: 'status-waiting',
    name: '等待权限确认',
    status: 'waiting_for_user',
    lastMessageAt: NOW - 8 * 60 * 1000,
    hasUnread: true,
  }),
  makeSession({
    id: 'status-blocked',
    name: 'OAuth 需要重新授权',
    status: 'blocked',
    blockedReason: 'auth',
    lastMessageAt: NOW - 20 * 60 * 1000,
  }),
  makeSession({
    id: 'status-review',
    name: '待审核的文件 diff',
    status: 'review',
    lastMessageAt: NOW - 37 * 60 * 1000,
  }),
  makeSession({
    id: 'status-done',
    name: '已完成的 smoke run',
    status: 'done',
    lastMessageAt: NOW - 2 * 60 * 60 * 1000,
  }),
  makeSession({
    id: 'status-archived',
    name: '归档的旧实验',
    status: 'archived',
    lastMessageAt: NOW - 8 * 24 * 60 * 60 * 1000,
  }),
  makeSession({
    id: 'status-aborted',
    name: '中止的临时尝试',
    status: 'aborted',
    lastMessageAt: NOW - 15 * 24 * 60 * 60 * 1000,
  }),
];

const statusGroups: StatusGroup[] = [
  {
    id: 'running',
    label: '进行中',
    sessions: statusSessions.filter((session) => session.status === 'running'),
    collapsible: false,
    defaultExpanded: true,
  },
  {
    id: 'waiting_for_user',
    label: '等待你',
    sessions: statusSessions.filter((session) => session.status === 'waiting_for_user'),
    collapsible: false,
    defaultExpanded: true,
  },
  {
    id: 'blocked',
    label: '需要处理',
    sessions: statusSessions.filter((session) => session.status === 'blocked'),
    collapsible: false,
    defaultExpanded: true,
  },
  {
    id: 'review',
    label: '待审核',
    sessions: statusSessions.filter((session) => session.status === 'review'),
    collapsible: false,
    defaultExpanded: true,
  },
  {
    id: 'done',
    label: '已完成',
    sessions: statusSessions.filter((session) => session.status === 'done'),
    collapsible: false,
    defaultExpanded: true,
  },
  {
    id: 'archived',
    label: '归档',
    sessions: statusSessions.filter((session) => session.status === 'archived'),
    collapsible: true,
    defaultExpanded: false,
  },
  {
    id: 'aborted',
    label: '已中止',
    sessions: statusSessions.filter((session) => session.status === 'aborted'),
    collapsible: true,
    defaultExpanded: false,
  },
];

const longListSessions = Array.from({ length: 36 }, (_, index) => makeSession({
  id: `long-list-${index + 1}`,
  name: `${index % 6 === 0 ? '已置顶 ' : ''}会话 ${String(index + 1).padStart(2, '0')} · ${
    [
      '整理发布前检查项',
      '跟进 UI 回归截图',
      '复盘运行时工具输出',
      '确认 provider 配置',
      '收敛 PR body',
      '处理 review 反馈',
    ][index % 6]
  }`,
  lastMessageAt: NOW - index * 47 * 60 * 1000,
  isFlagged: index === 0 || index === 6,
  hasUnread: index === 4 || index === 17,
}));

const longTitleSessions = [
  makeSession({
    id: 'long-title-active',
    name: '这是一个非常长的中文会话标题，用来检查窄侧边栏里标题、状态和时间不会互相挤压',
    lastMessageAt: NOW - 6 * 60 * 1000,
  }),
  makeSession({
    id: 'long-title-stale',
    name: 'Artifact Pane 验收路径和 sidebar row overflow menu 的长标题组合测试',
    status: 'blocked',
    blockedReason: 'permission_required',
    lastMessageAt: NOW - 31 * 60 * 1000,
  }),
  makeSession({
    id: 'long-title-pinned',
    name: 'PR #390 Sidebar session-list storyboard 状态覆盖范围确认',
    isFlagged: true,
    lastMessageAt: NOW - 52 * 60 * 1000,
  }),
];

export const Empty: Story = {
  render: () => (
    <StoryFrame>
      <SessionListPanel {...panelProps({ sessions: [] })} />
    </StoryFrame>
  ),
};

export const LongList: Story = {
  render: () => (
    <StoryFrame>
      <SessionListPanel {...panelProps({
        sessions: longListSessions,
        activeId: 'long-list-4',
      })} />
    </StoryFrame>
  ),
};

export const StatusGroups: Story = {
  render: () => (
    <StoryFrame>
      <SessionListPanel {...panelProps({
        sessions: statusSessions,
        activeId: 'status-waiting',
        statusGroups,
        streamingSessionIds: new Set(['status-running']),
        staleSessionIds: new Set(['status-blocked']),
      })} />
    </StoryFrame>
  ),
};

export const RowActions: Story = {
  render: () => (
    <StoryFrame focusActiveRow>
      <SessionListPanel {...panelProps({
        sessions: coreSessions,
        activeId: 'session-active',
        streamingSessionIds: new Set(['session-running']),
        staleSessionIds: new Set(['session-stale']),
      })} />
    </StoryFrame>
  ),
};

export const RowMenuOpen: Story = {
  render: () => (
    <StoryFrame openActiveRowMenu>
      <SessionListPanel {...panelProps({
        sessions: coreSessions,
        activeId: 'session-active',
        streamingSessionIds: new Set(['session-running']),
        staleSessionIds: new Set(['session-stale']),
      })} />
    </StoryFrame>
  ),
};

export const LongTitlesAndNarrow: Story = {
  render: () => (
    <StoryFrame width={176}>
      <SessionListPanel {...panelProps({
        sessions: longTitleSessions,
        activeId: 'long-title-active',
        staleSessionIds: new Set(['long-title-stale']),
      })} />
    </StoryFrame>
  ),
};

export const Collapsed: Story = {
  render: () => (
    <>
      <style>{`.agents-sidebar[data-collapsed="true"] { width: 100% !important }`}</style>
      <StoryFrame width={72}>
        <SessionListPanel {...panelProps({
          sessions: coreSessions,
          activeId: 'session-running',
          sidebarCollapsed: true,
        })} />
      </StoryFrame>
    </>
  ),
};
