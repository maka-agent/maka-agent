/**
 * Tests for the OAuth subscription core helpers (PR-OAUTH-SUBSCRIPTION-0).
 *
 * Anchor: `packages/core/src/oauth-subscription.ts`.
 * Historical gate: `docs/archive/pr-oauth-subscription-0-gate.md`.
 *
 * These tests are pure (no DOM, no fetch, no fs) so they live in
 * @maka/core's test suite.
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  QUOTA_CACHE_TTL_MS,
  TOKEN_REFRESH_SKEW_MS,
  base64urlEncode,
  buildClaudeAuthorizationUrl,
  constantTimeStringEqual,
  parsePastedAuthorization,
  pkceCodeChallenge,
  type ClaudeAuthorizationConfig,
  type Sha256Digest,
} from '../oauth-subscription.js';

// Test SHA-256 implementation backed by Node crypto. The helper
// itself is implementation-agnostic; production code will inject
// the same Node crypto from `@maka/desktop`'s main process.
const nodeSha256: Sha256Digest = {
  digest(input: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(input, 'utf8').digest());
  },
};

describe('base64urlEncode (RFC 4648 §5)', () => {
  it('returns empty string for empty input', () => {
    assert.equal(base64urlEncode(new Uint8Array([])), '');
  });

  it('removes padding and substitutes + → -, / → _', () => {
    // Bytes `0xfb, 0xff, 0xbf` standard-base64-encode to `+/+/`
    // which becomes `-_-_` in URL-safe encoding.
    assert.equal(base64urlEncode(new Uint8Array([0xfb, 0xff, 0xbf])), '-_-_');
  });

  it('matches Node Buffer.toString("base64url") on random input', () => {
    for (let i = 0; i < 16; i++) {
      const bytes = new Uint8Array(32);
      for (let j = 0; j < bytes.length; j++) {
        bytes[j] = Math.floor(Math.random() * 256);
      }
      const expected = Buffer.from(bytes).toString('base64url');
      assert.equal(base64urlEncode(bytes), expected, 'random round-trip mismatch');
    }
  });
});

describe('pkceCodeChallenge (RFC 7636 §4.2)', () => {
  it('produces base64url(SHA256(verifier))', () => {
    // Vector from RFC 7636 §B (the official PKCE example).
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    // RFC's example computes the challenge as the URL-safe base64
    // of the SHA-256 of the verifier bytes (ASCII).
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    assert.equal(pkceCodeChallenge(verifier, nodeSha256), expected);
  });

  it('is deterministic for the same verifier', () => {
    const verifier = 'test-verifier-with-some-length-just-fine';
    const a = pkceCodeChallenge(verifier, nodeSha256);
    const b = pkceCodeChallenge(verifier, nodeSha256);
    assert.equal(a, b);
  });
});

describe('buildClaudeAuthorizationUrl', () => {
  const config: ClaudeAuthorizationConfig = {
    clientId: 'test-client-id',
    authorizeEndpoint: 'https://claude.com/cai/oauth/authorize',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    scope: 'user:sessions:claude_code user:mcp_servers user:file_upload',
  };

  it('emits all required PKCE + OAuth params', () => {
    const verifier = 'verifier_with_safe_chars_only_42';
    const state = 'state_value_safe';
    const url = new URL(buildClaudeAuthorizationUrl(config, verifier, state, nodeSha256));

    assert.equal(url.origin + url.pathname, config.authorizeEndpoint);
    assert.equal(url.searchParams.get('client_id'), config.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
    assert.equal(url.searchParams.get('scope'), config.scope);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), state);
    assert.equal(url.searchParams.get('code_challenge'), pkceCodeChallenge(verifier, nodeSha256));
    assert.equal(url.searchParams.get('code'), 'true');
  });

  it('throws when client_id is empty', () => {
    assert.throws(
      () => buildClaudeAuthorizationUrl({ ...config, clientId: '' }, 'v', 's', nodeSha256),
      /clientId/,
    );
  });

  it('throws when verifier is empty', () => {
    assert.throws(() => buildClaudeAuthorizationUrl(config, '', 's', nodeSha256), /verifier/);
  });

  it('throws when state is empty', () => {
    assert.throws(() => buildClaudeAuthorizationUrl(config, 'v', '', nodeSha256), /state/);
  });
});

describe('parsePastedAuthorization (xuan G-X2 strict shape)', () => {
  it('parses `code#state` happy path', () => {
    const result = parsePastedAuthorization('abc_123-XYZ#state_value-42');
    assert.deepEqual(result, { code: 'abc_123-XYZ', state: 'state_value-42' });
  });

  it('trims surrounding whitespace and newlines', () => {
    const result = parsePastedAuthorization('  \n  abc#xyz  \n');
    assert.deepEqual(result, { code: 'abc', state: 'xyz' });
  });

  it('returns null for non-string input', () => {
    assert.equal(parsePastedAuthorization(null), null);
    assert.equal(parsePastedAuthorization(undefined), null);
    assert.equal(parsePastedAuthorization(42), null);
    assert.equal(parsePastedAuthorization({ code: 'x', state: 'y' }), null);
  });

  it('returns null for empty / whitespace-only input', () => {
    assert.equal(parsePastedAuthorization(''), null);
    assert.equal(parsePastedAuthorization('   '), null);
    assert.equal(parsePastedAuthorization('\n\n'), null);
  });

  it('returns null when missing # separator', () => {
    assert.equal(parsePastedAuthorization('abc'), null);
    assert.equal(parsePastedAuthorization('abcxyz'), null);
  });

  it('returns null when # is at start or end', () => {
    assert.equal(parsePastedAuthorization('#xyz'), null);
    assert.equal(parsePastedAuthorization('abc#'), null);
  });

  it('returns null when either side has non-base64url chars', () => {
    assert.equal(parsePastedAuthorization('abc!#xyz'), null);
    assert.equal(parsePastedAuthorization('abc#xy z'), null);
    assert.equal(parsePastedAuthorization('abc#xyz/'), null);
    // Periods are NOT in base64url alphabet (only `-` and `_`).
    assert.equal(parsePastedAuthorization('abc.123#xyz'), null);
  });

  it('uses the FIRST # as separator (caller built it that way)', () => {
    // Anthropic's redirect format is `<code>#<state>`; if the user
    // pasted a string with multiple `#`, we treat the rest as part
    // of state. We REJECT this case because the state side must
    // pass the base64url check, which `#` violates.
    assert.equal(parsePastedAuthorization('abc#xy#z'), null);
  });
});

describe('constantTimeStringEqual (xuan G-X1 timing defense)', () => {
  it('returns true for identical strings', () => {
    assert.equal(constantTimeStringEqual('abc', 'abc'), true);
    assert.equal(constantTimeStringEqual('', ''), true);
  });

  it('returns false for length mismatch', () => {
    assert.equal(constantTimeStringEqual('abc', 'abcd'), false);
    assert.equal(constantTimeStringEqual('abc', 'ab'), false);
  });

  it('returns false for any byte mismatch', () => {
    assert.equal(constantTimeStringEqual('abc', 'abd'), false);
    assert.equal(constantTimeStringEqual('xbc', 'abc'), false);
  });

  it('handles unicode (still character-by-character)', () => {
    assert.equal(constantTimeStringEqual('你好', '你好'), true);
    assert.equal(constantTimeStringEqual('你好', '你他'), false);
  });
});

describe('PKCE_VERIFIER_LENGTH_BYTES configuration', () => {
  it('is 32 bytes (upstream parity + RFC 7636 §4.1 minimum)', () => {
    // 32 random bytes → base64url ~43 chars → falls in
    // RFC 7636's 43-128 char verifier range.
    assert.equal(PKCE_VERIFIER_LENGTH_BYTES, 32);
  });
});

describe('TTL / cache constants', () => {
  it('PENDING_AUTHORIZATION_TTL_MS is 10 minutes', () => {
    assert.equal(PENDING_AUTHORIZATION_TTL_MS, 10 * 60 * 1000);
  });

  it('TOKEN_REFRESH_SKEW_MS is 5 minutes (upstream parity)', () => {
    assert.equal(TOKEN_REFRESH_SKEW_MS, 5 * 60 * 1000);
  });

  it('QUOTA_CACHE_TTL_MS is 5 minutes', () => {
    assert.equal(QUOTA_CACHE_TTL_MS, 5 * 60 * 1000);
  });
});

describe('public types do NOT expose token-shaped fields (xuan G-X3 spirit)', () => {
  it('SubscriptionAccountState has no accessToken/refreshToken/idToken fields', () => {
    // We can't introspect types at runtime, but we can assert the
    // SOURCE of this file has been audited. Read the module and
    // check for forbidden identifiers. This complements the desktop-
    // side static-analysis test (claude-subscription-ipc-boundary).
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/__tests__/oauth-subscription.test.js → ../../src/oauth-subscription.ts
    const src = readFileSync(resolve(here, '..', '..', 'src', 'oauth-subscription.ts'), 'utf8');
    const forbidden = [
      'accessToken',
      'refreshToken',
      'idToken',
      'access_token',
      'refresh_token',
      'id_token',
    ];
    for (const needle of forbidden) {
      // Allow the string only inside the file's docstring justification.
      // Pragmatic check: count occurrences; if any is OUTSIDE a comment,
      // fail. For this PR (no token fields anywhere) any occurrence at
      // all should be in comments only — so we just confirm none appears
      // as an object-literal key (followed by `:` then a non-space type
      // term).
      const keyRegex = new RegExp(`\\b${needle}\\s*:`, 'g');
      const matches = src.match(keyRegex) ?? [];
      assert.equal(
        matches.length,
        0,
        `oauth-subscription.ts must not declare "${needle}" as a field — found ${matches.length} occurrence(s)`,
      );
    }
  });
});
