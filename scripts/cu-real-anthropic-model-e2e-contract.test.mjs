import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('./cu-real-anthropic-model-e2e.mjs', import.meta.url),
  'utf8',
);

test('Anthropic real-model E2E uses the shared semantic synthetic scenario', () => {
  assert.match(source, /claude-sonnet-4-6/);
  assert.match(source, /cu-synthetic-model-scenario/);
  assert.match(source, /type: 'tool_result'/);
  assert.match(source, /is_error: true/);
  assert.match(source, /invalid_semantic_binding/);
  assert.match(source, /Call observe again/);
  assert.match(source, /rejections/);
  assert.doesNotMatch(source, /finalText: bounded/);
  assert.match(source, /Never invent observation or element IDs/);
  assert.doesNotMatch(source, /case 'left_click'|case 'scroll'|case 'press_key'/);
});
