import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input, Textarea } from '@maka/ui';
import { REPO_ROOT } from './css-test-helpers.js';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// #22 PR10: collapse the dual Input tracks onto one canonical
// primitives/input.tsx. The native ui.tsx Input (single <input> + inputClasses)
// is retired; primitives/input keeps the same single-<input> shape (no span
// wrapper, so caller CSS targeting `> input` / `input:focus-visible` still
// matches) but uses Base UI's Input primitive underneath and ports maka's
// inputClasses styling as the default chrome so the 44 usages keep their look.
test('input canonical (#22 PR10)', async () => {
  const inputSrc = read('packages/ui/src/primitives/input.tsx');
  const textareaSrc = read('packages/ui/src/primitives/textarea.tsx');

  // 1. inputClasses + bareFieldClasses ported into primitives/input
  assert.match(inputSrc, /export const inputClasses/, 'inputClasses must be ported into primitives/input');
  assert.match(inputSrc, /export const bareFieldClasses/, 'bareFieldClasses must be ported into primitives/input');

  // 2. no span wrapper — single <input> so caller `> input` CSS still matches
  assert.doesNotMatch(inputSrc, /data-slot="input-control"/, 'primitives/input must drop the span wrapper (single <input>)');
  assert.doesNotMatch(textareaSrc, /data-slot="textarea-control"/, 'primitives/textarea must drop the span wrapper (single <textarea>)');

  // 3. default chrome reproduces inputClasses tokens (min-h-9, border-input, ring-2 ring-offset-2)
  assert.match(inputSrc, /min-h-9/, 'default chrome must keep min-h-9');
  assert.match(inputSrc, /border-input/, 'default chrome must keep border-input');
  assert.match(inputSrc, /focus-visible:ring-2/, 'default chrome must keep focus-visible:ring-2');
  assert.match(inputSrc, /focus-visible:ring-offset-2/, 'default chrome must keep focus-visible:ring-offset-2');

  // 4. ui.tsx Input/Textarea retired
  const uiSrc = read('packages/ui/src/ui.tsx');
  assert.doesNotMatch(uiSrc, /export (function|const) Input\b/, 'ui.tsx Input must be retired');
  assert.doesNotMatch(uiSrc, /export (function|const) Textarea\b/, 'ui.tsx Textarea must be retired');

  // 5. index.ts re-exports primitives/input + primitives/textarea as canonical
  const indexSrc = read('packages/ui/src/index.ts');
  assert.match(indexSrc, /primitives\/input\.js/, 'index.ts must re-export primitives/input');
  assert.match(indexSrc, /primitives\/textarea\.js/, 'index.ts must re-export primitives/textarea');

  // 6. bare-field-chrome: unstyled Input renders a single bare <input>
  const bareMarkup = renderToStaticMarkup(createElement(Input, { unstyled: true, 'aria-label': 'Search skills' }));
  assert.match(bareMarkup, /^<input\b/, 'unstyled Input must render a single <input>');
  assert.match(bareMarkup, /data-maka-field-chrome="none"/, 'unstyled Input must keep data-maka-field-chrome="none"');
  assert.match(bareMarkup, /data-slot="input"/, 'Input must carry data-slot="input"');

  // 7. styled Input renders a single <input> with chrome (not a span wrapper)
  const styledMarkup = renderToStaticMarkup(createElement(Input, { 'aria-label': 'Named field' }));
  assert.match(styledMarkup, /^<input\b/, 'styled Input must render a single <input>, not a span wrapper');
  assert.match(styledMarkup, /data-slot="input"/);
  assert.doesNotMatch(styledMarkup, /data-maka-field-chrome=/, 'styled Input must not carry data-maka-field-chrome');
  assert.match(styledMarkup, /border-input/, 'styled Input chrome must include border-input');
  assert.match(styledMarkup, /focus-visible:ring-2/, 'styled Input chrome must include focus-visible:ring-2');

  // 8. Textarea parallel shape
  const textareaMarkup = renderToStaticMarkup(createElement(Textarea, { 'aria-label': 'Prompt' }));
  assert.match(textareaMarkup, /^<textarea\b/, 'Textarea must render a single <textarea>');
  assert.match(textareaMarkup, /data-slot="textarea"/);
});