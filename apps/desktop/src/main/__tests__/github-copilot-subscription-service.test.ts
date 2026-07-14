import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GitHubCopilotSubscriptionService } from '../oauth/github-copilot-subscription-service.js';

describe('GitHubCopilotSubscriptionService', () => {
  test('imports a supported existing gh login into the shared OAuth credential lifecycle', async () => {
    let stored: string | null = null;
    let exchangeAuthorization = '';
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => { stored = value; },
        deleteSecret: async () => { stored = null; },
      },
      resolveGitHubToken: async () => 'gho_existing_login\n',
      fetchFn: async (_url, init) => {
        exchangeAuthorization = new Headers(init?.headers).get('authorization') ?? '';
        return Response.json({
          token: 'short-lived-copilot-token',
          expires_at: 456,
          endpoints: { api: 'https://api.business.githubcopilot.com' },
        });
      },
    });

    assert.deepEqual(await service.connectExistingLogin(), { ok: true });
    assert.equal(exchangeAuthorization, 'token gho_existing_login');
    assert.deepEqual(JSON.parse(stored ?? ''), {
      access_token: 'short-lived-copilot-token',
      refresh_token: 'gho_existing_login',
      expires_at: 456_000,
      token_type: 'Bearer',
      base_url: 'https://api.business.githubcopilot.com',
    });
    assert.deepEqual(await service.getAccountState(), {
      provider: 'github-copilot',
      runtimeState: 'authenticated',
    });
  });

  test('rejects classic PATs before any Copilot exchange request', async () => {
    let exchanged = false;
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: memoryCredentialStore(),
      resolveGitHubToken: async () => 'ghp_classic_pat',
      fetchFn: async () => {
        exchanged = true;
        return Response.json({});
      },
    });

    const result = await service.connectExistingLogin();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'token_exchange_failed');
      assert.match(result.message, /不支持 classic PAT/);
      assert.equal(result.message.includes('ghp_classic_pat'), false);
    }
    assert.equal(exchanged, false);
  });

  test('refreshes and logs out through the same store without exposing either token in state', async () => {
    let stored: string | null = JSON.stringify({
      access_token: 'expired-token',
      refresh_token: 'github_pat_supported',
      expires_at: 1,
      base_url: 'https://api.githubcopilot.com',
    });
    const service = new GitHubCopilotSubscriptionService({
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => { stored = value; },
        deleteSecret: async () => { stored = null; },
      },
      now: () => 10_000,
      fetchFn: async () => Response.json({
        token: 'refreshed-token',
        expires_at: 456,
        endpoints: { api: 'https://api.individual.githubcopilot.com' },
      }),
    });

    assert.deepEqual(await service.refreshTokens(), { ok: true });
    const state = await service.getAccountState();
    assert.deepEqual(state, { provider: 'github-copilot', runtimeState: 'authenticated' });
    assert.equal('access_token' in state, false);
    assert.equal('refresh_token' in state, false);
    assert.deepEqual(await service.logout(), { ok: true });
    assert.deepEqual(await service.getAccountState(), {
      provider: 'github-copilot',
      runtimeState: 'not_logged_in',
    });
  });
});

function memoryCredentialStore() {
  return {
    getSecret: async () => null,
    setSecret: async () => undefined,
    deleteSecret: async () => undefined,
  };
}
