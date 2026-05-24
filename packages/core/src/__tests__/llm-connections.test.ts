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
import { validateConnectionBaseUrl } from '../llm-connections.js';

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
