import { openAiCodexHeaders, resolveOAuthSubscriptionTokens } from '@maka/runtime';
import { createFileCredentialStore } from '@maka/storage';
import type { ProviderUpstreamCredentialResolver } from './provider-auth-proxy.js';

export interface CodexOAuthHarnessCredentialResolverInput {
  credentialsRoot: string;
  connectionSlug: string;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export async function createCodexOAuthHarnessCredentialResolver(
  input: CodexOAuthHarnessCredentialResolverInput,
): Promise<ProviderUpstreamCredentialResolver> {
  const credentialStore = createFileCredentialStore(input.credentialsRoot);
  const resolveCredential: ProviderUpstreamCredentialResolver = async () => {
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: input.connectionSlug,
      credentialStore,
      ...(input.now ? { now: input.now } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    if (!tokens) throw new Error('Maka Codex OAuth credentials are unavailable');
    return {
      value: tokens.access_token,
      headers: openAiCodexHeaders(tokens.access_token),
    };
  };
  await resolveCredential();
  return resolveCredential;
}
