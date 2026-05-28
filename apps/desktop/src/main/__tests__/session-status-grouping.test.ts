/**
 * Tests for the sidebar status-grouping pure helper (PR109b).
 *
 * The group order is locked at the renderer + design-system level
 * (@kenji review). Future edits MUST update this test alongside the
 * helper or the smoke screenshot baseline goes stale silently.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionStatus, SessionSummary } from '@maka/core';
import {
  SESSION_STATUS_GROUP_ORDER,
  deriveSessionStatusGroups,
} from '../../renderer/session-status-grouping.js';

function session(input: {
  id: string;
  status: SessionStatus;
  lastMessageAt?: number;
  name?: string;
  isFlagged?: boolean;
}): SessionSummary {
  return {
    id: input.id,
    name: input.name ?? input.id,
    isFlagged: input.isFlagged ?? false,
    isArchived: input.status === 'archived',
    labels: [],
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'zai-live',
    model: 'glm-4.7',
    permissionMode: 'ask',
    status: input.status,
    ...(input.lastMessageAt !== undefined ? { lastMessageAt: input.lastMessageAt } : {}),
  };
}

describe('deriveSessionStatusGroups', () => {
  it('returns empty array when no sessions', () => {
    assert.deepEqual(deriveSessionStatusGroups([]), []);
  });

  it('groups in the locked order: Running → Waiting → Blocked → Active → Review → Done → Archived', () => {
    const sessions = [
      session({ id: 'a', status: 'active' }),
      session({ id: 'b', status: 'archived' }),
      session({ id: 'c', status: 'review' }),
      session({ id: 'd', status: 'running' }),
      session({ id: 'e', status: 'done' }),
      session({ id: 'f', status: 'waiting_for_user' }),
      session({ id: 'g', status: 'blocked' }),
    ];
    const groups = deriveSessionStatusGroups(sessions);
    assert.deepEqual(
      groups.map((g) => g.id),
      ['running', 'waiting_for_user', 'blocked', 'active', 'review', 'done', 'archived'],
    );
  });

  it('renders aborted in its own group at the bottom, default collapsed', () => {
    const groups = deriveSessionStatusGroups([
      session({ id: 'a', status: 'aborted' }),
      session({ id: 'b', status: 'active' }),
    ]);
    // active group comes first, aborted at the bottom
    assert.deepEqual(groups.map((g) => g.id), ['active', 'aborted']);
    const abortedGroup = groups.find((g) => g.id === 'aborted');
    assert.equal(abortedGroup?.collapsible, true);
    assert.equal(abortedGroup?.defaultExpanded, false);
    assert.equal(abortedGroup?.label, '已中止');
  });

  it('aborted group sorts after archived', () => {
    const groups = deriveSessionStatusGroups([
      session({ id: 'a', status: 'aborted' }),
      session({ id: 'b', status: 'archived' }),
    ]);
    assert.deepEqual(groups.map((g) => g.id), ['archived', 'aborted']);
  });

  it('drops empty groups (no placeholder headers)', () => {
    const groups = deriveSessionStatusGroups([
      session({ id: 'a', status: 'running' }),
    ]);
    assert.deepEqual(groups.map((g) => g.id), ['running']);
  });

  it('archived group is collapsible + defaults to collapsed', () => {
    const groups = deriveSessionStatusGroups([
      session({ id: 'a', status: 'archived' }),
    ]);
    assert.equal(groups[0]?.collapsible, true);
    assert.equal(groups[0]?.defaultExpanded, false);
  });

  it('dormant groups (archived + aborted) are collapsible + default collapsed', () => {
    const sessions = SESSION_STATUS_GROUP_ORDER.map((status) =>
      session({ id: status, status: status as SessionStatus }),
    );
    const groups = deriveSessionStatusGroups(sessions);
    const dormant = new Set(['archived', 'aborted']);
    for (const group of groups) {
      if (dormant.has(group.id)) {
        assert.equal(group.collapsible, true, `${group.id} should be collapsible`);
        assert.equal(group.defaultExpanded, false, `${group.id} should default collapsed`);
      } else {
        assert.equal(group.collapsible, false, `${group.id} should not be collapsible`);
        assert.equal(group.defaultExpanded, true, `${group.id} should default expanded`);
      }
    }
  });

  it('sorts within group by lastMessageAt desc with id secondary', () => {
    const groups = deriveSessionStatusGroups([
      session({ id: 'oldest', status: 'active', lastMessageAt: 1000 }),
      session({ id: 'newest', status: 'active', lastMessageAt: 3000 }),
      session({ id: 'middle', status: 'active', lastMessageAt: 2000 }),
    ]);
    const ids = groups[0]?.sessions.map((s) => s.id);
    assert.deepEqual(ids, ['newest', 'middle', 'oldest']);
  });

  it('tiebreaker on identical lastMessageAt is id lexicographic', () => {
    const groups = deriveSessionStatusGroups([
      session({ id: 'b', status: 'active', lastMessageAt: 1000 }),
      session({ id: 'a', status: 'active', lastMessageAt: 1000 }),
      session({ id: 'c', status: 'active', lastMessageAt: 1000 }),
    ]);
    const ids = groups[0]?.sessions.map((s) => s.id);
    assert.deepEqual(ids, ['a', 'b', 'c']);
  });

  it('sessions without lastMessageAt sort after sessions with one', () => {
    const groups = deriveSessionStatusGroups([
      session({ id: 'noTs', status: 'active' }),
      session({ id: 'withTs', status: 'active', lastMessageAt: 5000 }),
    ]);
    const ids = groups[0]?.sessions.map((s) => s.id);
    assert.deepEqual(ids, ['withTs', 'noTs']);
  });

  it('labels are Chinese (no English fallback per i18n contract)', () => {
    const groups = deriveSessionStatusGroups(
      SESSION_STATUS_GROUP_ORDER.map((status) => session({ id: status, status: status as SessionStatus })),
    );
    for (const group of groups) {
      assert.match(group.label, /[一-鿿]/, `${group.id} label should contain Chinese chars`);
      assert.doesNotMatch(group.label, /[a-zA-Z]/, `${group.id} label should have no Latin letters`);
    }
  });

  describe('pinFirst option', () => {
    it('without pinFirst (default), flagged sessions stay in their status group', () => {
      const groups = deriveSessionStatusGroups([
        session({ id: 'a', status: 'active', isFlagged: true, lastMessageAt: 1000 }),
        session({ id: 'b', status: 'active', lastMessageAt: 500 }),
      ]);
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.id, 'active');
      assert.equal(groups[0]?.sessions.length, 2);
    });

    it('with pinFirst, flagged sessions float to "Pinned" group at the top', () => {
      const groups = deriveSessionStatusGroups(
        [
          session({ id: 'a', status: 'active', isFlagged: true, lastMessageAt: 1000 }),
          session({ id: 'b', status: 'active', lastMessageAt: 500 }),
          session({ id: 'c', status: 'running', isFlagged: true, lastMessageAt: 2000 }),
        ],
        { pinFirst: true },
      );
      assert.equal(groups[0]?.id, 'pinned');
      assert.equal(groups[0]?.sessions.length, 2);
      assert.deepEqual(
        groups[0]?.sessions.map((s) => s.id),
        ['c', 'a'], // sorted by lastMessageAt desc within the pinned group
      );
    });

    it('with pinFirst, flagged sessions are removed from their status group (no double-count)', () => {
      const groups = deriveSessionStatusGroups(
        [
          session({ id: 'flagged', status: 'active', isFlagged: true, lastMessageAt: 1000 }),
          session({ id: 'plain', status: 'active', lastMessageAt: 500 }),
        ],
        { pinFirst: true },
      );
      const active = groups.find((g) => g.id === 'active');
      assert.equal(active?.sessions.length, 1);
      assert.equal(active?.sessions[0]?.id, 'plain');
    });

    it('Pinned group is NOT collapsible and defaults expanded', () => {
      const groups = deriveSessionStatusGroups(
        [session({ id: 'a', status: 'active', isFlagged: true })],
        { pinFirst: true },
      );
      const pinned = groups.find((g) => g.id === 'pinned');
      assert.equal(pinned?.collapsible, false);
      assert.equal(pinned?.defaultExpanded, true);
    });

    it('Pinned group label is "已置顶" (Chinese only)', () => {
      const groups = deriveSessionStatusGroups(
        [session({ id: 'a', status: 'active', isFlagged: true })],
        { pinFirst: true },
      );
      assert.equal(groups[0]?.label, '已置顶');
    });

    it('with pinFirst, aborted+flagged sessions still float to Pinned (pin priority is policy)', () => {
      // Per @kenji PR109b review: pinning is an overlay priority, not a
      // lifecycle filter. The Pinned group reflects user intent ("I want
      // to see this"), even when the underlying status is terminal.
      const groups = deriveSessionStatusGroups(
        [session({ id: 'a', status: 'aborted', isFlagged: true })],
        { pinFirst: true },
      );
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.id, 'pinned');
      assert.equal(groups[0]?.sessions[0]?.id, 'a');
    });
  });

  describe('@kenji review invariants', () => {
    it('pinned+running session keeps its real lifecycle status (does NOT downgrade to active)', () => {
      // Per @kenji review: "确保 pinned session 如果 running/blocked，
      // 行内 status icon 仍显示真实 lifecycle，不要因为 Pinned group
      // 把状态信号藏掉." The grouping helper preserves the original
      // session object, so consumers reading `session.status` still
      // see `running` even when the session lives in the Pinned group.
      const sessions = [session({ id: 'a', status: 'running', isFlagged: true })];
      const groups = deriveSessionStatusGroups(sessions, { pinFirst: true });
      assert.equal(groups[0]?.id, 'pinned');
      assert.equal(groups[0]?.sessions[0]?.status, 'running', 'pinned session preserves its real status');
    });

    it('aborted session is visible (not silently swallowed)', () => {
      // Per @kenji review: aborted is dormant history, not invisible.
      const groups = deriveSessionStatusGroups([session({ id: 'a', status: 'aborted' })]);
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.id, 'aborted');
      assert.equal(groups[0]?.label, '已中止');
    });
  });

  it('reproduces a realistic workspace mix', () => {
    // A user with one running task, one blocked auth issue, two
    // ordinary sessions, one in review, and 3 archived. Order /
    // counts should be deterministic.
    const groups = deriveSessionStatusGroups([
      session({ id: 'r1', status: 'running', lastMessageAt: 9000 }),
      session({ id: 'a1', status: 'active', lastMessageAt: 8000 }),
      session({ id: 'a2', status: 'active', lastMessageAt: 7000 }),
      session({ id: 'b1', status: 'blocked', lastMessageAt: 6000 }),
      session({ id: 'rv1', status: 'review', lastMessageAt: 5000 }),
      session({ id: 'ar1', status: 'archived', lastMessageAt: 4000 }),
      session({ id: 'ar2', status: 'archived', lastMessageAt: 3000 }),
      session({ id: 'ar3', status: 'archived', lastMessageAt: 2000 }),
    ]);
    assert.deepEqual(groups.map((g) => ({ id: g.id, count: g.sessions.length })), [
      { id: 'running', count: 1 },
      { id: 'blocked', count: 1 },
      { id: 'active', count: 2 },
      { id: 'review', count: 1 },
      { id: 'archived', count: 3 },
    ]);
  });
});
