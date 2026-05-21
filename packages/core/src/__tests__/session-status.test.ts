import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_BLOCKED_REASONS,
  SESSION_STATUSES,
  isSessionBlockedReason,
  isSessionStatus,
} from '../session.js';

describe('SessionStatus contract', () => {
  it('locks the Week 2 lifecycle enum', () => {
    assert.deepEqual(SESSION_STATUSES, [
      'active',
      'running',
      'waiting_for_user',
      'blocked',
      'review',
      'done',
      'archived',
      'aborted',
    ]);
  });

  it('validates status and blocked reason values', () => {
    assert.equal(isSessionStatus('running'), true);
    assert.equal(isSessionStatus('idle'), false);
    assert.deepEqual(SESSION_BLOCKED_REASONS, [
      'NO_REAL_CONNECTION',
      'auth',
      'permission_required',
      'tool_failed',
      'unknown',
    ]);
    assert.equal(isSessionBlockedReason('tool_failed'), true);
    assert.equal(isSessionBlockedReason('raw_provider_error'), false);
  });
});
