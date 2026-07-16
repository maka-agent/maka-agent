/**
 * Unit tests for the authoritative OAuth token persistence layer
 * (#1125): CredentialStore-backed save/load/delete plus the one-shot
 * import of legacy safeStorage-encrypted token files. Exercised
 * against the real pure-Node FileCredentialStore in a tmpdir so the
 * on-disk contract (v1 schema, 0600 perms) is covered end to end.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createFileCredentialStore, type CredentialStore } from '@maka/storage';
import {
  deleteSharedOAuthTokens,
  importLegacyOAuthTokenFiles,
  loadSharedOAuthTokens,
  saveSharedOAuthTokens,
  type LegacySafeStorageDecryptor,
} from '../oauth/shared-credential-bridge.js';

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_at: 1_800_000_000_000,
  account_uuid: 'uuid-1',
};

const tempRoots: string[] = [];
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-oauth-bridge-'));
  tempRoots.push(root);
  return root;
}
after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Reversible stand-in for safeStorage: "encryption" is base64. */
function fakeDecryptor(overrides: Partial<LegacySafeStorageDecryptor> = {}): LegacySafeStorageDecryptor {
  return {
    isEncryptionAvailable: () => true,
    decryptString: (encrypted: Buffer) => Buffer.from(encrypted.toString('utf8'), 'base64').toString('utf8'),
    ...overrides,
  };
}

function encryptedTokenFileContents(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

describe('shared OAuth token persistence (store authority)', () => {
  it('round-trips tokens through the credential store', async () => {
    const store = createFileCredentialStore(await makeWorkspace());
    await saveSharedOAuthTokens(store, 'claude-subscription', TOKENS);
    const result = await loadSharedOAuthTokens(store, 'claude-subscription');
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.tokens, TOKENS);
  });

  it('reports missing tokens as missing', async () => {
    const store = createFileCredentialStore(await makeWorkspace());
    assert.deepEqual(await loadSharedOAuthTokens(store, 'claude-subscription'), { status: 'missing' });
  });

  it('save propagates store failures instead of swallowing them', async () => {
    await assert.rejects(
      saveSharedOAuthTokens(
        { setSecret: async () => { throw new Error('store down'); } },
        'claude-subscription',
        TOKENS,
      ),
      /store down/,
    );
  });

  it('load propagates store read failures (fail closed, not logged out)', async () => {
    const workspaceRoot = await makeWorkspace();
    await writeFile(join(workspaceRoot, 'credentials.json'), '{"version":999,"values":{}}');
    const store = createFileCredentialStore(workspaceRoot);
    await assert.rejects(loadSharedOAuthTokens(store, 'claude-subscription'), /schema version/);
  });

  it('keeps an unparseable entry intact and reports corrupt (reads never destroy secrets)', async () => {
    const store = createFileCredentialStore(await makeWorkspace());
    await store.setSecret('claude-subscription', 'oauth_token', 'not-a-token-payload');
    assert.deepEqual(await loadSharedOAuthTokens(store, 'claude-subscription'), { status: 'corrupt' });
    assert.equal(await store.getSecret('claude-subscription', 'oauth_token'), 'not-a-token-payload');
    // A fresh login overwrites the corrupt entry — no delete needed to unstick.
    await saveSharedOAuthTokens(store, 'claude-subscription', TOKENS);
    assert.equal((await loadSharedOAuthTokens(store, 'claude-subscription')).status, 'ok');
  });

  it('delete removes the entry and leaves other kinds intact', async () => {
    const store = createFileCredentialStore(await makeWorkspace());
    await store.setSecret('claude-subscription', 'api_key', 'sk-keep');
    await saveSharedOAuthTokens(store, 'claude-subscription', TOKENS);
    await deleteSharedOAuthTokens(store, 'claude-subscription');
    assert.equal(await store.getSecret('claude-subscription', 'oauth_token'), null);
    assert.equal(await store.getSecret('claude-subscription', 'api_key'), 'sk-keep');
  });
});

describe('legacy safeStorage token file import (one-shot)', () => {
  it('imports a decryptable token file into the store and removes the file', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: store,
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.deepEqual(reports.map((r) => r.outcome), ['imported']);
    const result = await loadSharedOAuthTokens(store, 'claude-subscription');
    assert.equal(result.status === 'ok' && result.tokens.access_token, TOKENS.access_token);
    await assert.rejects(stat(filePath), { code: 'ENOENT' });
  });

  it('is a no-op for missing files and reports nothing', async () => {
    const workspaceRoot = await makeWorkspace();
    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: createFileCredentialStore(workspaceRoot),
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath: join(workspaceRoot, '.absent') }],
    });
    assert.deepEqual(reports, []);
  });

  it('never clobbers an existing store token; removes the stale file as superseded', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    const fresher = { ...TOKENS, access_token: 'fresher-from-cli-refresh' };
    await saveSharedOAuthTokens(store, 'claude-subscription', fresher);
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: store,
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.deepEqual(reports.map((r) => r.outcome), ['superseded']);
    const result = await loadSharedOAuthTokens(store, 'claude-subscription');
    assert.equal(result.status === 'ok' && result.tokens.access_token, 'fresher-from-cli-refresh');
    await assert.rejects(stat(filePath), { code: 'ENOENT' });
  });

  it('does not resurrect a legacy token after logout wins the serialized check', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await saveSharedOAuthTokens(store, 'claude-subscription', TOKENS);
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));
    let compareAndSetCalls = 0;
    assert.ok(store.compareAndSetSecret);
    const racingStore: CredentialStore = {
      getSecret: (slug, kind) => store.getSecret(slug, kind),
      setSecret: (slug, kind, value) => store.setSecret(slug, kind, value),
      deleteSecret: (slug, kind) => store.deleteSecret(slug, kind),
      compareAndSetSecret: async (slug, kind, expected, value) => {
        compareAndSetCalls += 1;
        if (compareAndSetCalls === 1) {
          await unlink(filePath);
          await store.deleteSecret(slug, kind);
        }
        return store.compareAndSetSecret!(slug, kind, expected, value);
      },
    };

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: racingStore,
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.equal(await store.getSecret('claude-subscription', 'oauth_token'), null);
    assert.equal(compareAndSetCalls, 1, 'a lost serialized check must never rebase the legacy write');
    assert.deepEqual(reports.map((report) => report.outcome), ['superseded']);
    await assert.rejects(stat(filePath), { code: 'ENOENT' });
  });

  it('does not rebase a legacy import over an unparseable concurrent write', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await saveSharedOAuthTokens(store, 'claude-subscription', TOKENS);
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));
    let compareAndSetCalls = 0;
    assert.ok(store.compareAndSetSecret);
    const racingStore: CredentialStore = {
      getSecret: (slug, kind) => store.getSecret(slug, kind),
      setSecret: (slug, kind, value) => store.setSecret(slug, kind, value),
      deleteSecret: (slug, kind) => store.deleteSecret(slug, kind),
      compareAndSetSecret: async (slug, kind, expected, value) => {
        compareAndSetCalls += 1;
        if (compareAndSetCalls === 1) await store.setSecret(slug, kind, 'concurrent-unparseable');
        return store.compareAndSetSecret!(slug, kind, expected, value);
      },
    };

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: racingStore,
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.equal(await store.getSecret('claude-subscription', 'oauth_token'), 'concurrent-unparseable');
    assert.equal(compareAndSetCalls, 1, 'a lost serialized check must never change its basis');
    assert.deepEqual(reports.map((report) => report.outcome), ['failed']);
    assert.equal((await stat(filePath)).isFile(), true);
  });

  it('does not overwrite a token committed after the import read its basis', async () => {
    const workspaceRoot = await makeWorkspace();
    const importingStore = createFileCredentialStore(workspaceRoot);
    const concurrentStore = createFileCredentialStore(workspaceRoot);
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));
    const concurrentTokens = { ...TOKENS, access_token: 'concurrent-live-token' };
    const concurrentRaw = JSON.stringify(concurrentTokens);
    const racingStore: CredentialStore = {
      getSecret: (slug, kind) => importingStore.getSecret(slug, kind),
      setSecret: async (slug, kind, value) => {
        await concurrentStore.setSecret(slug, kind, concurrentRaw);
        await importingStore.setSecret(slug, kind, value);
      },
      deleteSecret: (slug, kind) => importingStore.deleteSecret(slug, kind),
      compareAndSetSecret: async (slug, kind, expected, value) => {
        await concurrentStore.setSecret(slug, kind, concurrentRaw);
        assert.ok(importingStore.compareAndSetSecret);
        return importingStore.compareAndSetSecret(slug, kind, expected, value);
      },
    };

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: racingStore,
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.deepEqual(reports.map((report) => report.outcome), ['superseded']);
    const stored = await loadSharedOAuthTokens(concurrentStore, 'claude-subscription');
    assert.equal(stored.status === 'ok' && stored.tokens.access_token, concurrentTokens.access_token);
    await assert.rejects(stat(filePath), { code: 'ENOENT' });
  });

  it('a garbage store entry does not supersede a valid legacy file', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    await store.setSecret('claude-subscription', 'oauth_token', 'stored-garbage');
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: store,
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.deepEqual(reports.map((r) => r.outcome), ['imported']);
    const result = await loadSharedOAuthTokens(store, 'claude-subscription');
    assert.equal(result.status === 'ok' && result.tokens.access_token, TOKENS.access_token);
    await assert.rejects(stat(filePath), { code: 'ENOENT' });
  });

  it('leaves the file intact when decryption is unavailable', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: store,
      decryptor: fakeDecryptor({ isEncryptionAvailable: () => false }),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.deepEqual(reports.map((r) => r.outcome), ['left-encrypted']);
    assert.equal(await store.getSecret('claude-subscription', 'oauth_token'), null);
    await stat(filePath); // still present
  });

  it('leaves the file intact when decryption throws (keychain denied)', async () => {
    const workspaceRoot = await makeWorkspace();
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: createFileCredentialStore(workspaceRoot),
      decryptor: fakeDecryptor({ decryptString: () => { throw new Error('denied'); } }),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.deepEqual(reports.map((r) => r.outcome), ['left-encrypted']);
    await stat(filePath); // still present, retried next start
  });

  it('keeps a file whose decrypted payload is not a token this build can parse', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await writeFile(filePath, Buffer.from('{"not":"a token"}', 'utf8').toString('base64'));

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: store,
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath }],
    });

    assert.deepEqual(reports.map((r) => r.outcome), ['left-unparseable']);
    assert.equal(await store.getSecret('claude-subscription', 'oauth_token'), null);
    await stat(filePath); // kept — only an explicit logout destroys it
  });

  it('reports per-file failures without throwing and continues with the rest', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    const failingPath = join(workspaceRoot, '.claude_subscription_token');
    const okPath = join(workspaceRoot, '.codex_subscription_token');
    await writeFile(failingPath, encryptedTokenFileContents(TOKENS));
    await writeFile(okPath, encryptedTokenFileContents({ ...TOKENS, account_id: 'acct-1' }));

    const reports = await importLegacyOAuthTokenFiles({
      credentialStore: {
        getSecret: async (slug) => {
          if (slug === 'claude-subscription') throw new Error('store exploded');
          return store.getSecret(slug, 'oauth_token');
        },
        setSecret: (slug, kind, value) => store.setSecret(slug, kind, value),
      },
      decryptor: fakeDecryptor(),
      files: [
        { slug: 'claude-subscription', filePath: failingPath },
        { slug: 'codex-subscription', filePath: okPath },
      ],
    });

    assert.deepEqual(reports.map((r) => r.outcome), ['failed', 'imported']);
    await stat(failingPath); // failed file left intact
    assert.equal((await loadSharedOAuthTokens(store, 'codex-subscription')).status, 'ok');
  });

  it('keeps credentials.json owner-only after an import', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createFileCredentialStore(workspaceRoot);
    const filePath = join(workspaceRoot, '.claude_subscription_token');
    await writeFile(filePath, encryptedTokenFileContents(TOKENS));
    await importLegacyOAuthTokenFiles({
      credentialStore: store,
      decryptor: fakeDecryptor(),
      files: [{ slug: 'claude-subscription', filePath }],
    });
    if (process.platform !== 'win32') {
      const mode = (await stat(join(workspaceRoot, 'credentials.json'))).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    const raw = await readFile(join(workspaceRoot, 'credentials.json'), 'utf8');
    assert.match(raw, /"version": 1/);
  });
});
