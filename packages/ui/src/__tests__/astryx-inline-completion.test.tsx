import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatComposerInput } from '@astryxdesign/core';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Guard for the `inlineCompletion` half of
 * `patches/@astryxdesign+core+0.3.0.patch`.
 *
 * The behavior itself — Tab commits, Escape dismisses, the offer wraps and
 * scrolls with the field, the announcement — needs a caret and a focused
 * editor, so it is pinned by the `composer-inline-suggestion` play story in
 * the Storybook smoke run. What is checkable without a DOM is the seam: an
 * unpatched `ChatComposerInput` does not destructure `inlineCompletion`, so it
 * falls into `...rest`, reaches the root element, and React renders it as a
 * stray `inlinecompletion` attribute. That is the failure this catches, and it
 * is the same failure that would silently ship the feature as a no-op.
 *
 * Delete the patch when both assertions hold against an unpatched package.
 */
describe('Astryx ChatComposerInput inline completion', () => {
  it('consumes the offered completion instead of leaking it onto the DOM', () => {
    const markup = renderToStaticMarkup(
      <ChatComposerInput value="帮我把" inlineCompletion=" composer 的样式再收紧一点" />,
    );

    assert.doesNotMatch(markup, /inlinecompletion/i);
  });

  it('keeps an unaccepted completion out of the rendered value', () => {
    const markup = renderToStaticMarkup(
      <ChatComposerInput value="帮我把" inlineCompletion="绝不能出现在草稿里" />,
    );

    // Offered text is ephemeral: it exists only once the editor is focused
    // with the caret at the end, and it is never part of the value. A server
    // render has neither focus nor a caret, so nothing of it may appear.
    assert.doesNotMatch(markup, /绝不能出现在草稿里/);
    assert.match(markup, /contenteditable/i);
  });
});
