import type { AutomationDefinition } from './automation-state.js';

/**
 * Session statuses a heartbeat may fire into. A heartbeat injects a turn into
 * its own session, so it must only fire when that session is not mid-turn
 * ('running'), under review, blocked, aborted, or archived. Shared by every
 * host so the desktop and CLI gates cannot diverge.
 *
 * 'waiting_for_user' is IN the set (#639 decision): a session parked waiting
 * for the user's next message is the wakeup's HOME scenario — the whole point
 * of a heartbeat is to start a turn in place of the user. 'done' is also in
 * (firing into a completed session is the durable-cron case).
 */
export const HEARTBEAT_IDLE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'done',
  'waiting_for_user',
]);

/** Minimal session-header shape the fire gate reads. */
export interface CanFireSessionHeader {
  archivedAt?: number | null;
  status: string;
}

export interface EvaluateAutomationCanFireDeps {
  /** Global privacy gate — true blocks every kind. */
  isIncognitoActive: () => Promise<boolean>;
  /** Reads the session header; may THROW if the session file is gone (deleted). */
  readSessionHeader: (sessionId: string) => Promise<CanFireSessionHeader | null>;
  /** Session statuses a heartbeat may fire into (idle). Defaults to HEARTBEAT_IDLE_STATUSES. */
  idleStatuses?: ReadonlySet<string>;
}

/**
 * Decide whether an automation may fire now. Kind-aware:
 * - Global privacy (incognito) blocks every kind.
 * - Cron spawns a FRESH session, so its creator session is irrelevant — it is
 *   never gated on that session. This is what lets a durable cron keep firing
 *   after the conversation that created it is archived or deleted.
 * - Heartbeat injects into its own session, so that session must exist (reading
 *   it must not throw) and be idle (not archived, an idle status).
 * Pure and injectable so the gate is unit-testable and identical across hosts.
 */
export async function evaluateAutomationCanFire(
  automation: Pick<AutomationDefinition, 'kind' | 'sessionId'>,
  deps: EvaluateAutomationCanFireDeps,
): Promise<boolean> {
  if (await deps.isIncognitoActive()) return false;
  if (automation.kind === 'cron') return true;
  const idle = deps.idleStatuses ?? HEARTBEAT_IDLE_STATUSES;
  let header: CanFireSessionHeader | null;
  try {
    header = await deps.readSessionHeader(automation.sessionId);
  } catch {
    return false; // session file gone (deleted) → nothing to inject into
  }
  if (!header || header.archivedAt) return false;
  return idle.has(header.status);
}
