/**
 * Static-analysis + unit tests for the OpenAI Codex subscription
 * OAuth service (PR-MODEL-OAUTH-ALL-0).
 *
 * Pins the params (clientId, scopes, extras, redirect URI, PKCE
 * shape) to the upstream openai-codex-auth values, plus the JWT
 * account-id extraction.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  CODEX_OAUTH_CONFIG,
  buildCodexAuthorizationUrl,
  extractAccountClaims,
  pkceChallengeFromVerifier,
} from '../oauth/openai-codex-helpers.js';
import { base64urlEncode } from '@maka/core';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SERVICE_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'main',
  'oauth',
  'openai-codex-service.ts',
);
const HELPERS_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'main',
  'oauth',
  'openai-codex-helpers.ts',
);

describe('Codex subscription OAuth config (upstream openai-codex-auth pattern)', () => {
  it('pins clientId, endpoints, redirect URI, scopes and extras', () => {
    assert.equal(CODEX_OAUTH_CONFIG.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(CODEX_OAUTH_CONFIG.authUrl, 'https://auth.openai.com/oauth/authorize');
    assert.equal(CODEX_OAUTH_CONFIG.tokenUrl, 'https://auth.openai.com/oauth/token');
    assert.equal(CODEX_OAUTH_CONFIG.redirectUri, 'http://localhost:1455/auth/callback');
    assert.equal(CODEX_OAUTH_CONFIG.scopes, 'openid profile email offline_access');
    assert.equal(CODEX_OAUTH_CONFIG.callbackPort, 1455);
    const extrasMap = new Map(CODEX_OAUTH_CONFIG.extras);
    assert.equal(extrasMap.get('codex_cli_simplified_flow'), 'true');
    assert.equal(extrasMap.get('originator'), 'codex_cli_rs');
  });

  it('built authorize URL includes every required parameter', () => {
    const url = new URL(
      buildCodexAuthorizationUrl({
        clientId: CODEX_OAUTH_CONFIG.clientId,
        authorizeEndpoint: CODEX_OAUTH_CONFIG.authUrl,
        redirectUri: CODEX_OAUTH_CONFIG.redirectUri,
        scope: CODEX_OAUTH_CONFIG.scopes,
        state: 'pinned-state',
        challenge: 'pinned-challenge',
        extras: CODEX_OAUTH_CONFIG.extras,
      }),
    );
    assert.equal(url.origin + url.pathname, CODEX_OAUTH_CONFIG.authUrl);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), CODEX_OAUTH_CONFIG.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), CODEX_OAUTH_CONFIG.redirectUri);
    assert.equal(url.searchParams.get('scope'), CODEX_OAUTH_CONFIG.scopes);
    assert.equal(url.searchParams.get('code_challenge'), 'pinned-challenge');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'pinned-state');
    assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
    assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
  });

  it('PKCE challenge matches the standard S256 transform (RFC 7636 §4.2)', () => {
    const verifier = 'fixed-pkce-verifier-1234567890';
    const got = pkceChallengeFromVerifier(verifier);
    const expected = base64urlEncode(
      new Uint8Array(createHash('sha256').update(verifier, 'utf8').digest()),
    );
    assert.equal(got, expected);
    // The expected value should be base64url (no padding, only A-Za-z0-9_-).
    assert.match(got, /^[A-Za-z0-9_-]+$/);
  });
});

describe('Codex JWT account-id extraction', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none' })));
    const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    return `${header}.${body}.signature`;
  }

  it('reads the OpenAI-specific chatgpt_account_id claim from the access token', () => {
    const token = makeJwt({
      sub: 'fallback-sub',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_pinned' },
    });
    const claims = extractAccountClaims(token);
    assert.equal(claims.accountId, 'acct_pinned');
  });

  it('falls back to sub when the chatgpt_account_id claim is missing', () => {
    const token = makeJwt({ sub: 'fallback-sub-only' });
    const claims = extractAccountClaims(token);
    assert.equal(claims.accountId, 'fallback-sub-only');
  });

  it('extracts email + plan from the access token when present', () => {
    const token = makeJwt({
      sub: 'sub-1',
      email: 'user@example.test',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_x',
        chatgpt_plan_type: 'plus',
      },
    });
    const claims = extractAccountClaims(token);
    assert.equal(claims.email, 'user@example.test');
    assert.equal(claims.plan, 'plus');
    assert.equal(claims.accountId, 'acct_x');
  });

  it('fills picture + email from id_token when access token does not carry them', () => {
    const access = makeJwt({ sub: 'sub-2' });
    const id = makeJwt({
      picture: 'https://example.test/avatar.png',
      email: 'fill@example.test',
    });
    const claims = extractAccountClaims(access, id);
    assert.equal(claims.picture, 'https://example.test/avatar.png');
    assert.equal(claims.email, 'fill@example.test');
    assert.equal(claims.accountId, 'sub-2');
  });

  it('prefers ChatGPT organization/account claims over JWT sub for backend account routing', () => {
    const access = makeJwt({ sub: 'sub-not-chatgpt-account' });
    const id = makeJwt({
      sub: 'id-sub-not-chatgpt-account',
      organizations: [{ id: 'org_chatgpt_account' }],
    });
    const claims = extractAccountClaims(access, id);
    assert.equal(claims.accountId, 'org_chatgpt_account');
  });

  it('throws when neither token contains an account id', () => {
    const access = makeJwt({});
    assert.throws(() => extractAccountClaims(access), /account ID/i);
  });
});

describe('Codex service source-grep contract', () => {
  it('persists tokens through the shared credential store, not safeStorage (#1125)', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /saveSharedOAuthTokens\(this\.credentialStore, 'codex-subscription'/,
      'tokens must be written to the shared CredentialStore (the cross-surface authority)',
    );
    assert.doesNotMatch(
      src,
      /encryptString|decryptString|isEncryptionAvailable/,
      'no safeStorage-encrypted token path may remain',
    );
  });

  it('uses globalThis.fetch by default so Electron session proxy applies', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(src, /globalThis\.fetch/);
  });

  it('does not expose tokens through the `getAccountState` return object', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    const match = src.match(/async getAccountState\(\)[\s\S]*?\n {2}\}/);
    assert.ok(match, 'getAccountState must exist');
    const body = match[0];
    // The return objects (there are two — early not_logged_in and
    // the authenticated one) must not include any token field.
    const returns = [...body.matchAll(/return\s*\{[\s\S]*?\n\s*\};/g)].map((m) => m[0]);
    assert.ok(returns.length >= 1, 'must have at least one return literal');
    for (const ret of returns) {
      assert.doesNotMatch(
        ret,
        /(access_token|refresh_token|id_token)\s*:/,
        'getAccountState return objects must not include token fields',
      );
    }
  });

  it('exports isOpenAiCodexExperimentalEnabled tied to the env flag', async () => {
    const helpersSrc = await readFile(HELPERS_SOURCE, 'utf8');
    assert.match(helpersSrc, /export function isOpenAiCodexExperimentalEnabled\(\)/);
    assert.match(helpersSrc, /MAKA_CODEX_SUBSCRIPTION_EXPERIMENTAL/);
    const serviceSrc = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      serviceSrc,
      /isOpenAiCodexExperimentalEnabled/,
      'service must re-export the flag so main.ts can import from a single path',
    );
  });
});
