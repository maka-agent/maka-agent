import type {
  PromptComposition,
  PromptCompositionPartKind,
  SessionTrace,
  TraceModelAttempt,
  TraceModelCallStep,
  TurnTrace,
} from '@maka/core/session-trace';

/**
 * Overview view model for the Inspector panel's summary sections.
 *
 * Pure, for the same reason `deriveInspectorPanelModel` is: every judgement
 * about what a number means is testable without a DOM, and the panel only lays
 * the result out. Nothing is derived that the trace does not carry — a session
 * whose backend reports no usage shows its structure and says so, rather than
 * fabricating zeros (#1625, #1679).
 */

/**
 * One band of the context window.
 *
 * `cacheRead` + `fresh` split the prompt by what the provider served from its
 * cache; `used` is the same prompt left whole because the provider reported no
 * cache figure — an unsplit bar, not a bar that claims a zero cache hit.
 * `free` is the headroom left in the window.
 */
export type InspectorContextSegmentKind = 'cacheRead' | 'fresh' | 'used' | 'free';

export interface InspectorContextSegment {
  kind: InspectorContextSegmentKind;
  tokens: number;
}

/** The prompt size of the most recent metered call, against its own ceiling. */
export interface InspectorContextBudget {
  usedTokens: number;
  /** The window the call was metered against, frozen at call time. */
  windowTokens: number;
  /** usedTokens / windowTokens; the panel clamps for display, not here. */
  ratio: number;
  /**
   * The window broken into bands, in reading order and with empty bands
   * dropped, so the bar and its legend cannot disagree about what is drawn.
   */
  segments: readonly InspectorContextSegment[];
}

/**
 * One row of "what was this prompt made of", sized in bytes and estimated in
 * tokens (#2323).
 *
 * The estimate is made HERE, at the display layer, and never enters the trace:
 * `bytes / 4` is a rule of thumb over serialized JSON, and a figure that has
 * been rounded into the contract can no longer be labelled as an estimate where
 * it is shown. The panel prints every one of these with a `≈`.
 */
export interface InspectorCompositionRow {
  /** Stable key: a part kind, or a tool name. */
  key: string;
  bytes: number;
  estimatedTokens: number;
}

export interface InspectorCompositionPart extends InspectorCompositionRow {
  kind: PromptCompositionPartKind;
}

export interface InspectorCompositionTool extends InspectorCompositionRow {
  name: string;
}

export interface InspectorComposition {
  /**
   * The whole serialized request. Carried as the measured fact, not rendered:
   * the parts are what a reader acts on, and a fourth total beside them would
   * only invite subtracting one from the other across two different units.
   */
  totalBytes: number;
  parts: readonly InspectorCompositionPart[];
  /** The largest tool schemas, largest first — the ones worth removing. */
  tools: readonly InspectorCompositionTool[];
  /** Everything below the visible tools, folded so the total still adds up. */
  remainingTools?: { count: number; bytes: number; estimatedTokens: number };
  /** Tool schemas the payload did not name; counted, never attributed. */
  unlabelledTools?: { bytes: number; estimatedTokens: number };
}

/**
 * Composition of the same request the bar measures, or the reason there is
 * none.
 *
 * `unrecorded` is a real answer, not an empty one: metering is durable and the
 * capture carrying the segments is best-effort, so a metered call with no
 * breakdown on record happens, and rendering it as a prompt made of nothing
 * would be the fabrication the ledger rules exist to prevent (#1679).
 */
export type InspectorCompositionState =
  | { status: 'available'; composition: InspectorComposition }
  | { status: 'unrecorded' };

export interface InspectorOverviewModel {
  /** Absent when no completed main call reported both usage and a window. */
  context?: InspectorContextBudget;
  /**
   * What filled the context above. Absent only when there is no call to ask
   * about; present-but-`unrecorded` when there is one and it carried no
   * capture.
   *
   * Deliberately read off the SAME attempt as `context`, never the latest
   * capture on the session: a breakdown of one request under a bar measuring a
   * different one would be two facts wearing one heading.
   */
  composition?: InspectorCompositionState;
  /**
   * cacheRead / input over the attempts that reported input, session-wide.
   * Absent when no input was metered at all — a rate over nothing is not
   * zero, it is unknown.
   *
   * The only token figure the panel keeps. The raw totals it used to carry
   * were priced by `totals.costUsd`, sized by the context bar and audited in
   * the run ledger; three statements of the same tokens is two too many.
   */
  cacheHitRate?: number;
}

export function deriveInspectorOverviewModel(trace: SessionTrace | undefined): InspectorOverviewModel {
  if (!trace || trace.turns.length === 0) return {};

  const modelSteps = trace.turns.flatMap(modelCallSteps);
  const cacheHitRate = sessionCacheHitRate(modelSteps.flatMap((step) => step.attempts));
  const latest = latestMeteredMainAttempt(modelSteps);
  const context = latest ? contextBudget(latest) : undefined;
  const composition = latest ? compositionState(latest.promptComposition) : undefined;

  return {
    ...(context ? { context } : {}),
    ...(composition ? { composition } : {}),
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
  };
}

function modelCallSteps(turn: TurnTrace): TraceModelCallStep[] {
  return turn.steps.filter((step): step is TraceModelCallStep => step.kind === 'model_call');
}

/**
 * Summed over the attempts that reported input, and undefined when none did:
 * a rate over nothing is unknown, not zero, the same way "did not report" and
 * "reported none" stay apart in the ledger (#1679).
 *
 * An input-reported attempt without a cache figure reads as a miss, because
 * the providers that cache always count the hits.
 *
 * Each attempt's cache read is clamped to its own prompt, the same way the
 * context bar clamps it: a provider can report more cache than prompt — the
 * runtime's Google mapping guards against exactly that — and a share of a
 * prompt over 100% is not a fact, it is corruption wearing a percent sign.
 */
function sessionCacheHitRate(attempts: readonly TraceModelAttempt[]): number | undefined {
  const input = attempts.filter((attempt) => attempt.inputTokens !== undefined);
  const inputTokens = sum(input, (attempt) => attempt.inputTokens);
  if (inputTokens === 0) return undefined;
  return sum(input, (attempt) => Math.min(attempt.cacheReadInputTokens ?? 0, attempt.inputTokens!)) / inputTokens;
}

/**
 * The budget question a reader actually asks — "how full is the context right
 * now" — is answered by the most recent completed call whose provider counted
 * a prompt: its input total IS the context size the next call builds on.
 */
function latestMeteredMainAttempt(
  steps: readonly TraceModelCallStep[],
): TraceModelAttempt | undefined {
  const candidates = steps
    .filter((step) => step.callKind === 'main')
    .flatMap((step) => step.attempts)
    .filter(
      (attempt) =>
        attempt.status === 'completed' &&
        attempt.inputTokens !== undefined &&
        attempt.contextWindow !== undefined &&
        attempt.contextWindow > 0,
    );
  return candidates.reduce<TraceModelAttempt | undefined>(
    (carry, attempt) => (carry === undefined || attempt.completedAt >= carry.completedAt ? attempt : carry),
    undefined,
  );
}

function contextBudget(latest: TraceModelAttempt): InspectorContextBudget {
  const usedTokens = latest.inputTokens!;
  const windowTokens = latest.contextWindow!;
  // A cache figure larger than the prompt it belongs to is not a fact about
  // the window, so it is clamped rather than allowed to push `fresh` negative.
  const cacheRead =
    latest.cacheReadInputTokens !== undefined
      ? Math.min(latest.cacheReadInputTokens, usedTokens)
      : undefined;
  const prompt: { kind: InspectorContextSegmentKind; tokens: number }[] =
    cacheRead === undefined
      ? [{ kind: 'used', tokens: usedTokens }]
      : [
          { kind: 'cacheRead', tokens: cacheRead },
          { kind: 'fresh', tokens: usedTokens - cacheRead },
        ];
  return {
    usedTokens,
    windowTokens,
    ratio: usedTokens / windowTokens,
    segments: [
      ...prompt,
      { kind: 'free' as const, tokens: Math.max(0, windowTokens - usedTokens) },
    ].filter((segment) => segment.tokens > 0),
  };
}

/**
 * How many tool rows are worth showing.
 *
 * The list exists so a reader can name a tool to remove, and that decision is
 * made off the biggest few; a full registry printed at 4pt is a table, not an
 * answer. What falls below the cut is folded into one row rather than dropped,
 * so the parts still add up to the tool total above them.
 */
const VISIBLE_TOOL_ROWS = 5;

function compositionState(
  composition: PromptComposition | undefined,
): InspectorCompositionState {
  if (!composition) return { status: 'unrecorded' };

  const tools = composition.tools ?? [];
  const visible = tools.slice(0, VISIBLE_TOOL_ROWS);
  const remaining = tools.slice(VISIBLE_TOOL_ROWS);
  const remainingBytes = remaining.reduce((carry, tool) => carry + tool.bytes, 0);

  return {
    status: 'available',
    composition: {
      totalBytes: composition.totalBytes,
      parts: composition.parts.map((part) => ({
        key: part.kind,
        kind: part.kind,
        bytes: part.bytes,
        estimatedTokens: estimateTokens(part.bytes),
      })),
      tools: visible.map((tool) => ({
        key: tool.name,
        name: tool.name,
        bytes: tool.bytes,
        estimatedTokens: estimateTokens(tool.bytes),
      })),
      ...(remaining.length > 0
        ? {
            remainingTools: {
              count: remaining.length,
              bytes: remainingBytes,
              estimatedTokens: estimateTokens(remainingBytes),
            },
          }
        : {}),
      ...(composition.unlabelledToolBytes !== undefined
        ? {
            unlabelledTools: {
              bytes: composition.unlabelledToolBytes,
              estimatedTokens: estimateTokens(composition.unlabelledToolBytes),
            },
          }
        : {}),
    },
  };
}

/**
 * The same four-bytes-per-token rule of thumb `/context` prints, kept at the
 * display layer and rendered with a `≈` everywhere it appears. It is not a
 * count: the bytes it divides are serialized JSON, and an attachment's base64
 * makes it wrong in a direction nobody can correct for here.
 */
function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function sum(attempts: readonly TraceModelAttempt[], pick: (attempt: TraceModelAttempt) => number | undefined): number {
  return attempts.reduce((carry, attempt) => carry + (pick(attempt) ?? 0), 0);
}
