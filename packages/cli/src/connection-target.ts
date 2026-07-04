import { isConnectionReady, type ChatConfigurationReason } from '@maka/core/connection-readiness';
import type { LlmConnection } from '@maka/core/llm-connections';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { isOAuthSubscriptionProvider, resolveOAuthSubscriptionTokens, type OAuthSubscriptionTokens } from '@maka/runtime';
import type { ConnectionStore, CredentialKind, CredentialStore } from '@maka/storage';

export interface ReadySessionTarget {
  connection: LlmConnection;
  apiKey: string;
  model: string;
  oauthTokens?: OAuthSubscriptionTokens;
}

export function selectableModelIdsForTarget(target: Pick<ReadySessionTarget, 'connection' | 'model'>): string[] {
  const defaults = PROVIDER_DEFAULTS[target.connection.providerType];
  const candidates = [
    target.model,
    target.connection.defaultModel,
    ...(target.connection.models?.map((model) => model.id) ?? defaults?.fallbackModels ?? []),
  ];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface ResolveDefaultSessionTargetInput {
  connectionStore: Pick<ConnectionStore, 'get' | 'getDefault'>;
  credentialStore: Pick<CredentialStore, 'getSecret'> & Partial<Pick<CredentialStore, 'setSecret'>>;
  requestedModel?: string;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export async function resolveDefaultSessionTarget(
  input: ResolveDefaultSessionTargetInput,
): Promise<ReadySessionTarget> {
  const slug = await input.connectionStore.getDefault();
  if (!slug || slug === 'fake') throw noRealConnection('missing_default_connection');

  const connection = await input.connectionStore.get(slug);
  if (!connection) throw noRealConnection('connection_missing');

  const oauthProviderType = isOAuthSubscriptionProvider(connection.providerType)
    ? connection.providerType
    : null;
  const oauthTokens = oauthProviderType
    ? await resolveOAuthSubscriptionTokens({
      providerType: oauthProviderType,
      slug: connection.slug,
      credentialStore: input.credentialStore,
      now: input.now,
      fetchFn: input.fetchFn,
    })
    : undefined;
  const credentialKind = credentialKindForConnection(connection);
  const secret = !oauthProviderType && credentialKind
    ? await input.credentialStore.getSecret(connection.slug, credentialKind)
    : '';
  const apiKey = oauthProviderType ? oauthTokens?.access_token : secret;
  const verdict = isConnectionReady({
    connection,
    hasSecret: typeof apiKey === 'string' && apiKey.length > 0,
    requestedModel: input.requestedModel,
  });
  if (!verdict.ready) throw noRealConnection(verdict.reason);
  return {
    connection,
    apiKey: apiKey ?? '',
    model: verdict.model,
    ...(oauthTokens ? { oauthTokens } : {}),
  };
}

function credentialKindForConnection(connection: LlmConnection): CredentialKind | null {
  const authKind = PROVIDER_DEFAULTS[connection.providerType]?.authKind;
  switch (authKind) {
    case 'api_key':
      return 'api_key';
    case 'oauth_token':
      return 'oauth_token';
    case 'none':
      return null;
    default:
      return 'api_key';
  }
}

function noRealConnection(reason: ChatConfigurationReason): Error {
  return new Error(`NO_REAL_CONNECTION:${reason}`);
}
