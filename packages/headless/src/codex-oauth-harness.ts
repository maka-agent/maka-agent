import { createHash } from 'node:crypto';
import {
  extractCodexAccountId,
  openAiCodexHeaders,
  resolveOAuthSubscriptionTokens,
} from '@maka/runtime';
import { createFileCredentialStore } from '@maka/storage';
import type { ProviderUpstreamCredentialResolver } from './provider-auth-proxy.js';

export interface CodexOAuthHarnessCredentialBindingInput {
  credentialsRoot: string;
  connectionSlug: string;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export interface CodexOAuthHarnessCredentialBinding {
  credentialIdentity: {
    connectionSlug: string;
    accountIdHash: string;
  };
  resolveProviderCredential: ProviderUpstreamCredentialResolver;
}

export async function createCodexOAuthHarnessCredentialBinding(
  input: CodexOAuthHarnessCredentialBindingInput,
): Promise<CodexOAuthHarnessCredentialBinding> {
  const credentialStore = createFileCredentialStore(input.credentialsRoot);
  let expectedAccountId: string | null = null;
  const resolveCredential: ProviderUpstreamCredentialResolver = async () => {
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: input.connectionSlug,
      credentialStore,
      ...(input.now ? { now: input.now } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    if (!tokens) throw new Error('Maka Codex OAuth credentials are unavailable');
    const accountId = extractCodexAccountId(tokens.access_token);
    if (!accountId) throw new Error('Maka Codex OAuth credential has no account identity');
    if (expectedAccountId && accountId !== expectedAccountId) {
      throw new Error('Codex OAuth account changed during the run');
    }
    expectedAccountId = accountId;
    return {
      value: tokens.access_token,
      headers: openAiCodexHeaders(tokens.access_token),
    };
  };
  await resolveCredential();
  return {
    credentialIdentity: {
      connectionSlug: input.connectionSlug,
      accountIdHash: `sha256:${createHash('sha256').update(expectedAccountId!).digest('hex')}`,
    },
    resolveProviderCredential: resolveCredential,
  };
}
