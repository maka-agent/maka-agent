import type { SessionSummary } from '@maka/core';
import { SessionListPanel } from '@maka/ui';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export function makeSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    name: '测试会话',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    model: 'test-model',
    permissionMode: 'ask',
    ...overrides,
  };
}

export function renderSessionListPanel(options: {
  session?: Partial<SessionSummary>;
  rowActions?: Parameters<typeof SessionListPanel>[0]['rowActions'];
} = {}): string {
  const rowActions = options.rowActions ?? {
    onToggleFlag() {},
    onArchive() {},
    onUnarchive() {},
    onRename() {},
    onDelete() {},
  };

  return renderToStaticMarkup(createElement(SessionListPanel, {
    selection: { section: 'sessions', filter: 'chats' },
    sessions: [makeSessionSummary(options.session)],
    onSelectSession() {},
    onSelect() {},
    onOpenSettings() {},
    onNew() {},
    rowActions,
  } satisfies Parameters<typeof SessionListPanel>[0]));
}
