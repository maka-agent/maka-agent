import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input, Textarea, InputGroupInput, InputGroupTextarea } from '@maka/ui';

// #520 item 22: collapse the dual Input tracks onto one canonical
// primitives/input.tsx + primitives/textarea.tsx. Behavior contract only —
// what callers and CSS can observe. No source-regex: if a token moves but the
// rendered shape is wrong, the behavior assertions catch it; if a token moves
// but the shape is right, there is nothing to fix.

test('canonical Input: styled renders a single <input> with chrome', () => {
  const markup = renderToStaticMarkup(createElement(Input, { 'aria-label': 'Named field' }));
  assert.match(markup, /^<input\b/, 'styled Input must render a single <input>, not a span wrapper');
  assert.match(markup, /data-slot="input"/, 'Input must carry data-slot="input"');
  assert.doesNotMatch(markup, /data-maka-field-chrome=/, 'styled Input must not carry the field-chrome opt-out flag');
  assert.match(markup, /border-input/, 'styled Input chrome must include border-input');
  assert.match(markup, /focus-visible:ring-2/, 'styled Input chrome must include focus-visible:ring-2');
});

test('canonical Input: unstyled opts out of chrome and stays a single <input>', () => {
  const markup = renderToStaticMarkup(createElement(Input, { unstyled: true, 'aria-label': 'Bare input' }));
  assert.match(markup, /^<input\b/, 'unstyled Input must render a single <input>');
  assert.match(markup, /data-slot="input"/);
  assert.match(markup, /data-maka-field-chrome="none"/, 'unstyled Input must carry data-maka-field-chrome="none"');
  assert.doesNotMatch(markup, /border-input/, 'unstyled Input must not carry border-input chrome');
});

test('canonical Textarea: styled renders a single <textarea> with chrome', () => {
  const markup = renderToStaticMarkup(createElement(Textarea, { 'aria-label': 'Prompt' }));
  assert.match(markup, /^<textarea\b/, 'Textarea must render a single <textarea>, not a span wrapper');
  assert.match(markup, /data-slot="textarea"/);
  assert.match(markup, /border-input/, 'styled Textarea chrome must include border-input');
});

test('canonical Textarea: unstyled opts out of chrome', () => {
  const markup = renderToStaticMarkup(createElement(Textarea, { unstyled: true, 'aria-label': 'Bare textarea' }));
  assert.match(markup, /data-maka-field-chrome="none"/, 'unstyled Textarea must carry data-maka-field-chrome="none"');
  assert.doesNotMatch(markup, /border-input/, 'unstyled Textarea must not carry border-input chrome');
});

test('InputGroup adapters force the inner control bare even if caller passes unstyled={false}', () => {
  // InputGroupInput/InputGroupTextarea own the chrome; the inner control must
  // stay bare so there is no double border / focus ring. A caller passing
  // unstyled={false} must not re-enable the inner chrome (the spread-then-force
  // ordering in the adapter guarantees this).
  const inputMarkup = renderToStaticMarkup(
    createElement(InputGroupInput, { unstyled: false, type: 'search', 'aria-label': 'Search' }),
  );
  assert.match(inputMarkup, /data-maka-field-chrome="none"/, 'InputGroupInput must force data-maka-field-chrome="none"');
  assert.doesNotMatch(inputMarkup, /border-input/, 'InputGroupInput inner control must not carry border-input chrome');

  const textareaMarkup = renderToStaticMarkup(
    createElement(InputGroupTextarea, { unstyled: false, 'aria-label': 'Prompt' }),
  );
  assert.match(textareaMarkup, /data-maka-field-chrome="none"/, 'InputGroupTextarea must force data-maka-field-chrome="none"');
  assert.doesNotMatch(textareaMarkup, /border-input/, 'InputGroupTextarea inner control must not carry border-input chrome');
});

test('canonical Input: type="search" hides the native WebKit search widgets', () => {
  // Main's primitives/input always hid the WebKit cancel/decoration/results
  // widgets for type="search" so the app's own clear button is the single clear
  // affordance. The unified Input keeps this for both styled and bare (InputGroup)
  // search inputs.
  const styledMarkup = renderToStaticMarkup(createElement(Input, { type: 'search', 'aria-label': 'Search' }));
  // renderToStaticMarkup HTML-encodes `&` as `&amp;`, so match the encoded form.
  assert.match(styledMarkup, /&amp;::-webkit-search-cancel-button\]:appearance-none/, 'styled type="search" Input must hide the WebKit cancel button');

  const bareMarkup = renderToStaticMarkup(createElement(Input, { unstyled: true, type: 'search', 'aria-label': 'Bare search' }));
  assert.match(bareMarkup, /&amp;::-webkit-search-cancel-button\]:appearance-none/, 'bare type="search" Input (InputGroup path) must hide the WebKit cancel button');
});

test('canonical Input: type="text" does not carry the WebKit search reset', () => {
  const markup = renderToStaticMarkup(createElement(Input, { type: 'text', 'aria-label': 'Plain' }));
  assert.doesNotMatch(markup, /webkit-search-cancel-button/, 'type="text" Input must not carry the WebKit search reset');
});

test('barrel re-exports the canonical Input/Textarea/InputGroup adapters', () => {
  // Smoke: importing from @maka/ui resolves to the canonical primitives, not a
  // stale ui.tsx re-export. If the barrel pointed at ui.tsx (retired Input), this
  // import would either fail or resolve to a different component shape.
  assert.strictEqual(typeof Input, 'function', 'Input must be re-exported from @maka/ui');
  assert.strictEqual(typeof Textarea, 'function', 'Textarea must be re-exported from @maka/ui');
  assert.strictEqual(typeof InputGroupInput, 'function', 'InputGroupInput must be re-exported from @maka/ui');
  assert.strictEqual(typeof InputGroupTextarea, 'function', 'InputGroupTextarea must be re-exported from @maka/ui');
});