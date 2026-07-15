/**
 * Pure derivation of "which sessions in the sidebar are stale" — used to
 * dim those rows and stamp a small "已过期" pill so users can spot dead
 * sessions before clicking in and seeing the chat-header banner (PR108e).
 *
 * Lives outside the React component so it can be unit-tested without a DOM
 * (mirrors the `session-health-notice.ts` pattern). The renderer wraps the
 * returned Set into the `staleSessionIds` prop of SessionListPanel.
 *
 * Two signals classify a session as stale:
 *
 *   1. `backend === 'fake'` — FakeBackend session, either from a visual
 *      smoke fixture or a legacy install that pre-dates the chat-readiness
 *      gate. With @xuan's send-path silent rebind these will swap to the
 *      default connection on send.
 *
 *   2. `llmConnectionSlug` no longer resolves in the current connection
 *      list — covers (a) connection deletion while the session was open,
 *      and (b) legacy slugs like `fake-claude` that point at removed
 *      backend kinds.
 *
 * The classifier is intentionally generous: any session that won't reach a
 * real provider via its stored backend/slug is "stale" regardless of
 * whether a default exists. The chat-header banner uses a separate
 * `defaultConnectionReady` signal to decide warning vs. destructive tone;
 * the sidebar pill is uniform (just "is this row broken?").
 */

export interface StaleSessionsInput {
  /** Sessions visible in the sidebar (already filtered + grouped). */
  sessions: ReadonlyArray<{
    id: string;
    backend: string;
    llmConnectionSlug: string;
  }>;
  /** Connection slugs that currently exist in the store. */
  knownConnectionSlugs: ReadonlySet<string>;
}

export function deriveStaleSessionIds(input: StaleSessionsInput): Set<string> {
  const stale = new Set<string>();
  for (const session of input.sessions) {
    if (isStale(session, input.knownConnectionSlugs)) {
      stale.add(session.id);
    }
  }
  return stale;
}

function isStale(
  session: { backend: string; llmConnectionSlug: string },
  knownConnectionSlugs: ReadonlySet<string>,
): boolean {
  if (session.backend === 'fake') return true;
  return !knownConnectionSlugs.has(session.llmConnectionSlug);
}
