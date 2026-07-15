import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createConnectionStore } from '@maka/storage';
import { createConnectionWithCredential } from '../create-connection-with-credential.js';

describe('createConnectionWithCredential', () => {
  it('removes the new connection when credential persistence fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-create-connection-'));
    try {
      const connectionStore = createConnectionStore(workspaceRoot);
      await assert.rejects(
        createConnectionWithCredential(
          {
            connectionStore,
            credentialStore: {
              async setSecret() {
                throw new Error('credential write failed');
              },
            },
          },
          {
            slug: 'openai',
            name: 'OpenAI',
            providerType: 'openai',
            apiKey: 'test-key',
          },
        ),
        /credential write failed/,
      );

      assert.deepEqual(await connectionStore.list(), []);
      assert.equal(await connectionStore.getDefault(), null);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
