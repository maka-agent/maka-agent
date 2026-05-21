import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generalizedErrorMessage, redactSecrets } from '../redaction.js';

describe('redactSecrets', () => {
  test('masks bearer tokens and provider key prefixes', () => {
    const text = redactSecrets('Authorization: Bearer sk-live-secret-token-value and ghp_abcdefghijklmnopqrstuvwxyz');

    assert.equal(text.includes('sk-live-secret-token-value'), false);
    assert.equal(text.includes('ghp_abcdefghijklmnopqrstuvwxyz'), false);
    assert.match(text, /Authorization: Bearer \[redacted\]/);
  });

  test('masks only sensitive URL query values', () => {
    const text = redactSecrets('https://api.example.test/models?model=x&api_key=secret-value&timeout=30');

    assert.match(text, /https:\/\/api\.example\.test\/models\?model=x/);
    assert.match(text, /api_key=\[redacted\]/);
    assert.match(text, /timeout=30/);
    assert.equal(text.includes('secret-value'), false);
  });
});

describe('generalizedErrorMessage', () => {
  test('returns generic classes instead of raw redacted provider errors', () => {
    assert.equal(generalizedErrorMessage(new Error('401 Authorization: Bearer sk-live-secret-token-value')), 'Authentication failed');
    assert.equal(generalizedErrorMessage(new Error('fetch failed ECONNREFUSED token=secret')), 'Network error');
  });

  test('classifies status and rate-limit messages before redacted secret content', () => {
    const auth = generalizedErrorMessage(new Error('403 {"error":"bad key","api_key":"sk-live-secret-token-value"}'));
    const rateLimit = generalizedErrorMessage(new Error('429 Authorization: Bearer sk-live-secret-token-value'));

    assert.equal(auth, 'Authentication failed');
    assert.equal(rateLimit, 'Rate limit exceeded');
    assert.equal(auth.includes('sk-live-secret-token-value'), false);
    assert.equal(rateLimit.includes('sk-live-secret-token-value'), false);
  });
});
