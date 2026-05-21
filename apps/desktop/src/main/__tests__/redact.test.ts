/**
 * Tests for @maka/ui defensive secret redactor. Lives in the desktop
 * workspace because that's where node:test is already wired up; the
 * subject under test is the renderer-facing helper at
 * `packages/ui/src/redact.ts`, imported through the @maka/ui public API.
 *
 * These tests pin the invariants @kenji asked for in the personalization /
 * tool-error security review:
 *   - Authorization header / Bearer / Basic / Token mask the value
 *   - URL query params with secret-like keys mask the value, preserve
 *     host / path / other params
 *   - Provider key prefixes (sk-, sk-ant-, AIza, ghp_/gho_/ghu_/ghs_/ghr_,
 *     xox[abprs]-) are masked
 *   - X-API-Key / api-key HTTP header forms mask the value
 *   - Long high-entropy hex/base64 strings (40+) are masked as catch-all
 *   - Plain prose passes through unchanged
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { redactSecrets } from '@maka/ui';

describe('redactSecrets', () => {
  it('masks Authorization: Bearer token', () => {
    const out = redactSecrets('Authorization: Bearer sk-ant-api03-abc123def456ghi789jkl0mn1opq');
    assert.match(out, /Authorization: Bearer <redacted>/);
    assert.doesNotMatch(out, /sk-ant-api03/);
  });

  it('masks Authorization: Basic credentials', () => {
    const out = redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==');
    assert.match(out, /Basic <redacted>/);
    assert.doesNotMatch(out, /dXNlcjpwYXNz/);
  });

  it('masks X-API-Key HTTP header but preserves header name + surrounding URL', () => {
    const input = 'curl -H "X-API-Key: 1234567890abcdef1234567890abcdef" https://x.com/path';
    const out = redactSecrets(input);
    assert.match(out, /X-API-Key: <redacted>/);
    assert.doesNotMatch(out, /1234567890abcdef1234567890abcdef/);
    assert.match(out, /https:\/\/x\.com\/path/);
  });

  it('masks ?api_key= URL query value only, preserves host / path / other params', () => {
    const input = 'https://api.example.com/v1/chat?model=gpt-4o&api_key=secret123abc&user=alice&max_tokens=2048';
    const out = redactSecrets(input);
    // Secret value is masked
    assert.doesNotMatch(out, /secret123abc/);
    // Host + path preserved
    assert.match(out, /https:\/\/api\.example\.com\/v1\/chat/);
    // Other params preserved
    assert.match(out, /model=gpt-4o/);
    assert.match(out, /user=alice/);
    assert.match(out, /max_tokens=2048/);
    // Secret param uses the URL-query replacement form. In this input
    // `api_key` follows `&`, not `?`, so we assert against either delimiter.
    assert.match(out, /[?&]api_key=<redacted>/);
  });

  it('masks various URL query secret-key spellings', () => {
    const cases = [
      ['?access_token=abc', /access_token=<redacted>/],
      ['&token=abc', /&token=<redacted>/],
      ['?secret=abc', /\?secret=<redacted>/],
      ['?signature=abc', /\?signature=<redacted>/],
      ['?apikey=abc', /\?apikey=<redacted>/],
      ['?api-key=abc', /\?api-key=<redacted>/],
    ] as const;
    for (const [input, expect] of cases) {
      assert.match(redactSecrets(`https://x.com/p${input}&keep=ok`), expect, `failed for ${input}`);
    }
  });

  it('masks OpenAI / Anthropic / Google / GitHub / Slack provider key prefixes', () => {
    const inputs = [
      'use sk-proj-abcdefghijklmnopqrstuvwxyz1234567890abcdef as your key',
      'Anthropic: sk-ant-api03-aabbccddeeffgghhiijjkk1122334455',
      'Google AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'gh ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd',
      'slack xoxb-1234567890-abcdefghijklmnopqrstuvwx',
    ];
    for (const input of inputs) {
      const out = redactSecrets(input);
      assert.match(out, /<redacted>/, `expected mask in: ${out}`);
      // Sanity: the original raw token should not survive verbatim
      assert.doesNotMatch(out, /sk-proj-abcdefghijklmn/);
      assert.doesNotMatch(out, /sk-ant-api03-aabbccdd/);
      assert.doesNotMatch(out, /AIzaSyDxxxxxxxxx/);
      assert.doesNotMatch(out, /ghp_abcdefghij/);
      assert.doesNotMatch(out, /xoxb-1234567890-abcdef/);
    }
  });

  it('masks long high-entropy hex/base64 strings (40+ chars) as catch-all', () => {
    const hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const out = redactSecrets(`hash=${hash}`);
    assert.match(out, /hash=<redacted>/);
    assert.doesNotMatch(out, /deadbeefdeadbeefdeadbeef/);
  });

  it('leaves plain text untouched', () => {
    const inputs = [
      'Connection refused',
      'Request timed out',
      'Provider unavailable',
      'Authentication failed',
      'Permission denied for /tmp/file.txt',
    ];
    for (const input of inputs) {
      assert.equal(redactSecrets(input), input);
    }
  });

  it('is safe on empty / undefined-like input', () => {
    assert.equal(redactSecrets(''), '');
  });
});
