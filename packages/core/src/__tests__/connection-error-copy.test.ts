import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatConfigurationReason } from '../connection-readiness.js';
import {
  describeChatConfigurationReason,
  chatConfigurationReasonFromError,
} from '../connection-error-copy.js';

const ALL_REASONS: ChatConfigurationReason[] = [
  'missing_default_connection',
  'connection_missing',
  'connection_disabled',
  'missing_api_key',
  'missing_model',
  'empty_model_list',
  'model_not_enabled',
  'model_not_chat_capable',
  'oauth_subscription_not_wired',
  'fake_backend',
];

describe('describeChatConfigurationReason', () => {
  it('returns distinct, non-empty fix copy for every reason', () => {
    const seen = new Set<string>();
    for (const reason of ALL_REASONS) {
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

  it('accepts a non-Error value', () => {
    assert.equal(chatConfigurationReasonFromError('NO_REAL_CONNECTION:fake_backend'), 'fake_backend');
  });
});
