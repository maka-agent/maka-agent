import { CATALOG_PROVIDER_TYPES, PROVIDER_DEFAULTS, providerAuthSupportsApiKey, type LlmConnection, type ModelInfo, type ProviderType } from '@maka/core/llm-connections';
import type { ConnectionStore, CredentialStore } from '@maka/storage';

export interface SetupApiKeyConnectionInput {
  providerType: ProviderType;
  slug: string;
  apiKey: string;
  name?: string;
  baseUrl?: string;
  defaultModel?: string;
  connectionStore: Pick<ConnectionStore, 'create' | 'getDefault' | 'setDefault'>;
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
  const connection = await input.connectionStore.create({
    slug: input.slug,
    name: input.name ?? input.slug,
    providerType: input.providerType,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
  });
  await input.credentialStore.setSecret(input.slug, 'api_key', input.apiKey);
  await input.connectionStore.setDefault(input.slug);
  try {
    const models = await input.fetchModels(connection, input.apiKey);
    return { connection, models };
  } catch (error) {
    return { connection, models: [], testError: error instanceof Error ? error.message : String(error) };
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
 *  runs the real setupApiKeyConnection. */
export interface MakaOnboardingSurface {
  setup: (input: { providerType: ProviderType; apiKey: string; baseUrl?: string }) => Promise<void>;
}

/** Catalog providers that can be onboarded with an API key, in catalog order.
 *  The TUI wizard's first step picks from this list. */
export function listApiKeyOnboardableProviders(): OnboardableProvider[] {
  return CATALOG_PROVIDER_TYPES
    .filter((providerType) => providerAuthSupportsApiKey(providerType))
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
    .filter((provider) => !provider.requiresBaseUrl);
}
