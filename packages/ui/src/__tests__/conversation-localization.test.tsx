import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  AnyPermissionRequestEvent,
  SessionSummary,
  UiLocale,
  UserQuestionRequestEvent,
} from '@maka/core';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyChatHero } from '../chat-empty-hero.js';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { PermissionPrompt } from '../permission-dialog.js';
import { SessionHistoryList } from '../session-history-list.js';
import { ToolTrow } from '../tool-activity.js';
import { summarizeTrowTools } from '../tool-activity/trow-summary.js';
import { UserQuestionPrompt } from '../user-question-prompt.js';

function render(locale: UiLocale, children: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider locale={locale}>{children}</LocaleProvider>);
}

const permissionRequest = {
  id: 'event-permission',
  turnId: 'turn-1',
  ts: 1,
  type: 'permission_request',
  kind: 'tool_permission',
  requestId: 'request-1',
  toolUseId: 'tool-1',
  toolName: 'RawShellTool',
  category: 'shell_unsafe',
  reason: 'shell_dangerous',
  args: { command: 'echo RAW_COMMAND_中文' },
  rememberForTurnAllowed: true,
} satisfies AnyPermissionRequestEvent;

const questionRequest = {
  id: 'event-question',
  turnId: 'turn-1',
  ts: 2,
  type: 'user_question_request',
  requestId: 'question-1',
  toolUseId: 'tool-question',
  questions: [{ question: 'RAW_QUESTION_中文', options: [{ label: 'RAW_OPTION_中文' }] }],
} satisfies UserQuestionRequestEvent;

const archivedSession = {
  id: 'session-archived',
  name: 'Archived conversation',
  isFlagged: false,
  isArchived: true,
  labels: [],
  hasUnread: false,
  status: 'archived',
  backend: 'ai-sdk',
  llmConnectionSlug: 'test-connection',
  connectionLocked: false,
  model: 'test-model',
  permissionMode: 'ask',
} satisfies SessionSummary;

describe('localized conversation journey', () => {
  it('renders coherent empty and composer states in Chinese and English', () => {
    const surface = (
      <>
        <EmptyChatHero userLabel="RawUser" />
        <Composer onSend={() => {}} onStop={() => {}} />
      </>
    );
    const zh = render('zh', surface);
    const en = render('en', surface);

    assert.match(zh, /aria-label="开始对话"/);
    // U6: placeholder teaches the @ 引用文件 / 选择技能 mentions in both locales.
    assert.match(zh, /placeholder="描述任务，@ 引用文件，\/ 选择技能…"/);
    assert.match(zh, /aria-label="发送"/);
    assert.match(en, /aria-label="Start a conversation"/);
    assert.match(en, /placeholder="Describe a task, @ to reference files, \/ for skills…"/);
    assert.match(en, /aria-label="Send"/);
    assert.doesNotMatch(en, /开始对话|描述任务|发送/);
    assert.match(en, /RawUser/);
  });

  it('surfaces the no-model dead-end hint and explanatory Send title (U3)', () => {
    const withHint = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} noModelConnection onOpenModelSettings={() => {}} />,
    );
    // Inline hint above the composer box + link-button into 模型 settings.
    assert.match(withHint, /maka-composer-no-model-hint/);
    assert.match(withHint, /还没有可用的模型连接，无法发送。/);
    assert.match(withHint, /maka-composer-no-model-hint-action[^>]*>前往模型设置</);
    // Disabled Send carries the explanatory title (not the neutral 发送 label).
    assert.match(withHint, /type="submit"[^>]*disabled[^>]*title="先添加一个模型连接才能发送。"/);
    // Default (a model connection exists) shows neither the hint nor the title.
    const noHint = render('zh', <Composer onSend={() => {}} onStop={() => {}} />);
    assert.doesNotMatch(noHint, /maka-composer-no-model-hint/);
    assert.doesNotMatch(noHint, /先添加一个模型连接才能发送。/);

    const en = render(
      'en',
      <Composer onSend={() => {}} onStop={() => {}} noModelConnection onOpenModelSettings={() => {}} />,
    );
    assert.match(en, /No model connection yet, so sending is unavailable\./);
    assert.match(en, /Go to model settings/);
  });

  it('renders the compact Plan Mode switch only when the session action is available', () => {
    const inactive = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} onPlanModeChange={() => {}} />,
    );
    assert.match(inactive, /maka-composer-plan-mode-control/);
    assert.match(inactive, />Plan</);
    assert.match(inactive, /role="switch"/);
    assert.match(inactive, /aria-label="开启 Plan Mode"/);
    assert.match(inactive, /aria-checked="false"/);

    const active = render(
      'en',
      <Composer
        onSend={() => {}}
        onStop={() => {}}
        planModeActive
        onPlanModeChange={() => {}}
      />,
    );
    assert.match(active, /aria-label="Disable Plan Mode"/);
    assert.match(active, /aria-checked="true"/);

    const unavailable = render('zh', <Composer onSend={() => {}} onStop={() => {}} />);
    assert.doesNotMatch(unavailable, /maka-composer-plan-mode-control/);
  });

  it('renders the compact Swarm Mode switch with localized state labels', () => {
    const inactive = render(
      'zh',
      <Composer onSend={() => {}} onStop={() => {}} onSwarmModeChange={() => {}} />,
    );
    assert.match(inactive, /maka-composer-swarm-mode-control/);
    assert.match(inactive, />Swarm</);
    assert.match(inactive, /aria-label="开启 Swarm Mode"/);
    assert.match(inactive, /aria-checked="false"/);

    const active = render(
      'en',
      <Composer onSend={() => {}} onStop={() => {}} swarmModeActive onSwarmModeChange={() => {}} />,
    );
    assert.match(active, /aria-label="Disable Swarm Mode"/);
    assert.match(active, /aria-checked="true"/);
  });

  it('localizes permission and question chrome while preserving raw values', () => {
    const surface = (
      <>
        <PermissionPrompt request={permissionRequest} onRespond={() => {}} onStop={() => {}} />
        <UserQuestionPrompt request={questionRequest} onRespond={() => {}} onStop={() => {}} />
      </>
    );
    const zh = render('zh', surface);
    const en = render('en', surface);

    assert.match(zh, /允许执行高风险 shell 命令？/);
    assert.match(zh, /允许操作/);
    assert.match(en, /Allow a high-risk shell command\?/);
    assert.match(en, />Allow</);
    assert.match(en, /Other/);
    for (const raw of ['RAW_QUESTION_中文', 'RAW_OPTION_中文']) {
      assert.match(zh, new RegExp(raw));
      assert.match(en, new RegExp(raw));
    }
  });

  it('localizes stale permission wait durations without mixing unit languages', () => {
    const staleRequest = {
      ...permissionRequest,
      ts: Date.now() - 6 * 60_000,
    } satisfies AnyPermissionRequestEvent;
    const zh = render(
      'zh',
      <PermissionPrompt request={staleRequest} onRespond={() => {}} onStop={() => {}} />,
    );
    const en = render(
      'en',
      <PermissionPrompt request={staleRequest} onRespond={() => {}} onStop={() => {}} />,
    );

    assert.match(zh, /已等待 6 分钟/);
    assert.match(en, /Waiting for 6 minutes/);
    assert.doesNotMatch(en, /分钟|小时/);
  });

  it('formats collapsed session-group counts with locale-correct punctuation', () => {
    const group = (label: string) => ({
      id: 'archived',
      label,
      sessions: [archivedSession],
      collapsible: true,
      defaultExpanded: false,
    });
    const zh = render(
      'zh',
      <SessionHistoryList
        sessions={[archivedSession]}
        statusGroups={[group('已归档')]}
        onSelectSession={() => {}}
      />,
    );
    const en = render(
      'en',
      <SessionHistoryList
        sessions={[archivedSession]}
        statusGroups={[group('Archived')]}
        onSelectSession={() => {}}
      />,
    );

    assert.match(zh, /已归档[\s\S]*（1）/);
    assert.match(en, /Archived[\s\S]*\(1\)/);
    assert.doesNotMatch(en, /Archived[\s\S]*（1）/);
  });

  it('localizes live tool activity without rewriting tool-owned text', () => {
    const tool = {
      toolUseId: 'tool-raw',
      toolName: 'RawTool',
      intent: 'RAW_INTENT_中文',
      status: 'running' as const,
      args: { command: 'RAW_COMMAND_中文' },
    };
    const zh = render('zh', <ToolTrow items={[tool]} />);
    const en = render('en', <ToolTrow items={[tool]} />);

    const summaryItems = [
      { toolUseId: 'read-1', toolName: 'Read', status: 'running' as const, args: {} },
      { toolUseId: 'read-2', toolName: 'Read', status: 'completed' as const, args: {} },
    ];
    assert.match(summarizeTrowTools(summaryItems, { live: true, locale: 'zh' }), /^正在/);
    assert.match(summarizeTrowTools(summaryItems, { live: true, locale: 'en' }), /^Working:/);
    assert.match(zh, /RAW_INTENT_中文/);
    assert.match(en, /RAW_INTENT_中文/);
  });
});
