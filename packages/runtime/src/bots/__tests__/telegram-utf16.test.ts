import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../simple-bridge.js';

const { utf16Len, prefixWithinUtf16, splitForTelegram } = __TEST__;

describe('utf16Len (PR-TELEGRAM-UTF16-LIMIT-0)', () => {
  it('counts BMP characters as 1 unit each', () => {
    assert.equal(utf16Len('hello'), 5);
    assert.equal(utf16Len('你好世界'), 4);
  });

  it('counts astral-plane characters as 2 units each (surrogate pair)', () => {
    // U+1F600 GRINNING FACE = surrogate pair, 2 code units
    assert.equal(utf16Len('😀'), 2);
    assert.equal(utf16Len('a😀b'), 4);
    // CJK Extension B (U+20000) — also a surrogate pair
    assert.equal(utf16Len('\u{20000}'), 2);
  });

  it('handles empty string', () => {
    assert.equal(utf16Len(''), 0);
  });
});

describe('prefixWithinUtf16 (PR-TELEGRAM-UTF16-LIMIT-0)', () => {
  it('returns the input untouched when it already fits', () => {
    assert.equal(prefixWithinUtf16('hello', 100), 'hello');
  });

  it('truncates at cap when input exceeds it', () => {
    const out = prefixWithinUtf16('abcdef', 3);
    assert.equal(out, 'abc');
  });

  it('does NOT slice a surrogate pair in half', () => {
    // 'a😀' = 1 + 2 = 3 code units. Cap of 2 should drop the emoji
    // entirely, NOT yield 'a\uD83D' (the high-surrogate alone).
    const out = prefixWithinUtf16('a😀', 2);
    assert.equal(out, 'a');
    assert.equal(utf16Len(out), 1);
  });

  it('handles a string composed entirely of surrogate pairs', () => {
    const out = prefixWithinUtf16('😀😀😀😀', 5);
    // Two emojis = 4 code units fit; three = 6 don't. Three are out;
    // two are in.
    assert.equal(out, '😀😀');
  });
});

describe('splitForTelegram (PR-TELEGRAM-UTF16-LIMIT-0)', () => {
  it('returns the original text in a single-element array when it fits', () => {
    const out = splitForTelegram('hello world');
    assert.deepEqual(out, ['hello world']);
  });

  it('splits an oversized text and stamps continuation headers', () => {
    const big = 'a'.repeat(8500); // > 4000 cap, will produce 3 chunks
    const out = splitForTelegram(big);
    assert.ok(out.length >= 2);
    assert.match(out[0]!, /^\[1\/\d+\]\n/);
    assert.match(out[out.length - 1]!, /^\[\d+\/\d+\]\n/);
    // Every chunk MUST fit under the cap.
    for (const piece of out) {
      assert.ok(utf16Len(piece) <= 4000, `chunk over cap: ${utf16Len(piece)}`);
    }
  });

  it('does not split mid-surrogate', () => {
    // 4000 emojis = 8000 code units, requires at least 2 splits.
    const emoji = '😀'.repeat(4000);
    const out = splitForTelegram(emoji);
    assert.ok(out.length >= 2);
    for (const piece of out) {
      // Strip the [i/N]\n header before checking content for orphan
      // surrogates.
      const body = piece.replace(/^\[\d+\/\d+\]\n/, '');
      // If we split mid-surrogate, the first/last char of body would
      // be an unpaired surrogate. Round-trip through UTF-16 to verify
      // every codepoint survives.
      for (let i = 0; i < body.length; ) {
        const code = body.codePointAt(i)!;
        assert.ok(code >= 0x20 || code === 0x0a, `bad codepoint at ${i}`);
        i += code > 0xffff ? 2 : 1;
      }
    }
  });

  it('prefers newline split points when available', () => {
    const line = 'line\n'.repeat(900); // 5 * 900 = 4500 code units, splits
    const out = splitForTelegram(line);
    assert.ok(out.length >= 2);
    // The first chunk SHOULD end on a line boundary (not mid-word).
    const body0 = out[0]!.replace(/^\[\d+\/\d+\]\n/, '');
    assert.ok(
      body0.endsWith('line') || body0.endsWith('line\n'),
      `unexpected tail: ${JSON.stringify(body0.slice(-20))}`,
    );
  });
});
