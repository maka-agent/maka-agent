/**
 * Tests for the PR-UI-IPC-2 session-name normalization contract
 * (`@maka/core/session-name`).
 *
 * Locks the gate kenji + xuan signed off on (msgs 0474c3fe + 88d96a87):
 * runtime-type guard, NFC, C0/C1 + bidi + zero-width handling,
 * whitespace collapse, trim, empty-after-sanitize reject, 80
 * code-point cap (NOT byte/UTF-16 unit cap).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SESSION_NAME_MAX_CODE_POINTS, normalizeUserSessionName } from '../session-name.js';

describe('normalizeUserSessionName (PR-UI-IPC-2)', () => {
  describe('runtime-type guard', () => {
    it('non-string inputs reject with typed error (never throw)', () => {
      for (const bad of [
        undefined,
        null,
        42,
        0,
        NaN,
        true,
        false,
        {},
        [],
        Symbol('x'),
        () => '',
        BigInt(1),
      ]) {
        const result = normalizeUserSessionName(bad);
        assert.equal(result.ok, false, `bad input ${String(bad)} must reject`);
        if (!result.ok) {
          assert.ok(result.error.includes('must be a string'));
        }
      }
    });

    it('never throws on bad runtime type — sanity gate against `.normalize()` on non-string', () => {
      for (const bad of [undefined, null, 42, true, {}, [], Symbol('x'), () => '', BigInt(1)]) {
        assert.doesNotThrow(
          () => normalizeUserSessionName(bad),
          `bad input ${String(bad)} must not throw`,
        );
      }
    });
  });

  describe('happy path', () => {
    it('plain ASCII text passes through unchanged', () => {
      assert.deepEqual(normalizeUserSessionName('My chat session'), {
        ok: true,
        value: 'My chat session',
      });
    });

    it('Chinese text passes through unchanged', () => {
      assert.deepEqual(normalizeUserSessionName('帮我写代码'), { ok: true, value: '帮我写代码' });
    });

    it('emoji passes through unchanged (single code point even if surrogate pair)', () => {
      assert.deepEqual(normalizeUserSessionName('🦊 fox chat'), { ok: true, value: '🦊 fox chat' });
    });

    it('mixed CJK + emoji + ASCII passes through', () => {
      assert.deepEqual(normalizeUserSessionName('帮我写 Python 🐍 代码'), {
        ok: true,
        value: '帮我写 Python 🐍 代码',
      });
    });

    it('trim leading and trailing whitespace', () => {
      assert.deepEqual(normalizeUserSessionName('  hello  '), { ok: true, value: 'hello' });
      assert.deepEqual(normalizeUserSessionName('\t\nhello\n\t'), { ok: true, value: 'hello' });
    });

    it('collapse internal whitespace runs to single space', () => {
      assert.deepEqual(normalizeUserSessionName('foo    bar'), { ok: true, value: 'foo bar' });
      assert.deepEqual(normalizeUserSessionName('foo\t\tbar'), { ok: true, value: 'foo bar' });
    });
  });

  describe('empty / whitespace-only reject', () => {
    it('empty string rejects', () => {
      assert.equal(normalizeUserSessionName('').ok, false);
    });

    it('whitespace-only rejects', () => {
      for (const raw of ['   ', '\t', '\n', '\r\n', ' \t \n ']) {
        const result = normalizeUserSessionName(raw);
        assert.equal(result.ok, false, `raw=${JSON.stringify(raw)}`);
        if (!result.ok) {
          assert.ok(result.error.includes('empty'));
        }
      }
    });

    it('after sanitize empty rejects (control chars only)', () => {
      // String of only C0 controls → after replace becomes whitespace
      // → after collapse + trim becomes empty → reject.
      const onlyControls = '\x00\x01\x02\x03';
      assert.equal(normalizeUserSessionName(onlyControls).ok, false);
    });
  });

  describe('C0/C1 control character handling', () => {
    it('newline / tab replaced with space (not removed)', () => {
      assert.deepEqual(normalizeUserSessionName('line1\nline2'), {
        ok: true,
        value: 'line1 line2',
      });
      assert.deepEqual(normalizeUserSessionName('col1\tcol2'), { ok: true, value: 'col1 col2' });
    });

    it('ANSI escape sequences (C0 ESC) replaced with space', () => {
      // Raw ESC byte (U+001B) — common in tool output paste.
      assert.deepEqual(normalizeUserSessionName('green\x1b[32mtext\x1b[0m'), {
        ok: true,
        value: 'green [32mtext [0m',
      });
    });

    it('NUL byte (U+0000) replaced with space', () => {
      assert.deepEqual(normalizeUserSessionName('safe\x00name'), { ok: true, value: 'safe name' });
    });

    it('DEL (U+007F) and C1 controls (U+0080..U+009F) replaced', () => {
      assert.deepEqual(normalizeUserSessionName('a\x7fb\x80c\x9fd'), {
        ok: true,
        value: 'a b c d',
      });
    });
  });

  describe('bidi format character handling', () => {
    it('RLO (U+202E) replaced with space — defeats RTL display spoof', () => {
      // Classic RLO spoof: a string "file‮txt.exe" displays as
      // "fileexe.txt" in some renderers. Replacing with space
      // prevents the spoof and shows what the bytes actually are.
      assert.deepEqual(normalizeUserSessionName('file‮txt.exe'), {
        ok: true,
        value: 'file txt.exe',
      });
    });

    it('LRE / RLE / PDF / LRO removed too', () => {
      for (const ch of ['‪', '‫', '‬', '‭']) {
        const input = `before${ch}after`;
        const result = normalizeUserSessionName(input);
        assert.ok(result.ok);
        if (result.ok) {
          assert.ok(
            !result.value.includes(ch),
            `${ch.codePointAt(0)?.toString(16)} must be removed`,
          );
        }
      }
    });

    it('isolate format chars (U+2066..U+2069) replaced', () => {
      for (const ch of ['⁦', '⁧', '⁨', '⁩']) {
        const input = `pre${ch}post`;
        const result = normalizeUserSessionName(input);
        assert.ok(result.ok);
        if (result.ok) {
          assert.ok(!result.value.includes(ch));
        }
      }
    });
  });

  describe('zero-width format character handling', () => {
    it('ZWSP / ZWNJ / ZWJ / BOM removed (NOT replaced with space)', () => {
      // Zero-width chars are meant to be invisible. Removing them
      // entirely keeps the visible text intact; replacing with
      // space would inject visible whitespace into Chinese/emoji
      // strings that may legitimately use ZWJ for compound emoji.
      for (const ch of ['​', '‌', '‍', '﻿']) {
        const input = `clean${ch}name`;
        const result = normalizeUserSessionName(input);
        assert.ok(result.ok);
        if (result.ok) {
          assert.equal(
            result.value,
            'cleanname',
            `${ch.codePointAt(0)?.toString(16)} must be removed, not space-replaced`,
          );
        }
      }
    });

    it('zero-width prefix-attack (e.g. "ad\\u200Bmin") collapses to its visible form', () => {
      // Common spoof: prefix ZWSP between letters to evade exact-
      // string filters. After normalize, the string is what the
      // user sees: "admin".
      assert.deepEqual(normalizeUserSessionName('ad​min'), { ok: true, value: 'admin' });
    });
  });

  describe('NFC canonicalization', () => {
    it('NFD form normalizes to NFC', () => {
      // "café" in NFC: "café" (5 code units)
      // in NFD: "café" (5 code units, decomposed)
      const nfd = 'café';
      const nfc = 'café';
      const result = normalizeUserSessionName(nfd);
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value, nfc);
      }
    });

    it('NFC alone does NOT defeat zero-width injection (must run with strip step)', () => {
      // Documentation gate: NFC is canonicalization, not a security
      // boundary. Zero-width chars survive NFC; the dedicated strip
      // step (L5) is what removes them.
      const withZwsp = 'a​b';
      assert.equal(
        withZwsp.normalize('NFC'),
        withZwsp,
        'NFC keeps ZWSP — security requires explicit strip',
      );
      // Our normalize DOES strip it:
      const result = normalizeUserSessionName(withZwsp);
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.value, 'ab');
      }
    });
  });

  describe('code-point length cap (80)', () => {
    it('exactly 80 code points unchanged', () => {
      const exact = 'a'.repeat(80);
      const result = normalizeUserSessionName(exact);
      assert.deepEqual(result, { ok: true, value: exact });
    });

    it('81+ code points truncated to 80', () => {
      const long = 'a'.repeat(120);
      const result = normalizeUserSessionName(long);
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(Array.from(result.value).length, 80);
      }
    });

    it('surrogate pair (emoji) counts as 1 code point, never cut in half', () => {
      // 79 ASCII + 1 emoji = 80 code points. UTF-16 length is 79 + 2 = 81 code units.
      // A naive `.slice(0, 80)` would cut the emoji's high-surrogate
      // and leave a lone low-surrogate (invalid string). Our
      // `Array.from` iteration prevents that.
      const input = `${'a'.repeat(79)}🦊`;
      assert.equal(Array.from(input).length, 80);
      assert.equal(input.length, 81); // UTF-16 code units
      const result = normalizeUserSessionName(input);
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(Array.from(result.value).length, 80);
        // The emoji must be intact, not split.
        assert.ok(result.value.endsWith('🦊'));
      }
    });

    it('CJK characters count as 1 code point each (visual width is layout concern)', () => {
      // 80 CJK chars fits exactly at the cap (regardless that each
      // CJK char takes 2-3 visual columns in monospace). This is
      // intentional — the cap is on contract size, not visual
      // width.
      const cjk = '帮我写代码'.repeat(16); // 5 × 16 = 80
      assert.equal(Array.from(cjk).length, 80);
      const result = normalizeUserSessionName(cjk);
      assert.deepEqual(result, { ok: true, value: cjk });
    });

    it('exposes the cap constant', () => {
      assert.equal(SESSION_NAME_MAX_CODE_POINTS, 80);
    });

    it('truncation happens AFTER NFC/strip/trim (not on raw input)', () => {
      // Pad with controls that get stripped — final length matters,
      // not pre-strip raw length.
      const input = '\x00\x00\x00valid name';
      const result = normalizeUserSessionName(input);
      assert.ok(result.ok);
      if (result.ok) {
        // After strip + trim → "valid name" (10 chars). Cap doesn't fire.
        assert.equal(result.value, 'valid name');
      }
    });
  });
});
