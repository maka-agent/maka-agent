/**
 * Tests for the pure stream-fade primitives (streaming UI rework): the
 * append-record ring (window slide, out-of-order snapshot ages, cap), the
 * word/char tokenizer. The subject lives in `@maka/ui`; the test rides in the desktop
 * workspace where node:test is wired, like trow-summary.test.ts.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createFadeRing,
  updateFadeRing,
  fadeBoundary,
  fadeAgeAt,
  tokenizeFade,
  FADE_MS,
} from '@maka/ui';

describe('updateFadeRing / fadeBoundary', () => {
  it('first observation seeds len with no batch (mount text is not new)', () => {
    const ring = createFadeRing();
    updateFadeRing(ring, 10, 1000);
    assert.equal(ring.batches.length, 0);
    // Nothing pending → boundary is the whole seeded length (no fade).
    assert.equal(fadeBoundary(ring), 10);
  });

  it('records a batch on growth starting at the previous length', () => {
    const ring = createFadeRing();
    updateFadeRing(ring, 10, 1000);
    updateFadeRing(ring, 14, 1050);
    assert.deepEqual(ring.batches, [{ start: 10, at: 1050 }]);
    // Boundary is the oldest live batch start — graphemes < 10 are stable.
    assert.equal(fadeBoundary(ring), 10);
  });

  it('prunes batches older than the fade window (boundary advances)', () => {
    const ring = createFadeRing();
    updateFadeRing(ring, 10, 1000);
    updateFadeRing(ring, 12, 1010); // batch A: start 10
    updateFadeRing(ring, 16, 1200); // batch B: start 12
    // Advance time so A is now older than FADE_MS but B is not.
    updateFadeRing(ring, 16, 1010 + FADE_MS);
    assert.deepEqual(ring.batches, [{ start: 12, at: 1200 }]);
    assert.equal(fadeBoundary(ring), 12);
  });

  it('shrink (session switch / clear) resets the ring', () => {
    const ring = createFadeRing();
    updateFadeRing(ring, 10, 1000);
    updateFadeRing(ring, 20, 1050);
    updateFadeRing(ring, 3, 1060); // shorter buffer → reset
    assert.deepEqual(ring.batches, []);
    assert.equal(ring.len, 3);
    assert.equal(fadeBoundary(ring), 3);
  });

  it('caps retained batches (oldest dropped, only advances the boundary)', () => {
    const ring = createFadeRing();
    updateFadeRing(ring, 0, 0);
    // 5 growths, cap at 3, small fadeMs so nothing prunes by time (all same-ish t).
    const bigFade = 10_000;
    for (let i = 1; i <= 5; i += 1) {
      updateFadeRing(ring, i, 1000 + i, bigFade, 3);
    }
    assert.equal(ring.batches.length, 3);
    // Kept the newest 3 batches: starts 2, 3, 4.
    assert.deepEqual(ring.batches.map((b) => b.start), [2, 3, 4]);
    assert.equal(fadeBoundary(ring), 2);
  });
});

describe('fadeAgeAt', () => {
  it('returns age from the batch that first covered the offset, order-independent', () => {
    const ring = createFadeRing();
    updateFadeRing(ring, 0, 0);
    updateFadeRing(ring, 5, 100); // batch: [0,5) at 100
    updateFadeRing(ring, 9, 160); // batch: [5,9) at 160
    const now = 200;
    // Query a later offset first, then an earlier one — result must not depend
    // on query order (snapshot ring is immutable during a render).
    assert.equal(fadeAgeAt(ring, 7, now), now - 160);
    assert.equal(fadeAgeAt(ring, 2, now), now - 100);
    // Offset before any batch start falls through to `now` → age 0.
    assert.equal(fadeAgeAt(ring, 0, now), now - 100);
  });

  it('never returns a negative age', () => {
    const ring = createFadeRing();
    updateFadeRing(ring, 0, 0);
    updateFadeRing(ring, 3, 100);
    // now < batch.at can happen with clock skew; clamp to 0.
    assert.equal(fadeAgeAt(ring, 1, 50), 0);
  });
});

describe('tokenizeFade', () => {
  it('groups whitespace and Latin word runs, per-grapheme for CJK', () => {
    const { tokens, length } = tokenizeFade('hi 你好', 0, 0);
    assert.equal(length, 5); // h i _ 你 好
    assert.deepEqual(
      tokens.map((t) => t.text),
      ['hi', ' ', '你', '好'],
    );
  });

  it('only non-space tokens at/after the boundary fade', () => {
    // boundary at grapheme 3 → "hi " is stable, "world" fades.
    const { tokens } = tokenizeFade('hi world', 0, 3);
    const faded = tokens.filter((t) => t.fade).map((t) => t.text);
    assert.deepEqual(faded, ['world']);
    // A whitespace token is never a fade token even past the boundary.
    assert.ok(!tokens.some((t) => t.fade && /\s/.test(t.text)));
  });

  it('honors the startOffset when computing per-token offsets', () => {
    const { tokens } = tokenizeFade('abc', 100, 101);
    assert.equal(tokens[0]?.offset, 100);
    // Single Latin run "abc" starts at 100 < 101 → does not fade.
    assert.equal(tokens[0]?.fade, false);
  });
});
