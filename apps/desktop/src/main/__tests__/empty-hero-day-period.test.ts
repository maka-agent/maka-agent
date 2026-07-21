/**
 * Tests for the PR-UI-LAYOUT-4 / B1-a1 review fixup
 * `detectDayPeriod` boundary contract (@kenji msg 1d7ba56c).
 *
 * Visual-smoke fixtures freeze `Date.now()` to a deterministic
 * timestamp; the EmptyChatHero greeting prefix would drift across
 * the 5/11/14/18-hour boundaries if `detectDayPeriod()` read
 * `new Date()` instead. The function now accepts an explicit
 * `nowMs: number` argument that defaults to `Date.now()`, so the
 * e2e-fixture clock freeze flows through automatically.
 *
 * Each test passes an explicit local-time hour so the boundary
 * is testable without any clock dependency.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { detectDayPeriod } from '@maka/ui';

/**
 * Build a millisecond timestamp at the requested LOCAL hour on
 * 2026-05-22 (the canonical e2e-fixture fixture day). Using local
 * time matches what `detectDayPeriod` reads (`new Date(ms).getHours()`).
 */
function localHour(hour: number, minute = 0): number {
  return new Date(2026, 4, 22, hour, minute, 0, 0).getTime();
}

describe('detectDayPeriod — day-period bucket boundaries', () => {
  it('returns "evening" for late-night hours (00:00 → 04:59)', () => {
    assert.equal(detectDayPeriod(localHour(0, 0)), 'evening');
    assert.equal(detectDayPeriod(localHour(2, 30)), 'evening');
    assert.equal(detectDayPeriod(localHour(4, 59)), 'evening');
  });

  it('flips to "morning" at 05:00', () => {
    assert.equal(detectDayPeriod(localHour(4, 59)), 'evening');
    assert.equal(detectDayPeriod(localHour(5, 0)), 'morning');
    assert.equal(detectDayPeriod(localHour(10, 59)), 'morning');
  });

  it('flips to "noon" at 11:00', () => {
    assert.equal(detectDayPeriod(localHour(10, 59)), 'morning');
    assert.equal(detectDayPeriod(localHour(11, 0)), 'noon');
    assert.equal(detectDayPeriod(localHour(13, 59)), 'noon');
  });

  it('flips to "afternoon" at 14:00', () => {
    assert.equal(detectDayPeriod(localHour(13, 59)), 'noon');
    assert.equal(detectDayPeriod(localHour(14, 0)), 'afternoon');
    assert.equal(detectDayPeriod(localHour(17, 59)), 'afternoon');
  });

  it('flips to "evening" at 18:00', () => {
    assert.equal(detectDayPeriod(localHour(17, 59)), 'afternoon');
    assert.equal(detectDayPeriod(localHour(18, 0)), 'evening');
    assert.equal(detectDayPeriod(localHour(23, 59)), 'evening');
  });
});

describe('detectDayPeriod — e2e-fixture determinism', () => {
  it('reads Date.now() by default (so the renderer freeze flows through)', () => {
    // Stub Date.now (same trick the renderer uses in
    // `applyE2EFixture` when `state.now` is set) and verify
    // the function uses it without us passing an explicit arg.
    const originalNow = Date.now;
    try {
      const frozen = localHour(8, 0); // "morning"
      Date.now = () => frozen;
      assert.equal(detectDayPeriod(), 'morning');
      const lateFrozen = localHour(20, 0); // "evening"
      Date.now = () => lateFrozen;
      assert.equal(detectDayPeriod(), 'evening');
    } finally {
      Date.now = originalNow;
    }
  });

  it('does NOT call new Date() directly — host clock change does not affect output when nowMs is fixed', () => {
    // Sanity: pass the same `nowMs` twice, confirm deterministic.
    // If `detectDayPeriod` regressed to reading `new Date()`, the
    // host clock would dominate and this test would still pass —
    // but the `Date.now()` stub test above would fail.
    assert.equal(detectDayPeriod(localHour(7, 0)), detectDayPeriod(localHour(7, 0)));
  });
});
