import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  migrateLegacyCredentialFile,
  type LegacyCredentialDecryptor,
} from '../credential-store.js';

// Behavioral tests over real temp files for the one-time migration. The
// decryptor is injected (the crypto is the caller's concern), so these run
// under plain `node --test`. No fixed sleeps: concurrency is proven by racing
// two real migrations, not by waiting a guessed number of milliseconds.

/** Fake decryptor: "decrypt" strips an `enc:` prefix so every value is proven
 *  to round-trip through decrypt(). */
function fakeDecryptor(available: boolean): LegacyCredentialDecryptor {
  return {
    isAvailable: () => available,
    decrypt: (stored) => stored.replace(/^enc:/, ''),
  };
}

function legacyFile(values: Record<string, string>): string {
  return JSON.stringify({ values });
}

async function withWorkspace<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'maka-cred-mig-'));
  try {
    return await fn(join(root, 'credentials.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const isPosix = process.platform !== 'win32';

describe('migrateLegacyCredentialFile', () => {
  it('decrypts ALL secret kinds to v1 plaintext-0600 in place', async () => {
    await withWorkspace(async (path) => {
      // Full scope: not just API keys — bot/proxy/etc. secrets migrate too.
      await writeFile(
        path,
        legacyFile({
          'openai:apiKey': 'enc:sk-1',
          'settings:bot:telegram:botToken': 'enc:tok-2',
          'settings:network-proxy:proxyPassword': 'enc:pw-3',
        }),
        'utf8',
      );

      await migrateLegacyCredentialFile(path, fakeDecryptor(true));

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
      if (isPosix) {
        assert.equal((await stat(path)).mode & 0o777, 0o600); // owner-only at rest
      }
    });
  });

  it('aborts and leaves the legacy file intact when the decryptor is unavailable', async () => {
    await withWorkspace(async (path) => {
      const original = legacyFile({ 'openai:apiKey': 'enc:sk-1' });
      await writeFile(path, original, 'utf8');

      await assert.rejects(migrateLegacyCredentialFile(path, fakeDecryptor(false)), /unavailable/);
      assert.equal(await readFile(path, 'utf8'), original); // untouched — no data loss
    });
  });

  it('migrates an EMPTY legacy file even when the decryptor is unavailable', async () => {
    await withWorkspace(async (path) => {
      // A user who deleted their last secret under the old store left `values: {}`.
      // There is nothing to decrypt, so an unavailable decryptor must NOT block
      // the stamp — otherwise the v1 store (which refuses unversioned files)
      // would be permanently unusable for that workspace.
      await writeFile(path, legacyFile({}), 'utf8');

      await migrateLegacyCredentialFile(path, fakeDecryptor(false));

      const after = JSON.parse(await readFile(path, 'utf8')) as {
        version: number;
        values: Record<string, string>;
      };
      assert.equal(after.version, 1);
      assert.deepEqual(after.values, {});
    });
  });

  it('is a no-op on an already-migrated v1 file', async () => {
    await withWorkspace(async (path) => {
      const v1 = JSON.stringify({ version: 1, values: { 'openai:apiKey': 'sk-1' } });
      await writeFile(path, v1, 'utf8');

      await migrateLegacyCredentialFile(path, fakeDecryptor(true));
      assert.equal(await readFile(path, 'utf8'), v1); // unchanged
    });
  });

  it('does not wait on a leftover lock when the file is already v1', async () => {
    await withWorkspace(async (path) => {
      const v1 = JSON.stringify({ version: 1, values: { 'openai:apiKey': 'sk-1' } });
      await writeFile(path, v1, 'utf8');
      await mkdir(`${path}.lock`);

      await migrateLegacyCredentialFile(path, fakeDecryptor(true));

      assert.equal(await readFile(path, 'utf8'), v1); // unchanged
      await stat(`${path}.lock`); // still owned by whoever left it behind
    });
  });

  it('refuses a malformed legacy file rather than tombstone it empty', async () => {
    await withWorkspace(async (path) => {
      const malformed = JSON.stringify({ foo: 1 }); // no version, no values
      await writeFile(path, malformed, 'utf8');

      await assert.rejects(migrateLegacyCredentialFile(path, fakeDecryptor(true)), /malformed/);
      assert.equal(await readFile(path, 'utf8'), malformed); // untouched
    });
  });

  it('refuses a legacy file whose values are not all strings, leaving it untouched', async () => {
    // A number, null, or nested object can't be a safeStorage-encrypted string;
    // it must fail closed BEFORE reaching the decryptor (mirrors the v1 reader),
    // not be fed garbage to decrypt.
    for (const badValue of ['123', 'null', '{ "nested": "no" }']) {
      await withWorkspace(async (path) => {
        const original = `{ "values": { "x:apiKey": ${badValue} } }`;
        await writeFile(path, original, 'utf8');

        await assert.rejects(
          migrateLegacyCredentialFile(path, fakeDecryptor(true)),
          /not a string/,
        );
        assert.equal(await readFile(path, 'utf8'), original); // byte-for-byte untouched
      });
    }
  });

  it('is a no-op when there is no credentials file', async () => {
    await withWorkspace(async (path) => {
      await migrateLegacyCredentialFile(path, fakeDecryptor(true));
      await assert.rejects(stat(path)); // still absent, no file created
    });
  });

  it('serializes two racing migrations: one migrates, the other no-ops on the re-read', async () => {
    await withWorkspace(async (path) => {
      await writeFile(path, legacyFile({ 'openai:apiKey': 'enc:sk-1' }), 'utf8');

      // The shared lock serializes the two; the loser re-reads inside the lock,
      // sees v1, and no-ops instead of decrypting a stale snapshot again. Both
      // resolve cleanly and the result is the single correct v1 file.
      await Promise.all([
        migrateLegacyCredentialFile(path, fakeDecryptor(true)),
        migrateLegacyCredentialFile(path, fakeDecryptor(true)),
      ]);

      const after = JSON.parse(await readFile(path, 'utf8')) as {
        version: number;
        values: Record<string, string>;
      };
      assert.equal(after.version, 1);
      assert.deepEqual(after.values, { 'openai:apiKey': 'sk-1' });
    });
  });
});
