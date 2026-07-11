/**
 * Tests for the PR-UI-Cx assistant stream chokepoint
 * (`applyAssistantDelta`).
 *
 * Locks @kenji's three review gates:
 *   1. raw `event.text` only flows through helper input, never enters
 *      React state un-redacted (secondary redaction BEFORE state).
 *   2. per-delta + per-session total caps enforced before state.
 *   3. secret + oversize combined paths produce no raw-secret in
 *      output regardless of order (redaction-then-truncation +
 *      truncation-then-redaction both safe).
 *
 * Imported via `@maka/ui/assistant-stream` subpath so node:test
 * doesn't load the React barrel.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ASSISTANT_MAX_DELTA_CHARS,
  ASSISTANT_MAX_TOTAL_CHARS,
  applyAssistantComplete,
  applyAssistantDelta,
} from '@maka/ui/assistant-stream';

describe('applyAssistantDelta — happy path', () => {
  it('appends a short delta to an empty buffer; no flags set', () => {
    const result = applyAssistantDelta('', 'hello');
    assert.equal(result.text, 'hello');
    assert.equal(result.redacted, false);
    assert.equal(result.truncated, false);
  });

  it('appends a short delta to a non-empty buffer', () => {
    const result = applyAssistantDelta('hello ', 'world');
    assert.equal(result.text, 'hello world');
    assert.equal(result.redacted, false);
    assert.equal(result.truncated, false);
  });

  it('handles `prev` of undefined / null by treating as empty', () => {
    const a = applyAssistantDelta(undefined as unknown as string, 'x');
    const b = applyAssistantDelta(null as unknown as string, 'x');
    assert.equal(a.text, 'x');
    assert.equal(b.text, 'x');
  });
});

describe('applyAssistantDelta — defensive guard', () => {
  it('non-string rawDelta returns prev unchanged with no flag set', () => {
    const prev = 'so far';
    for (const bad of [undefined, null, 42, {}, [], true]) {
      const result = applyAssistantDelta(prev, bad as unknown as string);
      assert.equal(result.text, prev, `bad input ${String(bad)} should not change buffer`);
      assert.equal(result.redacted, false);
      assert.equal(result.truncated, false);
    }
  });

  it('empty rawDelta is a no-op', () => {
    const result = applyAssistantDelta('prev', '');
    assert.equal(result.text, 'prev');
    assert.equal(result.redacted, false);
    assert.equal(result.truncated, false);
  });
});

describe('applyAssistantDelta — secondary redaction (state-entry gate)', () => {
  // @kenji msg 94b0063d gate #1: raw secret bytes MUST be redacted
  // before they reach state. The helper is the only place this can
  // happen safely; the renderer wraps `setState` around the result.

  it('redacts a Bearer token in a single delta', () => {
    const raw = 'Here is my Authorization: Bearer sk-test-abc-1234567890 token';
    const result = applyAssistantDelta('', raw);
    assert.ok(!result.text.includes('sk-test-abc-1234567890'), 'raw token must not survive');
    assert.equal(result.redacted, true);
  });

  it('redacts an API key shaped string', () => {
    const raw = 'My key is sk-abcdef1234567890abcdef1234567890 thanks';
    const result = applyAssistantDelta('', raw);
    assert.ok(!result.text.includes('sk-abcdef1234567890abcdef1234567890'));
    assert.equal(result.redacted, true);
  });

  it('redacted=false when nothing matched', () => {
    const result = applyAssistantDelta('', 'just some normal prose');
    assert.equal(result.redacted, false);
    assert.equal(result.text, 'just some normal prose');
  });
});

describe('applyAssistantDelta — per-delta cap (tail-keep)', () => {
  // A single oversize delta is a runtime misbehavior. Tail-keep with
  // a head marker — same as thinking-stream — because the user has
  // not been reading inside the delta atomically.
  it('a delta over the per-delta cap is tail-kept with head marker', () => {
    // Use varied content so redactSecrets doesn't fire on
    // homogeneous test fillers (which it can mistake for a token).
    const big = 'word '.repeat(ASSISTANT_MAX_DELTA_CHARS); // 5× cap
    const result = applyAssistantDelta('', big);
    assert.ok(result.text.length <= ASSISTANT_MAX_DELTA_CHARS, 'must fit cap');
    assert.ok(result.text.startsWith('\n[…单条 delta 已截断]\n'), 'must mark truncation at head');
    assert.equal(result.truncated, true);
  });

  it('per-delta cap can be overridden via options', () => {
    const result = applyAssistantDelta('', 'aaaaaaaa', { maxDeltaChars: 4 });
    assert.ok(result.text.length <= 4 + '\n[…单条 delta 已截断]\n'.length, 'fits override cap');
    assert.equal(result.truncated, true);
  });

  it('a delta exactly at the cap is NOT truncated', () => {
    const exact = 'x'.repeat(ASSISTANT_MAX_DELTA_CHARS);
    const result = applyAssistantDelta('', exact);
    assert.equal(result.text.length, ASSISTANT_MAX_DELTA_CHARS);
    assert.equal(result.truncated, false);
  });
});

describe('applyAssistantDelta — per-session total cap (head-keep, trailing marker)', () => {
  // Assistant text is read top-down — head-keep so the start of the
  // answer (which the user has been reading) is preserved.
  it('accumulated deltas cross total cap → head-keep with trailing marker', () => {
    // Stream chunks UNDER the per-delta cap repeatedly until we
    // overshoot the per-session total. Each delta-cap-sized chunk
    // is varied prose so redactSecrets won't fire on it.
    let buffer = '';
    let lastResult: ReturnType<typeof applyAssistantDelta> = { text: '', redacted: false, truncated: false };
    const chunk = 'word '.repeat(800); // ~4000 chars, just under per-delta cap
    const iters = Math.ceil(ASSISTANT_MAX_TOTAL_CHARS / chunk.length) + 2;
    for (let i = 0; i < iters; i += 1) {
      lastResult = applyAssistantDelta(buffer, chunk);
      buffer = lastResult.text;
    }
    assert.ok(buffer.length <= ASSISTANT_MAX_TOTAL_CHARS, 'must fit total cap');
    assert.ok(buffer.endsWith('\n\n[…后续已截断]'), 'trailing marker present');
    assert.equal(lastResult.truncated, true);
  });

  it('first delta that crosses total cap (with override raising per-delta cap) head-keeps with trailing marker', () => {
    // Same property, single-delta version — raise per-delta cap so
    // the total cap is the gate that fires.
    const big = 'word '.repeat(ASSISTANT_MAX_TOTAL_CHARS / 5 + 100); // overshoot
    const result = applyAssistantDelta('', big, { maxDeltaChars: big.length });
    assert.ok(result.text.length <= ASSISTANT_MAX_TOTAL_CHARS, 'must fit total cap');
    assert.ok(result.text.endsWith('\n\n[…后续已截断]'), 'trailing marker present');
    assert.equal(result.truncated, true);
  });

  it('once buffer is at cap, subsequent deltas are dropped', () => {
    // Pre-fill to the cap exactly with the trailing marker, mimicking
    // a prior `applyAssistantDelta` result.
    const trailingMarker = '\n\n[…后续已截断]';
    const prefix = 'a'.repeat(ASSISTANT_MAX_TOTAL_CHARS - trailingMarker.length);
    const cappedBuffer = prefix + trailingMarker;
    assert.equal(cappedBuffer.length, ASSISTANT_MAX_TOTAL_CHARS);

    const result = applyAssistantDelta(cappedBuffer, 'more content');
    assert.equal(result.text, cappedBuffer, 'buffer must not grow');
    assert.equal(result.redacted, false, 'short-circuit: no redaction on dropped delta');
    assert.equal(result.truncated, true, 'truncated flag still propagated');
  });

  it('per-session cap can be overridden via options', () => {
    // Cap so small that "hello world" overshoots.
    const result = applyAssistantDelta('', 'hello world this is too long', { maxTotalChars: 16 });
    assert.ok(result.text.length <= 16, 'fits override total cap');
    assert.ok(result.text.endsWith('\n\n[…后续已截断]'));
    assert.equal(result.truncated, true);
  });

  it('a delta that brings total exactly to cap is NOT truncated', () => {
    const result = applyAssistantDelta('hi ', 'world', { maxTotalChars: 8 });
    assert.equal(result.text, 'hi world');
    assert.equal(result.truncated, false);
  });
});

describe('applyAssistantDelta — combined secret + oversize (kenji msg cd09bcac gate #3)', () => {
  // @kenji explicitly asked: regardless of whether truncation runs
  // before or after redaction, the stored text MUST NOT contain a
  // raw secret. Helper order is: redact FIRST, then per-delta cap,
  // then append, then total cap. This test exercises the worst-case
  // configurations.

  it('huge delta WITH embedded secret: secret is redacted, delta truncated, NO raw secret remains', () => {
    // Build a 5× cap-sized delta with the secret near the start.
    const secret = 'sk-abcdef1234567890abcdef1234567890';
    const filler = 'word '.repeat(ASSISTANT_MAX_DELTA_CHARS);
    const raw = `Here is the leaked ${secret} and now lots of filler: ${filler}`;
    const result = applyAssistantDelta('', raw);
    assert.ok(!result.text.includes(secret), 'raw secret must not survive');
    assert.equal(result.redacted, true);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= ASSISTANT_MAX_DELTA_CHARS);
  });

  it('huge delta with secret near the END (tail-keep area): still redacted before truncation', () => {
    // Tail-keep would, in a naive implementation, preserve the END.
    // The helper redacts BEFORE truncating, so the secret is masked
    // first; subsequent truncation just trims the (already-safe) tail.
    // Use varied filler so the bulk text doesn't itself trigger
    // redactSecrets's "repeated long alnum block" heuristic.
    const secret = 'sk-deadbeef00000000deadbeef00000000';
    const filler = 'lorem ipsum dolor sit amet '.repeat(200); // ~5400 chars, varied
    const raw = `${filler} and the leaked credential is ${secret} at the end`;
    const result = applyAssistantDelta('', raw);
    assert.ok(!result.text.includes(secret), 'raw secret must not survive even in tail-kept region');
    assert.equal(result.redacted, true);
    assert.equal(result.truncated, true);
  });

  it('CROSS-DELTA: long opaque token split exactly at the delta seam (40+ hex chars) is caught (@kenji Blocker 1 hard gate)', () => {
    // @kenji msg 3c01e901 Blocker 1 hard gate: the canonical
    // cross-delta case. A 40+ char hex run matches the "long opaque
    // token" pattern in `redactSecrets`. Splitting it across two
    // deltas means per-delta redaction can't see the full match;
    // ONLY the post-append L4 pass on the appended candidate catches
    // it.
    //   delta 1: 20 chars hex (innocuous by itself)
    //   delta 2: 25 chars hex (innocuous by itself)
    //   after append: 45 chars hex → matches pattern → must redact
    const half1 = 'a1b2c3d4e5f60718293a4b5c'; // 24 hex chars
    const half2 = '6d7e8f9012345678abcdef'; // 22 hex chars
    const combined = half1 + half2; // 46 hex chars total
    assert.equal(combined.length, 46);
    const r1 = applyAssistantDelta('', half1);
    // Half-1 by itself is 24 chars, below the 40-char threshold —
    // per-delta redaction does NOT fire. Critical: ensures we are
    // genuinely testing the cross-delta gate, not the per-delta one.
    assert.equal(r1.redacted, false, 'half-1 alone should NOT match any redaction pattern');
    assert.ok(r1.text.includes(half1), 'half-1 should be present in state pre-cross-delta');

    const r2 = applyAssistantDelta(r1.text, half2);
    // Now the appended candidate is 46 hex chars — matches the
    // long-opaque-token pattern. L4 post-append redactSecrets MUST
    // fire, and the stored text MUST NOT contain the combined raw
    // string.
    assert.ok(
      !r2.text.includes(combined),
      `cross-delta long-opaque token must be redacted by L4 post-append pass; got: ${r2.text}`,
    );
    assert.equal(
      r2.redacted,
      true,
      'second call must report redacted=true because L4 cross-delta pass fired',
    );
  });

  it('CROSS-DELTA: Authorization header partial-then-token (per-delta or post-append, either layer catches it)', () => {
    // Documents that EITHER L1 (per-delta on "Authorization: Bearer
    // sk-") OR L4 (post-append) may fire — the helper guarantees
    // the COMBINED state has no raw secret, regardless of which
    // layer caught it. (The Authorization regex in `redactSecrets`
    // happens to fire on the partial because `[^\s"'<>]+` matches
    // even a short token suffix.)
    const result1 = applyAssistantDelta('', 'Authorization: Bearer sk-');
    const result2 = applyAssistantDelta(result1.text, 'abcdef1234567890fedcba0987654321');
    const combinedSecret = 'sk-abcdef1234567890fedcba0987654321';
    assert.ok(
      !result2.text.includes(combinedSecret),
      `combined token must NOT appear in final state; got: ${result2.text}`,
    );
    // At least one of the two calls must have reported redaction.
    assert.ok(
      result1.redacted || result2.redacted,
      'redaction must fire at some layer in the cross-delta sequence',
    );
  });

  it('CROSS-DELTA: secret split across many tiny deltas — final accumulated state has no raw token', () => {
    // Token "sk-deadbeef00000000deadbeef00000000" streamed as
    // individual chars (worst-case per-delta is single char, far
    // below any pattern threshold). Final stored text must still
    // never contain the raw secret thanks to the post-append pass.
    const secret = 'sk-deadbeef00000000deadbeef00000000';
    const prefix = 'Authorization: Bearer ';
    const full = prefix + secret;
    let buf = '';
    let anyRedacted = false;
    for (const ch of full) {
      const r = applyAssistantDelta(buf, ch);
      buf = r.text;
      anyRedacted = anyRedacted || r.redacted;
    }
    assert.ok(!buf.includes(secret), 'no raw token in final accumulated state');
    assert.ok(anyRedacted, 'at least one call must have reported redaction');
  });

  it('CROSS-DELTA: prev already contains partial that becomes full secret after appending — caught', () => {
    // The chokepoint is the only place this can fire correctly. If
    // we ONLY redacted the delta, the prev's `"sk-"` prefix would
    // survive and the appended bytes would complete the token in
    // state. The L4 post-append redactSecrets pass catches this.
    const result = applyAssistantDelta('Token: sk-', 'abcdef0123456789abcdef0123456789');
    const expectedSecret = 'sk-abcdef0123456789abcdef0123456789';
    assert.ok(!result.text.includes(expectedSecret), 'cross-delta token caught by post-append pass');
    assert.equal(result.redacted, true);
  });

  it('non-string delta carrying ostensible secret: dropped, NO secret enters state', () => {
    // A misbehaving runtime that ships a non-string `text` with an
    // attribute named like a secret should not corrupt state.
    const sneaky = { text: 'sk-abcdef1234567890abcdef1234567890' } as unknown as string;
    const result = applyAssistantDelta('', sneaky);
    assert.equal(result.text, '', 'non-string drop');
    assert.equal(result.redacted, false);
    assert.equal(result.truncated, false);
  });
});

describe('applyAssistantDelta — monotonic truncated propagation', () => {
  // The renderer wires the helper's `truncated` flag into the active
  // projection with a monotonic OR that stays true until the step settles.
  // The helper itself doesn't enforce monotonicity (that's caller
  // responsibility); it only reports whether THIS call truncated.
  // These tests pin the per-call shape so the caller's monotonic OR
  // produces the expected result.

  it('reports truncated=true for the call that crosses the cap, true for subsequent dropped calls', () => {
    // Raise per-delta cap so the SINGLE delta path hits the TOTAL
    // cap (the test that exercises the short-circuit dropped-delta
    // path requires a buffer that ends with the trailing marker AND
    // is at maxTotal).
    const big = 'word '.repeat(ASSISTANT_MAX_TOTAL_CHARS / 5 + 100);
    const first = applyAssistantDelta('', big, { maxDeltaChars: big.length });
    assert.equal(first.truncated, true);
    assert.ok(first.text.endsWith('\n\n[…后续已截断]'));
    const second = applyAssistantDelta(first.text, 'more');
    assert.equal(second.truncated, true, 'subsequent drops still report truncated');
    assert.equal(second.text, first.text, 'buffer must not grow');
  });

  it('reports truncated=false for a small delta that fits comfortably', () => {
    const result = applyAssistantDelta('hello', ' there');
    assert.equal(result.truncated, false);
  });
});

describe('applyAssistantComplete — final payload replace path', () => {
  it('returns an empty result for an empty complete payload', () => {
    const result = applyAssistantComplete('');

    assert.deepEqual(result, { text: '', redacted: false, truncated: false });
  });

  it('does not apply the per-delta cap to a complete payload under the total cap', () => {
    const finalText = 'word '.repeat(Math.ceil(ASSISTANT_MAX_DELTA_CHARS / 5) + 20);
    assert.ok(finalText.length > ASSISTANT_MAX_DELTA_CHARS);
    assert.ok(finalText.length < ASSISTANT_MAX_TOTAL_CHARS);

    const result = applyAssistantComplete(finalText);

    assert.equal(result.text, finalText);
    assert.equal(result.truncated, false);
  });

  it('redacts and total-caps the final complete payload before it reaches state', () => {
    const secret = 'sk-abcdef1234567890abcdef1234567890';
    const result = applyAssistantComplete(`token ${secret} tail that is too long`, { maxTotalChars: 24 });

    assert.ok(!result.text.includes(secret), 'raw secret must not survive complete payload handling');
    assert.ok(result.text.endsWith('\n\n[…后续已截断]'));
    assert.equal(result.redacted, true);
    assert.equal(result.truncated, true);
  });
});
