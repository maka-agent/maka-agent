/**
 * Tests for the window-state sanitization helper. The IO layer
 * (readSavedBounds / writeSavedBounds) catches its own errors and
 * silently falls back to defaults; what matters is `sanitizeBounds`
 * never producing a half-applied or unsafe BrowserWindow size.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { sanitizeBounds } from '../window-state.js';

const DEFAULTS = { width: 1240, height: 820 };

describe('sanitizeBounds', () => {
  it('returns defaults for null / undefined / non-object', () => {
    assert.deepEqual(sanitizeBounds(null, DEFAULTS), DEFAULTS);
    assert.deepEqual(sanitizeBounds(undefined, DEFAULTS), DEFAULTS);
    assert.deepEqual(sanitizeBounds('not a thing', DEFAULTS), DEFAULTS);
    assert.deepEqual(sanitizeBounds(42, DEFAULTS), DEFAULTS);
  });

  it('returns defaults when width or height missing / non-numeric', () => {
    assert.deepEqual(sanitizeBounds({ height: 600 }, DEFAULTS), DEFAULTS);
    assert.deepEqual(sanitizeBounds({ width: 800 }, DEFAULTS), DEFAULTS);
    assert.deepEqual(sanitizeBounds({ width: 'big', height: 600 }, DEFAULTS), DEFAULTS);
  });

  it('returns defaults when width or height below safe minimum', () => {
    // 320 minimum on height, 480 on width — anything smaller is treated as
    // corruption / pre-fullscreen sentinel and replaced with defaults.
    assert.deepEqual(sanitizeBounds({ width: 100, height: 600 }, DEFAULTS), DEFAULTS);
    assert.deepEqual(sanitizeBounds({ width: 800, height: 50 }, DEFAULTS), DEFAULTS);
    assert.deepEqual(sanitizeBounds({ width: 0, height: 0 }, DEFAULTS), DEFAULTS);
    assert.deepEqual(sanitizeBounds({ width: -100, height: -100 }, DEFAULTS), DEFAULTS);
  });

  it('keeps valid width + height, drops bad x/y', () => {
    assert.deepEqual(
      sanitizeBounds({ width: 800, height: 600, x: 'left', y: 100 }, DEFAULTS),
      { width: 800, height: 600 },
    );
    assert.deepEqual(
      sanitizeBounds({ width: 800, height: 600, x: Infinity, y: 0 }, DEFAULTS),
      { width: 800, height: 600 },
    );
  });

  it('keeps valid x + y alongside width + height', () => {
    assert.deepEqual(
      sanitizeBounds({ width: 800, height: 600, x: 100, y: 50 }, DEFAULTS),
      { width: 800, height: 600, x: 100, y: 50 },
    );
  });

  it('keeps isMaximized when boolean, drops otherwise', () => {
    assert.deepEqual(
      sanitizeBounds({ width: 800, height: 600, isMaximized: true }, DEFAULTS),
      { width: 800, height: 600, isMaximized: true },
    );
    assert.deepEqual(
      sanitizeBounds({ width: 800, height: 600, isMaximized: 'true' }, DEFAULTS),
      { width: 800, height: 600 },
    );
  });

  it('floors fractional pixel values', () => {
    // BrowserWindow expects integers; high-DPI screen restore can land at
    // fractional values. Floor them rather than reject.
    assert.deepEqual(
      sanitizeBounds({ width: 800.7, height: 600.3, x: 100.9, y: 50.1 }, DEFAULTS),
      { width: 800, height: 600, x: 100, y: 50 },
    );
  });
});
