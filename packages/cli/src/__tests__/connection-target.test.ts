import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { resolveDefaultSessionTarget } from '../connection-target.js';

describe('default session target resolver', () => {
  test('uses the default ready connection and requested model', async () => {
    const connection = makeConnection({
      slug: 'local',
      providerType: 'ollama',
      defaultModel: 'qwen2.5-coder',
      models: [{ id: 'qwen2.5-coder' }, { id: 'llama3.2' }],
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'local',
        get: async (slug) => slug === 'local' ? connection : null,
      },
      credentialStore: {
        getSecret: async () => null,
      },
      requestedModel: 'llama3.2',
    });

    assert.equal(target.connection.slug, 'local');
    assert.equal(target.apiKey, '');
    assert.equal(target.model, 'llama3.2');
  });

  test('uses a stored subscription access token for OAuth default connections', async () => {
    const connection = makeConnection({
      slug: 'codex-subscription',
      providerType: 'codex-subscription',
      defaultModel: 'gpt-5.5',
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'codex-subscription',
        get: async (slug) => slug === 'codex-subscription' ? connection : null,
      },
      credentialStore: {
        getSecret: async () => JSON.stringify({
          access_token: 'oauth-access-token',
          refresh_token: 'oauth-refresh-token',
          expires_at: Date.now() + 10 * 60_000,
          account_id: 'acct_123',
        }),
      },
    });

    assert.equal(target.connection.slug, 'codex-subscription');
    assert.equal(target.apiKey, 'oauth-access-token');
    assert.equal(target.model, 'gpt-5.5');
  });

  test('refreshes an expired OAuth subscription token before selecting the default target', async () => {
    const connection = makeConnection({
      slug: 'codex-subscription',
      providerType: 'codex-subscription',
      defaultModel: 'gpt-5.5',
    });
    let stored = JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: 1_000,
      account_id: 'acct_123',
    });
    let refreshBody = '';

    const target = await resolveDefaultSessionTarget({
      connectionStore: {
        getDefault: async () => 'codex-subscription',
        get: async (slug) => slug === 'codex-subscription' ? connection : null,
      },
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => {
          stored = value;
        },
      },
      now: () => 10_000,
      fetchFn: async (_url, init) => {
        refreshBody = String(init?.body ?? '');
        return Response.json({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        });
      },
    });

    assert.equal(target.apiKey, 'fresh-access-token');
    assert.match(refreshBody, /grant_type=refresh_token/);
    assert.match(refreshBody, /refresh_token=oauth-refresh-token/);
    assert.equal(JSON.parse(stored).access_token, 'fresh-access-token');
  });

  test('rejects unusable OAuth subscription credentials instead of using the raw secret as an API key', async () => {
    const connection = makeConnection({
      slug: 'codex-subscription',
      providerType: 'codex-subscription',
      defaultModel: 'gpt-5.5',
    });
    const expiredToken = JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: 1_000,
      account_id: 'acct_123',
    });

    for (const secret of ['not-json', expiredToken]) {
      await assert.rejects(
        resolveDefaultSessionTarget({
          connectionStore: {
            getDefault: async () => 'codex-subscription',
            get: async (slug) => slug === 'codex-subscription' ? connection : null,
          },
          credentialStore: {
            getSecret: async () => secret,
            setSecret: async () => {
              throw new Error('refresh should fail before storing');
            },
          },
          now: () => 10_000,
          fetchFn: async () => new Response('refresh failed', { status: 500 }),
        }),
        /NO_REAL_CONNECTION:missing_api_key/,
      );
    }
  });

  test('fails before session creation when no default connection exists', async () => {
    await assert.rejects(
      resolveDefaultSessionTarget({
        connectionStore: {
          getDefault: async () => null,
          get: async () => null,
        },
        credentialStore: {
          getSecret: async () => null,
        },
      }),
      /NO_REAL_CONNECTION:missing_default_connection/,
    );
  });
});

function makeConnection(input: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'conn',
    name: 'Connection',
    providerType: 'ollama',
    defaultModel: 'llama3.2',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}
