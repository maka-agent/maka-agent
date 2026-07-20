import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileCredentialStore } from '@maka/storage';
import { createCodexOAuthHarnessCredentialResolver } from '../codex-oauth-harness.js';

test('Codex OAuth broker resolves the current host authority for every request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-codex-oauth-resolver-test-'));
  try {
    const store = createFileCredentialStore(root);
    const accountId = 'acct-shared';
    const firstAccessToken = jwt(accountId, 'first');
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: firstAccessToken,
        refresh_token: 'refresh-first',
        expires_at: Date.now() + 86_400_000,
        account_id: accountId,
      }),
    );
    const resolveCredential = await createCodexOAuthHarnessCredentialResolver({
      credentialsRoot: root,
      connectionSlug: 'codex-subscription',
    });

    const first = await resolveCredential();
    const secondAccessToken = jwt(accountId, 'second');
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: secondAccessToken,
        refresh_token: 'refresh-second',
        expires_at: Date.now() + 86_400_000,
        account_id: accountId,
      }),
    );
    const second = await resolveCredential();

    assert.equal(first.value, firstAccessToken);
    assert.equal(second.value, secondAccessToken);
    assert.equal(first.headers?.['ChatGPT-Account-Id'], accountId);
    assert.equal(second.headers?.['ChatGPT-Account-Id'], accountId);
    assert.equal(second.headers?.['OpenAI-Beta'], 'responses=experimental');
    assert.equal(second.headers?.originator, 'codex_cli_rs');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex OAuth broker refreshes and persists authority across a long run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-codex-oauth-refresh-test-'));
  try {
    const store = createFileCredentialStore(root);
    const accountId = 'acct-shared';
    let now = 1_000_000;
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: jwt(accountId, 'expired'),
        refresh_token: 'refresh-0',
        expires_at: now - 1,
        account_id: accountId,
      }),
    );
    let refreshCount = 0;
    const resolveCredential = await createCodexOAuthHarnessCredentialResolver({
      credentialsRoot: root,
      connectionSlug: 'codex-subscription',
      now: () => now,
      fetchFn: async () => {
        refreshCount += 1;
        return new Response(
          JSON.stringify({
            access_token: jwt(accountId, `refreshed-${refreshCount}`),
            refresh_token: `refresh-${refreshCount}`,
            expires_in: 3_600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    assert.equal((await resolveCredential()).value, jwt(accountId, 'refreshed-1'));
    now += 3_600_001;
    assert.equal((await resolveCredential()).value, jwt(accountId, 'refreshed-2'));
    assert.equal(refreshCount, 2);
    const persisted = JSON.parse(
      (await store.getSecret('codex-subscription', 'oauth_token')) ?? 'null',
    );
    assert.equal(persisted.refresh_token, 'refresh-2');
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
