import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connectionTestStatusPatch } from '../connection-test-status.js';

describe('connection test status persistence', () => {
  const now = new Date('2026-05-21T09:00:00.000Z');

  test('success writes verified with a generalized message', () => {
    assert.deepEqual(
      connectionTestStatusPatch({ ok: true, modelTested: 'claude-sonnet-4-5' }, now),
      {
        lastTestStatus: 'verified',
        lastTestAt: now.toISOString(),
        lastTestMessage: 'Connection verified',
      },
    );
  });

  test('401/403 failures write needs_reauth', () => {
    assert.equal(
      connectionTestStatusPatch({ ok: false, statusCode: 401, errorMessage: '401 raw provider body' }, now).lastTestStatus,
      'needs_reauth',
    );
    assert.deepEqual(
      connectionTestStatusPatch({ ok: false, statusCode: 403, errorClass: 'auth' }, now),
      {
        lastTestStatus: 'needs_reauth',
        lastTestAt: now.toISOString(),
        lastTestMessage: 'Authentication failed',
      },
    );
  });

  test('timeout, network, and 5xx failures write generic error statuses', () => {
    assert.equal(
      connectionTestStatusPatch({ ok: false, errorClass: 'timeout', errorMessage: 'Fetch timeout' }, now).lastTestMessage,
      'Request timed out',
    );
    assert.equal(
      connectionTestStatusPatch({ ok: false, errorClass: 'network', errorMessage: 'ECONNREFUSED token=abc' }, now).lastTestMessage,
      'Network error',
    );
    assert.equal(
      connectionTestStatusPatch({ ok: false, statusCode: 503, errorMessage: '503 raw upstream body' }, now).lastTestMessage,
      'Provider unavailable',
    );
  });

  test('persistent message never stores raw provider error text', () => {
    const result = connectionTestStatusPatch({
      ok: false,
      errorClass: 'network',
      errorMessage: 'Authorization: Bearer sk-live-secret-token-value',
    }, now);

    assert.equal(JSON.stringify(result).includes('sk-live-secret-token-value'), false);
  });
});
