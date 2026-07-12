/**
 * Static-analysis + unit tests for the Antigravity (Google /
 * Gemini) subscription OAuth service.
 *
 * We pin:
 *   - the loopback port (51121)
 *   - the `STATUS = 'preview'` marker
 *   - the fail-closed envelope when GOOGLE_CLIENT_ID is empty
 *     (the entire point of this preview service is that real
 *     calls must surface a clear, copy-paste-ready error so a
 *     future review catches an accidental enable).
 *
 * The tests import from `antigravity-subscription-helpers.ts`
 * directly so they don't pull in the `electron` ESM module —
 * the service class file imports `safeStorage` from electron,
 * which is unavailable under plain `node --test`.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import {
  ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE,
  ANTIGRAVITY_OAUTH_CONFIG,
  GOOGLE_CLIENT_ID,
  STATUS,
  buildAntigravityAuthorizationUrl,
} from '../oauth/antigravity-subscription-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SERVICE_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'main',
  'oauth',
  'antigravity-subscription-service.ts',
);
const HELPERS_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'main',
  'oauth',
  'antigravity-subscription-helpers.ts',
);

describe('Antigravity subscription preview config', () => {
  it('pins STATUS = preview and exports it for the contract scan', () => {
    assert.equal(STATUS, 'preview');
    assert.equal(ANTIGRAVITY_OAUTH_CONFIG.status, 'preview');
  });

  it('uses port 51121 for the loopback callback', () => {
    assert.equal(ANTIGRAVITY_OAUTH_CONFIG.callbackPort, 51121);
    assert.equal(
      ANTIGRAVITY_OAUTH_CONFIG.redirectUri,
      'http://localhost:51121/callback',
    );
  });

  it('targets Google OAuth endpoints', () => {
    assert.equal(
      ANTIGRAVITY_OAUTH_CONFIG.authUrl,
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    assert.equal(ANTIGRAVITY_OAUTH_CONFIG.tokenUrl, 'https://oauth2.googleapis.com/token');
  });

  it('marks itself as not configured because no Google client_id is bundled', () => {
    assert.equal(GOOGLE_CLIENT_ID, '');
    assert.equal(
      ANTIGRAVITY_OAUTH_CONFIG.hasClientId,
      false,
      'a future PR must explicitly flip GOOGLE_CLIENT_ID; CI should catch any silent fill-in',
    );
  });

  it('exposes a clear "needs Google client_id" envelope as a pure constant', () => {
    assert.equal(ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE.ok, false);
    assert.equal(ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE.reason, 'unknown');
    assert.match(
      ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE.message,
      /Google client_id/,
      'error copy must call out the missing client_id so the user knows why',
    );
  });

  it('built authorize URL carries access_type=offline + prompt=consent (standard Google PKCE)', () => {
    const url = new URL(
      buildAntigravityAuthorizationUrl({
        clientId: 'fixture-client',
        authorizeEndpoint: ANTIGRAVITY_OAUTH_CONFIG.authUrl,
        redirectUri: ANTIGRAVITY_OAUTH_CONFIG.redirectUri,
        scope: ANTIGRAVITY_OAUTH_CONFIG.scopes,
        state: 'pinned-state',
        challenge: 'pinned-challenge',
      }),
    );
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'pinned-state');
  });
});

describe('Antigravity service source-grep contract', () => {
  it('service file references the missing-client-id envelope from getAuthorizationUrl', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE/,
      'service must return the shared envelope when GOOGLE_CLIENT_ID is empty',
    );
    // The check itself must live next to getAuthorizationUrl.
    const match = src.match(/async getAuthorizationUrl\(\)[\s\S]{0,400}/);
    assert.ok(match, 'getAuthorizationUrl must exist');
    assert.match(
      match[0],
      /GOOGLE_CLIENT_ID/,
      'getAuthorizationUrl must early-return based on GOOGLE_CLIENT_ID',
    );
  });

  it('declares the safeStorage-encrypted token path under userData', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /\.antigravity_subscription_token/,
      'token file path must mirror the Claude / Codex pattern',
    );
    assert.match(src, /safeStorage\.encryptString/, 'tokens must be encrypted via safeStorage');
    assert.match(src, /mode:\s*0o600/, 'persisted token file must be written with mode 0o600');
  });

  it('exports the preview status constant for the renderer-side scan', async () => {
    const src = await readFile(HELPERS_SOURCE, 'utf8');
    assert.match(src, /export const STATUS = 'preview' as const;/);
  });

  it('marks Google-specific calls as spec-only in the comment block', async () => {
    const src = await readFile(HELPERS_SOURCE, 'utf8');
    assert.match(
      src,
      /spec-only/i,
      'antigravity helpers must call out that endpoint values come from the docs spec, not from a working upstream plugin source',
    );
  });

  it('uses globalThis.fetch by default so Electron session proxy applies', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(src, /globalThis\.fetch/);
  });
});
