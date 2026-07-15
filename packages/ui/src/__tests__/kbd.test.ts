import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Kbd, KbdGroup } from '../primitives/kbd.js';

test('KbdGroup groups physical keys without drawing a third outer keycap', () => {
  const markup = renderToStaticMarkup(
    createElement(
      KbdGroup,
      null,
      createElement(Kbd, null, '↑'),
      createElement(Kbd, null, '↓'),
    ),
  );

  assert.match(markup, /^<span\b[^>]*data-slot="kbd-group"/);
  assert.equal((markup.match(/<kbd\b/g) ?? []).length, 2);
});

test('Kbd owns one compact flat keycap recipe', () => {
  const markup = renderToStaticMarkup(createElement(Kbd, null, 'Esc'));

  assert.match(markup, /\bh-4\b/);
  assert.match(markup, /\bmin-w-4\b/);
  assert.match(markup, /\bbg-foreground\/4\b/);
  assert.match(markup, /\bfont-sans\b/);
  assert.doesNotMatch(markup, /\bborder\b/);
  assert.doesNotMatch(markup, /shadow/);
});
