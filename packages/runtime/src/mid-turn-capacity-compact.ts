import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ContextBudgetExhaustedDetail } from '@maka/core/events';
import { estimateRuntimeEventsTokens } from './context-budget.js';
import {
  buildHistoryCompactCheckpoint,
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  projectHistoryCompactCheckpointReplay,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

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
  // A partial anywhere in the covered prefix (not just at the cut) poisons the
  // digest — its snapshot is later replaced or deleted — so the boundary
  // retreats to strictly before the first partial in the pool.
  const firstPartialIndex = events.findIndex((event) => event.partial === true);
  const maxCut = Math.min(
    events.length - reserveTail,
    firstPartialIndex === -1 ? events.length : firstPartialIndex,
  );
  const pairSpans = toolPairSpans(events);
  for (let cut = maxCut; cut >= 1; cut -= 1) {
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

// ============================================================================
// Orchestration: engine + checkpoint protocol + injected summarizer → decision
// ============================================================================

export type MidTurnSummarizer = (input: {
  coveredRuntimeEvents: readonly RuntimeEvent[];
  newlyFoldedRuntimeEvents: readonly RuntimeEvent[];
  previousCheckpoint?: HistoryCompactCheckpoint;
}) => Promise<string | undefined> | string | undefined;

export interface PlanMidTurnCapacityCompactionInput {
  sessionId: string;
  /**
   * Full ordered content-event projection for the compaction pool:
   * `[...prior turns, head anchor, ...current-turn completed steps]`.
   */
  orderedEvents: readonly RuntimeEvent[];
  /** The current turn's user message; must be one of `orderedEvents`. */
  headAnchor: { runtimeEventId: string; turnId: string };
  /** Estimated size of the next provider request (see estimateNextRequestTokens). */
  estimatedNextRequestTokens: number;
  contextWindow: number;
  reserveTokens: number;
  reserveTailEvents?: number;
  charsPerToken?: number;
  now?: number;
  highWaterName?: string;
  highWaterSeq?: number;
  maxSummaryEstimatedTokens?: number;
  previousCheckpoint?: HistoryCompactCheckpoint;
  summarize: MidTurnSummarizer;
}

export type PlanMidTurnCapacityCompactionResult =
  | { decision: 'skip'; reason: 'below_high_water' | 'head_anchor_not_covered' }
  | { decision: 'fail_open'; reason: MidTurnFailReason }
  | { decision: 'exhausted'; detail: ContextBudgetExhaustedDetail }
  | {
      decision: 'compacted';
      checkpoint: HistoryCompactCheckpoint;
      /** Deterministic `[block, head anchor, tail]` replacement projection. */
      replacementEvents: RuntimeEvent[];
      coveredRuntimeEvents: RuntimeEvent[];
      tailRuntimeEvents: RuntimeEvent[];
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
    };

export type MidTurnFailReason =
  | 'no_safe_completed_span'
  | 'summarizer_failed'
  | 'replacement_exceeds_window';

/**
 * Decide, deterministically, how a long active turn compacts before the next
 * provider request. Two failure tiers (design): below the high-water the turn
 * still fits the window, so a compaction failure fails open (send as-is +
 * diagnostic); once the estimate exceeds the window itself and compaction
 * cannot help, the turn ends with an explicit `context_budget_exhausted`
 * outcome instead of relying on a provider context-length error.
 */
export async function planMidTurnCapacityCompaction(
  input: PlanMidTurnCapacityCompactionInput,
): Promise<PlanMidTurnCapacityCompactionResult> {
  const charsPerToken = Math.max(1, input.charsPerToken ?? 4);
  const highWater = Math.max(1, input.contextWindow - Math.max(0, input.reserveTokens));
  if (input.estimatedNextRequestTokens <= highWater) {
    return { decision: 'skip', reason: 'below_high_water' };
  }
  const overWindow = input.estimatedNextRequestTokens > input.contextWindow;
  const failOrExhaust = (
    reason: MidTurnFailReason,
    detail: ContextBudgetExhaustedDetail,
  ): PlanMidTurnCapacityCompactionResult =>
    overWindow ? { decision: 'exhausted', detail } : { decision: 'fail_open', reason };

  const boundary = selectMidTurnSafeBoundary(input.orderedEvents, {
    reserveTailEvents: input.reserveTailEvents ?? 1,
  });
  const headAnchorIndex = input.orderedEvents.findIndex(
    (event) => event.id === input.headAnchor.runtimeEventId,
  );
  // Coverage must include the head anchor and at least one other event, since the
  // anchor is re-rendered verbatim — folding only the anchor saves nothing.
  if (
    !boundary.ok
    || headAnchorIndex < 0
    || boundary.coveredCount <= headAnchorIndex
    || boundary.coveredCount < 2
  ) {
    return failOrExhaust('no_safe_completed_span', 'no_safe_completed_span');
  }

  const coveredRuntimeEvents = input.orderedEvents.slice(0, boundary.coveredCount);
  const tailRuntimeEvents = input.orderedEvents.slice(boundary.coveredCount);

  // Roll forward from a previous checkpoint when it is an exact prefix of the
  // covered events, so the summary only re-reads the newly folded span.
  const checkpointMatch = input.previousCheckpoint
    ? matchHistoryCompactCheckpointPrefix(input.previousCheckpoint, coveredRuntimeEvents)
    : undefined;
  const previousCheckpoint = checkpointMatch && !checkpointMatch.reason ? input.previousCheckpoint : undefined;
  const newlyFoldedRuntimeEvents = previousCheckpoint
    ? checkpointMatch!.successorRuntimeEvents
    : coveredRuntimeEvents;

  let summary: string | undefined;
  try {
    summary = (await Promise.resolve(input.summarize({
      coveredRuntimeEvents,
      newlyFoldedRuntimeEvents,
      ...(previousCheckpoint ? { previousCheckpoint } : {}),
    })))?.trim();
  } catch {
    summary = undefined;
  }
  if (!summary) {
    return failOrExhaust('summarizer_failed', 'summarizer_failed');
  }

  const checkpoint = buildHistoryCompactCheckpoint({
    sessionId: input.sessionId,
    coveredRuntimeEvents,
    summary,
    phase: 'mid_turn',
    headAnchor: input.headAnchor,
    ...(input.highWaterName !== undefined ? { highWaterName: input.highWaterName } : {}),
    ...(input.highWaterSeq !== undefined ? { highWaterSeq: input.highWaterSeq } : {}),
    ...(input.maxSummaryEstimatedTokens !== undefined
      ? { maxSummaryEstimatedTokens: input.maxSummaryEstimatedTokens }
      : {}),
    ...(previousCheckpoint ? { previousCheckpointId: previousCheckpoint.checkpointId } : {}),
    charsPerToken,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  const replacementEvents = projectHistoryCompactCheckpointReplay(
    checkpoint,
    coveredRuntimeEvents,
    tailRuntimeEvents,
  );
  const estimatedTokensBefore = estimateRuntimeEventsTokens(coveredRuntimeEvents, charsPerToken);
  const estimatedTokensAfter = estimateRuntimeEventsTokens(
    [historyCompactCheckpointToRuntimeEvent(checkpoint)],
    charsPerToken,
  );

  // Re-estimate the FULL next request after folding, keeping the fixed
  // overhead (system prompt, tool schemas, current user content) that the
  // usage-anchored estimate carries: subtract only the covered span's share
  // and add back the [block, verbatim head anchor, tail] projection. Folding
  // cannot reduce the request below this number, so when it still exceeds the
  // window the turn is not rescuable by compaction: over the window that is
  // the explicit exhausted outcome (the irreducible remainder — head anchor,
  // reserved tail, and fixed overhead — exceeds capacity); under the window
  // the raw request still fits, so a replacement projection that would grow
  // past the window fails open instead of replacing.
  const estimatedNextRequestAfter =
    Math.max(0, input.estimatedNextRequestTokens - estimatedTokensBefore)
    + estimateRuntimeEventsTokens(replacementEvents, charsPerToken);
  if (estimatedNextRequestAfter > input.contextWindow) {
    return failOrExhaust('replacement_exceeds_window', 'head_anchor_exceeds_capacity');
  }

  return {
    decision: 'compacted',
    checkpoint,
    replacementEvents,
    coveredRuntimeEvents,
    tailRuntimeEvents,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}
