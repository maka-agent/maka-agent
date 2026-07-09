/**
 * #646: the composer Stop reaches the model-wait window, and in that window the
 * hint must read "Maka 正在处理…" (matching the timeline's "正在处理…" indicator)
 * instead of "Maka 正在回答…" — nothing is being answered before the first token.
 * Once real output streams, the responding copy returns. Rendered via SSR like
 * the ChatView contract tests.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '@maka/ui';

function render(props: Partial<Parameters<typeof Composer>[0]>): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      onSend: () => {},
      onStop: () => {},
      ...props,
    }),
  );
}

describe('composer model-wait hint (#646)', () => {
  it('reads "正在处理…" while awaiting the first token (streaming + processing)', () => {
    const markup = render({ streaming: true, processing: true });
    assert.match(markup, /Maka 正在处理…/, 'the wait window matches the timeline indicator');
    assert.doesNotMatch(markup, /Maka 正在回答…/, 'nothing is being answered yet');
  });

  it('reads "正在回答…" once real output streams (streaming, not processing)', () => {
    const markup = render({ streaming: true, processing: false });
    assert.match(markup, /Maka 正在回答…/, 'live output uses the responding copy');
    assert.doesNotMatch(markup, /Maka 正在处理…/);
  });

  it('shows neither hint when idle (Send is offered, not Stop)', () => {
    const markup = render({ streaming: false });
    assert.doesNotMatch(markup, /Maka 正在处理…/);
    assert.doesNotMatch(markup, /Maka 正在回答…/);
  });
});
