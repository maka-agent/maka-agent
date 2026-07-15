import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Checkbox, Radio, Switch } from '../ui.js';

test('selection controls expose their native roles through stable slots', () => {
  const cases = [
    ['switch', renderToStaticMarkup(createElement(Switch, { 'aria-label': 'Example switch' }))],
    ['checkbox', renderToStaticMarkup(createElement(Checkbox, { 'aria-label': 'Example checkbox' }))],
    ['radio', renderToStaticMarkup(createElement(Radio, { 'aria-label': 'Example radio', value: 'example' }))],
  ];
  for (const [role, markup] of cases) {
    assert.match(markup, new RegExp(`role="${role}"`));
    assert.match(markup, new RegExp(`data-slot="${role}"`));
  }
});
