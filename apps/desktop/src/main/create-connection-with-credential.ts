import type { CreateConnectionInput, LlmConnection } from '@maka/core/llm-connections';
import type { ConnectionStore, CredentialStore } from '@maka/storage';

interface CreateConnectionWithCredentialDeps {
  connectionStore: Pick<ConnectionStore, 'create' | 'remove'>;
  credentialStore: Pick<CredentialStore, 'setSecret'>;
}

export async function createConnectionWithCredential(
  deps: CreateConnectionWithCredentialDeps,
  input: CreateConnectionInput,
): Promise<LlmConnection> {
  const connection = await deps.connectionStore.create(input);
  if (input.apiKey) {
    try {
      await deps.credentialStore.setSecret(connection.slug, 'api_key', input.apiKey);
    } catch (error) {
      await deps.connectionStore.remove(connection.slug);
      throw error;
    }
  }
  return connection;
}
