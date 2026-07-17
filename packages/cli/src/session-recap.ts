import type { ModelMessage } from 'ai';
import { userFacingText, type StoredMessage } from '@maka/core';

/**
 * Final instruction appended as the last user message when asking the model
 * to recap a session. No tools are offered on this call and the exchange is
 * never persisted to the session's own history.
 */
export const RECAP_INSTRUCTION =
  '<system-reminder>The user is returning to this session after being away. Write ONE sentence (roughly 25-40 words) recapping where things stand so they can resume instantly. Lead with agency: "You asked ..." if the session was mainly questions or review with no landed change; "We fixed/added/wired ..." if the agent landed changes; exactly "You had just begun this session." if almost nothing happened. Output only the sentence - no labels, no quotes, no preamble.</system-reminder>';

/** Idle gap (ms) after which the first normal prompt on return triggers an automatic recap. */
export const AUTO_RECAP_IDLE_MS = 180_000;
/** Minimum main-turn count (user-prompted turns) before an automatic recap may fire. */
export const AUTO_RECAP_MIN_TURNS = 3;
/** Raw-output size (bytes) above which an automatic recap is not surfaced in the transcript (still persisted). */
export const AUTO_RECAP_DISPLAY_LIMIT_BYTES = 500;

/** Projected messages are trimmed down to no fewer than this many, plus the instruction. */
const MIN_PROJECTED_MESSAGES_KEPT = 4;

function isToolPlaceholder(message: ModelMessage): boolean {
  return (
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    (message.content.startsWith('[tool: ') || message.content.startsWith('[tool result: '))
  );
}

/**
 * Projects one StoredMessage into a ModelMessage for the recap prompt, or
 * `undefined` when the message contributes nothing (empty text, or a
 * non-conversational bookkeeping row such as token usage / turn state /
 * permission decisions / system notes).
 */
function projectMessage(message: StoredMessage): ModelMessage | undefined {
  switch (message.type) {
    case 'user': {
      const text = userFacingText(message);
      if (!text.trim()) return undefined;
      return { role: 'user', content: text };
    }
    case 'assistant': {
      if (!message.text.trim()) return undefined;
      return { role: 'assistant', content: message.text };
    }
    case 'tool_call':
      return { role: 'assistant', content: `[tool: ${message.toolName}]` };
    case 'tool_result':
      return { role: 'assistant', content: `[tool result: ${message.isError ? 'error' : 'ok'}]` };
    default:
      // permission_decision / token_usage / turn_state / system_note carry no
      // conversational content for a recap.
      return undefined;
  }
}

function estimateTokens(messages: readonly ModelMessage[]): number {
  const totalChars = messages.reduce((sum, message) => {
    return sum + (typeof message.content === 'string' ? message.content.length : 0);
  }, 0);
  return Math.ceil(totalChars / 4);
}

/**
 * Projects stored session messages into a recap prompt, appending
 * `RECAP_INSTRUCTION` as the final user message. When `contextWindow` is
 * known, trims to fit an 85%-of-window budget (minus a 4096-token safety
 * margin): first the trailing run of dangling tool placeholders, then from
 * the head — always keeping at least the last 4 projected messages plus the
 * instruction.
 */
export function buildRecapMessages(
  messages: readonly StoredMessage[],
  budget: { contextWindow: number | undefined },
): ModelMessage[] {
  const instruction: ModelMessage = { role: 'user', content: RECAP_INSTRUCTION };
  const projected: ModelMessage[] = [];
  for (const message of messages) {
    const entry = projectMessage(message);
    if (entry) projected.push(entry);
  }

  if (budget.contextWindow === undefined) {
    return [...projected, instruction];
  }

  const tokenBudget = Math.floor(budget.contextWindow * 0.85) - 4096;
  let working = projected;
  const withinBudget = () => estimateTokens([...working, instruction]) <= tokenBudget;

  if (!withinBudget()) {
    // Drop the trailing run of dangling tool placeholders first.
    while (
      working.length > MIN_PROJECTED_MESSAGES_KEPT &&
      isToolPlaceholder(working[working.length - 1])
    ) {
      working = working.slice(0, -1);
    }
    // Still over budget: drop from the head, keeping the most recent messages.
    while (working.length > MIN_PROJECTED_MESSAGES_KEPT && !withinBudget()) {
      working = working.slice(1);
    }
  }

  return [...working, instruction];
}

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
