/**
 * session-project-grouping.ts — pure derivation: group sessions by their
 * `cwd` (working directory). Sessions without a `cwd` fall into a
 * "未归属项目" group. Used by the sidebar "按项目" view-mode.
 */

import type { SessionSummary } from '@maka/core';
import type { SessionHistoryStatusGroup } from '@maka/ui';

const UNGROUPED_LABEL = '未归属项目';
const UNGROUPED_KEY = '__ungrouped__';

/**
 * Group the given sessions by their `cwd` field.
 * Groups are returned in insertion order; the ungrouped bucket (if any)
 * appears last. The label is the basename of the project directory.
 */
export function deriveProjectGroups(sessions: ReadonlyArray<SessionSummary>): SessionHistoryStatusGroup[] {
  const map = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = session.cwd ?? UNGROUPED_KEY;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(session);
  }

  const groups: SessionHistoryStatusGroup[] = [];
  for (const [key, bucket] of map) {
    if (key === UNGROUPED_KEY) continue; // append last
    groups.push({
      id: groupIdFromPath(key),
      label: labelFromPath(key),
      sessions: bucket,
      collapsible: true,
      defaultExpanded: true,
    });
  }
  // Un-belonged sessions go last, in a single catch-all group.
  const ungrouped = map.get(UNGROUPED_KEY);
  if (ungrouped) {
    groups.push({
      id: UNGROUPED_KEY,
      label: UNGROUPED_LABEL,
      sessions: ungrouped,
      collapsible: true,
      defaultExpanded: true,
    });
  }
  return groups;
}

function labelFromPath(projectPath: string): string {
  // Use the basename (last path segment) as the human-readable label.
  const parts = projectPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || projectPath;
}

/**
 * Derive a stable, DOM-safe group id from a project path. Paths can contain
 * spaces and slashes, which are invalid in DOM ids and would break the
 * `aria-controls` / body-id pairing in SessionListGroups. The basename alone
 * is not enough: two projects can share a basename, so the full normalized
 * path is hashed (FNV-1a) to keep distinct paths distinct.
 */
function groupIdFromPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `project:${(hash >>> 0).toString(36)}`;
}
