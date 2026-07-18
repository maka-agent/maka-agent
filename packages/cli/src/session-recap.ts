/**
 * Final instruction appended as the last user message when asking the model
 * to recap a session. No tools are offered on this call and the exchange is
 * never persisted to the session's own history.
 */
export const RECAP_INSTRUCTION =
  '<system-reminder>The user is returning to this session after being away. Write ONE sentence (roughly 25-40 words) recapping where things stand so they can resume instantly. Write the sentence in the language of the user\'s most recent substantive message; for mixed-language sessions use the dominant language of the user\'s messages. Lead with agency, phrased naturally in that language: if the session was mainly questions or review with no landed change, open by referencing what the user asked (the equivalent of "You asked ..."); if the agent landed changes, reference what was done (the equivalent of "We fixed/added/wired ..."); if almost nothing happened, say in that language that the session had just begun. Output only the sentence - no labels, no quotes, no preamble.</system-reminder>';

/** Idle gap (ms) after which the first normal prompt on return triggers an automatic recap. */
export const AUTO_RECAP_IDLE_MS = 180_000;
/** Minimum main-turn count (user-prompted turns) before an automatic recap may fire. */
export const AUTO_RECAP_MIN_TURNS = 3;
/** Raw-output size (bytes) above which an automatic recap is not surfaced in the transcript (still persisted). */
export const AUTO_RECAP_DISPLAY_LIMIT_BYTES = 500;

/**
 * Cleans a raw model recap response: collapses whitespace, strips a leading
 * `Recap:` / `Summary:` / `回顾：`-style label, strips one layer of wrapping
 * quotes, and truncates to 1200 characters (with an ellipsis) if needed.
 */
export function cleanRecapText(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/^(recap|summary|回顾)\s*[:：]\s*/i, '').trim();

  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
  ];
  for (const [open, close] of quotePairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }

  if (text.length > 1200) {
    text = `${text.slice(0, 1200)}…`;
  }
  return text;
}

export interface ShouldAutoRecapInput {
  /** Milliseconds since the last recorded user activity. */
  idleMs: number;
  /** Current main (user-prompted) turn count. */
  mainTurnCount: number;
  /** Main turn count as of the last recap (manual or automatic). */
  lastRecapMainTurnCount: number;
}

/**
 * Whether a normal-prompt submission after an idle gap should trigger an
 * automatic recap: idle for at least `AUTO_RECAP_IDLE_MS`, at least
 * `AUTO_RECAP_MIN_TURNS` main turns so far, and progress since the last recap
 * (a per-main-turn watermark).
 */
export function shouldAutoRecap(input: ShouldAutoRecapInput): boolean {
  return (
    input.idleMs >= AUTO_RECAP_IDLE_MS &&
    input.mainTurnCount >= AUTO_RECAP_MIN_TURNS &&
    input.mainTurnCount > input.lastRecapMainTurnCount
  );
}
