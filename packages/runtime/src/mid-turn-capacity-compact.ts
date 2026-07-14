import type { RuntimeEvent } from '@maka/core/runtime-event';

/**
 * Mid-turn capacity compaction: the pure measurement + safe-boundary engine.
 *
 * The runtime owns one active-turn context invariant — a long single turn must
 * compact a safe completed prefix before the next provider request crosses the
 * selected model's context window. This module is turn-agnostic and side-effect
 * free: it estimates the next request, decides whether the high-water or the
 * hard window is crossed, and selects the largest safe covered prefix. The
 * checkpoint protocol (history-compact-checkpoint.ts) then folds that prefix.
 */

export interface EstimateNextRequestTokensInput {
  /**
   * Real provider usage for the last completed step, summed as
   * `inputTokens + outputTokens`. Undefined on cold start (no step has reported
   * usage yet), which falls back to a whole-projection char estimate.
   */
  priorUsageTokens?: number;
  /** Chars of content appended since the last usage sample (e.g. tool results). */
  appendedChars: number;
  /** Estimate conversion; defaults to 4 chars/token. */
  charsPerToken?: number;
  /** Whole-projection chars, used only when `priorUsageTokens` is undefined. */
  coldStartChars?: number;
}

/**
 * Estimate the token size of the next provider request. Anchors on the last
 * step's real usage plus a char/4 tail delta for content the provider has not
 * yet counted; cold-start (no usage) is a pure char/4 estimate of the whole
 * projection. This mirrors how surveyed peers avoid pure character guessing.
 */
export function estimateNextRequestTokens(input: EstimateNextRequestTokensInput): number {
  const charsPerToken = Math.max(1, input.charsPerToken ?? 4);
  if (input.priorUsageTokens !== undefined && Number.isFinite(input.priorUsageTokens)) {
    return Math.max(0, Math.floor(input.priorUsageTokens)) + estimateChars(input.appendedChars, charsPerToken);
  }
  return estimateChars(input.coldStartChars ?? input.appendedChars, charsPerToken);
}

/** Proactive threshold: the next request would cross `contextWindow - reserve`. */
export function exceedsHighWater(
  estimatedTokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  const highWater = Math.max(1, contextWindow - Math.max(0, reserveTokens));
  return estimatedTokens > highWater;
}

/** Hard cap: the estimate exceeds the raw context window even before the reserve. */
export function exceedsContextWindow(estimatedTokens: number, contextWindow: number): boolean {
  return estimatedTokens > contextWindow;
}

export interface MidTurnBoundaryOptions {
  /** Keep at least this many trailing events uncovered as the verbatim tail. */
  reserveTailEvents?: number;
}

export type MidTurnBoundary =
  | { ok: true; coveredCount: number }
  | { ok: false; reason: 'no_safe_completed_span' };

/**
 * Select the largest contiguous covered prefix that is safe to fold:
 *
 *  - it ends on an immutable, non-partial event (a partial streaming snapshot is
 *    later replaced/deleted, so a digest over it can never replay);
 *  - it never straddles a tool call/result pair (a provider protocol unit);
 *  - it leaves at least `reserveTailEvents` trailing events as the verbatim tail.
 *
 * Returns `no_safe_completed_span` when no such cut exists (e.g. the remaining
 * pool is a single atomic call/result pair), which the caller surfaces as an
 * explicit `context_budget_exhausted` outcome rather than a provider error.
 */
export function selectMidTurnSafeBoundary(
  events: readonly RuntimeEvent[],
  options: MidTurnBoundaryOptions = {},
): MidTurnBoundary {
  const reserveTail = Math.max(0, Math.floor(options.reserveTailEvents ?? 0));
  const maxCut = events.length - reserveTail;
  const pairSpans = toolPairSpans(events);
  for (let cut = maxCut; cut >= 1; cut -= 1) {
    if (events[cut - 1]?.partial === true) continue;
    if (straddlesToolPair(pairSpans, cut)) continue;
    return { ok: true, coveredCount: cut };
  }
  return { ok: false, reason: 'no_safe_completed_span' };
}

interface ToolPairSpan {
  callIndex?: number;
  responseIndex?: number;
}

function toolPairSpans(events: readonly RuntimeEvent[]): ToolPairSpan[] {
  const byCallId = new Map<string, ToolPairSpan>();
  events.forEach((event, index) => {
    const content = event.content;
    if (content?.kind === 'function_call') {
      const span = byCallId.get(content.id) ?? {};
      span.callIndex = index;
      byCallId.set(content.id, span);
    } else if (content?.kind === 'function_response') {
      const span = byCallId.get(content.id) ?? {};
      span.responseIndex = index;
      byCallId.set(content.id, span);
    }
  });
  return [...byCallId.values()];
}

/** A cut at exclusive index `cut` straddles a pair if exactly one side is covered. */
function straddlesToolPair(spans: readonly ToolPairSpan[], cut: number): boolean {
  for (const span of spans) {
    if (span.callIndex === undefined || span.responseIndex === undefined) continue;
    const callCovered = span.callIndex < cut;
    const responseCovered = span.responseIndex < cut;
    if (callCovered !== responseCovered) return true;
  }
  return false;
}

function estimateChars(chars: number | undefined, charsPerToken: number): number {
  const value = Math.max(0, Math.floor(chars ?? 0));
  if (value === 0) return 0;
  return Math.ceil(value / charsPerToken);
}
