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
 * The service receives its Electron-only URL opener as a dependency,
 * so the preview's public behavior can run under plain `node --test`.
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
import { AntigravitySubscriptionService } from '../oauth/antigravity-subscription-service.js';

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
describe('Antigravity subscription preview config', () => {
  it('stays in preview status', () => {
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

describe('Antigravity service contract', () => {
  it('fails closed through the public authorization API when no Google client_id is bundled', async () => {
    const service = new AntigravitySubscriptionService({
      userDataDir: '/unused',
      openExternal: async () => undefined,
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async () => {},
      },
    });

    assert.deepEqual(
      await service.getAuthorizationUrl(),
      ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE,
    );
  });

  it('uses globalThis.fetch by default so Electron session proxy applies', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(src, /globalThis\.fetch/);
  });
});
