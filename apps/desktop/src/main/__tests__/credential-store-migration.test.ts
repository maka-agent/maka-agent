import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { migrateLegacyCredentials, type SafeStorageLike } from '../credential-store.js';

// The migration ORCHESTRATION — shared lock, version gate, fail-closed aborts,
// atomic 0600 rewrite, idempotency, malformed/missing handling — is tested in
// @maka/storage against migrateLegacyCredentialFile. This file covers only the
// desktop GLUE: that safeStorage is wired through correctly (base64-decode then
// decryptString) and that its availability is propagated.

/** Fake safeStorage: "decrypt" strips an `enc:` prefix so every value is proven
 *  to round-trip through decryptString. */
function fakeSafeStorage(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
  };
}

/** The legacy on-disk encoding: base64(safeStorage.encryptString(value)). */
function encrypted(value: string): string {
  return Buffer.from(`enc:${value}`).toString('base64');
}

async function withWorkspace<T>(fn: (root: string, path: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'maka-cred-mig-'));
  try {
    return await fn(root, join(root, 'credentials.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('migrateLegacyCredentials (desktop safeStorage glue)', () => {
  it('base64-decodes and safeStorage-decrypts every kind to v1 plaintext-0600', async () => {
    await withWorkspace(async (root, path) => {
      // Full scope: API key + bot token + proxy password all migrate.
      await writeFile(
        path,
        JSON.stringify({
          values: {
            'openai:apiKey': encrypted('sk-1'),
            'settings:bot:telegram:botToken': encrypted('tok-2'),
            'settings:network-proxy:proxyPassword': encrypted('pw-3'),
          },
        }),
        'utf8',
      );

      await migrateLegacyCredentials(root, fakeSafeStorage(true));

      const after = JSON.parse(await readFile(path, 'utf8')) as {
        version: number;
        values: Record<string, string>;
      };
      assert.equal(after.version, 1);
      assert.deepEqual(after.values, {
        'openai:apiKey': 'sk-1',
        'settings:bot:telegram:botToken': 'tok-2',
        'settings:network-proxy:proxyPassword': 'pw-3',
      });
      if (process.platform !== 'win32') {
        assert.equal((await stat(path)).mode & 0o777, 0o600); // owner-only at rest
      }
    });
  });

  it('propagates safeStorage unavailability: aborts and leaves the file intact', async () => {
    await withWorkspace(async (root, path) => {
      const original = JSON.stringify({ values: { 'openai:apiKey': encrypted('sk-1') } });
      await writeFile(path, original, 'utf8');

      await assert.rejects(migrateLegacyCredentials(root, fakeSafeStorage(false)), /unavailable/);
      assert.equal(await readFile(path, 'utf8'), original); // untouched — no data loss
    });
  });
});
