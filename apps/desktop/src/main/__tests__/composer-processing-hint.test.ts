/**
 * #646: the composer Stop reaches the model-wait window, and in that window the
 * hint must read "Maka 正在处理…" (matching the timeline's "正在处理…" indicator)
 * instead of "Maka 正在回答…" — nothing is being answered before the first token.
 * Once real output streams, the responding copy returns. Rendered via SSR like
 * the ChatView contract tests.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer, LocaleProvider } from '@maka/ui';

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'zh', children: child }),
  );
}

function render(props: Partial<Parameters<typeof Composer>[0]>): string {
  return renderWithLocale(
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

  it('reads "继续中…" in a mid-turn lull — Stop stays up without re-showing "正在处理…" (#646)', () => {
    const markup = render({ streaming: true, processing: false, continuing: true });
    assert.match(markup, /Maka 继续中…/, 'the step-to-step lull uses the calm continuation copy');
    assert.doesNotMatch(markup, /Maka 正在处理…/, 'the first-token copy must not re-appear mid-turn');
    assert.doesNotMatch(markup, /Maka 正在回答…/, 'and it is distinct from the live-answer copy');
  });

  it('shows neither hint when idle (Send is offered, not Stop)', () => {
    const markup = render({ streaming: false });
    assert.doesNotMatch(markup, /Maka 正在处理…/);
    assert.doesNotMatch(markup, /Maka 正在回答…/);
  });
});
