import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createGitHubCopilotAccountTokens,
  parseOAuthSubscriptionTokens,
  resolveOAuthSubscriptionTokens,
} from '../subscription-credentials.js';

describe('GitHub Copilot subscription credentials', () => {
  test('preserves the account-scoped API endpoint in the existing OAuth token record', () => {
    assert.deepEqual(parseOAuthSubscriptionTokens(JSON.stringify({
      access_token: 'copilot-token',
      refresh_token: 'github-account-token',
      expires_at: 123_000,
      base_url: 'https://api.business.githubcopilot.com',
    })), {
      access_token: 'copilot-token',
      refresh_token: 'github-account-token',
      expires_at: 123_000,
      base_url: 'https://api.business.githubcopilot.com',
    });
  });

  test('stores one direct Copilot-capable GitHub token in the shared OAuth record', () => {
    const tokens = createGitHubCopilotAccountTokens('github-account-token');

    assert.deepEqual(tokens, {
      access_token: 'github-account-token',
      refresh_token: 'github-account-token',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
  });

  test('resolves the durable direct token without calling the retired exchange endpoint', async () => {
    const stored = JSON.stringify({
      access_token: 'github-account-token',
      refresh_token: 'github-account-token',
      expires_at: Number.MAX_SAFE_INTEGER,
      base_url: 'https://api.githubcopilot.com',
    });
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'github-copilot',
      slug: 'github-copilot',
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async () => assert.fail('durable GitHub tokens do not refresh through a token exchange'),
      },
      now: () => 10_000,
      fetchFn: async () => assert.fail('the retired token exchange must not be called'),
    });

    assert.equal(tokens?.access_token, 'github-account-token');
    assert.equal(tokens?.refresh_token, 'github-account-token');
    assert.equal(tokens?.base_url, 'https://api.githubcopilot.com');
  });
});

describe('OAuth refresh response validation', () => {
  const nearExpiryStored = JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: 1_000, // already past `now` below → refresh path runs
  });

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  for (const [name, body] of [
    ['empty object', {}],
    ['empty access token', { access_token: '', expires_in: 3600 }],
    ['missing expiry', { access_token: 'new-access' }],
    ['non-numeric expiry', { access_token: 'new-access', expires_in: 'soon' }],
    ['non-positive expiry', { access_token: 'new-access', expires_in: 0 }],
  ] as const) {
    test(`a 200 refresh with ${name} never replaces the stored token`, async () => {
      const writes: string[] = [];
      const tokens = await resolveOAuthSubscriptionTokens({
        providerType: 'claude-subscription',
        slug: 'claude-subscription',
        credentialStore: {
          getSecret: async () => nearExpiryStored,
          setSecret: async (_slug, _kind, value) => {
            writes.push(value);
          },
        },
        now: () => 10_000_000,
        fetchFn: async () => okResponse(body),
      });

      assert.equal(tokens, null, 'an invalid refresh payload must surface as a refresh failure');
      assert.deepEqual(writes, [], 'the still-working stored record must not be overwritten with garbage');
    });
  }

  test('a rotated refresh token that is an empty string keeps the previous refresh token', async () => {
    const writes: string[] = [];
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'claude-subscription',
      slug: 'claude-subscription',
      credentialStore: {
        getSecret: async () => nearExpiryStored,
        setSecret: async (_slug, _kind, value) => {
          writes.push(value);
        },
      },
      now: () => 10_000_000,
      fetchFn: async () => okResponse({ access_token: 'new-access', refresh_token: '', expires_in: 3600 }),
    });

    assert.equal(tokens?.access_token, 'new-access');
    assert.equal(tokens?.refresh_token, 'old-refresh');
    assert.equal(writes.length, 1);
  });
});
