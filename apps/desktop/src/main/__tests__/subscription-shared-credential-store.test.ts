import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const MAIN_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');
const CLAUDE_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'oauth', 'claude-subscription-service.ts');
const CODEX_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'oauth', 'codex-subscription-service.ts');

describe('OAuth subscription shared credential store bridge', () => {
  for (const [name, source, slug] of [
    ['Claude', CLAUDE_SOURCE, 'claude-subscription'],
    ['Codex', CODEX_SOURCE, 'codex-subscription'],
  ] as const) {
    it(`${name} subscription persists and clears send-path tokens in the shared credential store`, async () => {
      const src = await readFile(source, 'utf8');

      assert.match(src, /credentialStore\?:/);
      assert.match(src, /serializeOAuthSubscriptionTokens/);
      assert.match(src, new RegExp(`setSecret\\(\\s*'${slug}',\\s*'oauth_token'`));
      assert.match(src, new RegExp(`getSecret\\(\\s*'${slug}',\\s*'oauth_token'`));
      assert.match(src, new RegExp(`deleteSecret\\(\\s*'${slug}',\\s*'oauth_token'`));
    });
  }

  it('desktop passes the live shared credential store into subscription services', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');

    assert.match(src, /new ClaudeSubscriptionService\(\{[\s\S]*credentialStore/);
    assert.match(src, /new CodexSubscriptionService\(\{[\s\S]*credentialStore/);
  });
});
