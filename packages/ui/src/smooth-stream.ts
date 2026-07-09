/**
 * PR-UI-RENDER-1 — Smooth streaming hook.
 *
 * The renderer used to bind streaming text directly to `<Markdown>`,
 * so each `text_delta` event triggered an immediate re-render. The
 * visible result was "jumpy" output: chunks landed in clumps,
 * sometimes the whole sentence appeared at once, and the user never
 * saw the calm typewriter cadence other modern chat clients produce.
 *
 * `useSmoothStreamContent` decouples the displayed text from the
 * upstream `rawText`. It:
 *
 *   - Tracks the EMA of arrival characters-per-second (graphemes
 *     per second, more precisely). New deltas feed the EMA; a slow
 *     network does not slow the typewriter floor.
 *   - Advances `displayedCount` once per RAF frame at the smoothed
 *     CPS, clamped to `[minCps, maxCps]`.
 *   - **Grapheme-aware slicing** via `Intl.Segmenter` so emoji
 *     ZWJ-sequences (family, skin-tone, flag) and CRLF stay whole.
 *     Falls back to codepoint slicing (`Array.from`) when the
 *     environment lacks `Intl.Segmenter`. Never slices on raw code
 *     unit indices, which would cut surrogate pairs.
 *   - **Backlog snap**: if displayed lags raw by more than
 *     `maxBacklogGraphemes`, snap to raw. This handles history
 *     hydration (initial mount with non-empty raw) and "the network
 *     dumped 5KB in one chunk" without infinite catch-up.
 *   - **Complete flush budget**: when `streaming` flips to false,
 *     raise the catch-up speed so the remaining tail drains within
 *     `completeFlushBudgetMs` instead of snapping to the final text.
 *   - **Reduced-motion bypass**: callers pass `snap: true` (typically
 *     derived from `prefers-reduced-motion: reduce` or the
 *     visual-smoke fixture attribute) to skip all smoothing.
 *   - **Single RAF owner**: one `useEffect` schedules one RAF; its
 *     cleanup cancels any in-flight handle before the next effect
 *     re-runs. No way to have two RAFs writing state concurrently
 *     (review blocker #4 from @kenji).
 *
 * The pure helpers (`segmentGraphemes`, `computeFrameAdvance`,
 * `shouldSnapForBacklog`, `updateEma`, `resolveInitialDisplayedCount`)
 * are exported so they can be unit-tested without a DOM. The React
 * hook is a thin shell over them.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { redactSecrets } from './redact.js';

const DEFAULT_MIN_CPS = 30;
const DEFAULT_MAX_CPS = 400;
const DEFAULT_MAX_BACKLOG_GRAPHEMES = 800;
const DEFAULT_COMPLETE_FLUSH_BUDGET_MS = 600;
const EMA_ALPHA = 0.3;
/**
 * Seed CPS used before any arrival has been observed. Picked to feel
 * roughly like a fast typist so the first few hundred ms of a fresh
 * stream don't crawl while the EMA warms up.
 */
const SEED_CPS = 80;

export interface SmoothStreamOptions {
  /**
   * `true` while the upstream is still emitting deltas. `false` means
   * the stream has officially completed (or aborted / errored — the
   * caller decides what counts as "done"). Required — the hook will
   * not try to infer stream-end from rawText growth, because a network
   * stall and a true complete look identical from the rawText side.
   * (@kenji review blocker #1.)
   */
  streaming: boolean;
  /**
   * Force an immediate full-text display, bypassing all smoothing.
   * Callers should set this when:
   *   - `prefers-reduced-motion: reduce` matches,
   *   - the visual-smoke fixture attribute is set,
   *   - the content is being hydrated from history (the stream
   *     already finished — there is nothing to "smoothly" replay).
   */
  snap?: boolean;
  /**
   * Cap on how far displayed may lag raw before we snap to raw.
   * Defaults to 800 graphemes (~one paragraph). Set higher only if
   * you want very long catch-up animations.
   */
  maxBacklogGraphemes?: number;
  /**
   * Floor on emit speed in graphemes-per-second. A slow upstream
   * still feels alive at this rate. Default 30.
   */
  minCps?: number;
  /**
   * Ceiling on emit speed. Prevents a burst arrival from making the
   * typewriter look like an instant snap. Default 400.
   */
  maxCps?: number;
  /**
   * After `streaming` flips to `false`, the hook allows at most this
   * many ms to finish flushing the remaining backlog. The hook may exceed
   * `maxCps` during this drain so completion stays smooth without waiting
   * indefinitely. Default 600.
   */
  completeFlushBudgetMs?: number;
}

export interface SmoothStreamResult {
  /** Text the caller should render right now. Always a prefix of rawText. */
  displayed: string;
  /** True while the smoother is still catching up to rawText. */
  catchingUp: boolean;
}

/**
 * Split `text` into an array of grapheme clusters. Prefers
 * `Intl.Segmenter` (handles emoji ZWJ sequences, skin-tone modifiers,
 * flags, regional indicators, combining marks). Falls back to
 * `Array.from(text)` (codepoint-aware, surrogate-pair-safe, but NOT
 * grapheme-aware) when `Intl.Segmenter` is unavailable.
 *
 * Never indexes on raw UTF-16 code units (which would cut emoji in
 * half). This is the load-bearing rule of the entire smoother.
 */
export function segmentGraphemes(text: string): string[] {
  if (text === '') return [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const out: string[] = [];
      for (const s of seg.segment(text)) {
        out.push(s.segment);
      }
      return out;
    } catch {
      // fall through to Array.from fallback
    }
  }
  return Array.from(text);
}

export interface FrameAdvanceInputs {
  rawGraphemeCount: number;
  displayedGraphemeCount: number;
  emaCps: number;
  dtMs: number;
  minCps: number;
  maxCps: number;
}

/**
 * Pure: how many graphemes should this RAF tick advance? Clamps the
 * EMA into [minCps, maxCps], converts to graphemes for `dtMs`, and
 * never overshoots the available backlog. Always advances at least 1
 * when there is work to do — INCLUDING when `dtMs <= 0`.
 *
 * The `dtMs <= 0` case is load-bearing, not theoretical: `dtMs` is
 * "rAF callback timestamp minus wall-clock time at effect re-arm", and
 * Chromium's rAF timestamps are vsync-aligned, so under main-thread
 * pressure (an IPC delta burst re-rendering the whole chat) the
 * timestamp lags the wall clock and `dtMs` clamps to 0 for every tick
 * in the recovery window. Returning 0 here used to leave
 * `displayedCount` unchanged, which meant the RAF effect (keyed on
 * `displayedCount`/`rawLength`) never re-armed — the typewriter died
 * with a full backlog and the bubble sat BLANK until stream end
 * snapped the whole answer in at once. Advancing 1 grapheme keeps the
 * single-owner RAF chain alive at the frame-rate floor until the
 * timestamps normalize.
 */
export function computeFrameAdvance(inputs: FrameAdvanceInputs): number {
  const { rawGraphemeCount, displayedGraphemeCount, emaCps, dtMs, minCps, maxCps } = inputs;
  const backlog = rawGraphemeCount - displayedGraphemeCount;
  if (backlog <= 0) return 0;
  const cps = Math.min(Math.max(emaCps, minCps), maxCps);
  const advance = Math.max(1, Math.floor((cps * dtMs) / 1000));
  return Math.min(advance, backlog);
}

export interface BacklogSnapInputs {
  rawGraphemeCount: number;
  displayedGraphemeCount: number;
  maxBacklogGraphemes: number;
  /** Backlog snap is only for live network bursts, not completion drain. */
  streaming?: boolean;
}

/**
 * Pure: should we snap to raw because the backlog is too large?
 * True when (raw - displayed) > threshold.
 */
export function shouldSnapForBacklog(inputs: BacklogSnapInputs): boolean {
  if (inputs.streaming === false) return false;
  return inputs.rawGraphemeCount - inputs.displayedGraphemeCount > inputs.maxBacklogGraphemes;
}

export interface CompletionMaxCpsInputs {
  rawGraphemeCount: number;
  displayedGraphemeCount: number;
  elapsedMs: number;
  budgetMs: number;
  maxCps: number;
}

/**
 * Pure: while a stream is completing, raise the frame speed enough to drain
 * the remaining tail inside the completion budget. This keeps the completion
 * handoff fast without a visible end-of-budget snap.
 */
export function resolveCompletionMaxCps(inputs: CompletionMaxCpsInputs): number {
  const backlog = inputs.rawGraphemeCount - inputs.displayedGraphemeCount;
  if (backlog <= 0) return inputs.maxCps;
  const remainingMs = Math.max(1, inputs.budgetMs - inputs.elapsedMs);
  return Math.max(inputs.maxCps, Math.ceil((backlog * 1000) / remainingMs));
}

export interface EmaUpdateInputs {
  prevEma: number;
  alpha: number;
  observedCps: number;
}

/**
 * Pure: EMA = alpha * observed + (1 - alpha) * prev. Ignores
 * non-finite / non-positive observations (so a stalled arrival with
 * dt → 0 doesn't poison the average with Infinity).
 */
export function updateEma(inputs: EmaUpdateInputs): number {
  const { prevEma, alpha, observedCps } = inputs;
  if (!Number.isFinite(observedCps) || observedCps <= 0) return prevEma;
  return alpha * observedCps + (1 - alpha) * prevEma;
}

export interface InitialDisplayInputs {
  rawGraphemeCount: number;
  streaming: boolean;
  snap: boolean;
}

/**
 * Pure: how much of `rawText` should be displayed on first mount?
 *
 * - `snap: true` → full text immediately (reduced-motion / fixture).
 * - `streaming: false` with non-empty raw → history hydration.
 *   The stream already finished; replay would be a fake animation
 *   over already-settled content. Snap. (@kenji review blocker #3.)
 * - Otherwise → 0 (start from nothing, let typewriter catch up).
 */
export function resolveInitialDisplayedCount(inputs: InitialDisplayInputs): number {
  if (inputs.snap) return inputs.rawGraphemeCount;
  if (!inputs.streaming) return inputs.rawGraphemeCount;
  return 0;
}

/**
 * React hook. See module doc for the design contract.
 */
export function useSmoothStreamContent(
  rawText: string,
  options: SmoothStreamOptions,
): SmoothStreamResult {
  const minCps = options.minCps ?? DEFAULT_MIN_CPS;
  const maxCps = options.maxCps ?? DEFAULT_MAX_CPS;
  const maxBacklog = options.maxBacklogGraphemes ?? DEFAULT_MAX_BACKLOG_GRAPHEMES;
  const completeBudget = options.completeFlushBudgetMs ?? DEFAULT_COMPLETE_FLUSH_BUDGET_MS;
  const snap = !!options.snap;

  // Segment once per rawText change. For typical streaming sizes
  // (~few KB) Intl.Segmenter is microseconds-fast, so re-segmenting
  // the full string on every delta is fine and avoids the subtle
  // boundary bugs of incremental segmentation (ZWJ sequences can
  // extend across appends).
  const rawGraphemes = useMemo(() => segmentGraphemes(rawText), [rawText]);
  const rawLength = rawGraphemes.length;

  const [displayedCount, setDisplayedCount] = useState(() =>
    resolveInitialDisplayedCount({ rawGraphemeCount: rawLength, streaming: options.streaming, snap }),
  );

  // Mutable refs read by the RAF tick.
  const refs = useRef({
    emaCps: SEED_CPS,
    lastObservedRawLength: rawLength,
    lastArrivalAt: nowMs(),
    completeStartedAt: 0,
    initialized: false,
  });

  // Update EMA on arrival (rawLength grew).
  useEffect(() => {
    const s = refs.current;
    if (!s.initialized) {
      s.lastObservedRawLength = rawLength;
      s.lastArrivalAt = nowMs();
      s.initialized = true;
      return;
    }
    if (rawLength > s.lastObservedRawLength) {
      const now = nowMs();
      const dtMs = now - s.lastArrivalAt;
      if (dtMs > 0) {
        const observedCps = ((rawLength - s.lastObservedRawLength) * 1000) / dtMs;
        s.emaCps = updateEma({ prevEma: s.emaCps, alpha: EMA_ALPHA, observedCps });
      }
      s.lastArrivalAt = now;
      s.lastObservedRawLength = rawLength;
      // New deltas after a "complete" flag — caller flipped streaming
      // back on (e.g., a retry). Clear the complete budget so we
      // typewriter the new chunk instead of insta-snapping.
      s.completeStartedAt = 0;
    } else if (rawLength < s.lastObservedRawLength) {
      // Raw shrunk: session switch / clearStreaming. Reset the EMA
      // and the typewriter cursor. The displayedCount reset is
      // handled in the snap/initial effect below.
      s.lastObservedRawLength = rawLength;
      s.emaCps = SEED_CPS;
      s.completeStartedAt = 0;
      setDisplayedCount(
        resolveInitialDisplayedCount({ rawGraphemeCount: rawLength, streaming: options.streaming, snap }),
      );
    }
  }, [rawLength, options.streaming, snap]);

  // Explicit snap option (e.g., reduced-motion flipped mid-stream).
  // Also runs on mount when snap starts true, mirroring the initial
  // displayedCount computation.
  useEffect(() => {
    if (snap) setDisplayedCount(rawLength);
  }, [snap, rawLength]);

  // Single RAF owner. Re-runs on any input change; its cleanup
  // cancels the prior handle before the next effect schedules a new
  // one. Two concurrent RAF writers are impossible by construction.
  useEffect(() => {
    if (snap) return;
    if (displayedCount >= rawLength) {
      // Caught up. If we're still streaming, the next arrival will
      // trigger the EMA effect; this effect will re-run and schedule
      // the next frame. If streaming finished, we're truly done.
      return;
    }
    if (typeof requestAnimationFrame !== 'function') {
      // SSR / non-browser env (node:test without jsdom): snap.
      setDisplayedCount(rawLength);
      return;
    }

    let cancelled = false;
    let frameStartedAt = nowMs();

    const tick = (now: number) => {
      if (cancelled) return;

      // Backlog snap — handles history paste, network burst, etc.
      // Only applies to live streams; history hydration is already
      // pre-snapped via resolveInitialDisplayedCount.
      if (
        shouldSnapForBacklog({
          rawGraphemeCount: rawLength,
          displayedGraphemeCount: displayedCount,
          maxBacklogGraphemes: maxBacklog,
          streaming: options.streaming,
        })
      ) {
        setDisplayedCount(rawLength);
        return;
      }

      // Stream-end bounded flush. Once streaming flips false and we
      // still have backlog, raise the speed enough to drain inside
      // completeBudget instead of snapping the tail all at once.
      let frameMaxCps = maxCps;
      if (!options.streaming) {
        const s = refs.current;
        if (s.completeStartedAt === 0) s.completeStartedAt = now;
        frameMaxCps = resolveCompletionMaxCps({
          rawGraphemeCount: rawLength,
          displayedGraphemeCount: displayedCount,
          elapsedMs: now - s.completeStartedAt,
          budgetMs: completeBudget,
          maxCps,
        });
      }

      const dtMs = Math.max(0, now - frameStartedAt);
      const advance = computeFrameAdvance({
        rawGraphemeCount: rawLength,
        displayedGraphemeCount: displayedCount,
        emaCps: refs.current.emaCps,
        dtMs,
        minCps,
        maxCps: frameMaxCps,
      });
      if (advance > 0) {
        setDisplayedCount((cur) => Math.min(cur + advance, rawLength));
      }
      // Do NOT re-arm here. Let the effect re-run on the new
      // displayedCount and schedule the next frame; that keeps the
      // single-owner invariant.
    };

    const handle = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [rawLength, displayedCount, options.streaming, snap, minCps, maxCps, maxBacklog, completeBudget]);

  const displayed = useMemo(() => {
    if (displayedCount >= rawLength) return rawText;
    if (displayedCount <= 0) return '';
    return rawGraphemes.slice(0, displayedCount).join('');
  }, [rawText, rawGraphemes, displayedCount, rawLength]);

  return {
    displayed,
    catchingUp: displayedCount < rawLength,
  };
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * PR-UI-C1 review fixup (@kenji msg fbb8f119) — pure trust-boundary
 * gate that callers MUST apply before feeding text to
 * `useSmoothStreamContent`.
 *
 * The smoother typewriters by rendering successive PREFIXES of its
 * input string. If the raw input contains a partially-emitted
 * secret (e.g. mid-delta `Authorization: Bearer sk-secret123`), the
 * smoother would briefly paint each prefix to the DOM — even though
 * the FULL string would later be masked by the downstream Markdown
 * redactor. The prefix `Authorization: Bearer s` doesn't match any
 * secret pattern by itself, so it would leak to the screen for a
 * frame or two.
 *
 * Solution: callers run the raw text through `prepareSmoothStreamText`
 * BEFORE handing it to `useSmoothStreamContent`. The function
 * applies `redactSecrets` on the full input, so the smoother only
 * ever sees already-masked text — every prefix of which is
 * guaranteed secret-free. The downstream `<Markdown>` (or `<pre>`)
 * stays in place as defense in depth.
 *
 * `redactSecrets` is idempotent on already-masked text, so it's
 * safe to apply this helper even when the upstream path already
 * redacted (e.g. ReasoningPanel, where C0's `applyThinkingDelta`
 * already ran `redactSecrets` on each delta).
 *
 * The function is pure and exported so callers can also use it in
 * tests / non-React contexts to verify the trust boundary.
 */
export function prepareSmoothStreamText(raw: string): string {
  if (typeof raw !== 'string') return '';
  return redactSecrets(raw);
}
