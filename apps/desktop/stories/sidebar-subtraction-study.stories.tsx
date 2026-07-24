import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { SessionSummary } from '@maka/core';
import { SessionListPanel, type SessionViewMode } from '@maka/ui';

const NOW = Date.UTC(2026, 6, 1, 9, 30, 0);
const noop = () => undefined;

const sessions: SessionSummary[] = [
  makeSession('running', '生成本周 benchmark 对比表', 'running', 2),
  makeSession('waiting', '等待权限确认的部署任务', 'waiting_for_user', 8),
  makeSession('active', '整理 Storybook 表面覆盖', 'active', 14),
  makeSession('done', '已完成的 smoke 回归', 'done', 180),
];

function makeSession(id: string, name: string, status: SessionSummary['status'], minutesAgo: number): SessionSummary {
  return {
    id,
    name,
    status,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: id === 'active',
    lastMessageAt: NOW - minutesAgo * 60_000,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
  };
}

const statusGroups = [
  { id: 'running', label: '进行中', sessions: sessions.filter((session) => session.status === 'running'), collapsible: false, defaultExpanded: true },
  { id: 'waiting', label: '等待你', sessions: sessions.filter((session) => session.status === 'waiting_for_user'), collapsible: false, defaultExpanded: true },
  { id: 'active', label: '最近', sessions: sessions.filter((session) => session.status === 'active'), collapsible: false, defaultExpanded: true },
  { id: 'done', label: '已完成', sessions: sessions.filter((session) => session.status === 'done'), collapsible: true, defaultExpanded: false },
];

const rowActions = {
  onToggleFlag: noop,
  onArchive: noop,
  onUnarchive: noop,
  onRename: noop,
  onDelete: noop,
};

type StudyVariant = 'current' | 'extensions-hub' | 'compact-grouping' | 'balanced' | 'minimal';

const variants: Array<{ variant: StudyVariant; label: string; description: string }> = [
  { variant: 'current', label: '0 · 现状', description: '扩展树 + 每日回顾 + 定时任务 + 常驻分组切换' },
  { variant: 'extensions-hub', label: 'A · 合并扩展', description: '技能 / MCP 改为扩展主界面内的选择；其余不动' },
  { variant: 'compact-grouping', label: 'B · 收起分组', description: '在 A 上把分组切换收进会话列表头' },
  { variant: 'balanced', label: 'C · 归并回顾', description: '在 B 上把每日回顾归入定时任务主界面' },
  { variant: 'minimal', label: 'D · 移走设置', description: '在 C 上由未来的顶栏溢出菜单承接设置' },
];

function SidebarVariant(props: { variant: StudyVariant; label: string; description: string }) {
  const [viewMode, setViewMode] = useState<SessionViewMode>('status');
  return (
    <section style={{ display: 'grid', gridTemplateRows: 'auto 680px', gap: 10, minWidth: 0 }}>
      <header style={{ minHeight: 48, paddingInline: 4 }}>
        <h2 style={{ margin: 0, color: 'var(--foreground)', fontSize: 14, fontWeight: 600 }}>{props.label}</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--muted-foreground)', fontSize: 11, lineHeight: 1.4 }}>{props.description}</p>
      </header>
      <div
        className="maka-panel maka-panel-list maka-floating-panel"
        style={{ width: 250, minWidth: 250, height: 680, overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 10 }}
      >
        <SessionListPanel
          selection={{ section: 'sessions', filter: 'chats' }}
          sessions={sessions}
          activeId="active"
          statusGroups={statusGroups}
          streamingSessionIds={new Set(['running'])}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onSelect={noop}
          onSelectSession={noop}
          onOpenSettings={noop}
          onNew={noop}
          rowActions={rowActions}
          studyVariant={props.variant}
        />
      </div>
    </section>
  );
}

const meta = {
  title: 'Design Studies/Sidebar Subtraction',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SideBySide: Story = {
  render: () => (
    <main
      data-maka-e2e-fixture="true"
      style={{
        minHeight: '100vh',
        overflowX: 'auto',
        background: 'var(--surface-canvas)',
        padding: '28px 32px 36px',
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 250px)', gap: 16, width: 'max-content', marginInline: 'auto' }}>
        {variants.map((variant) => <SidebarVariant key={variant.variant} {...variant} />)}
      </div>
    </main>
  ),
};
