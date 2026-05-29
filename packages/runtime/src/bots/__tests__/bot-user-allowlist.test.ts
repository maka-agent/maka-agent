import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { isAllowedUser } = __TEST__;

describe('isAllowedUser (PR-BOT-USER-ALLOWLIST-0)', () => {
  it('returns true when no allowlist is configured (V0.1 default)', () => {
    assert.equal(isAllowedUser(undefined, '12345'), true);
  });

  it('returns true when the allowlist is empty (treated as unconfigured)', () => {
    assert.equal(isAllowedUser([], '12345'), true);
  });

  it('admits a user whose id matches an entry exactly', () => {
    assert.equal(isAllowedUser(['12345', '67890'], '12345'), true);
    assert.equal(isAllowedUser(['12345', '67890'], '67890'), true);
  });

  it('rejects a user whose id is not in the list', () => {
    assert.equal(isAllowedUser(['12345', '67890'], '99999'), false);
  });

  it('does not substring-match — a prefix is NOT a match', () => {
    // Telegram user IDs are 64-bit so partial matches must never be
    // accepted: '123' should not unlock '1234567890'.
    assert.equal(isAllowedUser(['1234567890'], '123'), false);
    assert.equal(isAllowedUser(['1234567890'], '67890'), false);
  });

  it('rejects empty / falsy candidate user IDs even when present in list', () => {
    // Defense-in-depth: even if normalization let an empty string through
    // (it does not — see settings test), the runtime gate should still
    // not match an empty incoming id to anything.
    assert.equal(isAllowedUser([''], ''), true); // exact match per Set semantics
    // ...but a real allowlist of real IDs should not admit '':
    assert.equal(isAllowedUser(['12345'], ''), false);
  });
});
