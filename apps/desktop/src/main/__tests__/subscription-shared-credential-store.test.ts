import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  tryDeleteSharedOAuthToken,
  trySaveSharedOAuthToken,
} from '../oauth/shared-credential-bridge.js';

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLAUDE_SOURCE = resolve(DESKTOP_ROOT, 'src', 'main', 'oauth', 'claude-subscription-service.ts');
const CODEX_SOURCE = resolve(DESKTOP_ROOT, 'src', 'main', 'oauth', 'openai-codex-service.ts');

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

  it('reports shared credential delete failures without throwing', async () => {
    const deleted = await tryDeleteSharedOAuthToken({
      credentialStore: {
        deleteSecret: async () => {
          throw new Error('shared store unavailable');
        },
      },
      slug: 'claude-subscription',
    });

    assert.equal(deleted, false);
  });

  it('desktop services export tokens to shared credentials but never restore login state from them', async () => {
    for (const [name, source, slug] of [
      ['Claude', CLAUDE_SOURCE, 'claude-subscription'],
      ['Codex', CODEX_SOURCE, 'codex-subscription'],
    ] as const) {
      const src = await readFile(source, 'utf8');
      assert.doesNotMatch(src, /loadSharedTokens/, `${name} service must not read CLI shared tokens back into desktop state`);
      assert.doesNotMatch(
        src,
        new RegExp(`getSecret\\(\\s*'${slug}',\\s*'oauth_token'`),
        `${name} service must not restore desktop login from shared CLI credentials`,
      );
      assert.match(
        src,
        new RegExp(`tryDeleteSharedOAuthToken\\(\\{[\\s\\S]*slug:\\s*'${slug}'`),
        `${name} logout should still attempt to clean the exported CLI token`,
      );
    }
  });
});
