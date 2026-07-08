import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_CONFIGURATION_REASONS,
  describeChatConfigurationReason,
  chatConfigurationReasonFromError,
} from '../connection-error-copy.js';

describe('describeChatConfigurationReason', () => {
  it('covers every reason in the union', () => {
    // Derived from the source list, so a new ChatConfigurationReason is exercised
    // here automatically rather than needing a hand-updated array.
    assert.equal(CHAT_CONFIGURATION_REASONS.length, 10);
  });

  it('returns distinct, non-empty fix copy for every reason', () => {
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
});

describe('chatConfigurationReasonFromError', () => {
  it('parses the bare CLI form NO_REAL_CONNECTION:<reason>', () => {
    assert.equal(
      chatConfigurationReasonFromError(new Error('NO_REAL_CONNECTION:missing_default_connection')),
      'missing_default_connection',
    );
  });

  it('parses the wrapped form NO_REAL_CONNECTION:<reason>: <message>', () => {
    assert.equal(
      chatConfigurationReasonFromError(
        new Error("Error invoking remote method 'send': Error: NO_REAL_CONNECTION:missing_api_key: no key"),
      ),
      'missing_api_key',
    );
  });

  it('returns undefined for a non-NO_REAL_CONNECTION error', () => {
    assert.equal(chatConfigurationReasonFromError(new Error('network timeout')), undefined);
  });

  it('returns undefined for an unrecognized reason token', () => {
    assert.equal(chatConfigurationReasonFromError(new Error('NO_REAL_CONNECTION:not_a_real_reason')), undefined);
  });

  it('rejects a malformed token that merely starts with a known reason', () => {
    // The token is captured whole, so a known-reason prefix followed by extra
    // characters is not mistaken for the known reason.
    assert.equal(chatConfigurationReasonFromError(new Error('NO_REAL_CONNECTION:missing_api_key2')), undefined);
    assert.equal(chatConfigurationReasonFromError(new Error('NO_REAL_CONNECTION:fake_backend-extra')), undefined);
  });

  it('accepts a non-Error value', () => {
    assert.equal(chatConfigurationReasonFromError('NO_REAL_CONNECTION:fake_backend'), 'fake_backend');
  });
});
