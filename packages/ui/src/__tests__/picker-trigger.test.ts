import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerTriggerClasses } from '../ui.js';

test('picker triggers separate field chrome from quiet toolbar chrome', () => {
  const field = pickerTriggerClasses('field');
  const quiet = pickerTriggerClasses('quiet');

  assert.match(field, /\bmin-h-9\b/);
  assert.match(field, /\bw-full\b/);
  assert.match(field, /\bshadow-sm\b/);

  assert.doesNotMatch(quiet, /\bmin-h-9\b/);
  assert.doesNotMatch(quiet, /\bw-full\b/);
  assert.doesNotMatch(quiet, /\bshadow-/);
  assert.doesNotMatch(quiet, /\bborder-input\b/);
  assert.match(quiet, /focus-visible:ring-2/);
  assert.match(quiet, /disabled:pointer-events-none/);
});
