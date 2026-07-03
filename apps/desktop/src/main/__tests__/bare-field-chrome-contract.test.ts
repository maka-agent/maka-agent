import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input, Textarea } from '@maka/ui';

const BARE_FIELD_RESET_CLASSES = [
  'appearance-none',
  'rounded-none',
  'border-0',
  'bg-transparent',
  'p-0',
  'text-inherit',
  'shadow-none',
  'outline-none',
  '[font:inherit]',
  'focus-visible:outline-none',
  'focus-visible:ring-0',
  'focus-visible:ring-offset-0',
  'disabled:cursor-not-allowed',
  'disabled:opacity-60',
];

function classAttribute(markup: string): string {
  const match = markup.match(/\bclass="([^"]*)"/);
  assert.ok(match, `expected rendered markup to include a class attribute: ${markup}`);
  return match[1] ?? '';
}

function assertBareField(markup: string): void {
  assert.match(markup, /\bdata-maka-field-chrome="none"/);
  const className = classAttribute(markup);
  for (const token of BARE_FIELD_RESET_CLASSES) {
    assert.match(className, new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`));
  }
  assert.doesNotMatch(className, /(?:^|\s)focus-visible:ring-2(?:\s|$)/);
  assert.doesNotMatch(className, /(?:^|\s)border-input(?:\s|$)/);
}

describe('bare field chrome contract', () => {
  it('renders unstyled Input as a real bare input', () => {
    const markup = renderToStaticMarkup(createElement(Input, { unstyled: true, 'aria-label': 'Search skills' }));

    assert.match(markup, /^<input\b/);
    assertBareField(markup);
  });

  it('renders unstyled Textarea as a real bare textarea', () => {
    const markup = renderToStaticMarkup(createElement(Textarea, { unstyled: true, 'aria-label': 'Prompt' }));

    assert.match(markup, /^<textarea\b/);
    assertBareField(markup);
  });

  it('keeps default field chrome on styled fields', () => {
    const markup = renderToStaticMarkup(createElement(Input, { 'aria-label': 'Named field' }));
    const className = classAttribute(markup);

    assert.doesNotMatch(markup, /\bdata-maka-field-chrome=/);
    assert.match(className, /(?:^|\s)border-input(?:\s|$)/);
    assert.match(className, /(?:^|\s)focus-visible:ring-2(?:\s|$)/);
  });
});
