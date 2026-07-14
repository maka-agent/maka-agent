import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CuaDriverLifecycleError,
  cuaDriverLifecycleMessage,
  isCuaDriverLifecycleError,
} from '../cua-driver-release.js';

describe('cua-driver release contract', () => {
  it('keeps outcome_unknown distinct from availability and abort failures', () => {
    const error = new CuaDriverLifecycleError(
      'outcome_unknown',
      'action child exited after request delivery',
      'action',
      7,
      'delivered',
    );

    assert.equal(isCuaDriverLifecycleError(error, 'outcome_unknown'), true);
    assert.equal(isCuaDriverLifecycleError(error, 'service_unavailable'), false);
    assert.equal(
      cuaDriverLifecycleMessage(error),
      'outcome_unknown: action child exited after request delivery',
    );
    assert.equal(error.generation, 7);
    assert.equal(error.requestStage, 'delivered');
  });
});
