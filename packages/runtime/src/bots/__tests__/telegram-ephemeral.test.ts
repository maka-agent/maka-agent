import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { ephemeralDelayFromOptions, EPHEMERAL_REPLY_MIN_MS, EPHEMERAL_REPLY_MAX_MS } = __TEST__;

describe('ephemeralDelayFromOptions (PR-BOT-EPHEMERAL-REPLY-0)', () => {
  it('returns undefined when no options are provided', () => {
    assert.equal(ephemeralDelayFromOptions(undefined), undefined);
  });

  it('returns undefined when ephemeralTtlMs is missing', () => {
    assert.equal(ephemeralDelayFromOptions({}), undefined);
    assert.equal(ephemeralDelayFromOptions({ replyToMessageId: 'm-1' }), undefined);
  });

  it('returns undefined when ephemeralTtlMs is zero or negative (opt-out)', () => {
    assert.equal(ephemeralDelayFromOptions({ ephemeralTtlMs: 0 }), undefined);
    assert.equal(ephemeralDelayFromOptions({ ephemeralTtlMs: -1 }), undefined);
    assert.equal(ephemeralDelayFromOptions({ ephemeralTtlMs: -60_000 }), undefined);
  });

  it('returns undefined for non-finite ephemeralTtlMs (defends against NaN / Infinity)', () => {
    assert.equal(ephemeralDelayFromOptions({ ephemeralTtlMs: Number.NaN }), undefined);
    assert.equal(
      ephemeralDelayFromOptions({ ephemeralTtlMs: Number.POSITIVE_INFINITY }),
      undefined,
    );
  });

  it('floors a too-small TTL at the minimum so an immediate self-delete cannot race the send', () => {
    // 100ms requested — clamp up to MIN so we never schedule a delete
    // that could fire before the Telegram receiver finishes rendering.
    assert.equal(ephemeralDelayFromOptions({ ephemeralTtlMs: 100 }), EPHEMERAL_REPLY_MIN_MS);
    assert.equal(ephemeralDelayFromOptions({ ephemeralTtlMs: 1 }), EPHEMERAL_REPLY_MIN_MS);
  });

  it('passes through TTLs within the valid window', () => {
    assert.equal(ephemeralDelayFromOptions({ ephemeralTtlMs: 5 * 60 * 1_000 }), 5 * 60 * 1_000);
    assert.equal(ephemeralDelayFromOptions({ ephemeralTtlMs: 60 * 60 * 1_000 }), 60 * 60 * 1_000);
  });

  it('caps a too-large TTL at the 48-hour bot self-delete window', () => {
    // Telegram silently refuses bot self-delete past 48 hours in DMs,
    // so scheduling a longer timer would be a no-op surprise.
    assert.equal(
      ephemeralDelayFromOptions({ ephemeralTtlMs: 72 * 60 * 60 * 1_000 }),
      EPHEMERAL_REPLY_MAX_MS,
    );
    assert.equal(
      ephemeralDelayFromOptions({ ephemeralTtlMs: 7 * 24 * 60 * 60 * 1_000 }),
      EPHEMERAL_REPLY_MAX_MS,
    );
  });
});
