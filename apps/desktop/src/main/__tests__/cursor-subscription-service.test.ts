/**
 * Static-analysis + unit tests for the Cursor subscription OAuth
 * service (PR-MODEL-OAUTH-ALL-0).
 *
 * Pins the login URL params, poll URL shape and refresh URL to
 * the upstream cursor-auth values.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  CURSOR_OAUTH_CONFIG,
  buildCursorLoginUrl,
  getTokenExpiry,
  pkceChallengeFromVerifier,
} from '../oauth/cursor-subscription-helpers.js';
import { base64urlEncode } from '@maka/core';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SERVICE_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'main',
  'oauth',
  'cursor-subscription-service.ts',
);
const HELPERS_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'main',
  'oauth',
  'cursor-subscription-helpers.ts',
);

describe('Cursor subscription OAuth config (upstream cursor-auth pattern)', () => {
  it('pins login / poll / refresh URLs to upstream cursor-auth values', () => {
    assert.equal(CURSOR_OAUTH_CONFIG.loginUrl, 'https://cursor.com/loginDeepControl');
    assert.equal(CURSOR_OAUTH_CONFIG.pollUrl, 'https://api2.cursor.sh/auth/poll');
    assert.equal(
      CURSOR_OAUTH_CONFIG.refreshUrl,
      'https://api2.cursor.sh/auth/exchange_user_api_key',
    );
  });

  it('mirrors upstream poll cadence: 1s baseline, 1.2x backoff, 10s cap, 150 attempts', () => {
    assert.equal(CURSOR_OAUTH_CONFIG.pollBaseDelayMs, 1000);
    assert.equal(CURSOR_OAUTH_CONFIG.pollMaxDelayMs, 10_000);
    assert.equal(CURSOR_OAUTH_CONFIG.pollBackoffMultiplier, 1.2);
    assert.equal(CURSOR_OAUTH_CONFIG.pollMaxAttempts, 150);
  });

  it('built login URL includes challenge, uuid, mode=login, redirectTarget=cli', () => {
    const url = new URL(
      buildCursorLoginUrl({
        loginUrl: CURSOR_OAUTH_CONFIG.loginUrl,
        challenge: 'pinned-challenge',
        uuid: 'pinned-uuid',
      }),
    );
    assert.equal(url.origin + url.pathname, CURSOR_OAUTH_CONFIG.loginUrl);
    assert.equal(url.searchParams.get('challenge'), 'pinned-challenge');
    assert.equal(url.searchParams.get('uuid'), 'pinned-uuid');
    assert.equal(url.searchParams.get('mode'), 'login');
    assert.equal(url.searchParams.get('redirectTarget'), 'cli');
  });

  it('PKCE challenge is base64url(SHA256(verifier))', () => {
    const verifier = 'fixed-cursor-verifier-7890';
    const got = pkceChallengeFromVerifier(verifier);
    const expected = base64urlEncode(
      new Uint8Array(createHash('sha256').update(verifier, 'utf8').digest()),
    );
    assert.equal(got, expected);
    assert.match(got, /^[A-Za-z0-9_-]+$/);
  });

  it('getTokenExpiry returns exp - 5 min when JWT has an exp claim', () => {
    // exp is in seconds; bake a future timestamp 1 hour out.
    const now = 1_700_000_000_000;
    const futureExpSeconds = Math.floor(now / 1000) + 3600;
    const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256' })));
    const payload = base64urlEncode(
      new TextEncoder().encode(JSON.stringify({ exp: futureExpSeconds })),
    );
    const token = `${header}.${payload}.sig`;
    const expiry = getTokenExpiry(token, now);
    assert.equal(expiry, futureExpSeconds * 1000 - 5 * 60 * 1000);
  });

  it('getTokenExpiry falls back to now + 1h when JWT is malformed', () => {
    const now = 1_700_000_000_000;
    const expiry = getTokenExpiry('not-a-jwt', now);
    assert.equal(expiry, now + 3600 * 1000);
  });
});

describe('Cursor service source-grep contract', () => {
  it('persists tokens through the shared credential store, not safeStorage (#1125)', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /saveSharedOAuthTokens\(this\.credentialStore, 'cursor-subscription'/,
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

  it('poll request hits api2.cursor.sh/auth/poll with uuid + verifier query', async () => {
    const serviceSrc = await readFile(SERVICE_SOURCE, 'utf8');
    const helpersSrc = await readFile(HELPERS_SOURCE, 'utf8');
    assert.match(serviceSrc, /CURSOR_POLL_URL/, 'poll URL constant must be referenced in the loop');
    assert.match(
      helpersSrc,
      /api2\.cursor\.sh\/auth\/poll/,
      'poll URL literal must exactly match upstream cursor-auth (in helpers config)',
    );
    assert.match(
      serviceSrc,
      /uuid=\$\{[^}]+\}&verifier=\$\{[^}]+\}/,
      'poll URL must carry uuid + verifier query params',
    );
  });

  it('refresh request hits api2.cursor.sh/auth/exchange_user_api_key', async () => {
    const serviceSrc = await readFile(SERVICE_SOURCE, 'utf8');
    const helpersSrc = await readFile(HELPERS_SOURCE, 'utf8');
    assert.match(
      helpersSrc,
      /api2\.cursor\.sh\/auth\/exchange_user_api_key/,
      'refresh URL literal must exactly match upstream cursor-auth (in helpers config)',
    );
    assert.match(serviceSrc, /Authorization:\s*`Bearer/, 'refresh must send Bearer auth');
  });

  it('does not expose tokens through the `getAccountState` return object', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    const match = src.match(/async getAccountState\(\)[\s\S]*?\n {2}\}/);
    assert.ok(match, 'getAccountState must exist');
    const body = match[0];
    const returns = [...body.matchAll(/return\s*\{[\s\S]*?\n\s*\};/g)].map((m) => m[0]);
    assert.ok(returns.length >= 1, 'must have at least one return literal');
    for (const ret of returns) {
      assert.doesNotMatch(
        ret,
        /(access_token|refresh_token)\s*:/,
        'getAccountState return objects must not include token fields',
      );
    }
  });

  it('exports isCursorSubscriptionExperimentalEnabled tied to the env flag', async () => {
    const helpersSrc = await readFile(HELPERS_SOURCE, 'utf8');
    assert.match(helpersSrc, /export function isCursorSubscriptionExperimentalEnabled\(\)/);
    assert.match(helpersSrc, /MAKA_CURSOR_SUBSCRIPTION_EXPERIMENTAL/);
    const serviceSrc = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      serviceSrc,
      /isCursorSubscriptionExperimentalEnabled/,
      'service must re-export the flag so main.ts can import from a single path',
    );
  });
});
