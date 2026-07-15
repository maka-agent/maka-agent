import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createOAuthModelConnectionsMainService,
  CODEX_SUBSCRIPTION_CONNECTION_SLUG,
} from '../oauth-model-connections-main.js';
import { PROVIDER_REGISTRY, PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { OpenAiCodexDiscoveryError } from '@maka/runtime';
import type { LlmConnection } from '@maka/core/llm-connections';

// syncOpenAiCodexConnection live-discovers the account's Codex model list
// from chatgpt.com/backend-api/codex/models. These behavior tests inject fake
// deps (connectionStore / openAiCodex / fetchModels) so the three discovery
// outcomes - fetched, empty, failed - and the OAuth-token-failure path can be
// asserted directly, instead of grepping source.

type ModelInfo = NonNullable<LlmConnection['models']>[number];

function makeExisting(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: CODEX_SUBSCRIPTION_CONNECTION_SLUG,
    name: 'Codex OAuth',
    providerType: 'openai-codex',
    baseUrl: PROVIDER_DEFAULTS['openai-codex'].baseUrl,
    defaultModel: 'gpt-5.6-sol',
    enabled: true,
    models: [{ id: 'gpt-5.6-sol' }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeService(opts: {
  existing?: LlmConnection | null;
  token?: string | null;
  fetchModels?: (conn: LlmConnection, token: string) => Promise<ModelInfo[]>;
  accountState?: { runtimeState: string };
}): { sync: () => Promise<LlmConnection | null>; getSaved: () => LlmConnection | null } {
  let saved: LlmConnection | null = null;
  const existing = opts.existing ?? null;
  const connectionStore = {
    get: async () => existing,
    list: async () => (existing ? [existing] : []),
    save: async (v: LlmConnection) => {
      saved = v;
      return v;
    },
    update: async (_slug: string, patch: Partial<LlmConnection>) => {
      saved = { ...(existing as LlmConnection), ...patch } as LlmConnection;
      return saved;
    },
    create: async () => {
      throw new Error('not used');
    },
    delete: async () => {},
    remove: async () => {},
    getDefault: async () => null,
    setDefault: async () => {},
  };
  const service = createOAuthModelConnectionsMainService({
    connectionStore,
    credentialStore: {
      getSecret: async () => null,
      setSecret: async () => {},
      deleteSecret: async () => {},
    },
    claudeSubscription: {} as never,
    openAiCodex: {
      getAccountState: async () => ({
        provider: 'openai-codex',
        runtimeState: opts.accountState?.runtimeState ?? 'authenticated',
      }),
      getAccessTokenInternal: async () => opts.token ?? null,
    },
    githubCopilotSubscription: {} as never,
    fetchModels: opts.fetchModels,
  } as never);
  return { sync: () => service.syncOpenAiCodexConnection(), getSaved: () => saved };
}

describe('syncOpenAiCodexConnection live discovery behavior', () => {
  it('declares protocol live discovery for the openai-codex provider', () => {
    assert.deepEqual(
      PROVIDER_REGISTRY['openai-codex'].modelDiscovery,
      { kind: 'protocol', auth: 'openai-codex' },
    );
  });

  it('stamps modelSource=fetched and persists discovered models on success', async () => {
    const { sync, getSaved } = makeService({
      token: 'tok',
      fetchModels: async () => [{ id: 'gpt-5.6-sol', contextWindow: 372000 }, { id: 'gpt-5.5' }],
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.modelSource, 'fetched');
    assert.deepEqual(saved.models, [{ id: 'gpt-5.6-sol', contextWindow: 372000 }, { id: 'gpt-5.5' }]);
    assert.equal(saved.enabled, true);
    assert.equal(saved.lastTestStatus, 'verified');
  });

  it('disables the connection with lastTestStatus=error when /models returns an empty list', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting(),
      token: 'tok',
      fetchModels: async () => [],
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'error');
  });

  it('disables the connection with lastTestStatus=needs_reauth when the access token is unavailable', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting(),
      token: null,
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'needs_reauth');
  });

  it('rebuilds the fallback list from the registry on discovery failure, not the stale persisted copy', async () => {
    // Existing connection carries an old fallback snapshot (pre-gpt-5.6-sol).
    // A transient discovery failure must not reuse that stale copy; it must
    // rebuild from the current registry fallbackModels so gpt-5.6-sol appears.
    const { sync, getSaved } = makeService({
      existing: makeExisting({ models: [{ id: 'gpt-5.4' }], modelSource: 'fallback' }),
      token: 'tok',
      fetchModels: async () => {
        throw new Error('offline');
      },
    });
    await sync();
    const saved = getSaved()!;
    assert.deepEqual(
      saved.models!.map((m) => m.id),
      PROVIDER_DEFAULTS['openai-codex'].fallbackModels,
    );
    assert.ok(
      saved.models!.some((m) => m.id === 'gpt-5.6-sol'),
      'fallback must include gpt-5.6-sol from the current registry',
    );
    assert.equal(saved.modelSource, 'fallback');
    assert.equal(saved.enabled, true);
    assert.equal(saved.lastTestStatus, 'verified');
  });

  it('keeps the last fetched list as a cache on transient discovery failure', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting({ models: [{ id: 'gpt-5.6-sol' }], modelSource: 'fetched' }),
      token: 'tok',
      fetchModels: async () => {
        throw new Error('offline');
      },
    });
    await sync();
    const saved = getSaved()!;
    assert.deepEqual(saved.models, [{ id: 'gpt-5.6-sol' }]);
    assert.equal(saved.modelSource, 'fetched');
    assert.equal(saved.enabled, true);
  });

  it('disables with needs_reauth when /models rejects with 401', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting(),
      token: 'tok',
      fetchModels: async () => {
        throw new OpenAiCodexDiscoveryError(401);
      },
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'needs_reauth');
  });

  it('disables with error when all discovered models are filtered as unsupported', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting(),
      token: 'tok',
      fetchModels: async () => [{ id: 'gpt-5-codex' }],
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'error');
  });

  it('clears stale models when /models returns empty', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting({ models: [{ id: 'gpt-5.6-sol' }], modelSource: 'fetched' }),
      token: 'tok',
      fetchModels: async () => [],
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'error');
    assert.deepEqual(saved.models, []);
    assert.equal(saved.modelSource, 'fetched');
  });
});
