import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnTimelineItem } from '../materialize.js';
import {
  areWorkLogTimelineItemsEqual,
  areWorkLogTimelineListsEqual,
  resolveWorkLogOpen,
  shouldAutoCollapseWorkLog,
  splitTimelineAtLastTool,
} from '../turn-work-log.js';

const text = (value: string): TurnTimelineItem => ({
  kind: 'text',
  text: value,
  messageId: value,
});

const tool = (id: string): TurnTimelineItem => ({
  kind: 'tools',
  items: [{ toolUseId: id, toolName: 'Bash', status: 'completed', args: {} }],
});

describe('turn work-log timeline split', () => {
  it('auto-collapses only when a live process settles', () => {
    assert.equal(shouldAutoCollapseWorkLog(true, false), true);
    assert.equal(shouldAutoCollapseWorkLog(true, true), false);
    assert.equal(shouldAutoCollapseWorkLog(false, false), false);
  });

  it('resolves the work log closed in the same render that live mode settles', () => {
    assert.equal(resolveWorkLogOpen(true, true, false), false);
    assert.equal(resolveWorkLogOpen(true, true, true), true);
    assert.equal(resolveWorkLogOpen(false, false, false), false);
  });

  it('treats recreated but unchanged narration as memo-equivalent', () => {
    const previous = text('稳定的过程说明');
    const recreated = text('稳定的过程说明');
    const changed = text('发生变化的过程说明');

    assert.equal(areWorkLogTimelineItemsEqual(previous, recreated), true);
    assert.equal(areWorkLogTimelineItemsEqual(previous, changed), false);
    assert.equal(areWorkLogTimelineListsEqual([previous], [recreated]), true);
  });

  it('invalidates memoized tool groups when a tool object changes', () => {
    const stableTool = tool('command-1');
    const stableItems = stableTool.kind === 'tools' ? stableTool.items : [];
    const sameToolsNewGroup: TurnTimelineItem = {
      kind: 'tools',
      items: [...stableItems],
    };
    const changedTool: TurnTimelineItem = {
      kind: 'tools',
      items: stableItems.map((item) => ({ ...item, status: 'running' as const })),
    };

    assert.equal(areWorkLogTimelineItemsEqual(stableTool, sameToolsNewGroup), true);
    assert.equal(areWorkLogTimelineItemsEqual(stableTool, changedTool), false);
  });

  it('keeps model narration interleaved with tools and leaves the final answer outside', () => {
    const narration = text('先检查实现');
    const command = tool('command-1');
    const followup = text('命令已通过，接下来收尾');
    const secondCommand = tool('command-2');
    const finalAnswer = text('修改完成。');

    const result = splitTimelineAtLastTool([
      narration,
      command,
      followup,
      secondCommand,
      finalAnswer,
    ]);

    assert.deepEqual(result.workLog, [narration, command, followup, secondCommand]);
    assert.deepEqual(result.answer, [finalAnswer]);
  });

  it('does not add a work disclosure to a text-only response', () => {
    const answer = text('直接回答');
    assert.deepEqual(splitTimelineAtLastTool([answer]), {
      workLog: [],
      answer: [answer],
    });
  });

  it('filters provider reasoning before splitting the process log and final answer', () => {
    const command = tool('command-1');
    const finalReasoning: TurnTimelineItem = {
      kind: 'thinking',
      text: '确认命令结果后组织最终回答。',
      messageId: 'final-step',
    };
    const finalAnswer = text('最终回答。');

    assert.deepEqual(splitTimelineAtLastTool([command, finalReasoning, finalAnswer]), {
      workLog: [command],
      answer: [finalAnswer],
    });
  });

  it('never renders raw provider reasoning inside the work log', () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TurnView, {
        turn: {
          turnId: 'turn-1',
          status: 'completed',
          partialOutputRetained: false,
          tools: [],
          notes: [],
          startedAt: 1,
          timeline: [
            {
              kind: 'thinking',
              text: 'The user is asking for local modifications.',
              messageId: 'step-1',
            },
            tool('command-1'),
          ],
        },
        liveStreaming: {},
      }),
    }));

    assert.match(markup, /data-turn-work-log="true"/);
    assert.doesNotMatch(markup, /The user is asking for local modifications/);
    assert.doesNotMatch(markup, /data-work-log-narration/);
    assert.doesNotMatch(markup, />深度思考</);
  });

  it('does not render a trailing thinking disclosure beside the final answer', () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TurnView, {
        turn: {
          turnId: 'turn-final',
          status: 'completed',
          partialOutputRetained: false,
          tools: [],
          notes: [],
          startedAt: 1,
          timeline: [
            tool('command-final'),
            { kind: 'thinking', text: '整理结果。', messageId: 'final-step' },
            text('这是最终回答。'),
          ],
        },
        liveStreaming: {},
      }),
    }));

    assert.doesNotMatch(markup, /整理结果。/);
    assert.doesNotMatch(markup, /data-work-log-narration/);
    assert.match(markup, /这是最终回答。/);
    assert.doesNotMatch(markup, />深度思考</);
  });

  it('hides reasoning for text-only answers as well', () => {
    const reasoning: TurnTimelineItem = {
      kind: 'thinking',
      text: 'I should answer the user in Chinese.',
      messageId: 'reasoning-only',
    };
    const finalAnswer = text('只显示这段中文回答。');

    assert.deepEqual(splitTimelineAtLastTool([reasoning, finalAnswer]), {
      workLog: [],
      answer: [finalAnswer],
    });
  });

  it('does not render the heavy work-log body while settled and folded', () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(TurnView, {
        turn: {
          turnId: 'turn-folded',
          status: 'completed',
          partialOutputRetained: false,
          tools: [],
          notes: [],
          startedAt: 1,
          timeline: [
            { kind: 'thinking', text: '不应提前渲染的大段过程。', messageId: 'step-1' },
            tool('command-folded'),
            text('最终回答保持可见。'),
          ],
        },
      }),
    }));

    assert.match(markup, /data-turn-work-log="true"/);
    assert.doesNotMatch(markup, /data-turn-work-log-body="true"/);
    assert.doesNotMatch(markup, /不应提前渲染的大段过程。/);
    assert.match(markup, /最终回答保持可见。/);
  });
});
