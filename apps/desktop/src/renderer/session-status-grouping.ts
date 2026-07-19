/**
 * Pure derivation of sidebar session grouping by status.
 *
 * Extracted from the React component layer so the group ordering +
 * filtering + per-group counts can be unit-tested with node:test (no
 * DOM dependency). Mirrors `session-health-notice.ts` + `stale-sessions.ts`
 * patterns from earlier PRs.
 *
 * Group order is the @kenji-locked sequence:
 *   1. Running                — `running`
 *   2. Waiting                — `waiting_for_user`
 *   3. Blocked                — `blocked`
 *   4. Active                 — `active`
 *   5. Review                 — `review`
 *   6. Done                   — `done`
 *   7. Archived               — `archived` (default collapsed)
 *   8. Aborted                — `aborted` (default collapsed)
 *
 * `aborted` is dormant history, but still user-visible. It lives in a
 * bottom collapsed group like `archived`, so users can recover sessions
 * they explicitly cancelled without adding noise to the active groups.
 *
 * Within each group sessions are ordered by `lastMessageAt` desc with
 * `id.localeCompare` secondary (matching storage layer's determinism
 * sort from PR108k-yj).
 */

import type { SessionStatus, SessionSummary, UiLocale } from '@maka/core';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

/**
 * Stable group ordering. Used by both the renderer and node:test
 * gates; do not reorder without updating those tests and the screenshot
 * fixture.
 */
export const SESSION_STATUS_GROUP_ORDER = [
  'running',
  'waiting_for_user',
  'blocked',
  'active',
  'review',
  'done',
  'archived',
  'aborted',
] as const satisfies readonly SessionStatus[];

export type SessionStatusGroupId = (typeof SESSION_STATUS_GROUP_ORDER)[number];

/**
 * Group id including the synthetic "pinned" bucket used when
 * `pinFirst` is set. Pinned isn't a SessionStatus — it's an orthogonal
 * "this session is starred" axis — but it shares the same renderer
 * group infrastructure.
 */
export type SessionGroupId = SessionStatusGroupId | 'pinned';

export interface SessionStatusGroup {
  /** Canonical group id (SessionStatus or 'pinned'). */
  id: SessionGroupId;
  /** Chinese label shown in the sidebar group header. */
  label: string;
  /** Sessions in this group, already sorted (see file-level comment). */
  sessions: SessionSummary[];
  /**
   * Whether the group is collapsible. `archived` is the only collapsible
   * group; the rest are always open so users can spot lifecycle status
   * at a glance.
   */
  collapsible: boolean;
  /**
   * Default expanded state when the user hasn't toggled this group yet.
   * `archived` defaults to collapsed because it's a closed/dormant
   * bucket; everything else defaults to expanded.
   */
  defaultExpanded: boolean;
}

const COLLAPSIBLE_GROUPS: ReadonlySet<SessionGroupId> = new Set(['archived', 'aborted']);
const COLLAPSED_BY_DEFAULT: ReadonlySet<SessionGroupId> = new Set(['archived', 'aborted']);

/**
 * Sort sessions within a group. Matches `session-store.list()` ordering
 * from PR108k-yj — `lastMessageAt` desc with `id.localeCompare`
 * tiebreaker. Identical timestamp + identical id can't happen because
 * id is a UUID, but we still cover that branch for safety.
 */
function sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const tsDelta = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
    if (tsDelta !== 0) return tsDelta;
    return a.id.localeCompare(b.id);
  });
}

export interface DeriveSessionStatusGroupsOptions {
  /**
   * When true, pinned (flagged) sessions float to the top in a synthetic
   * "Pinned" group BEFORE the status-ordered groups. Pinned sessions are
   * also removed from their status group so a flagged-active session
   * only appears once (in Pinned, not double-counted in Active).
   *
   * Used by the `chats` sidebar filter to preserve the
   * pinned-floats-to-top behavior introduced in PR48 + PR108k.
   */
  pinFirst?: boolean;
  locale?: UiLocale;
}

/**
 * Project a flat session list into status-grouped buckets in the
 * locked order. Empty groups are dropped from the output so the
 * sidebar doesn't render placeholder headers.
 *
 * `aborted` sessions land in their own group at the bottom, default
 * collapsed (same convention as `archived`). Per @kenji review on
 * PR109b: aborted is dormant history, not silently swallowed — users
 * who actually cancelled a session expect to see it later.
 *
 * When `pinFirst` is true, flagged sessions are pulled into a synthetic
 * "Pinned" group at the top and removed from their status-derived
 * group (no double counting).
 */
export function deriveSessionStatusGroups(
  sessions: readonly SessionSummary[],
  options: DeriveSessionStatusGroupsOptions = {},
): SessionStatusGroup[] {
  const labels = getDesktopConversationCopy(options.locale ?? 'zh').groups;
  const pinned: SessionSummary[] = [];
  const byStatus = new Map<SessionStatusGroupId, SessionSummary[]>();
  for (const status of SESSION_STATUS_GROUP_ORDER) {
    byStatus.set(status, []);
  }
  for (const session of sessions) {
    if (options.pinFirst && session.isFlagged) {
      pinned.push(session);
      continue;
    }
    const bucket = byStatus.get(session.status as SessionStatusGroupId);
    if (!bucket) continue;
    bucket.push(session);
  }
  const groups: SessionStatusGroup[] = [];
  if (options.pinFirst && pinned.length > 0) {
    groups.push({
      id: 'pinned',
      label: labels.pinned,
      sessions: sortSessions(pinned),
      collapsible: false,
      defaultExpanded: true,
    });
  }
  for (const id of SESSION_STATUS_GROUP_ORDER) {
    const list = byStatus.get(id) ?? [];
    if (list.length === 0) continue;
    groups.push({
      id,
      label: labels[id],
      sessions: sortSessions(list),
      collapsible: COLLAPSIBLE_GROUPS.has(id),
      defaultExpanded: !COLLAPSED_BY_DEFAULT.has(id),
    });
  }
  return groups;
}
