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
