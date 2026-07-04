import type { CredentialStore } from '@maka/storage';

export type SharedOAuthCredentialSaveStore = Pick<CredentialStore, 'setSecret'>;
export type SharedOAuthCredentialDeleteStore = Pick<CredentialStore, 'deleteSecret'>;

export interface TrySaveSharedOAuthTokenInput {
  credentialStore?: SharedOAuthCredentialSaveStore;
  slug: string;
  value: string;
}

export interface TryDeleteSharedOAuthTokenInput {
  credentialStore?: SharedOAuthCredentialDeleteStore;
  slug: string;
}

export async function trySaveSharedOAuthToken(input: TrySaveSharedOAuthTokenInput): Promise<boolean> {
  try {
    await input.credentialStore?.setSecret(input.slug, 'oauth_token', input.value);
    return Boolean(input.credentialStore);
  } catch {
    return false;
  }
}

export async function tryDeleteSharedOAuthToken(input: TryDeleteSharedOAuthTokenInput): Promise<boolean> {
  if (!input.credentialStore) return true;
  try {
    await input.credentialStore.deleteSecret(input.slug, 'oauth_token');
    return true;
  } catch {
    return false;
  }
}
