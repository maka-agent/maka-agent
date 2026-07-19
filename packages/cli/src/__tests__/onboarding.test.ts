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
        get: async () => null,
        create: async (input) => {
          createdInputs.push({ slug: input.slug, providerType: input.providerType });
          return makeConnection({
            slug: input.slug,
            providerType: input.providerType,
            defaultModel: 'gpt-5.5',
          });
        },
        remove: async () => {},
        getDefault: async () => null,
        setDefault: async () => {},
      } satisfies Pick<ConnectionStore, 'create' | 'get' | 'remove' | 'getDefault' | 'setDefault'>,
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
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['gpt-5.5', 'gpt-5.5-mini'],
    );
  });

  test('records a model-fetch failure as a non-blocking test error instead of throwing', async () => {
    const result = await setupApiKeyConnection({
      providerType: 'openai',
      slug: 'openai',
      apiKey: 'sk-test',
      connectionStore: {
        get: async () => null,
        create: async (input) =>
          makeConnection({ slug: input.slug, providerType: input.providerType }),
        remove: async () => {},
        getDefault: async () => null,
        setDefault: async () => {},
      },
      credentialStore: {
        setSecret: async () => {},
      },
      fetchModels: async () => {
        throw new Error('HTTP 401');
      },
    });

    // A failing probe (wrong key, offline, no /models endpoint) must not abort
    // onboarding — the connection is already saved; the wizard offers manual entry.
    assert.deepEqual(result.models, []);
    assert.equal(result.testError, 'HTTP 401');
  });

  test('a failing probe does not make the broken connection the default', async () => {
    const setDefaultCalls: string[] = [];
    const result = await setupApiKeyConnection({
      providerType: 'openai',
      slug: 'openai',
      apiKey: 'sk-typo',
      connectionStore: {
        get: async () => null,
        create: async (input) =>
          makeConnection({ slug: input.slug, providerType: input.providerType }),
        remove: async () => {},
        getDefault: async () => null,
        setDefault: async (slug) => {
          if (slug) setDefaultCalls.push(slug);
        },
      } satisfies Pick<ConnectionStore, 'create' | 'get' | 'remove' | 'getDefault' | 'setDefault'>,
      credentialStore: {
        setSecret: async () => {},
      } satisfies Pick<CredentialStore, 'setSecret'>,
      fetchModels: async () => {
        throw new Error('HTTP 401');
      },
    });

    // The connection is saved (retrying rotates the key), but a broken key
    // must NOT become the default — otherwise the host would report it as
    // configured and trap the next launch out of onboarding.
    assert.equal(result.testError, 'HTTP 401');
    assert.deepEqual(setDefaultCalls, []);
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
          get: async () => null,
          create: async () => {
            created = true;
            return makeConnection({});
          },
          remove: async () => {},
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
        get: async () => null,
        create: async (input) =>
          makeConnection({ slug: input.slug, providerType: input.providerType }),
        remove: async () => {},
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
          get: async () => null,
          create: async () => {
            created = true;
            return makeConnection({});
          },
          remove: async () => {},
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
        get: async () => null,
        create: async (input) => {
          createdInputs.push(input);
          return makeConnection({ slug: input.slug, providerType: input.providerType });
        },
        remove: async () => {},
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

  test('rotates the key when the slug already exists instead of creating a duplicate (upsert)', async () => {
    // Re-onboarding the same provider (e.g. fixing a typo'd key) must update the
    // secret on the existing connection rather than throw "slug already exists".
    const storedSecrets: Array<{ slug: string; value: string }> = [];

    const result = await setupApiKeyConnection({
      providerType: 'openai',
      slug: 'openai',
      apiKey: 'key-rotated',
      connectionStore: {
        get: async () => makeConnection({ slug: 'openai', providerType: 'openai' }),
        create: async () => {
          throw new Error('create must not be called when the slug already exists');
        },
        remove: async () => {},
        getDefault: async () => 'openai',
        setDefault: async () => {},
      },
      credentialStore: {
        setSecret: async (slug, _kind, value) => {
          storedSecrets.push({ slug, value });
        },
      } satisfies Pick<CredentialStore, 'setSecret'>,
      fetchModels: async () => [],
    });

    assert.equal(result.connection.slug, 'openai');
    assert.deepEqual(storedSecrets, [{ slug: 'openai', value: 'key-rotated' }]);
  });

  test('rolls back a newly created connection when the secret write fails', async () => {
    // Atomicity: create succeeds, setSecret fails -> the orphan connection is
    // removed so a half-configured connection never becomes the default.
    const removedSlugs: string[] = [];

    await assert.rejects(
      setupApiKeyConnection({
        providerType: 'openai',
        slug: 'openai',
        apiKey: 'sk-test',
        connectionStore: {
          get: async () => null,
          create: async (input) =>
            makeConnection({ slug: input.slug, providerType: input.providerType }),
          remove: async (slug) => {
            removedSlugs.push(slug);
          },
          getDefault: async () => null,
          setDefault: async () => {},
        },
        credentialStore: {
          setSecret: async () => {
            throw new Error('disk full');
          },
        },
        fetchModels: async () => [],
      }),
      /disk full/,
    );

    assert.deepEqual(removedSlugs, ['openai']);
  });

  test('leaves an existing connection in place when a key rotation secret write fails', async () => {
    // Upsert atomicity: an existing connection whose key rotation fails must not
    // be deleted (its previous secret stands); only newly-created ones roll back.
    const removedSlugs: string[] = [];

    await assert.rejects(
      setupApiKeyConnection({
        providerType: 'openai',
        slug: 'openai',
        apiKey: 'sk-test',
        connectionStore: {
          get: async () => makeConnection({ slug: 'openai', providerType: 'openai' }),
          create: async () => {
            throw new Error('create must not be called');
          },
          remove: async (slug) => {
            removedSlugs.push(slug);
          },
          getDefault: async () => 'openai',
          setDefault: async () => {},
        },
        credentialStore: {
          setSecret: async () => {
            throw new Error('disk full');
          },
        },
        fetchModels: async () => [],
      }),
      /disk full/,
    );

    assert.deepEqual(removedSlugs, []);
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
