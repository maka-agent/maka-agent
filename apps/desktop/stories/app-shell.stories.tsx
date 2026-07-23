import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import type { ComponentProps } from 'react';
import type { SessionSummary, StoredMessage } from '@maka/core';
import { ChatView, Composer, SessionListPanel } from '@maka/ui';
import type { ChatModelChoice } from '@maka/ui';
import { AppShellTopbarActions, AppShellWorkspaceTopActions } from '../src/renderer/app-shell-chrome-actions';
import { OnboardingHero } from '../src/renderer/OnboardingHero';

const NOW = Date.UTC(2026, 6, 1, 9, 30, 0);

const meta = {
  title: 'Product/Shell Child Composition',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type ChatViewProps = ComponentProps<typeof ChatView>;
type ComposerProps = ComponentProps<typeof Composer>;
type SessionListPanelProps = ComponentProps<typeof SessionListPanel>;
type StatusGroup = NonNullable<SessionListPanelProps['statusGroups']>[number];

const noop = () => undefined;

const modelChoices: ChatModelChoice[] = [
  {
    connectionSlug: 'anthropic-main',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
  },
  {
    connectionSlug: 'openai-main',
    providerType: 'openai',
    model: 'gpt-5.1',
    label: 'GPT-5.1',
  },
];

function makeSession(input: {
  id: string;
  name: string;
  status?: SessionSummary['status'];
  lastMessageAt?: number;
  isFlagged?: boolean;
  hasUnread?: boolean;
}): SessionSummary {
  return {
    id: input.id,
    name: input.name,
    isFlagged: input.isFlagged ?? false,
    isArchived: false,
    labels: [],
    hasUnread: input.hasUnread ?? false,
    status: input.status ?? 'active',
    lastMessageAt: input.lastMessageAt ?? NOW - 12 * 60_000,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
  };
}

const sidebarSessions: SessionSummary[] = [
  makeSession({ id: 'session-running', name: '生成本周 benchmark 对比表', status: 'running', lastMessageAt: NOW - 2 * 60_000 }),
  makeSession({ id: 'session-active', name: '整理 Storybook 表面覆盖', lastMessageAt: NOW - 14 * 60_000, hasUnread: true }),
  makeSession({ id: 'session-waiting', name: '等待权限确认的部署任务', status: 'waiting_for_user', lastMessageAt: NOW - 8 * 60_000 }),
  makeSession({ id: 'session-pinned', name: 'PR #435 发布风险清单', lastMessageAt: NOW - 76 * 60_000, isFlagged: true }),
  makeSession({ id: 'session-review', name: '已完成的 smoke 回归', status: 'done', lastMessageAt: NOW - 3 * 60 * 60_000 }),
];

const statusGroups: StatusGroup[] = [
  { id: 'running', label: '进行中', sessions: sidebarSessions.filter((s) => s.status === 'running'), collapsible: false, defaultExpanded: true },
  { id: 'waiting_for_user', label: '等待你', sessions: sidebarSessions.filter((s) => s.status === 'waiting_for_user'), collapsible: false, defaultExpanded: true },
  { id: 'active', label: '最近', sessions: sidebarSessions.filter((s) => s.status === 'active'), collapsible: false, defaultExpanded: true },
  { id: 'done', label: '已完成', sessions: sidebarSessions.filter((s) => s.status === 'done'), collapsible: true, defaultExpanded: false },
];

const sidebarRowActions: NonNullable<SessionListPanelProps['rowActions']> = {
  onToggleFlag: noop,
  onArchive: noop,
  onUnarchive: noop,
  onRename: noop,
  onDelete: noop,
};

const activeSession = sidebarSessions[1];

function user(id: string, turnId: string, minutesAgo: number, text: string): StoredMessage {
  return { type: 'user', id, turnId, ts: NOW - minutesAgo * 60_000, text };
}

function assistant(id: string, turnId: string, minutesAgo: number, text: string): StoredMessage {
  return { type: 'assistant', id, turnId, ts: NOW - minutesAgo * 60_000, text, modelId: 'claude-sonnet-4-5' };
}

const conversation: StoredMessage[] = [
  user('msg-1', 'turn-1', 14, '帮我把这轮 Storybook 覆盖的风险列出来，只保留真正会影响 review 的部分。'),
  assistant('msg-2', 'turn-1', 12, '现在最值得先固定的是几个高频但还没有 story 的页面：权限弹窗、顶层布局、首次启动引导。把它们的可见状态摆出来，reviewer 就能在 Storybook 里逐个看，不用手动把 app 驱动到这些路径。'),
  user('msg-3', 'turn-2', 6, '顶层布局怎么处理？它依赖很多 IPC。'),
  assistant('msg-4', 'turn-2', 4, '不整体挂载 AppShell，改为用真实的子组件（侧栏、聊天区、顶栏）拼出布局。能稳定反映页面长什么样，又不被 IPC 耦合拖住。'),
];

const baseChatProps: ChatViewProps = {
  messages: conversation,
  activeSession,
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  userLabel: '你',
  onNew: noop,
  onPromptSuggestion: noop,
};

const baseComposerProps: ComposerProps = {
  draftKey: 'storybook-app-shell',
  onSend: noop,
  onStop: noop,
  modelLabel: 'Claude Sonnet 4.5',
  activeSession,
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  permissionMode: 'ask',
  onPermissionModeChange: noop,
	  workspacePicker: {
	    label: 'maka-agent',
	    branch: 'opencode/storybook-surface-coverage',
	    onOpen: noop,
	    onSelect: noop,
	  },
};

function ShellFrame(props: { children: ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{ background: 'var(--surface-canvas)', height: '100%', minHeight: 640 }}
    >
      {props.children}
    </div>
  );
}

// Composition smoke: mounts the real SessionListPanel + ChatView + Composer
// + topbar chrome pieces side-by-side. Does NOT mount the monolithic
// AppShell (1442 lines, heavy IPC coupling). When AppShell's internal
// layout shifts, this story may drift — it owns its own 2-col scaffold.
function ComposedShell(props: {
  sidebarCollapsed?: boolean;
  chat?: Partial<ChatViewProps>;
  composer?: Partial<ComposerProps>;
  detailChildren?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(props.sidebarCollapsed ?? false);
  const sidebarWidth = collapsed ? 0 : 260;

  return (
    <ShellFrame>
      <div
        className="app maka-shell-2col agents-layout-body"
        data-sidebar-state={collapsed ? 'collapsed' : 'expanded'}
        style={{
          ['--maka-session-list-width' as string]: `${sidebarWidth}px`,
          ['--maka-resize-handle-width' as string]: '0px',
          height: '100%',
        }}
      >
        <AppShellTopbarActions
          sidebarCollapsed={collapsed}
          onOpenSearchModal={noop}
          onCollapseSidebar={() => setCollapsed(true)}
          onExpandSidebar={() => setCollapsed(false)}
          onCreateSession={noop}
        />
        {!collapsed && (
          <div className="maka-panel maka-panel-list maka-floating-panel">
            <SessionListPanel
              selection={{ section: 'sessions', filter: 'chats' }}
              sessions={sidebarSessions}
              activeId={activeSession.id}
              statusGroups={statusGroups}
              streamingSessionIds={new Set(['session-running'])}
              onSelect={noop}
              onSelectSession={noop}
              onOpenSettings={noop}
              onNew={noop}
              rowActions={sidebarRowActions}
            />
          </div>
        )}
        <div
          className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
          data-sidebar-state={collapsed ? 'collapsed' : 'expanded'}
          data-agents-view="im_hub"
          style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
        >
          <AppShellWorkspaceTopActions
            workbarAvailable
            workbarCollapsed={false}
            onToggleWorkbar={noop}
            onOpenFeedback={noop}
            onOpenPalette={noop}
            onOpenHelp={noop}
            onOpenHealth={noop}
          />
          {props.detailChildren ?? (
            <div style={{ display: 'flex', minHeight: 0, width: '100%', flexDirection: 'column', flex: 1 }}>
              <ChatView {...baseChatProps} {...props.chat} />
              <div style={{ padding: '0 24px 24px' }}>
                <Composer {...baseComposerProps} {...props.composer} />
              </div>
            </div>
          )}
        </div>
      </div>
    </ShellFrame>
  );
}

export const DefaultLayout: Story = {
  render: () => <ComposedShell />,
};

export const CollapsedSidebar: Story = {
  render: () => <ComposedShell sidebarCollapsed />,
};

export const StreamingTurn: Story = {
  render: () => (
    <ComposedShell
      chat={{
        messages: [
          user('msg-s-1', 'turn-s', 3, '顶层布局的 story 怎么做最稳？'),
          { type: 'turn_state', id: 'state-s', turnId: 'turn-s', ts: NOW - 30_000, status: 'running', partialOutputRetained: false },
        ],
        liveTurn: {
          turnId: 'turn-s', phase: 'streamed', steps: [{
            stepId: 'msg-assistant-s',
            text: { text: '用真实的子组件拼出 2 栏布局，不整体挂载 AppShell，避开 IPC 耦合。', truncated: false, complete: false },
            tools: [],
          }],
        },
      }}
      composer={{ streaming: true }}
    />
  ),
};

export const WaitingForPermission: Story = {
  render: () => (
    <ComposedShell
      chat={{
        activeSession: { ...activeSession, status: 'waiting_for_user', blockedReason: 'permission_required' },
      }}
      composer={{
        disabled: true,
        activeSession: { ...activeSession, status: 'waiting_for_user', blockedReason: 'permission_required' },
        permissionModeDisabledReason: '当前有工具调用正在等待确认，处理后再切换权限模式。',
      }}
    />
  ),
};

export const EmptyHome: Story = {
  render: () => (
    <ComposedShell
      sidebarCollapsed
      detailChildren={
        <div style={{ margin: '0 auto', maxWidth: 720, padding: '48px 32px', width: '100%' }}>
          <OnboardingHero
            state={{ kind: 'ready_empty', defaultConnectionSlug: 'anthropic-main', defaultModel: 'claude-sonnet-4-5' }}
            onOpenSettings={noop}
            onAddProvider={noop}
            onBrowseProviders={noop}
            onQuickChatSubmit={async () => true}
          />
        </div>
      }
    />
  ),
};
