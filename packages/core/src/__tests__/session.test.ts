import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeStoredMessageForRecovery } from '../session.js';

const USER_MESSAGE = {
  type: 'user',
  id: 'message-1',
  turnId: 'turn-1',
  ts: 1,
  text: 'run',
} as const;

describe('stored user message turn origin', () => {
  test('accepts Automation and Goal identities', () => {
    assert.deepEqual(
      decodeStoredMessageForRecovery({
        ...USER_MESSAGE,
        origin: { kind: 'automation', automationId: 'automation-1' },
      }),
      { ...USER_MESSAGE, origin: { kind: 'automation', automationId: 'automation-1' } },
    );
    assert.deepEqual(
      decodeStoredMessageForRecovery({
        ...USER_MESSAGE,
        origin: { kind: 'automation', automationId: 'automation-1', fireId: 'fire-1' },
      }),
      {
        ...USER_MESSAGE,
        origin: { kind: 'automation', automationId: 'automation-1', fireId: 'fire-1' },
      },
    );
    assert.deepEqual(
      decodeStoredMessageForRecovery({
        ...USER_MESSAGE,
        origin: { kind: 'goal', goalId: 'goal-1' },
      }),
      { ...USER_MESSAGE, origin: { kind: 'goal', goalId: 'goal-1' } },
    );
  });

  test('rejects fields outside the closed origin shape', () => {
    assert.throws(
      () =>
        decodeStoredMessageForRecovery({
          ...USER_MESSAGE,
          origin: {
            kind: 'automation',
            automationId: 'automation-1',
            fireId: 'fire-1',
            unexpected: true,
          },
        }),
      /Invalid stored message schema/,
    );
    assert.throws(
      () =>
        decodeStoredMessageForRecovery({
          ...USER_MESSAGE,
          origin: { kind: 'goal', goalId: 'goal-1', unexpected: true },
        }),
      /Invalid stored message schema/,
    );
  });
});
