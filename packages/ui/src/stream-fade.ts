/**
 * Per-word fade-in for streamed assistant text (streaming UI rework) — the
 * replacement for the retired ▎ blink caret. As `useSmoothStreamContent`
 * reveals more of the displayed prefix, freshly appended text fades in over a
 * short window; text older than the window is stable and never re-animates.
 *
 * Two pieces live here:
 *  - a pure "append record ring": as the displayed grapheme length grows, each
 *    growth is recorded as a batch `{ start, at }`. Batches older than
 *    `FADE_MS` are pruned (they've finished fading), and the ring is capped so
 *    a very long stream can't grow it without bound. From the ring we read a
 *    `boundaryOffset` (graphemes before it are stable — never wrapped) and the
 *    age of any offset (drives the CSS `animation-delay`).
 *  - `useStreamFade`, a thin React wrapper holding the ring in a ref, plus
 *    `tokenizeFade`, the pure word/char splitter used by the plain-text
 *    reasoning renderer.
 *
 * Offsets are GRAPHEME offsets (via `segmentGraphemes`, same as the smoother)
 * so we never split an emoji / surrogate pair. The negative `animation-delay`
 * (= -age) makes the CSS animation resume mid-flight, so React re-mounting the
 * spans on each streaming re-render continues the fade instead of restarting
 * it. Under snap (reduced-motion / visual-smoke / OS reduced-motion) the hook
 * returns `undefined` and callers skip wrapping entirely — the snap path shows
 * the final text at full opacity with no spans.
 */

import { useMemo, useRef } from 'react';
import { segmentGraphemes } from './smooth-stream.js';

/**
 * Fade window: text younger than this (ms) is still animating in. Pinned to
 * `--duration-large` (280ms) so it equals the `.maka-stream-fade` CSS animation
 * duration — the negative `animation-delay` (= -age) is only correct when the
 * JS window matches the CSS window. Retuning the fade means changing both.
 */
export const FADE_MS = 280;

/** Hard cap on retained batches so a long stream can't grow the ring forever. */
export const MAX_FADE_BATCHES = 512;

/** One recorded append: graphemes at `[start, nextStart)` first appeared at `at`. */
export interface FadeBatch {
  start: number;
  at: number;
}

export interface FadeRingState {
  batches: FadeBatch[];
  /** Last observed displayed grapheme length. */
  len: number;
  /** False until the first observation, which seeds `len` without a batch. */
  seeded: boolean;
}

export function createFadeRing(): FadeRingState {
  return { batches: [], len: 0, seeded: false };
}

/**
 * Fold a new displayed grapheme length into the ring at time `now`:
 *  - first observation seeds `len` with no batch (mount text isn't "new");
 *  - growth records a batch starting at the previous length;
 *  - shrink (session switch / clear) resets the ring;
 *  - batches older than `fadeMs` are pruned, then the ring is capped
 *    (oldest dropped) — capping only advances the stable boundary, never
 *    re-animates text.
 * Pure aside from mutating the passed-in `state`.
 */
export function updateFadeRing(
  state: FadeRingState,
  len: number,
  now: number,
  fadeMs: number = FADE_MS,
  maxBatches: number = MAX_FADE_BATCHES,
): void {
  if (!state.seeded) {
    state.len = len;
    state.seeded = true;
  } else if (len > state.len) {
    state.batches.push({ start: state.len, at: now });
    state.len = len;
  } else if (len < state.len) {
    state.batches = [];
    state.len = len;
  }
  while (state.batches.length > 0 && now - state.batches[0]!.at >= fadeMs) {
    state.batches.shift();
  }
  if (state.batches.length > maxBatches) {
    state.batches.splice(0, state.batches.length - maxBatches);
  }
}

/** Graphemes before this offset are stable (finished fading) — never wrapped. */
export function fadeBoundary(state: FadeRingState): number {
  return state.batches.length > 0 ? state.batches[0]!.start : state.len;
}

/**
 * Age (ms) of the grapheme at `offset` — `now` minus the appearance time of the
 * batch that first covered it. Offsets in a pruned/stable region return their
 * batch age of 0 (they won't be wrapped anyway). Query order does not matter.
 */
export function fadeAgeAt(state: FadeRingState, offset: number, now: number): number {
  let at = now;
  for (let i = state.batches.length - 1; i >= 0; i -= 1) {
    if (offset >= state.batches[i]!.start) {
      at = state.batches[i]!.at;
      break;
    }
  }
  return Math.max(0, now - at);
}

/** Snapshot the fade state for one render: a stable boundary + an age lookup. */
export interface StreamFade {
  boundaryOffset: number;
  ageAt(offset: number): number;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * React wrapper: fold the current `displayed` prefix into a ref-held ring and
 * return a per-render {@link StreamFade}, or `undefined` when `active` is false
 * (snap paths, or non-streaming). Recording happens in render, guarded by a
 * length change, so the boundary/age reflect the text being rendered this frame
 * (a StrictMode double-invoke with the same length is idempotent).
 */
export function useStreamFade(displayed: string, active: boolean): StreamFade | undefined {
  const ringRef = useRef<FadeRingState>(createFadeRing());
  const len = useMemo(() => segmentGraphemes(displayed).length, [displayed]);
  if (!active) {
    // Reset so a later activation doesn't fade the whole (already-visible) blob.
    ringRef.current = createFadeRing();
    return undefined;
  }
  const now = nowMs();
  const ring = ringRef.current;
  // Fold this frame's length in (records growth on change; always prunes so
  // ages advance and the stable boundary moves forward frame to frame).
  updateFadeRing(ring, len, now);
  const boundaryOffset = fadeBoundary(ring);
  const snapshotRing: FadeRingState = { batches: ring.batches.slice(), len: ring.len, seeded: ring.seeded };
  return {
    boundaryOffset,
    ageAt: (offset: number) => fadeAgeAt(snapshotRing, offset, now),
  };
}

// --- Word / char tokenizer -------------------------------------------------

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

function isSpaceGrapheme(g: string): boolean {
  return /^\s+$/.test(g);
}

function isWordGrapheme(g: string): boolean {
  return /^[\p{L}\p{N}_'-]$/u.test(g) && !CJK_RE.test(g);
}

export interface FadeToken {
  text: string;
  /** Grapheme offset of this token's first grapheme. */
  offset: number;
  /** True when this token should fade in (non-space and at/after the boundary). */
  fade: boolean;
}

/**
 * Split `text` (starting at grapheme `startOffset`) into fade tokens:
 * whitespace runs and Latin word runs stay grouped; CJK / emoji / punctuation
 * are per-grapheme so a space-less CJK line still fades character by character.
 * A token fades when it is non-whitespace and its offset is at/after
 * `boundaryOffset`. Returns tokens in order plus the total graphemes consumed.
 */
export function tokenizeFade(
  text: string,
  startOffset: number,
  boundaryOffset: number,
): { tokens: FadeToken[]; length: number } {
  const gs = segmentGraphemes(text);
  const tokens: FadeToken[] = [];
  let i = 0;
  while (i < gs.length) {
    const g = gs[i]!;
    let j = i + 1;
    if (isSpaceGrapheme(g)) {
      while (j < gs.length && isSpaceGrapheme(gs[j]!)) j += 1;
    } else if (isWordGrapheme(g)) {
      while (j < gs.length && isWordGrapheme(gs[j]!)) j += 1;
    }
    const offset = startOffset + i;
    const space = isSpaceGrapheme(g);
    tokens.push({
      text: gs.slice(i, j).join(''),
      offset,
      fade: !space && offset >= boundaryOffset,
    });
    i = j;
  }
  return { tokens, length: gs.length };
}
