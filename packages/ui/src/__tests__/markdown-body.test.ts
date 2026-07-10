import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import { MarkdownBody } from '../markdown-body.js';
import { MakaUriContext } from '../markdown.js';

it('keeps raw HTML inert instead of expanding the Markdown trust surface', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '<details open><summary>Click</summary>payload</details>',
  }));

  assert.match(markup, /&lt;details open&gt;/);
  assert.doesNotMatch(markup, /<details/);
});

it('exposes one stable Maka root around rendered Markdown blocks', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '# Heading\n\nparagraph',
  }));

  assert.match(markup, /^<div class="[^"]*\bmaka-markdown-root\b[^"]*">/);
});

it('preserves allowlisted Maka navigation links through sanitization', () => {
  const markup = renderToStaticMarkup(
    createElement(
      MakaUriContext.Provider,
      { value: () => {} },
      createElement(MarkdownBody, {
        text: '[Account](maka://settings/account)',
      }),
    ),
  );

  assert.match(markup, /<button[^>]*class="maka-markdown-link maka-markdown-link-internal"/);
  assert.match(markup, /data-maka-uri-kind="settings"/);
  assert.doesNotMatch(markup, /Blocked URL/);
});
