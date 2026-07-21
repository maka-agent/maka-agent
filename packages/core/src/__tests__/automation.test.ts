import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeAutomationDefinition } from '../automation.js';

const validDefinition = {
  automationId: 'automation-1',
  name: 'Deployment check',
  prompt: 'Check the deployment.',
  target: { kind: 'heartbeat' as const, sessionId: 'session-1' },
  schedule: { kind: 'interval' as const, intervalMs: 60_000 },
  maxFireCount: null,
  expiresAt: 100_000,
  status: 'enabled' as const,
  revision: 3,
  createdAt: 1_000,
  updatedAt: 3_000,
  nextFireAt: 60_000,
  fireCount: 2,
};

describe('Automation domain validation', () => {
  test('rejects non-canonical user text', () => {
    assert.throws(
      () => decodeAutomationDefinition({ ...validDefinition, name: 'bad\0name' }),
      /canonical bounded text/,
    );
    assert.throws(
      () => decodeAutomationDefinition({ ...validDefinition, name: 'Cafe\u0301' }),
      /canonical bounded text/,
    );
  });

  test('rejects a max fire count below the durable fire count', () => {
    assert.throws(
      () => decodeAutomationDefinition({ ...validDefinition, maxFireCount: 1 }),
      /fireCount exceeds maxFireCount/,
    );
  });
});
