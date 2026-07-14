import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('./cu-synthetic-model-scenario.mjs', import.meta.url),
  'utf8',
);

test('shared synthetic model scenario remains AX-semantic and exact-targeted', () => {
  assert.match(source, /enum: \['list_apps', 'observe', 'click_element', 'set_value'\]/);
  assert.match(source, /args\.observation_id !== state\.activeObservationId/);
  assert.match(source, /obs-fixture-\$\{\+\+state\.observationSequence\}/);
  assert.match(source, /case 'click_element'/);
  assert.match(source, /args\.element_id !== 'field-1'/);
  assert.match(source, /evidence: \{ path: 'ax', effect: 'confirmed' \}/);
  assert.match(source, /include_screenshot: true/);
  assert.doesNotMatch(source, /case 'left_click'|case 'scroll'|case 'press_key'/);
});
