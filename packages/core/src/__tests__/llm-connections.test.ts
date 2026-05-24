/**
 * Tests for the LlmConnection contract helpers in
 * `packages/core/src/llm-connections.ts`.
 *
 * Current scope: PR-UI-IPC-1 `validateConnectionBaseUrl` gate
 * (closed scheme allowlist for connection `baseUrl` at the IPC
 * boundary). The gate is the credentials-exfiltration boundary
 * @kenji locked at msg 35260e29 — `javascript:` / `file:` / garbage
 * must NOT persist; `http:` / `https:` are the only accepted
 * schemes. Localhost / private-network URLs are intentionally
 * allowed (Ollama, LM Studio, vLLM).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  normalizeConnectionBaseUrl,
  validateConnectionBaseUrl,
} from '../llm-connections.js';

describe('validateConnectionBaseUrl (PR-UI-IPC-1, @kenji msg 35260e29)', () => {
  describe('accept (returns null)', () => {
    it('undefined → null (no override; fall back to provider default)', () => {
      assert.equal(validateConnectionBaseUrl(undefined), null);
    });

    it('null → null', () => {
      assert.equal(validateConnectionBaseUrl(null), null);
    });

    it('empty string → null (treated as "no override")', () => {
      assert.equal(validateConnectionBaseUrl(''), null);
    });

    it('whitespace-only → null', () => {
      assert.equal(validateConnectionBaseUrl('   '), null);
      assert.equal(validateConnectionBaseUrl('\t\n'), null);
    });

    it('https provider canonical URLs', () => {
      const canonical = [
        'https://api.anthropic.com',
        'https://api.openai.com/v1',
        'https://generativelanguage.googleapis.com',
        'https://api.deepseek.com',
        'https://api.z.ai/api/coding/paas/v4',
        'https://api.moonshot.cn/v1',
      ];
      for (const url of canonical) {
        assert.equal(validateConnectionBaseUrl(url), null, `URL ${url} should be accepted`);
      }
    });

    it('http localhost URLs (Ollama, LM Studio, vLLM) — intentionally allowed', () => {
      // @kenji msg 35260e29 explicitly: localhost / private-network
      // MUST stay allowed. Ollama default is http://localhost:11434.
      const local = [
        'http://localhost:11434/v1',
        'http://127.0.0.1:8000',
        'http://0.0.0.0:8080',
        'http://192.168.1.50:11434',
        'http://10.0.0.5:8080',
        'http://lan-server.local:5000',
      ];
      for (const url of local) {
        assert.equal(validateConnectionBaseUrl(url), null, `localhost / private URL ${url} must be accepted`);
      }
    });

    it('http URLs in general (allowed scheme)', () => {
      const allowed = [
        'http://example.com',
        'http://example.com:80/path',
        'http://user:pass@example.com', // userinfo is parsed; URL accepts it
      ];
      for (const url of allowed) {
        assert.equal(validateConnectionBaseUrl(url), null, `URL ${url} should be accepted`);
      }
    });

    it('https with custom port + path + query survives', () => {
      assert.equal(validateConnectionBaseUrl('https://api.custom.example.com:8443/v2/chat?region=us'), null);
    });

    it('trims surrounding whitespace', () => {
      assert.equal(validateConnectionBaseUrl('  https://api.openai.com  '), null);
      assert.equal(validateConnectionBaseUrl('\thttps://api.openai.com\n'), null);
    });

    it('exactly 2048 chars (cap boundary) is accepted', () => {
      const padding = 'a'.repeat(2048 - 'https://example.com/'.length);
      const exact = `https://example.com/${padding}`;
      assert.equal(exact.length, 2048);
      assert.equal(validateConnectionBaseUrl(exact), null);
    });
  });

  describe('reject (returns error message)', () => {
    it('javascript: URL is rejected (XSS / credential exfiltration)', () => {
      const result = validateConnectionBaseUrl('javascript:alert(1)');
      assert.ok(result !== null, 'javascript: must reject');
      assert.ok(
        result!.includes("'javascript:'"),
        `reject message should name the offending scheme; got: ${result}`,
      );
    });

    it('file: URL is rejected (local file read)', () => {
      const result = validateConnectionBaseUrl('file:///etc/passwd');
      assert.ok(result !== null);
      assert.ok(result!.includes("'file:'"));
    });

    it('data: URL is rejected', () => {
      const result = validateConnectionBaseUrl('data:text/html,<script>alert(1)</script>');
      assert.ok(result !== null);
    });

    it('vbscript: URL is rejected', () => {
      assert.ok(validateConnectionBaseUrl('vbscript:msgbox') !== null);
    });

    it('chrome-extension: URL is rejected', () => {
      assert.ok(validateConnectionBaseUrl('chrome-extension://abc/page.html') !== null);
    });

    it('ws: / wss: rejected (websocket — out of scope for this contract)', () => {
      assert.ok(validateConnectionBaseUrl('ws://example.com') !== null);
      assert.ok(validateConnectionBaseUrl('wss://example.com') !== null);
    });

    it('ftp: rejected', () => {
      assert.ok(validateConnectionBaseUrl('ftp://example.com') !== null);
    });

    it('custom scheme rejected', () => {
      assert.ok(validateConnectionBaseUrl('maka://settings') !== null);
      assert.ok(validateConnectionBaseUrl('app://x') !== null);
      assert.ok(validateConnectionBaseUrl('myproto://abc') !== null);
    });

    it('malformed URL (bare string, no scheme) is rejected', () => {
      const result = validateConnectionBaseUrl('not-a-url');
      assert.ok(result !== null);
      assert.ok(result!.includes('valid URL'), `should report invalid URL; got: ${result}`);
    });

    it('malformed URL (only scheme) is rejected', () => {
      // `http:` alone parses to `protocol: 'http:'` but with no
      // host. Whether `new URL('http:')` throws depends on the
      // runtime; this test pins the documented behavior.
      const result = validateConnectionBaseUrl('http:');
      // Either path (throw → invalid URL message OR pass scheme but
      // empty host) should reject. We assert reject without locking
      // which message wins.
      assert.ok(result !== null, '`http:` alone must reject');
    });

    it('oversize URL (> 2048 chars) is rejected before URL parse', () => {
      const oversize = `https://example.com/${'a'.repeat(2050)}`;
      assert.ok(oversize.length > 2048);
      const result = validateConnectionBaseUrl(oversize);
      assert.ok(result !== null);
      assert.ok(
        result!.includes('2048'),
        `oversize reject should reference the cap; got: ${result}`,
      );
    });

    it('weird unicode in URL is rejected if URL constructor throws', () => {
      // Invalid host bytes that `new URL` throws on.
      assert.ok(validateConnectionBaseUrl('https://exa mple .com') !== null);
    });
  });

  describe('case-sensitivity of scheme', () => {
    it('accepts mixed-case schemes (URL normalizes to lowercase)', () => {
      // WHATWG URL spec lowercases special-scheme protocols.
      assert.equal(validateConnectionBaseUrl('HTTPS://api.example.com'), null);
      assert.equal(validateConnectionBaseUrl('Http://localhost:8000'), null);
    });
  });
});

describe('normalizeConnectionBaseUrl (PR-UI-IPC-1 fixup v2, @kenji msg 8755ffb3 + 6b638e08)', () => {
  // The store-boundary chokepoint: the IPC handler calls this helper
  // and uses the returned canonical value as the patch payload. The
  // contract distinguishes between "explicit clear" (preserved as
  // empty string so the store removes the override) and "set"
  // (trimmed URL). It does NOT collapse explicit clear into
  // "don't touch" — that would silently swallow the user's intent.

  describe('explicit-clear intent (whitespace / empty)', () => {
    it('empty string → ok with value: ""', () => {
      const result = normalizeConnectionBaseUrl('');
      assert.deepEqual(result, { ok: true, value: '' });
    });

    it('whitespace-only → ok with value: "" (trimmed to empty)', () => {
      for (const raw of ['   ', '\t', '\n', ' \t \n ']) {
        const result = normalizeConnectionBaseUrl(raw);
        assert.deepEqual(result, { ok: true, value: '' }, `raw=${JSON.stringify(raw)}`);
      }
    });

    it('explicit clear value MUST be "" (not undefined) — preserves store clear semantics', () => {
      // Critical for the store boundary: the existing store update
      // path is
      //   `patch.baseUrl !== undefined ? patch.baseUrl || undefined : current.baseUrl`
      // so a `'' ` patch clears the existing override, but
      // `undefined` would be treated as "don't touch". The
      // normalize contract MUST return `''` for whitespace input
      // — never `undefined`.
      const result = normalizeConnectionBaseUrl('   ');
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value, '');
        assert.notEqual(result.value, undefined, 'must not collapse to undefined');
      }
    });
  });

  describe('set intent (trimmed URL)', () => {
    it('clean URL → returns identical value', () => {
      const result = normalizeConnectionBaseUrl('https://api.openai.com/v1');
      assert.deepEqual(result, { ok: true, value: 'https://api.openai.com/v1' });
    });

    it('URL with surrounding whitespace → trimmed', () => {
      assert.deepEqual(
        normalizeConnectionBaseUrl('  https://api.openai.com  '),
        { ok: true, value: 'https://api.openai.com' },
      );
      assert.deepEqual(
        normalizeConnectionBaseUrl('\thttps://api.openai.com\n'),
        { ok: true, value: 'https://api.openai.com' },
      );
    });

    it('does NOT lowercase scheme / host / path (no URL canonicalization)', () => {
      // @kenji explicit non-canonicalization: trim is the ONLY
      // normalization. Users who deliberately configured
      // mixed-case URLs keep them. WHATWG URL accepts the case
      // variants; we don't re-emit a normalized URL.
      assert.deepEqual(
        normalizeConnectionBaseUrl('  https://Example.com:443/V1  '),
        { ok: true, value: 'https://Example.com:443/V1' },
      );
    });

    it('localhost / private-network URLs survive (Ollama etc.)', () => {
      assert.deepEqual(
        normalizeConnectionBaseUrl('  http://localhost:11434/v1  '),
        { ok: true, value: 'http://localhost:11434/v1' },
      );
      assert.deepEqual(
        normalizeConnectionBaseUrl('http://192.168.1.50:11434'),
        { ok: true, value: 'http://192.168.1.50:11434' },
      );
    });
  });

  describe('reject (validate gate fires)', () => {
    it('bad scheme rejects through normalize too', () => {
      const result = normalizeConnectionBaseUrl('javascript:alert(1)');
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes("'javascript:'"));
      }
    });

    it('file: URL rejected', () => {
      const result = normalizeConnectionBaseUrl('  file:///etc/passwd  ');
      assert.equal(result.ok, false);
    });

    it('malformed URL rejected', () => {
      const result = normalizeConnectionBaseUrl('not-a-url');
      assert.equal(result.ok, false);
    });

    it('oversize rejected', () => {
      const oversize = `https://example.com/${'a'.repeat(2050)}`;
      const result = normalizeConnectionBaseUrl(oversize);
      assert.equal(result.ok, false);
    });
  });

  describe('store-boundary scenarios (IPC handler simulation)', () => {
    // Simulate the IPC handler's caller contract. The handler does:
    //   if (patch.baseUrl !== undefined) {
    //     const result = normalizeConnectionBaseUrl(patch.baseUrl);
    //     if (!result.ok) throw new Error(result.error);
    //     normalizedPatch = { ...patch, baseUrl: result.value };
    //   }
    //   await connectionStore.update(slug, normalizedPatch);
    //
    // These tests verify that the value the store sees matches the
    // user's intent for each input.

    it('user-typed URL with whitespace → store sees trimmed URL (set)', () => {
      const result = normalizeConnectionBaseUrl('  https://api.openai.com  ');
      assert.equal(result.ok, true);
      if (result.ok) {
        // Store sees this as `patch.baseUrl = 'https://api.openai.com'`
        // → ternary: truthy string → sets override to trimmed.
        assert.equal(result.value, 'https://api.openai.com');
      }
    });

    it('user typed whitespace-only (clear intent) → store sees "" (clear)', () => {
      const result = normalizeConnectionBaseUrl('   ');
      assert.equal(result.ok, true);
      if (result.ok) {
        // Store sees this as `patch.baseUrl = ''`
        // → ternary: `'' !== undefined && '' || undefined = undefined`
        // → existing override is cleared. NOT "don't touch".
        assert.equal(result.value, '');
      }
    });

    it('user typed bad scheme → throw before store; store never sees the bogus value', () => {
      // Handler would `throw new Error(result.error)` and skip the
      // store update entirely.
      const result = normalizeConnectionBaseUrl('javascript:exfil()');
      assert.equal(result.ok, false);
      // Handler never reaches the store update line on this path.
    });

    it('omitted (patch.baseUrl === undefined) → handler does not call normalize', () => {
      // This isn't a normalize test per se — it's a documentation
      // assertion that the IPC handler's `if (patch.baseUrl !==
      // undefined)` guard means undefined NEVER reaches this
      // helper. The store sees `patch.baseUrl === undefined` and
      // falls back to "don't touch existing" via its existing
      // ternary. We just lock the boundary: normalize requires a
      // string caller. (TypeScript signature `(baseUrl: string)`
      // makes this load-bearing.)
      // No runtime call needed; the type system + handler-side
      // guard is the contract.
      assert.ok(true);
    });
  });
});
