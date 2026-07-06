import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSessionBackend } from '../session-backend-resolver.js';

describe('resolveSessionBackend', () => {
  test('forces fake when MAKA_E2E is active, ignoring the requested backend', () => {
    assert.equal(resolveSessionBackend(undefined, { MAKA_E2E: '1' }), 'fake');
    assert.equal(resolveSessionBackend({ backend: 'ai-sdk' }, { MAKA_E2E: '1' }), 'fake');
  });

  test('honors the requested backend when E2E is off', () => {
    assert.equal(resolveSessionBackend({ backend: 'fake' }, {}), 'fake');
    assert.equal(resolveSessionBackend({ backend: 'ai-sdk' }, {}), 'ai-sdk');
  });

  test('defaults to ai-sdk when no backend is requested and E2E is off', () => {
    assert.equal(resolveSessionBackend(undefined, {}), 'ai-sdk');
  });
});
