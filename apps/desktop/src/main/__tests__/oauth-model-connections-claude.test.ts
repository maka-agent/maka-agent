import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROVIDER_DEFAULTS, type LlmConnection } from '@maka/core';
import {
  CLAUDE_SUBSCRIPTION_CONNECTION_SLUG,
  createOAuthModelConnectionsMainService,
} from '../oauth-model-connections-main.js';

function claudeService(seed: LlmConnection | null) {
  let saved = seed;
  const connectionStore = {
    get: async () => saved,
    list: async () => (saved ? [saved] : []),
    save: async (connection: LlmConnection) => {
      saved = connection;
      return connection;
    },
    update: async (_slug: string, patch: Partial<LlmConnection>) => {
      saved = { ...(saved as LlmConnection), ...patch };
      return saved;
    },
  };
  return createOAuthModelConnectionsMainService({
    connectionStore,
    credentialStore: { getSecret: async () => null },
    claudeSubscription: {
      getAccountState: async () => ({
        provider: 'claude-subscription',
        runtimeState: 'authenticated',
      }),
      getAccessTokenInternal: async () => 'claude-oauth-token',
    },
    openAiCodex: {} as never,
    githubCopilotSubscription: {} as never,
    xaiOAuth: {} as never,
  } as never);
}

function persistedConnection(patch: Partial<LlmConnection>): LlmConnection {
  return {
    slug: CLAUDE_SUBSCRIPTION_CONNECTION_SLUG,
    name: 'Claude OAuth',
    providerType: 'claude-subscription',
    baseUrl: PROVIDER_DEFAULTS['claude-subscription'].baseUrl,
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as LlmConnection;
}

describe('Claude subscription model connection synchronization', () => {
  // Discovery is fallback-only for this provider, so a snapshot persisted by an
  // older build is not evidence of anything the account still offers. Pinning it
  // hid newly curated models and, worse, made reconciliation drop them straight
  // back out of enabledModelIds — the user's selection silently reverted.
  test('rebuilds a stale persisted inventory from the current registry', async () => {
    const service = claudeService(
      persistedConnection({
        models: [
          { id: 'claude-sonnet-4-5-20250929' },
          { id: 'claude-opus-4-1-20250805' },
          { id: 'claude-haiku-4-5-20251001' },
        ],
        modelSource: 'fallback',
        enabledModelIds: ['claude-sonnet-4-5-20250929'],
      }),
    );

    const synchronized = await service.syncClaudeSubscriptionConnection();

    assert.deepEqual(
      synchronized?.models?.map(({ id }) => id),
      PROVIDER_DEFAULTS['claude-subscription'].fallbackModels,
    );
    assert.equal(synchronized?.modelSource, 'fallback');
  });

  test('keeps a newly enabled curated model across a sync', async () => {
    const service = claudeService(
      persistedConnection({
        models: [{ id: 'claude-sonnet-4-5-20250929' }, { id: 'claude-opus-4-1-20250805' }],
        modelSource: 'fallback',
        // What the settings sheet writes after the user picks claude-opus-5
        // from the catalog-backed list.
        enabledModelIds: ['claude-sonnet-4-5-20250929', 'claude-opus-5'],
      }),
    );

    const synchronized = await service.syncClaudeSubscriptionConnection();

    assert.ok(synchronized?.enabledModelIds?.includes('claude-opus-5'));
    assert.ok(synchronized?.enabledModelIds?.includes('claude-sonnet-4-5-20250929'));
  });

  test('repairs a default model the curated catalog has retired', async () => {
    const service = claudeService(
      persistedConnection({
        defaultModel: 'claude-opus-4-1-20250805',
        models: [{ id: 'claude-opus-4-1-20250805' }],
        modelSource: 'fallback',
        enabledModelIds: ['claude-opus-4-1-20250805'],
      }),
    );

    const synchronized = await service.syncClaudeSubscriptionConnection();

    const curated = PROVIDER_DEFAULTS['claude-subscription'].fallbackModels;
    assert.ok(curated.includes(synchronized?.defaultModel ?? ''));
    assert.ok(synchronized?.enabledModelIds?.includes(synchronized.defaultModel));
    assert.equal(synchronized?.enabledModelIds?.includes('claude-opus-4-1-20250805'), false);
  });
});
