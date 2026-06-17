import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add } from './src.mjs';

test('add sums its two arguments', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});
