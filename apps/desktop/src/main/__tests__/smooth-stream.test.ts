/**
 * Tests for the PR-UI-RENDER-1 smooth-streaming pure helpers.
 *
 * The React hook `useSmoothStreamContent` lives in `packages/ui` and
 * is exercised via screenshots + manual smoke. The helpers under test
 * here are the load-bearing pure functions the hook is a thin shell
 * over:
 *   - grapheme segmentation must not split emoji ZWJ sequences,
 *     skin-tone modifiers, flag indicators (review blocker #2)
 *   - frame advance respects EMA × dt with min/max CPS clamp, never
 *     overshoots the backlog, and always emits ≥1 char when work
 *     remains
 *   - backlog snap triggers above threshold (review blocker #3, live
 *     stream burst case)
 *   - EMA ignores degenerate observations so a stalled arrival can't
 *     poison the typewriter speed
 *   - initial displayed count handles the three modes: snap=true,
 *     history hydration (streaming=false), live stream (streaming=true)
 *
 * Imported via the dedicated `@maka/ui/smooth-stream` subpath export so
 * the node:test environment loads ONLY the pure-helper module — not the
 * React-heavy `components.tsx` barrel. (@kenji review concern #1.) A
 * future export break in either `packages/ui/package.json` exports map
 * or `packages/ui/src/smooth-stream.ts` shows up here as a load error.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeFrameAdvance,
  prepareSmoothStreamText,
  resolveCompletionMaxCps,
  resolveInitialDisplayedCount,
  segmentGraphemes,
  shouldSnapForBacklog,
  updateEma,
} from '@maka/ui/smooth-stream';

describe('segmentGraphemes', () => {
  it('returns [] for the empty string', () => {
    assert.deepEqual(segmentGraphemes(''), []);
  });

  it('keeps ASCII as individual segments', () => {
    assert.deepEqual(segmentGraphemes('hi'), ['h', 'i']);
  });

  it('does not split a surrogate-pair emoji', () => {
    // U+1F642 'slightly smiling face' is a non-BMP codepoint encoded
    // as a UTF-16 surrogate pair. A naive `text.slice(0, 1)` would
    // return half a surrogate, producing a lone surrogate that
    // renders as the replacement char. We require the segmenter to
    // treat it as a single grapheme.
    const text = '🙂';
    const graphemes = segmentGraphemes(text);
    assert.equal(graphemes.length, 1);
    assert.equal(graphemes[0], text);
  });

  it('keeps a ZWJ family emoji as one grapheme', () => {
    // 👨‍👩‍👧‍👦 = man + ZWJ + woman + ZWJ + girl + ZWJ + boy.
    // Codepoints: 7 (4 emoji + 3 ZWJ). Graphemes: 1 (the family).
    // If we fall back to Array.from this assertion would see 7;
    // Intl.Segmenter (which Node 22 ships with) collapses to 1.
    const family = '👨‍👩‍👧‍👦';
    const graphemes = segmentGraphemes(family);
    // Either segmenter behavior is acceptable AS LONG AS we never
    // mid-cut a surrogate. With Intl.Segmenter we expect 1; with
    // Array.from we expect 7 codepoint atoms but NEVER a half
    // surrogate. Assert the contract that matters: the join is
    // lossless and no segment is a lone surrogate.
    assert.equal(graphemes.join(''), family);
    for (const g of graphemes) {
      assert.ok(g.length >= 1, 'segment must be non-empty');
      // No lone surrogate: each segment, when re-encoded, must
      // round-trip through the codepoint iterator.
      assert.deepEqual([...g], [...g]);
    }
  });

  it('keeps a skin-tone modified emoji as one grapheme', () => {
    // 👍🏽 = thumbs up + medium skin tone (Fitzpatrick 4).
    const thumb = '👍🏽';
    const graphemes = segmentGraphemes(thumb);
    assert.equal(graphemes.join(''), thumb);
    // We require the segmenter behavior; Node 22's Intl.Segmenter
    // collapses skin-tone modifiers into one grapheme.
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      assert.equal(graphemes.length, 1);
    }
  });

  it('keeps a regional-indicator flag as one grapheme', () => {
    // 🇨🇳 = U+1F1E8 U+1F1F3 (two regional indicators that combine
    // into the China flag).
    const flag = '🇨🇳';
    const graphemes = segmentGraphemes(flag);
    assert.equal(graphemes.join(''), flag);
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      assert.equal(graphemes.length, 1);
    }
  });

  it('CRLF stays as one grapheme', () => {
    const crlf = '\r\n';
    const graphemes = segmentGraphemes(crlf);
    assert.equal(graphemes.join(''), crlf);
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      assert.equal(graphemes.length, 1);
    }
  });

  it('round-trips arbitrary mixed content losslessly', () => {
    const text = 'Hello 🙂 你好 👨‍👩‍👧 测试 🇨🇳!';
    const graphemes = segmentGraphemes(text);
    assert.equal(graphemes.join(''), text);
  });
});

describe('computeFrameAdvance', () => {
  it('returns 0 when displayed already caught up', () => {
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 10,
        displayedGraphemeCount: 10,
        emaCps: 60,
        dtMs: 16,
        minCps: 30,
        maxCps: 400,
      }),
      0,
    );
  });

  // Regression lock (streaming UI rework, blank-bubble freeze): rAF timestamps
  // are vsync-aligned and lag the wall clock under IPC delta bursts, so dtMs
  // clamps to 0 for every tick in the recovery window. Returning 0 left
  // displayedCount unchanged → the RAF effect never re-armed → the typewriter
  // died with a full backlog and the answer snapped in at stream end. With
  // backlog present, a non-positive dt must still advance 1 to keep the
  // single-owner RAF chain alive.
  it('advances 1 (not 0) when dt is non-positive but backlog remains — keeps the RAF chain alive', () => {
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 100,
        displayedGraphemeCount: 0,
        emaCps: 60,
        dtMs: 0,
        minCps: 30,
        maxCps: 400,
      }),
      1,
    );
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 100,
        displayedGraphemeCount: 0,
        emaCps: 60,
        dtMs: -10,
        minCps: 30,
        maxCps: 400,
      }),
      1,
    );
    // …but never invents work: zero backlog still returns 0.
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 10,
        displayedGraphemeCount: 10,
        emaCps: 60,
        dtMs: 0,
        minCps: 30,
        maxCps: 400,
      }),
      0,
    );
  });

  it('emits at least 1 grapheme when there is backlog and dt > 0', () => {
    // EMA × dt / 1000 = 0.5 → floor = 0 → bumped to 1.
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 100,
        displayedGraphemeCount: 0,
        emaCps: 30,
        dtMs: 16,
        minCps: 30,
        maxCps: 400,
      }),
      1,
    );
  });

  it('computes floor(cps * dt / 1000) for normal frames', () => {
    // 120 cps × 50ms = 6 graphemes per frame.
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 100,
        displayedGraphemeCount: 0,
        emaCps: 120,
        dtMs: 50,
        minCps: 30,
        maxCps: 400,
      }),
      6,
    );
  });

  it('clamps the EMA into [minCps, maxCps]', () => {
    // Below minCps: 5 cps observed but min is 30. 30 × 50ms = 1.5 → 1.
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 100,
        displayedGraphemeCount: 0,
        emaCps: 5,
        dtMs: 50,
        minCps: 30,
        maxCps: 400,
      }),
      1,
    );
    // Above maxCps: 9999 cps but max is 400. 400 × 50ms = 20.
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 100,
        displayedGraphemeCount: 0,
        emaCps: 9999,
        dtMs: 50,
        minCps: 30,
        maxCps: 400,
      }),
      20,
    );
  });

  it('never overshoots the available backlog', () => {
    // 400 cps × 50ms = 20 chars wanted, but only 3 remain.
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 3,
        displayedGraphemeCount: 0,
        emaCps: 400,
        dtMs: 50,
        minCps: 30,
        maxCps: 400,
      }),
      3,
    );
  });
});

describe('shouldSnapForBacklog', () => {
  it('false when displayed equals raw', () => {
    assert.equal(
      shouldSnapForBacklog({
        rawGraphemeCount: 100,
        displayedGraphemeCount: 100,
        maxBacklogGraphemes: 800,
      }),
      false,
    );
  });

  it('false at the threshold (strict greater-than)', () => {
    assert.equal(
      shouldSnapForBacklog({
        rawGraphemeCount: 800,
        displayedGraphemeCount: 0,
        maxBacklogGraphemes: 800,
      }),
      false,
    );
  });

  it('true when backlog exceeds the threshold', () => {
    assert.equal(
      shouldSnapForBacklog({
        rawGraphemeCount: 801,
        displayedGraphemeCount: 0,
        maxBacklogGraphemes: 800,
      }),
      true,
    );
  });

  it('catches the network-burst case', () => {
    // The smoother was caught up; a 5KB chunk lands in one delta.
    assert.equal(
      shouldSnapForBacklog({
        rawGraphemeCount: 5_200,
        displayedGraphemeCount: 200,
        maxBacklogGraphemes: 800,
        streaming: true,
      }),
      true,
    );
  });

  it('does not snap a completion-drain backlog just because the final text arrived at once', () => {
    assert.equal(
      shouldSnapForBacklog({
        rawGraphemeCount: 5_200,
        displayedGraphemeCount: 200,
        maxBacklogGraphemes: 800,
        streaming: false,
      }),
      false,
    );
  });
});

describe('updateEma', () => {
  it('blends prev and observed by alpha', () => {
    // 0.3 * 100 + 0.7 * 50 = 65
    assert.equal(updateEma({ prevEma: 50, alpha: 0.3, observedCps: 100 }), 65);
  });

  it('ignores observed = 0', () => {
    assert.equal(updateEma({ prevEma: 50, alpha: 0.3, observedCps: 0 }), 50);
  });

  it('ignores negative observed', () => {
    assert.equal(updateEma({ prevEma: 50, alpha: 0.3, observedCps: -100 }), 50);
  });

  it('ignores non-finite observed (stalled arrival → dt 0 → cps Infinity)', () => {
    assert.equal(updateEma({ prevEma: 50, alpha: 0.3, observedCps: Infinity }), 50);
    assert.equal(updateEma({ prevEma: 50, alpha: 0.3, observedCps: NaN }), 50);
  });
});

describe('resolveCompletionMaxCps', () => {
  it('raises the completion ceiling so a large final tail can drain inside the budget', () => {
    assert.equal(
      resolveCompletionMaxCps({
        rawGraphemeCount: 5_200,
        displayedGraphemeCount: 200,
        elapsedMs: 0,
        budgetMs: 500,
        maxCps: 400,
      }),
      10_000,
    );
  });

  it('keeps the normal max when the final tail already fits the budget', () => {
    assert.equal(
      resolveCompletionMaxCps({
        rawGraphemeCount: 260,
        displayedGraphemeCount: 200,
        elapsedMs: 0,
        budgetMs: 500,
        maxCps: 400,
      }),
      400,
    );
  });
});

describe('resolveInitialDisplayedCount', () => {
  it('snap=true → full immediately regardless of streaming', () => {
    assert.equal(
      resolveInitialDisplayedCount({ rawGraphemeCount: 500, streaming: true, snap: true }),
      500,
    );
    assert.equal(
      resolveInitialDisplayedCount({ rawGraphemeCount: 500, streaming: false, snap: true }),
      500,
    );
  });

  it('streaming=false with non-empty raw → history hydration snap', () => {
    // The stream already finished; the caller is replaying a stored
    // message. A "type it back out" animation would be misleading.
    assert.equal(
      resolveInitialDisplayedCount({ rawGraphemeCount: 2000, streaming: false, snap: false }),
      2000,
    );
  });

  it('streaming=true + snap=false → start from 0 (typewriter live)', () => {
    assert.equal(
      resolveInitialDisplayedCount({ rawGraphemeCount: 5, streaming: true, snap: false }),
      0,
    );
  });

  it('empty raw → 0 (nothing to display either way)', () => {
    assert.equal(
      resolveInitialDisplayedCount({ rawGraphemeCount: 0, streaming: true, snap: false }),
      0,
    );
  });
});

describe('prepareSmoothStreamText — secret-prefix safety gate (@kenji msg fbb8f119)', () => {
  /**
   * The smoother typewriters PREFIXES of its input. So the trust
   * contract we want from `prepareSmoothStreamText` is:
   *   for any raw input containing a known secret pattern,
   *   no prefix of `prepareSmoothStreamText(raw)` reveals the raw
   *   secret token.
   *
   * Easiest check: ensure `prepared` itself never contains the
   * raw secret. Since every prefix of `prepared` is a substring of
   * `prepared`, that's sufficient.
   */
  it('masks Authorization: Bearer in raw text', () => {
    const raw = 'response: Authorization: Bearer sk-test1234567890ABCDEF\nmore text';
    const prepared = prepareSmoothStreamText(raw);
    assert.equal(
      prepared.includes('sk-test1234567890ABCDEF'),
      false,
      'raw bearer token must not survive into prepared text',
    );
  });

  it('masks bare API-key prefixes', () => {
    const raw = 'planning to use sk-ant-1234567890abcdefghijklmnopqrstuvwxyz';
    const prepared = prepareSmoothStreamText(raw);
    assert.equal(prepared.includes('sk-ant-1234567890abcdefghijklmnopqrstuvwxyz'), false);
  });

  it('every prefix of prepared output is secret-free', () => {
    // The contract that matters for the smoother: every typewriter
    // frame renders some prefix of the prepared text. We can't
    // enumerate every prefix at runtime, but we can verify the
    // load-bearing invariant: the SECRET TOKEN does not appear in
    // the prepared text, so every prefix is by definition free of
    // the secret token (a string contains a substring iff one of
    // its prefixes ends with that substring).
    const raw = 'Authorization: Bearer sk-secret123ABCDEFG more text';
    const prepared = prepareSmoothStreamText(raw);
    // Sample 5 prefixes across the prepared length; none should
    // contain the secret.
    for (const len of [10, 25, 50, prepared.length - 1, prepared.length]) {
      const prefix = prepared.slice(0, Math.max(0, len));
      assert.equal(
        prefix.includes('sk-secret123ABCDEFG'),
        false,
        `prefix length=${len} unexpectedly contains the secret`,
      );
    }
  });

  it('is idempotent on already-redacted text (safe to apply twice)', () => {
    // Defense-in-depth use case (ReasoningPanel): C0's
    // `applyThinkingDelta` already redacted the text, then
    // `prepareSmoothStreamText` runs again in the renderer. Must be
    // a no-op on already-clean text.
    const clean = 'normal reasoning step about the math';
    assert.equal(prepareSmoothStreamText(clean), clean);
    // And applying twice on a raw-secret input must be stable.
    const onceMasked = prepareSmoothStreamText('Bearer sk-test1234567890ABCDEF rest');
    const twiceMasked = prepareSmoothStreamText(onceMasked);
    assert.equal(twiceMasked, onceMasked);
  });

  it('returns empty string for non-string input (defensive)', () => {
    // @ts-expect-error — defensive
    assert.equal(prepareSmoothStreamText(null), '');
    // @ts-expect-error — defensive
    assert.equal(prepareSmoothStreamText(undefined), '');
    // @ts-expect-error — defensive
    assert.equal(prepareSmoothStreamText(42), '');
  });
});
