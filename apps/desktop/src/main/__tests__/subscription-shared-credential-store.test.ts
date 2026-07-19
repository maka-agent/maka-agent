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
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OAUTH_DIR = resolve(DESKTOP_ROOT, 'src', 'main', 'oauth');

const STORE_AUTHORITY_SERVICES = [
  ['Claude', 'claude-subscription-service.ts', 'claude-subscription'],
  ['Codex', 'openai-codex-service.ts', 'codex-subscription'],
  ['Cursor', 'cursor-subscription-service.ts', 'cursor-subscription'],
  ['Antigravity', 'antigravity-subscription-service.ts', 'antigravity-subscription'],
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

    it(`${name} delegates refresh persistence and races to the runtime transaction`, async () => {
      const src = await readFile(resolve(OAUTH_DIR, file), 'utf8');
      const refreshStart = src.indexOf('async refreshTokens()');
      const refreshEnd = src.indexOf('\n  async logout()', refreshStart);
      assert.ok(refreshStart > 0 && refreshEnd > refreshStart, `${name} refreshTokens body must exist`);
      const refreshBody = src.slice(refreshStart, refreshEnd);
      assert.match(
        refreshBody,
        /refreshAndPersistOAuthSubscriptionTokens\(\{/,
        `${name} refresh must delegate read/network/CAS persistence to the runtime transaction`,
      );
      assert.doesNotMatch(
        refreshBody,
        /this\.saveTokens\(/,
        `${name} refresh must not persist outside the runtime transaction`,
      );
      assert.doesNotMatch(
        src,
        /credentialEpoch/,
        `${name} must not keep the in-process epoch guard superseded by cross-process CAS`,
      );
    });

    it(`${name} delegates automatic refresh decisions to the same runtime transaction`, async () => {
      const src = await readFile(resolve(OAUTH_DIR, file), 'utf8');
      const accessTokenMethod = src.match(/async getAccessTokenInternal\([^]*?\n  \}/u)?.[0];
      assert.ok(accessTokenMethod, `${name} getAccessTokenInternal body must exist`);
      assert.match(
        accessTokenMethod,
        /resolveAndPersistOAuthSubscriptionTokens\(\{/,
        `${name} automatic refresh must preserve the runtime transaction's first-read CAS basis`,
      );
      assert.doesNotMatch(
        accessTokenMethod,
        /tokens\.expires_at/,
        `${name} must not make an expiry decision before entering the runtime transaction`,
      );
    });
  }

  it('no production OAuth path invokes safeStorage (#1125 acceptance)', async () => {
    // The acceptance bar for #1125: saving or loading a runtime-usable
    // token must never require safeStorage. No module under oauth/ may
    // import or call safeStorage (the bridge's legacy import takes an
    // injected decryptor instead); main.ts may only pass the object
    // into the legacy importers, never call it.
    for (const file of await readdir(OAUTH_DIR)) {
      if (!file.endsWith('.ts')) continue;
      const src = await readFile(resolve(OAUTH_DIR, file), 'utf8');
      assert.doesNotMatch(
        src,
        /import\s*\{[^}]*\bsafeStorage\b[^}]*\}\s*from 'electron'/,
        `oauth/${file} must not import safeStorage from electron`,
      );
      assert.doesNotMatch(
        src,
        /\bsafeStorage\s*[.(]/,
        `oauth/${file} must not invoke safeStorage`,
      );
    }
    const mainSrc = await readFile(resolve(DESKTOP_ROOT, 'src', 'main', 'main.ts'), 'utf8');
    assert.doesNotMatch(
      mainSrc,
      /safeStorage\s*\./,
      'main.ts must only hand safeStorage to the legacy importers, never call it',
    );
  });

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

  it('finishes credential migration before the first window can issue OAuth mutations', async () => {
    const src = await readFile(resolve(DESKTOP_ROOT, 'src', 'main', 'main.ts'), 'utf8');
    const credentialStartup = src.indexOf('await runCredentialStartup();');
    const backgroundStartup = src.indexOf('const backgroundStartup = runBackgroundStartup();');
    const createWindow = src.indexOf('await mainWindowController.createWindow();', backgroundStartup);
    const secondInstance = src.indexOf("app.on('second-instance', focusOrCreateMainWindow);");
    const activate = src.indexOf("app.on('activate', focusOrCreateMainWindow);");

    assert.notEqual(credentialStartup, -1, 'startup must expose an awaited credential migration phase');
    assert.ok(
      credentialStartup < backgroundStartup && backgroundStartup < createWindow,
      'credential migration must finish before background startup opens the interactive window',
    );
    assert.ok(
      credentialStartup < secondInstance && credentialStartup < activate,
      'window-creation events must not be registered until credential migration finishes',
    );
  });
});
