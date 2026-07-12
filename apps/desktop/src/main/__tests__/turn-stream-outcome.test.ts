import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { turnFailureMessageFromSessionEvent } from '../turn-stream-outcome.js';

describe('turnFailureMessageFromSessionEvent', () => {
  test('treats step_limit as incomplete while leaving clean completions alone', () => {
    const base = { id: 'event-1', turnId: 'turn-1', ts: 1 };
    assert.equal(
      turnFailureMessageFromSessionEvent({ ...base, type: 'complete', stopReason: 'step_limit' }),
      'turn ended: tool_step_cap_reached',
    );
    assert.equal(
      turnFailureMessageFromSessionEvent({ ...base, type: 'complete', stopReason: 'end_turn' }),
      undefined,
    );
  });
});
