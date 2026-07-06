import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeResizeDimensions } from '../attachment-resize.js';

describe('computeResizeDimensions', () => {
  test('scales the longest edge down to the cap, preserving aspect ratio', () => {
    assert.deepEqual(computeResizeDimensions(3000, 2000, 2000), { width: 2000, height: 1333 });
  });

  test('returns null when the image already fits the cap', () => {
    assert.equal(computeResizeDimensions(2000, 1000, 2000), null);
    assert.equal(computeResizeDimensions(1000, 2000, 2000), null);
  });

  test('returns null for a zero-dimension image (cannot scale)', () => {
    assert.equal(computeResizeDimensions(0, 0, 2000), null);
  });
});
