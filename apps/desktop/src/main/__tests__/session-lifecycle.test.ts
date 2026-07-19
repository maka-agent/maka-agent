import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertSessionCanSendFromHeader,
  isSessionLifecycleError,
  sessionLifecycleErrorFromReadFailure,
  SessionLifecycleError,
} from '../session-lifecycle.js';

describe('session lifecycle send admission', () => {
  test('uses persisted archived state as the send authority', () => {
    assert.throws(
      () => assertSessionCanSendFromHeader({ isArchived: true, status: 'active' }),
      (error: unknown) => isSessionLifecycleError(error)
        && error.reason === 'archived',
    );
    assert.throws(
      () => assertSessionCanSendFromHeader({ isArchived: false, status: 'archived' }),
      (error: unknown) => error instanceof SessionLifecycleError
        && error.reason === 'archived',
    );
  });

  test('classifies a missing persisted session as removed', () => {
    const error = sessionLifecycleErrorFromReadFailure(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    assert.ok(error);
    assert.equal(error.reason, 'removed');
    assert.equal(isSessionLifecycleError(error), true);
  });
});
