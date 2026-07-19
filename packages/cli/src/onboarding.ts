import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  providerAuthSupportsApiKey,
  type LlmConnection,
  type ModelInfo,
  type ProviderType,
} from '@maka/core/llm-connections';
import type { ConnectionStore, CredentialStore } from '@maka/storage';

export interface SetupApiKeyConnectionInput {
  providerType: ProviderType;
  slug: string;
  apiKey: string;
  name?: string;
  baseUrl?: string;
  defaultModel?: string;
  connectionStore: Pick<ConnectionStore, 'create' | 'get' | 'remove' | 'getDefault' | 'setDefault'>;
  credentialStore: Pick<CredentialStore, 'setSecret'>;
  fetchModels: (connection: LlmConnection, apiKey: string) => Promise<ModelInfo[]>;
}

export interface SetupApiKeyConnectionResult {
  connection: LlmConnection;
  models: ModelInfo[];
  /** Set when the model probe failed. The connection is still saved; onboarding
   *  offers manual model entry instead of aborting (non-blocking test). */
  testError?: string;
}

/**
 * Persist a single API-key connection end to end: create the connection, store
 * its secret, and probe it for models. Onboarding's write side — the read side
 * lives in `connection-target.ts`. Pure and dependency-injected so the TUI wizard
 * (PR②) drives the same seam the tests do.
 */
export async function setupApiKeyConnection(
  input: SetupApiKeyConnectionInput,
): Promise<SetupApiKeyConnectionResult> {
  if (!providerAuthSupportsApiKey(input.providerType)) {
    throw new Error(`Provider "${input.providerType}" does not accept an API key`);
  }
  if (PROVIDER_DEFAULTS[input.providerType]?.authKind === 'api_key' && !input.apiKey.trim()) {
    throw new Error('API key is required');
  }
  // Upsert by slug so re-onboarding the same provider (e.g. fixing a typo'd
  // key) rotates the secret instead of throwing "slug already exists". An
  // existing connection keeps its endpoint/model; only the key is refreshed.
  const existing = await input.connectionStore.get(input.slug);
  const connection = existing
    ? existing
    : await input.connectionStore.create({
        slug: input.slug,
        name: input.name ?? input.slug,
        providerType: input.providerType,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
      });
  try {
    await input.credentialStore.setSecret(input.slug, 'api_key', input.apiKey);
  } catch (error) {
    // Atomicity: a newly-created connection is rolled back when the secret write
    // fails, so no half-configured connection becomes the default. An existing
    // connection is left in place — its previous secret stands.
    if (!existing) await input.connectionStore.remove(input.slug);
    throw error;
  }
  try {
    const models = await input.fetchModels(connection, input.apiKey);
    // Only a verified connection becomes the default: a probe failure leaves
    // the host's getDefault() accurate so a cancelled first-run attempt does
    // not trap the next launch out of onboarding.
    await input.connectionStore.setDefault(input.slug);
    return { connection, models };
  } catch (error) {
    return {
      connection,
      models: [],
      testError: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface OnboardableProvider {
  providerType: ProviderType;
  label: string;
  authKind: 'api_key' | 'optional_api_key';
  /** True when the catalog ships no default baseUrl, so the wizard must prompt
   *  for an endpoint (self-hosted / compatible gateways). */
  requiresBaseUrl: boolean;
  fallbackModels: readonly string[];
}

/** Host-supplied onboarding surface. The TUI wizard collects a provider + API
 *  key and calls setup(); the host owns the connection/credential stores and
 *  runs the real setupApiKeyConnection. `setup` resolves with `{ testError }`
 *  when the connection was saved but the model probe failed, so the wizard can
 *  re-arm the key prompt instead of claiming success. */
export interface MakaOnboardingSurface {
  setup: (input: {
    providerType: ProviderType;
    apiKey: string;
    baseUrl?: string;
  }) => Promise<{ testError?: string }>;
}

/** Build the onboarding surface the TUI wizard calls, owning the connection and
 *  credential stores plus the model probe. Centralizes the `slug = providerType`
 *  policy so the first-run host (cli.ts) and the in-session host
 *  (runtime-bootstrap) share one write path. */
export function createApiKeyOnboardingSurface(deps: {
  connectionStore: Pick<ConnectionStore, 'create' | 'get' | 'remove' | 'getDefault' | 'setDefault'>;
  credentialStore: Pick<CredentialStore, 'setSecret'>;
  fetchModels: (connection: LlmConnection, apiKey: string) => Promise<ModelInfo[]>;
}): MakaOnboardingSurface {
  return {
    setup: async ({ providerType, apiKey, baseUrl }) => {
      const result = await setupApiKeyConnection({
        providerType,
        slug: providerType,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        connectionStore: deps.connectionStore,
        credentialStore: deps.credentialStore,
        fetchModels: deps.fetchModels,
      });
      return result.testError ? { testError: result.testError } : {};
    },
  };
}

/** Catalog providers that can be onboarded with an API key, in catalog order.
 *  The TUI wizard's first step picks from this list. */
export function listApiKeyOnboardableProviders(): OnboardableProvider[] {
  return (
    CATALOG_PROVIDER_TYPES.filter((providerType) => providerAuthSupportsApiKey(providerType))
      .map((providerType) => {
        const def = PROVIDER_DEFAULTS[providerType];
        return {
          providerType,
          label: def.label,
          authKind: def.authKind as 'api_key' | 'optional_api_key',
          requiresBaseUrl: !def.baseUrl,
          fallbackModels: def.fallbackModels,
        };
      })
      // Phase 1 collects only an API key; providers without a default baseUrl
      // cannot be completed by this wizard and would wedge a fresh install, so
      // exclude them until the base-URL prompt lands (phase 2).
      .filter((provider) => !provider.requiresBaseUrl)
  );
}
