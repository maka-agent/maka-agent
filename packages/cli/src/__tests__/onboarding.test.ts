import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, ModelInfo, ProviderType } from '@maka/core/llm-connections';
import type { ConnectionStore, CredentialStore } from '@maka/storage';
import { listApiKeyOnboardableProviders, setupApiKeyConnection } from '../onboarding.js';

describe('setupApiKeyConnection', () => {
  test('creates the connection, stores the API key secret, and returns discovered models', async () => {
    const createdInputs: Array<{ slug: string; providerType: ProviderType }> = [];
    const storedSecrets: Array<{ slug: string; kind: string; value: string }> = [];
    const fakeModels: ModelInfo[] = [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }];

    const result = await setupApiKeyConnection({
      providerType: 'openai',
      slug: 'openai',
      apiKey: 'sk-test',
      connectionStore: {
        create: async (input) => {
          createdInputs.push({ slug: input.slug, providerType: input.providerType });
          return makeConnection({ slug: input.slug, providerType: input.providerType, defaultModel: 'gpt-5.5' });
        },
        getDefault: async () => null,
        setDefault: async () => {},
      } satisfies Pick<ConnectionStore, 'create' | 'getDefault' | 'setDefault'>,
      credentialStore: {
        setSecret: async (slug, kind, value) => {
          storedSecrets.push({ slug, kind, value });
        },
      } satisfies Pick<CredentialStore, 'setSecret'>,
      fetchModels: async () => fakeModels,
    });

    // The connection is persisted with the chosen slug and provider type.
    assert.deepEqual(createdInputs, [{ slug: 'openai', providerType: 'openai' }]);
    // The API key is stored under the connection slug, typed api_key.
    assert.deepEqual(storedSecrets, [{ slug: 'openai', kind: 'api_key', value: 'sk-test' }]);
    // The created connection and the discovered models come back for the next step.
    assert.equal(result.connection.slug, 'openai');
    assert.deepEqual(result.models.map((m) => m.id), ['gpt-5.5', 'gpt-5.5-mini']);
  });

  test('records a model-fetch failure as a non-blocking test error instead of throwing', async () => {
    const result = await setupApiKeyConnection({
      providerType: 'openai',
      slug: 'openai',
      apiKey: 'sk-test',
      connectionStore: {
        create: async (input) => makeConnection({ slug: input.slug, providerType: input.providerType }),
        getDefault: async () => null,
        setDefault: async () => {},
      },
      credentialStore: {
        setSecret: async () => {},
      },
      fetchModels: async () => { throw new Error('HTTP 401'); },
    });

    // A failing probe (wrong key, offline, no /models endpoint) must not abort
    // onboarding — the connection is already saved; the wizard offers manual entry.
    assert.deepEqual(result.models, []);
    assert.equal(result.testError, 'HTTP 401');
  });

  test('rejects a provider that does not accept an API key before touching the stores', async () => {
    let created = false;
    let stored = false;

    await assert.rejects(
      setupApiKeyConnection({
        providerType: 'ollama', // authKind 'none' — keyless local model
        slug: 'ollama',
        apiKey: 'unused',
        connectionStore: {
          create: async () => {
            created = true;
            return makeConnection({});
          },
          getDefault: async () => null,
          setDefault: async () => {},
        },
        credentialStore: {
          setSecret: async () => {
            stored = true;
          },
        },
        fetchModels: async () => [],
      }),
      /does not accept an API key/,
    );

    // The guard fires before any write so a miscategorized provider never gets
    // a bogus api_key secret persisted.
    assert.equal(created, false);
    assert.equal(stored, false);
  });

  test('makes the new connection the default even when one already exists', async () => {
    let defaultSlug: string | null = 'old-default';
    const setDefaultCalls: string[] = [];

    await setupApiKeyConnection({
      providerType: 'openai',
      slug: 'openai',
      apiKey: 'sk-test',
      connectionStore: {
        create: async (input) => makeConnection({ slug: input.slug, providerType: input.providerType }),
        getDefault: async () => defaultSlug,
        setDefault: async (slug) => {
          if (slug) setDefaultCalls.push(slug);
          defaultSlug = slug;
        },
      },
      credentialStore: {
        setSecret: async () => {},
      },
      fetchModels: async () => [],
    });

    // A freshly onboarded connection becomes the active default so the first turn runs on it.
    assert.deepEqual(setDefaultCalls, ['openai']);
  });

  test('rejects an empty API key for a provider that requires one, before touching the stores', async () => {
    let created = false;
    await assert.rejects(
      setupApiKeyConnection({
        providerType: 'openai', // authKind 'api_key' (required)
        slug: 'openai',
        apiKey: '   ',
        connectionStore: {
          create: async () => {
            created = true;
            return makeConnection({});
          },
          getDefault: async () => null,
          setDefault: async () => {},
        },
        credentialStore: {
          setSecret: async () => {},
        },
        fetchModels: async () => [],
      }),
      /API key is required/,
    );
    assert.equal(created, false);
  });

  test('passes a custom baseUrl through to the created connection', async () => {
    const createdInputs: Array<{ baseUrl?: string }> = [];
    await setupApiKeyConnection({
      providerType: 'openai',
      slug: 'self-hosted',
      apiKey: 'sk-test',
      baseUrl: 'https://my-gateway.example/v1',
      connectionStore: {
        create: async (input) => {
          createdInputs.push(input);
          return makeConnection({ slug: input.slug, providerType: input.providerType });
        },
        getDefault: async () => null,
        setDefault: async () => {},
      },
      credentialStore: {
        setSecret: async () => {},
      },
      fetchModels: async () => [],
    });

    assert.equal(createdInputs[0]?.baseUrl, 'https://my-gateway.example/v1');
  });
});

describe('listApiKeyOnboardableProviders', () => {
  test('lists only API-key providers, excluding OAuth and keyless ones', () => {
    const providers = listApiKeyOnboardableProviders();
    const types = providers.map((p) => p.providerType);

    assert.ok(types.includes('anthropic'));
    assert.ok(types.includes('openai'));
    // keyless local models and OAuth subscription providers are not onboardable this way
    assert.ok(!types.includes('ollama'));

    for (const provider of providers) {
      assert.ok(
        provider.authKind === 'api_key' || provider.authKind === 'optional_api_key',
        `${provider.providerType} should accept an api key`,
      );
    }
  });

  test('excludes providers that require a user-supplied baseUrl (phase 1)', () => {
    const providers = listApiKeyOnboardableProviders();
    const anthropic = providers.find((p) => p.providerType === 'anthropic');

    // anthropic ships a default baseUrl, so the wizard skips that field for it.
    assert.equal(anthropic?.requiresBaseUrl, false);
    // Phase 1 cannot collect a base URL, so providers without a default one are
    // not onboardable yet (they would wedge the install — see PR #1177 review).
    for (const provider of providers) {
      assert.equal(
        provider.requiresBaseUrl,
        false,
        `${provider.providerType} requires a base URL and must be excluded until the wizard can prompt for one`,
      );
    }
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
