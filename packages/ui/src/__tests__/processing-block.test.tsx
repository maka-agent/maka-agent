import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import type { ToolActivityItem, TurnViewModel } from '../materialize.js';
import { TurnView } from '../chat-turn.js';

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

function turnWithTools(tools: ToolActivityItem[]): TurnViewModel {
  return {
    turnId: 'turn-1',
    status: 'completed',
    partialOutputRetained: false,
    tools,
    notes: [],
    timeline: [
      { kind: 'thinking', text: 'reasoning', messageId: 'a1' },
      { kind: 'tools', items: tools },
    ],
    startedAt: 1,
  };
}

describe('ProcessingBlock disclosure wiring (#1307)', () => {
  it('a waiting_permission tool inside the block forces the disclosure open', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'w1', toolName: 'Write', activityKind: 'edit', status: 'waiting_permission', args: {}, intent: '写入配置' },
      ]),
    }));
    // The folded run renders as one Processing block whose panel is OPEN —
    // the nested tool trow (and thereby the actionable permission row) is in
    // the static markup, not hidden behind the collapsed summary.
    assert.match(markup, /data-processing="block"/);
    assert.match(markup, /data-trow="group"/);
  });

  it('ordinary settled work stays collapsed (no panel content in static markup)', () => {
    const markup = renderToStaticMarkup(createElement(TurnView, {
      turn: turnWithTools([
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      ]),
    }));
    assert.match(markup, /data-processing="block"/);
    assert.doesNotMatch(markup, /data-trow="group"/);
  });
});
