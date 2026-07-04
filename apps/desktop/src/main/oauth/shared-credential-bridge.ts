import type { CredentialStore } from '@maka/storage';

export type SharedOAuthCredentialStore = Pick<CredentialStore, 'setSecret'>;

export interface TrySaveSharedOAuthTokenInput {
  credentialStore?: SharedOAuthCredentialStore;
  slug: string;
  value: string;
}

export async function trySaveSharedOAuthToken(input: TrySaveSharedOAuthTokenInput): Promise<boolean> {
  try {
    await input.credentialStore?.setSecret(input.slug, 'oauth_token', input.value);
    return Boolean(input.credentialStore);
  } catch {
    return false;
  }
}
