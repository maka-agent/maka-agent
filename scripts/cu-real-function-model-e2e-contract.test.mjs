import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./cu-real-function-model-e2e.mjs', import.meta.url), 'utf8');

test('real function model E2E is synthetic, serial, semantic, and fail closed', () => {
  assert.match(source, /gpt-5\.6-sol/);
  assert.match(source, /parallel_tool_calls: false/);
  assert.match(source, /SYNTHETIC_COMPUTER_TOOL_PROPERTIES/);
  assert.match(source, /createOpenAIStrictObjectSchema/);
  assert.match(source, /projectOpenAIStrictFunctionArgs/);
  assert.match(source, /allowedKeysByAction/);
  assert.match(source, /discardedKeys/);
  assert.match(source, /Never invent observation or element IDs/);
  assert.match(
    source,
    /Coordinate click, scroll, drag, press_key, type, and pixel fallback are disabled/,
  );
  assert.doesNotMatch(source, /finalText: bounded/);
  assert.doesNotMatch(source, /coordinate: \{|scroll_amount|start_coordinate/);
});
