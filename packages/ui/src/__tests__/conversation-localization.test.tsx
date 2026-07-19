import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AnyPermissionRequestEvent, UiLocale, UserQuestionRequestEvent } from '@maka/core';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyChatHero } from '../chat-empty-hero.js';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { PermissionPrompt } from '../permission-dialog.js';
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
    assert.match(zh, /placeholder="描述任务…"/);
    assert.match(zh, /aria-label="发送"/);
    assert.match(en, /aria-label="Start a conversation"/);
    assert.match(en, /placeholder="Describe a task, \/ for commands, @ for context…"/);
    assert.match(en, /aria-label="Send"/);
    assert.doesNotMatch(en, /开始对话|描述任务|发送/);
    assert.match(en, /RawUser/);
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
