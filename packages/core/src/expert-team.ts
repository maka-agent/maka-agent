/**
 * Expert-team session labels.
 *
 * An expert-team session is a normal session tagged with the label
 * `mode:expert-team:<teamId>`. The label activates the team lead's orchestrator
 * persona (a system-prompt fragment) and the `expert_dispatch` tool that lets
 * the lead fan work out to member experts. This mirrors the read-only Deep
 * Research mode (`mode:deep_research`), but is parameterized by a team id.
 *
 * Only the label vocabulary lives here (the shared session-contract layer). The
 * team definitions, member personas, and the lead system-prompt fragment live
 * in `@maka/runtime` (they reference agent/tool concepts core does not own).
 */

export const EXPERT_TEAM_LABEL_PREFIX = 'mode:expert-team:';

/** Build the session label for a given expert team id. */
export function expertTeamLabel(teamId: string): string {
  return `${EXPERT_TEAM_LABEL_PREFIX}${teamId}`;
}

/**
 * Extract the expert-team id from a session's labels, or `undefined` if the
 * session is not an expert-team session. Returns the first matching label's id.
 */
export function expertTeamIdFromLabels(labels: readonly string[] | undefined): string | undefined {
  if (!Array.isArray(labels)) return undefined;
  for (const label of labels) {
    if (label.startsWith(EXPERT_TEAM_LABEL_PREFIX)) {
      const teamId = label.slice(EXPERT_TEAM_LABEL_PREFIX.length);
      if (teamId) return teamId;
    }
  }
  return undefined;
}

/** True when the session carries an expert-team label. */
export function isExpertTeamSession(labels: readonly string[] | undefined): boolean {
  return expertTeamIdFromLabels(labels) !== undefined;
}
