import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { trySaveSharedOAuthToken } from '../oauth/shared-credential-bridge.js';

describe('OAuth subscription shared credential store bridge', () => {
  it('writes OAuth tokens to the shared credential store when available', async () => {
    const writes: Array<{ slug: string; kind: string; value: string }> = [];

    const saved = await trySaveSharedOAuthToken({
      credentialStore: {
        setSecret: async (slug, kind, value) => {
          writes.push({ slug, kind, value });
        },
      },
      slug: 'claude-subscription',
      value: '{"access_token":"token"}',
    });

    assert.equal(saved, true);
    assert.deepEqual(writes, [{
      slug: 'claude-subscription',
      kind: 'oauth_token',
      value: '{"access_token":"token"}',
    }]);
  });

  it('keeps desktop OAuth usable when the shared credential write fails', async () => {
    const saved = await trySaveSharedOAuthToken({
      credentialStore: {
        setSecret: async () => {
          throw new Error('shared store unavailable');
        },
      },
      slug: 'codex-subscription',
      value: '{"access_token":"token"}',
    });

    assert.equal(saved, false);
  });
});
