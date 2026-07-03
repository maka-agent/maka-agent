import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InputGroup, InputGroupInput, InputGroupTextarea } from '../primitives/input-group.js';
import { Input as PrimitiveInput } from '../primitives/input.js';
import { Textarea as PrimitiveTextarea } from '../primitives/textarea.js';

test('primitive unstyled Input does not imply the field chrome opt-out', () => {
  const markup = renderToStaticMarkup(createElement(PrimitiveInput, {
    unstyled: true,
    nativeInput: true,
    'aria-label': 'Primitive input',
  }));

  assert.doesNotMatch(markup, /\bdata-maka-field-chrome=/);
  assert.match(markup, /data-slot="input"/);
  assert.match(markup, /\bh-8\.5\b/);
  assert.match(markup, /\bpx-\[calc\(--spacing\(3\)-1px\)\]/);
});

test('primitive unstyled Textarea does not imply the field chrome opt-out', () => {
  const markup = renderToStaticMarkup(createElement(PrimitiveTextarea, {
    unstyled: true,
    'aria-label': 'Primitive textarea',
  }));

  assert.doesNotMatch(markup, /\bdata-maka-field-chrome=/);
  assert.match(markup, /data-slot="textarea"/);
  assert.match(markup, /\bfield-sizing-content\b/);
  assert.match(markup, /\bpx-\[calc\(--spacing\(3\)-1px\)\]/);
});

test('InputGroup adapters explicitly opt their inner fields out of global chrome', () => {
  const inputMarkup = renderToStaticMarkup(
    createElement(InputGroup, { 'aria-label': 'Grouped input' },
      createElement(InputGroupInput, { nativeInput: true, 'aria-label': 'Grouped input field' }),
    ),
  );
  const textareaMarkup = renderToStaticMarkup(
    createElement(InputGroup, { 'aria-label': 'Grouped textarea' },
      createElement(InputGroupTextarea, { 'aria-label': 'Grouped textarea field' }),
    ),
  );

  assert.match(inputMarkup, /\bdata-maka-field-chrome="none"/);
  assert.match(inputMarkup, /\bh-8\.5\b/);
  assert.match(inputMarkup, /\bpx-\[calc\(--spacing\(3\)-1px\)\]/);
  assert.match(textareaMarkup, /\bdata-maka-field-chrome="none"/);
  assert.match(textareaMarkup, /\bfield-sizing-content\b/);
  assert.match(textareaMarkup, /\bpx-\[calc\(--spacing\(3\)-1px\)\]/);
});
