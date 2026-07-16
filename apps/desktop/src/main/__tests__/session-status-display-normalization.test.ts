/**
 * Display normalization for non-actionable blocked sessions.
 *
 * Runtime keeps writing the strict lifecycle status (the #397/#410
 * terminal-fact invariant): a run that closes without terminal evidence
 * marks its session `blocked/unknown`. But session-level "已阻塞" in the
 * sidebar/header is only worth the interruption when the user can ACT
 * (configure a connection, re-login, confirm a permission). Legacy
 * sessions repaired as `missing_terminal_event` are intact, retryable
 * conversations — showing three healthy chats under an「已阻塞」group
 * (real-world report, 2026-07-03) reads as data loss.
 *
 * `normalizeSessionSummaryForDisplay` is applied at the renderer state
 * boundary (app-shell commitSessions / upsertSessionSummary), so the
 * grouping, row icon, and chat-header badge all agree.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionBlockedReason, SessionStatus, SessionSummary } from '@maka/core';
import {
  isActionableBlocked,
  normalizeSessionSummaryForDisplay,
} from '../../renderer/session-status-presentation.js';

function session(status: SessionStatus, blockedReason?: SessionBlockedReason): SessionSummary {
  return {
    id: 'session-1',
    name: '测试会话',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'zai-live',
    connectionLocked: false,
    model: 'glm-4.7',
    permissionMode: 'ask',
    status,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

describe('normalizeSessionSummaryForDisplay', () => {
  it('reads non-actionable blocked (missing terminal bookkeeping) as an ordinary resumable session', () => {
    for (const reason of ['unknown', 'tool_failed'] as const) {
      const out = normalizeSessionSummaryForDisplay(session('blocked', reason));
      assert.equal(out.status, 'active', `blocked/${reason} should display as active`);
      assert.equal(out.blockedReason, undefined, `blocked/${reason} should drop the stale reason`);
    }
  });

  it('keeps actionable blocked states (user can fix something) as blocked', () => {
    for (const reason of ['NO_REAL_CONNECTION', 'auth', 'permission_required'] as const) {
      const out = normalizeSessionSummaryForDisplay(session('blocked', reason));
      assert.equal(out.status, 'blocked', `blocked/${reason} must stay blocked`);
      assert.equal(out.blockedReason, reason);
      assert.equal(isActionableBlocked(reason), true);
    }
  });

  it('treats blocked with a missing reason as non-actionable', () => {
    const out = normalizeSessionSummaryForDisplay(session('blocked'));
    assert.equal(out.status, 'active');
  });

  it('passes every non-blocked status through unchanged', () => {
    for (const status of ['active', 'running', 'waiting_for_user', 'review', 'done', 'archived', 'aborted'] as const) {
      const input = session(status);
      assert.equal(normalizeSessionSummaryForDisplay(input), input, `${status} must be identity`);
    }
  });
});
