import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import {
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
  resetRelativeTimeFormatters,
} from '../relative-time.js';

beforeEach(() => {
  // Some test environments still have `navigator` from prior runs;
  // reset the cache so each case independently resolves the locale.
  resetRelativeTimeFormatters();
});

describe('formatRelativeTimestamp', () => {
  const NOW = Date.parse('2026-05-29T12:00:00Z');

  it('defaults to Chinese instead of the host navigator locale', () => {
    const out = formatRelativeTimestamp(NOW - 8_000, NOW);
    assert.match(out, /秒/);
    assert.doesNotMatch(out, /seconds?\s+ago/i);
  });

  it('clamps sub-second ages to >=1s so we never see "0 seconds ago"', () => {
    const out = formatRelativeTimestamp(NOW - 100, NOW);
    assert.match(out, /1.*second|秒|now|刚刚/i);
  });

  it('formats a 30-second age in seconds', () => {
    const out = formatRelativeTimestamp(NOW - 30_000, NOW);
    assert.match(out, /30.*second|秒/i);
  });

  it('formats a 5-minute age in minutes', () => {
    const out = formatRelativeTimestamp(NOW - 5 * 60_000, NOW);
    assert.match(out, /5.*minute|分钟/i);
  });

  it('formats against the explicitly resolved English locale', () => {
    const out = formatRelativeTimestamp(NOW - 5 * 60_000, NOW, 'en');
    assert.match(out, /5 minutes ago/i);
    assert.doesNotMatch(out, /分钟/);
  });

  it('formats against the explicitly resolved Chinese locale', () => {
    const out = formatRelativeTimestamp(NOW - 5 * 60_000, NOW, 'zh');
    assert.match(out, /5.*分钟/);
    assert.doesNotMatch(out, /minutes ago/i);
  });

  it('formats a 3-hour age in hours', () => {
    const out = formatRelativeTimestamp(NOW - 3 * 60 * 60_000, NOW);
    assert.match(out, /3.*hour|小时/i);
  });

  it('formats a 2-day age in days', () => {
    const out = formatRelativeTimestamp(NOW - 2 * 24 * 60 * 60_000, NOW);
    assert.match(out, /2.*day|天/i);
  });

  it('falls back to absolute date past the 7-day horizon', () => {
    const out = formatRelativeTimestamp(NOW - 30 * 24 * 60 * 60_000, NOW);
    // Absolute format includes the year (medium dateStyle).
    assert.match(out, /2026|4月|Apr|April/);
  });

  it('clamps future timestamps to "刚刚" instead of emitting "in N minutes"', () => {
    const out = formatRelativeTimestamp(NOW + 5 * 60_000, NOW);
    assert.doesNotMatch(out, /in 5 minutes|5 分钟后/);
    assert.match(out, /second|秒|now|刚刚/i);
  });
});

describe('nextRelativeRefreshDelay', () => {
  const NOW = Date.parse('2026-05-29T12:00:00Z');

  it('returns 1s when within the first minute', () => {
    assert.equal(nextRelativeRefreshDelay(NOW - 5_000, NOW), 1_000);
  });

  it('returns 60s when within the first hour', () => {
    assert.equal(nextRelativeRefreshDelay(NOW - 10 * 60_000, NOW), 60_000);
  });

  it('returns 10m when within the day window', () => {
    assert.equal(nextRelativeRefreshDelay(NOW - 5 * 60 * 60_000, NOW), 10 * 60_000);
  });

  it('returns null past the horizon (no further ticks needed)', () => {
    assert.equal(nextRelativeRefreshDelay(NOW - 30 * 24 * 60 * 60_000, NOW), null);
  });
});
