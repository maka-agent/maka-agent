import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { ModuleHubSwitch } from '../module-hub-switch.js';
import { SessionListPanel } from '../session-list-panel.js';
import { SessionSidebarNav } from '../session-sidebar-nav.js';

function renderSidebarNav(): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <SessionSidebarNav
        selection={{ section: 'sessions', filter: 'chats' }}
        onSelect={() => {}}
        onNew={() => {}}
      />
    </LocaleProvider>,
  );
}

describe('sidebar subtraction', () => {
  it('keeps only the hub-level destinations in permanent navigation', () => {
    const markup = renderSidebarNav();

    assert.match(markup, />新任务</);
    assert.match(markup, />扩展</);
    assert.match(markup, />定时任务</);
    assert.doesNotMatch(markup, />技能</);
    assert.doesNotMatch(markup, />MCP</);
    assert.doesNotMatch(markup, />每日回顾</);
    assert.doesNotMatch(markup, /aria-expanded=/);
  });

  it('renders the two hub switches as localized persistent choices', () => {
    const extensions = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <ModuleHubSwitch hub="extensions" value="skills" onChange={() => {}} />
      </LocaleProvider>,
    );
    const automations = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <ModuleHubSwitch hub="automations" value="plan-reminders" onChange={() => {}} />
      </LocaleProvider>,
    );

    assert.match(extensions, /aria-label="扩展内容"/);
    assert.match(extensions, />技能</);
    assert.match(extensions, />MCP</);
    assert.match(automations, /aria-label="定时任务内容"/);
    assert.match(automations, />计划提醒</);
    assert.match(automations, />每日回顾</);
  });

  it('moves session grouping from a permanent segmented control into the list heading', () => {
    const session: SessionSummary = {
      id: 'session-1',
      name: '侧栏减法',
      status: 'active',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      lastMessageAt: 1,
      backend: 'ai-sdk',
      llmConnectionSlug: 'anthropic-main',
      connectionLocked: false,
      model: 'claude-sonnet-4-5',
      permissionMode: 'ask',
    };
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <SessionListPanel
          selection={{ section: 'sessions', filter: 'chats' }}
          sessions={[session]}
          viewMode="status"
          onViewModeChange={() => {}}
          onSelectSession={() => {}}
          onSelect={() => {}}
          onOpenSettings={() => {}}
          onNew={() => {}}
        />
      </LocaleProvider>,
    );

    assert.match(markup, /class="maka-session-list-heading"[^>]*>会话</);
    assert.match(markup, /aria-label="会话分组方式"/);
    assert.doesNotMatch(markup, />按状态</);
    assert.doesNotMatch(markup, />按项目</);
  });
});
