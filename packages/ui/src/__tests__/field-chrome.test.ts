import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input } from '../primitives/input.js';
import { Textarea } from '../primitives/textarea.js';
import { InputGroup, InputGroupInput, InputGroupTextarea } from '../primitives/input-group.js';

// #520 item 22: primitives/input + primitives/textarea are the canonical fields
// (the native ui.tsx Input/Textarea retired onto them). unstyled renders a
// bare single <input>/<textarea> carrying the field-chrome opt-out flag, and
// the InputGroup adapters explicitly opt their inner fields out so the
// InputGroup owns the chrome (no double chrome).
test('unstyled Input/Textarea opt out of field chrome and stay single elements', () => {
  const inputMarkup = renderToStaticMarkup(createElement(Input, { unstyled: true, 'aria-label': 'Bare input' }));
  const textareaMarkup = renderToStaticMarkup(createElement(Textarea, { unstyled: true, 'aria-label': 'Bare textarea' }));

  assert.match(inputMarkup, /^<input\b/, 'unstyled Input renders a single <input>');
  assert.match(inputMarkup, /data-slot="input"/);
  assert.match(inputMarkup, /data-maka-field-chrome="none"/);
  assert.doesNotMatch(inputMarkup, /border-input/);
  assert.doesNotMatch(inputMarkup, /focus-visible:ring-2/);

  assert.match(textareaMarkup, /^<textarea\b/, 'unstyled Textarea renders a single <textarea>');
  assert.match(textareaMarkup, /data-slot="textarea"/);
  assert.match(textareaMarkup, /data-maka-field-chrome="none"/);
});

test('InputGroup adapters keep their inner fields bare so InputGroup owns the chrome', () => {
  const inputMarkup = renderToStaticMarkup(
    createElement(InputGroup, { 'aria-label': 'Grouped input' },
      createElement(InputGroupInput, { 'aria-label': 'Grouped input field' }),
    ),
  );
  const textareaMarkup = renderToStaticMarkup(
    createElement(InputGroup, { 'aria-label': 'Grouped textarea' },
      createElement(InputGroupTextarea, { 'aria-label': 'Grouped textarea field' }),
    ),
  );

  assert.match(inputMarkup, /data-maka-field-chrome="none"/, 'InputGroupInput inner field opts out of chrome');
  assert.match(textareaMarkup, /data-maka-field-chrome="none"/, 'InputGroupTextarea inner field opts out of chrome');
  assert.match(inputMarkup, /data-slot="input"/);
  assert.match(textareaMarkup, /data-slot="textarea"/);
});