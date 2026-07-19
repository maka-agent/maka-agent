/**
 * Derivation of the session health notice shown above the composer.
 *
 * #1038 — the notice answers exactly one question: "will the next send
 * fail for a recoverable connection/session reason, and where should the
 * user go?". The answer comes from `projectSessionSendOutcome` — the
 * same core projection the main-process send gate delegates to — fed
 * with renderer-side facts: the connection list, the default slug, a
 * `connections:hasSecret` probe, and `connectionLocked` on the session
 * summary. The notice and the send path cannot disagree, because they
 * decide from the same code over the same facts:
 *
 *   - `ready` / `rebind` → no notice (silent rebind stays silent, #1032).
 *   - `blocked` → destructive notice whose copy names the failing
 *     connection and points at the matching Settings section.
 *
 * `lastTestStatus` is an intentional pre-send reminder (product contract
 * decided in #1038). E4 locks that it must NOT gate send, so here it
 * must never claim send is blocked either: it renders only as a
 * `warning`, only when the projection says the session's own connection
 * will serve the next send (`ready`), and its copy states plainly that
 * the send is not intercepted. When the projection rebinds away from the
 * connection, the reminder is noise and stays silent.
 */

import {
  projectSessionSendOutcome,
  type LlmConnection,
  type SessionSendProjection,
  type SessionSendProjectionSession,
  type UiLocale,
} from '@maka/core';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

export interface SessionHealthNoticeInput {
  locale: UiLocale;
  /**
   * The active session's send-relevant header facts. `undefined` when no
   * session is active → no notice. `backend` is `string` (not
   * `BackendKind`) so legacy on-disk values like `'claude'` surface
   * exactly as stored.
   */
  session: SessionSendProjectionSession | undefined;
  /** Every persisted connection — the projection's rebind walk reads all of them. */
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  /**
   * Secret presence per slug from the `connections:hasSecret` probe.
   * Unknown (probe in flight) is treated as present so a destructive
   * notice never flashes before the first probe lands; a genuine block
   * simply appears one tick later.
   */
  hasSecret(slug: string): boolean;
  /**
   * The session's own connection's most recent credential test result.
   * Advisory reminder only — never interpreted as a send block (E4).
   */
  lastTestStatus: 'verified' | 'needs_reauth' | 'error' | undefined;
}

export type SessionHealthNoticeTarget = 'models' | 'account';

export interface SessionHealthNotice {
  tone: 'info' | 'warning' | 'destructive';
  /** Short label shown inside the notice. */
  label: string;
  /** Longer explanation for tooltip / assistive text. */
  tooltip?: string;
  /** Which Settings section the click handler should navigate to. */
  onClickTarget: SessionHealthNoticeTarget;
}

export function deriveSessionHealthNotice(
  input: SessionHealthNoticeInput,
): SessionHealthNotice | undefined {
  const { session } = input;
  if (!session) return undefined;

  const outcome = projectSessionSendOutcome({
    session,
    connections: input.connections,
    defaultSlug: input.defaultSlug,
    hasSecret: input.hasSecret,
  });

  if (outcome.kind === 'blocked') return blockedNotice(outcome, input);
  if (outcome.kind === 'rebind') return undefined;
  return credentialReminderNotice(input.lastTestStatus, input.locale);
}

function blockedNotice(
  outcome: Extract<SessionSendProjection, { kind: 'blocked' }>,
  input: SessionHealthNoticeInput,
): SessionHealthNotice {
  const session = input.session!;
  const own = input.connections.find((connection) => connection.slug === session.llmConnectionSlug);
  const name = own?.name ?? session.llmConnectionSlug;
  const copy = getDesktopConversationCopy(input.locale).health.blocked[outcome.reason];
  return {
    tone: 'destructive',
    label: copy.label,
    tooltip: copy.tooltip(name, session.model),
    onClickTarget: 'models',
  };
}

/**
 * The intentional `lastTestStatus` reminder (#1038 contract): warning
 * tone only, copy states the send is NOT intercepted, Settings remains
 * the fix home. Only called when the projection is `ready`.
 */
function credentialReminderNotice(
  lastTestStatus: SessionHealthNoticeInput['lastTestStatus'],
  locale: UiLocale,
): SessionHealthNotice | undefined {
  const copy = getDesktopConversationCopy(locale).health;
  if (lastTestStatus === 'needs_reauth') {
    return {
      tone: 'warning',
      label: copy.reauth.label,
      tooltip: copy.reauth.tooltip,
      onClickTarget: 'account',
    };
  }
  if (lastTestStatus === 'error') {
    return {
      tone: 'warning',
      label: copy.testError.label,
      tooltip: copy.testError.tooltip,
      onClickTarget: 'account',
    };
  }
  return undefined;
}
