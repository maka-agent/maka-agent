import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_CONFIGURATION_REASONS,
  describeChatConfigurationReason,
  parseNoRealConnectionError,
} from '../connection-error-copy.js';

describe('describeChatConfigurationReason', () => {
  it('returns distinct, non-empty fix copy for every reason', () => {
    // CHAT_CONFIGURATION_REASONS derives from the copy table's keys, which is
    // typed Record<ChatConfigurationReason, string> — adding a reason (missing
    // key) or removing one (excess key) already fails the build, so this needs no
    // hardcoded count; it only checks each reason maps to its own real copy.
    assert.ok(CHAT_CONFIGURATION_REASONS.length > 0);
    const seen = new Set<string>();
    for (const reason of CHAT_CONFIGURATION_REASONS) {
      const copy = describeChatConfigurationReason(reason);
      assert.ok(copy.length > 0, `${reason} has copy`);
      assert.equal(seen.has(copy), false, `${reason} copy is distinct`);
      seen.add(copy);
    }
  });

  it('names the credential fix for a missing API key and the model fix for a bad model', () => {
    assert.match(describeChatConfigurationReason('missing_api_key'), /API key/);
    assert.match(describeChatConfigurationReason('missing_api_key'), /设置 · 模型/);
    assert.match(describeChatConfigurationReason('model_not_chat_capable'), /模型/);
  });

  it('falls back to generic copy for undefined rather than throwing', () => {
    const copy = describeChatConfigurationReason(undefined);
    assert.match(copy, /设置 · 模型/);
  });

  it('falls back to generic copy for an unknown runtime reason', () => {
    assert.equal(
      describeChatConfigurationReason('future_reason'),
      describeChatConfigurationReason(undefined),
    );
  });
});

describe('parseNoRealConnectionError', () => {
  it('parses the bare CLI form NO_REAL_CONNECTION:<reason>', () => {
    assert.deepEqual(
      parseNoRealConnectionError(new Error('NO_REAL_CONNECTION:missing_default_connection')),
      { matched: true, reason: 'missing_default_connection' },
    );
  });

  it('parses the wrapped form NO_REAL_CONNECTION:<reason>: <message>', () => {
    assert.deepEqual(
      parseNoRealConnectionError(
        new Error("Error invoking remote method 'send': Error: NO_REAL_CONNECTION:missing_api_key: no key"),
      ),
      { matched: true, reason: 'missing_api_key' },
    );
  });

  it('reports no match for a non-NO_REAL_CONNECTION error', () => {
    assert.deepEqual(parseNoRealConnectionError(new Error('network timeout')), { matched: false });
  });

  it('does not match a longer word that merely starts with the code', () => {
    // The optional reason group means the bare code can match on its own, so the
    // trailing word boundary must stop `NO_REAL_CONNECTIONS...` from matching and
    // swallowing an unrelated startup error as connection guidance.
    assert.deepEqual(parseNoRealConnectionError(new Error('NO_REAL_CONNECTIONS cache failed')), {
      matched: false,
    });
  });

  it('matches but yields no reason for an unrecognized reason token', () => {
    assert.deepEqual(
      parseNoRealConnectionError(new Error('NO_REAL_CONNECTION:not_a_real_reason')),
      { matched: true, reason: undefined },
    );
  });

  it('matches but yields no reason for the bare code with no token', () => {
    assert.deepEqual(parseNoRealConnectionError(new Error('NO_REAL_CONNECTION')), {
      matched: true,
      reason: undefined,
    });
  });

  it('rejects a malformed token that merely starts with a known reason', () => {
    // The token is captured whole, so a known-reason prefix followed by extra
    // characters matches the failure but resolves to no known reason.
    assert.deepEqual(parseNoRealConnectionError(new Error('NO_REAL_CONNECTION:missing_api_key2')), {
      matched: true,
      reason: undefined,
    });
    assert.deepEqual(parseNoRealConnectionError(new Error('NO_REAL_CONNECTION:fake_backend-extra')), {
      matched: true,
      reason: undefined,
    });
  });

  it('accepts a non-Error value', () => {
    assert.deepEqual(parseNoRealConnectionError('NO_REAL_CONNECTION:fake_backend'), {
      matched: true,
      reason: 'fake_backend',
    });
  });
});
