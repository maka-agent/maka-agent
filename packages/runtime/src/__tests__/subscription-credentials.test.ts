import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  exchangeGitHubCopilotToken,
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

  test('exchanges an existing GitHub login without putting it in the URL or body', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const tokens = await exchangeGitHubCopilotToken({
      githubToken: 'github-account-token',
      fetchFn: async (url, init) => {
        requestedUrl = String(url);
        requestedInit = init;
        return Response.json({
          token: 'short-lived-copilot-token',
          expires_at: 456,
          endpoints: { api: 'https://api.business.githubcopilot.com' },
        });
      },
    });

    assert.equal(requestedUrl, 'https://api.github.com/copilot_internal/v2/token');
    assert.equal(requestedInit?.method, 'GET');
    assert.equal(new Headers(requestedInit?.headers).get('authorization'), 'token github-account-token');
    assert.equal(requestedInit?.body, undefined);
    assert.deepEqual(tokens, {
      access_token: 'short-lived-copilot-token',
      refresh_token: 'github-account-token',
      expires_at: 456_000,
      token_type: 'Bearer',
      base_url: 'https://api.business.githubcopilot.com',
    });
  });

  test('rejects an account endpoint outside GitHub-owned Copilot hosts', async () => {
    await assert.rejects(exchangeGitHubCopilotToken({
      githubToken: 'github-account-token',
      fetchFn: async () => Response.json({
        token: 'short-lived-copilot-token',
        expires_at: 456,
        endpoints: { api: 'https://copilot-token.example.com' },
      }),
    }), /untrusted GitHub Copilot API endpoint/);
  });

  test('refreshes through the same OAuth credential lifecycle and preserves the GitHub account token', async () => {
    let stored = JSON.stringify({
      access_token: 'expired-copilot-token',
      refresh_token: 'github-account-token',
      expires_at: 1_000,
      base_url: 'https://api.githubcopilot.com',
    });
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'github-copilot',
      slug: 'github-copilot',
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => { stored = value; },
      },
      now: () => 10_000,
      fetchFn: async () => Response.json({
        token: 'fresh-copilot-token',
        expires_at: 456,
        endpoints: { api: 'https://api.individual.githubcopilot.com' },
      }),
    });

    assert.equal(tokens?.access_token, 'fresh-copilot-token');
    assert.equal(tokens?.refresh_token, 'github-account-token');
    assert.equal(tokens?.base_url, 'https://api.individual.githubcopilot.com');
    assert.deepEqual(JSON.parse(stored), tokens);
  });
});
