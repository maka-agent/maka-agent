/**
 * session-project-grouping.ts — pure derivation: group sessions by their
 * `cwd` (working directory). Sessions without a `cwd` fall into a
 * "未归属项目" group. Used by the sidebar "按项目" view-mode.
 */

import type { SessionSummary } from '@maka/core';

export interface ProjectGroup {
  projectPath: string;
  label: string;
  sessions: SessionSummary[];
}

const UNGROUPED_LABEL = '未归属项目';
const UNGROUPED_KEY = '__ungrouped__';

/**
 * Group the given sessions by their `cwd` field.
 * Groups are returned in insertion order; the ungrouped bucket (if any)
 * appears last. The label is the basename of the project directory.
 */
export function deriveProjectGroups(sessions: ReadonlyArray<SessionSummary>): ProjectGroup[] {
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

  const groups: ProjectGroup[] = [];
  for (const [key, bucket] of map) {
    if (key === UNGROUPED_KEY) continue; // append last
    groups.push({
      projectPath: key,
      label: labelFromPath(key),
      sessions: bucket,
    });
  }
  // Un-belonged sessions go last, in a single catch-all group.
  const ungrouped = map.get(UNGROUPED_KEY);
  if (ungrouped) {
    groups.push({
      projectPath: '',
      label: UNGROUPED_LABEL,
      sessions: ungrouped,
    });
  }
  return groups;
}

function labelFromPath(projectPath: string): string {
  // Use the basename (last path segment) as the human-readable label.
  const parts = projectPath.replace(/\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || projectPath;
}
