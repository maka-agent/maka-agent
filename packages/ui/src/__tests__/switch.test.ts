import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Checkbox, Radio, Switch } from '../ui.js';

test('Switch uses compact flat geometry with a full pointer-coarse target', () => {
  const markup = renderToStaticMarkup(
    createElement(Switch, { 'aria-label': 'Example switch' }),
  );

  assert.match(markup, /\bh-4\.5\b/);
  assert.match(markup, /\bw-8\b/);
  assert.match(markup, /pointer-coarse:after:min-h-11/);
  assert.doesNotMatch(markup, /\bborder-input\b/);
  assert.doesNotMatch(markup, /\bshadow-sm\b/);
});

test('Checkbox and Radio match the same flat selection-control language', () => {
  const markups = [
    renderToStaticMarkup(createElement(Checkbox, { 'aria-label': 'Example checkbox' })),
    renderToStaticMarkup(createElement(Radio, { 'aria-label': 'Example radio', value: 'example' })),
  ];
  for (const markup of markups) {
    assert.match(markup, /pointer-coarse:after:min-h-11/);
    assert.doesNotMatch(markup, /\bshadow-sm\b/);
    assert.doesNotMatch(markup, /ring-offset/);
  }
});
