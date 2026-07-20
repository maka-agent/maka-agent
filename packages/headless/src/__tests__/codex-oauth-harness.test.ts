import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createFileCredentialStore } from '@maka/storage';
import { withCodexOAuthHarnessCredentials } from '../codex-oauth-harness.js';

test('Codex OAuth harness shares one account through ephemeral 0600 credential files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-codex-oauth-test-'));
  let ephemeralPaths: { makaAccessTokenPath: string; codexAuthJsonPath: string } | undefined;
  try {
    const accountId = 'acct-shared';
    const makaAccessToken = jwt(accountId, 'maka');
    const codexAccessToken = jwt(accountId, 'codex');
    const store = createFileCredentialStore(root);
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: makaAccessToken,
        refresh_token: 'maka-refresh',
        expires_at: Date.now() + 86_400_000,
        account_id: accountId,
      }),
    );
    const sourceAuthPath = join(root, 'source-auth.json');
    await writeFile(
      sourceAuthPath,
      `${JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: codexAccessToken,
          refresh_token: 'codex-refresh',
          account_id: accountId,
        },
      })}\n`,
      { mode: 0o600 },
    );

    const result = await withCodexOAuthHarnessCredentials(
      {
        credentialsRoot: root,
        connectionSlug: 'codex-subscription',
        codexAuthJsonPath: sourceAuthPath,
      },
      async (paths) => {
        ephemeralPaths = paths;
        assert.equal(await readFile(paths.makaAccessTokenPath, 'utf8'), makaAccessToken);
        assert.equal(
          JSON.parse(await readFile(paths.codexAuthJsonPath, 'utf8')).tokens.access_token,
          codexAccessToken,
        );
        assert.equal((await stat(paths.makaAccessTokenPath)).mode & 0o777, 0o600);
        assert.equal((await stat(paths.codexAuthJsonPath)).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(paths.makaAccessTokenPath))).mode & 0o777, 0o700);
        return 'completed';
      },
    );

    assert.equal(result, 'completed');
    assert.ok(ephemeralPaths);
    await assert.rejects(access(ephemeralPaths.makaAccessTokenPath), { code: 'ENOENT' });
    await assert.rejects(access(ephemeralPaths.codexAuthJsonPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function jwt(accountId: string, suffix: string): string {
  const encoded = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, suffix }),
  ).toString('base64url');
  return `header.${encoded}.signature`;
}
