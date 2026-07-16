/**
 * Source-grounded contract: the shared CredentialStore (workspace
 * credentials.json) is the single OAuth token authority for the
 * desktop subscription services (#1125). Desktop persists through the
 * shared-credential-bridge helpers and never through Electron
 * safeStorage; the runtime-usable token a pure-Node surface reads is
 * the same one the desktop wrote. Unit coverage of the bridge itself
 * lives in shared-oauth-token-persistence.test.ts.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OAUTH_DIR = resolve(DESKTOP_ROOT, 'src', 'main', 'oauth');

const STORE_AUTHORITY_SERVICES = [
  ['Claude', 'claude-subscription-service.ts', 'claude-subscription'],
  ['Codex', 'openai-codex-service.ts', 'codex-subscription'],
] as const;

describe('OAuth subscription token authority (shared CredentialStore)', () => {
  for (const [name, file, slug] of STORE_AUTHORITY_SERVICES) {
    it(`${name} service persists tokens only through the shared credential store`, async () => {
      const src = await readFile(resolve(OAUTH_DIR, file), 'utf8');
      assert.match(
        src,
        new RegExp(`saveSharedOAuthTokens\\(this\\.credentialStore, '${slug}'`),
        `${name} service must write tokens to the shared store (the authority)`,
      );
      assert.match(
        src,
        new RegExp(`loadSharedOAuthTokens\\(this\\.credentialStore, '${slug}'`),
        `${name} service must read tokens back from the shared store`,
      );
      assert.match(
        src,
        new RegExp(`deleteSharedOAuthTokens\\(this\\.credentialStore, '${slug}'`),
        `${name} logout must delete the authoritative shared token`,
      );
    });

    it(`${name} service has no safeStorage / encrypted-file token path left`, async () => {
      const src = await readFile(resolve(OAUTH_DIR, file), 'utf8');
      assert.doesNotMatch(
        src,
        /from 'electron'.*safeStorage|safeStorage.*from 'electron'/,
        `${name} service must not import safeStorage — the store is the only authority (#1125)`,
      );
      assert.doesNotMatch(
        src,
        /encryptString|decryptString|isEncryptionAvailable/,
        `${name} service must not encrypt/decrypt token files`,
      );
      assert.doesNotMatch(
        src,
        /fs\.writeFile\(this\.legacyTokenFilePath/,
        `${name} service must never write the legacy token file`,
      );
      assert.match(
        src,
        /fs\.unlink\(this\.legacyTokenFilePath\)/,
        `${name} logout must still clear a legacy token file the startup import could not process`,
      );
    });

    it(`${name} service refreshes through the runtime's shared refresher`, async () => {
      const src = await readFile(resolve(OAUTH_DIR, file), 'utf8');
      assert.match(
        src,
        /refreshOAuthSubscriptionTokens\(\{/,
        `${name} service must reuse the runtime refresh implementation, not a private duplicate`,
      );
      assert.doesNotMatch(
        src,
        /private async requestRefresh/,
        `${name} service must not keep a parallel refresh implementation`,
      );
    });
  }

  it('main.ts runs the one-shot legacy token import at startup, non-fatally', async () => {
    const src = await readFile(resolve(DESKTOP_ROOT, 'src', 'main', 'main.ts'), 'utf8');
    assert.match(
      src,
      /try\s*\{[\s\S]{0,600}importLegacyOAuthTokenFiles\(\{[\s\S]*?\}\);?[\s\S]{0,600}catch/,
      'legacy OAuth token import must be wrapped so a failure cannot break startup',
    );
    for (const slug of ['claude-subscription', 'codex-subscription']) {
      assert.match(
        src,
        new RegExp(`slug: '${slug}', filePath: join\\(userDataDir, '\\.\\w+_subscription_token'\\)`),
        `startup import must cover the legacy ${slug} token file`,
      );
    }
  });
});
