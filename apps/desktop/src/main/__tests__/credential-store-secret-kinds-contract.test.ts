import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { BotProvider } from '@maka/core';
import type { CredentialKind, CredentialStore } from '../credential-store.js';

const repoRoot = process.cwd().endsWith(join('apps', 'desktop'))
  ? resolve(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), 'utf8');
}

const credentialKinds: CredentialKind[] = [
  'api_key',
  'oauth_token',
  'bot_token',
  'app_secret',
  'proxy_password',
  'gateway_token',
  'tavily_api_key',
];

type Phase4CredentialStoreMethods = Pick<
  CredentialStore,
  | 'getBotToken'
  | 'setBotToken'
  | 'deleteBotToken'
  | 'getBotAppSecret'
  | 'setBotAppSecret'
  | 'deleteBotAppSecret'
  | 'getProxyPassword'
  | 'setProxyPassword'
  | 'deleteProxyPassword'
  | 'getGatewayToken'
  | 'setGatewayToken'
  | 'deleteGatewayToken'
  | 'getTavilyApiKey'
  | 'setTavilyApiKey'
  | 'deleteTavilyApiKey'
>;

type BotScopedSetter = (provider: BotProvider, secret: string) => Promise<void>;
const botScopedSetter: BotScopedSetter = null as unknown as Phase4CredentialStoreMethods['setBotToken'];

void credentialKinds;
void botScopedSetter;

describe('credential-store secret kind expansion contract', () => {
  it('exposes the Phase 4 credential kinds without changing legacy stored kind names', async () => {
    const source = await readRepo('apps/desktop/src/main/credential-store.ts');

    for (const kind of credentialKinds) {
      assert.match(source, new RegExp(`'${kind}'`), `CredentialKind must include ${kind}`);
    }

    assert.match(source, /case 'api_key':\s*return 'apiKey';/, 'api_key must keep the legacy stored key suffix');
    assert.match(source, /case 'oauth_token':\s*return 'oauthToken';/, 'oauth_token must keep the legacy stored key suffix');
    assert.match(source, /getApiKey\(slug: string\)[\s\S]*?return this\.get\(slug, 'apiKey'\);/);
    assert.match(source, /setApiKey\(slug: string, apiKey: string\)[\s\S]*?return this\.set\(slug, 'apiKey', apiKey\);/);
    assert.match(source, /getOAuthToken\(slug: string\)[\s\S]*?return this\.get\(slug, 'oauthToken'\);/);
    assert.match(source, /setOAuthToken\(slug: string, token: string\)[\s\S]*?return this\.set\(slug, 'oauthToken', token\);/);
    assert.match(source, /private key\(slug: string, kind: StoredCredentialKind\): string \{\s*return `\$\{slug\}:\$\{kind\}`;\s*\}/);
  });

  it('scopes bot token and app-secret helpers by provider and kind', async () => {
    const source = await readRepo('apps/desktop/src/main/credential-store.ts');

    assert.match(source, /const BOT_SECRET_SLUG_PREFIX = 'settings:bot';/);
    assert.match(source, /function botSecretSlug\(provider: BotProvider\): string \{\s*return `\$\{BOT_SECRET_SLUG_PREFIX\}:\$\{provider\}`;\s*\}/);
    assert.match(source, /getBotToken\(provider: BotProvider\)[\s\S]*return this\.get\(botSecretSlug\(provider\), 'botToken'\);/);
    assert.match(source, /setBotToken\(provider: BotProvider, token: string\)[\s\S]*return this\.set\(botSecretSlug\(provider\), 'botToken', token\);/);
    assert.match(source, /deleteBotToken\(provider: BotProvider\)[\s\S]*return this\.deleteSecret\(botSecretSlug\(provider\), 'bot_token'\);/);
    assert.match(source, /getBotAppSecret\(provider: BotProvider\)[\s\S]*return this\.get\(botSecretSlug\(provider\), 'botAppSecret'\);/);
    assert.match(source, /setBotAppSecret\(provider: BotProvider, secret: string\)[\s\S]*return this\.set\(botSecretSlug\(provider\), 'botAppSecret', secret\);/);
    assert.match(source, /deleteBotAppSecret\(provider: BotProvider\)[\s\S]*return this\.deleteSecret\(botSecretSlug\(provider\), 'app_secret'\);/);
    assert.doesNotMatch(source, /botSecretSlug\([^)]*(token|secret|value|apiKey|password|key)[^)]*\)/);
  });

  it('uses isolated singleton slugs for global secret helpers', async () => {
    const source = await readRepo('apps/desktop/src/main/credential-store.ts');

    assert.match(source, /const GLOBAL_PROXY_SECRET_SLUG = 'settings:network-proxy';/);
    assert.match(source, /const GLOBAL_GATEWAY_SECRET_SLUG = 'settings:open-gateway';/);
    assert.match(source, /const GLOBAL_TAVILY_SECRET_SLUG = 'settings:web-search:tavily';/);
    assert.match(source, /getProxyPassword\(\)[\s\S]*return this\.get\(GLOBAL_PROXY_SECRET_SLUG, 'proxyPassword'\);/);
    assert.match(source, /setProxyPassword\(password: string\)[\s\S]*return this\.set\(GLOBAL_PROXY_SECRET_SLUG, 'proxyPassword', password\);/);
    assert.match(source, /deleteProxyPassword\(\)[\s\S]*return this\.deleteSecret\(GLOBAL_PROXY_SECRET_SLUG, 'proxy_password'\);/);
    assert.match(source, /getGatewayToken\(\)[\s\S]*return this\.get\(GLOBAL_GATEWAY_SECRET_SLUG, 'gatewayToken'\);/);
    assert.match(source, /setGatewayToken\(token: string\)[\s\S]*return this\.set\(GLOBAL_GATEWAY_SECRET_SLUG, 'gatewayToken', token\);/);
    assert.match(source, /deleteGatewayToken\(\)[\s\S]*return this\.deleteSecret\(GLOBAL_GATEWAY_SECRET_SLUG, 'gateway_token'\);/);
    assert.match(source, /getTavilyApiKey\(\)[\s\S]*return this\.get\(GLOBAL_TAVILY_SECRET_SLUG, 'tavilyApiKey'\);/);
    assert.match(source, /setTavilyApiKey\(key: string\)[\s\S]*return this\.set\(GLOBAL_TAVILY_SECRET_SLUG, 'tavilyApiKey', key\);/);
    assert.match(source, /deleteTavilyApiKey\(\)[\s\S]*return this\.deleteSecret\(GLOBAL_TAVILY_SECRET_SLUG, 'tavily_api_key'\);/);
  });

  it('keeps credential writes encrypted, fail-closed, and in the existing file shape', async () => {
    const source = await readRepo('apps/desktop/src/main/credential-store.ts');
    const setBlock = source.match(/private async set\([^)]*\): Promise<void> \{[\s\S]*?\n  \}/);
    const getBlock = source.match(/private async get\([^)]*\): Promise<string \| null> \{[\s\S]*?\n  \}/);
    const readBlock = source.match(/private async readUnlocked\(\): Promise<CredentialFile> \{[\s\S]*?\n  \}/);

    assert.ok(setBlock, 'set helper must exist');
    assert.ok(getBlock, 'get helper must exist');
    assert.ok(readBlock, 'readUnlocked helper must exist');
    assert.match(setBlock![0], /if \(!safeStorage\.isEncryptionAvailable\(\)\) \{[\s\S]*throw new Error/);
    assert.match(setBlock![0], /file\.values\[this\.key\(slug, kind\)\] = safeStorage\.encryptString\(value\)\.toString\('base64'\);/);
    assert.match(getBlock![0], /if \(!encrypted\) return null;/);
    assert.match(getBlock![0], /safeStorage\.decryptString\(Buffer\.from\(encrypted, 'base64'\)\)/);
    assert.match(readBlock![0], /ENOENT'[\s\S]*return \{ values: \{\} \};/);
    assert.match(source, /interface CredentialFile \{\s*values: Record<string, string>;\s*\}/);
    assert.match(source, /JSON\.stringify\(file, null, 2\) \+ '\\n'/);
    assert.doesNotMatch(source, /writeFile\([^)]*value/);
  });

  it('keeps delete helpers idempotent and targeted', async () => {
    const source = await readRepo('apps/desktop/src/main/credential-store.ts');
    const deleteSecretBlock = source.match(/async deleteSecret\([^)]*\): Promise<void> \{[\s\S]*?\n  \}/);
    const deleteBlock = source.match(/async delete\(slug: string\): Promise<void> \{[\s\S]*?\n  \}/);

    assert.ok(deleteSecretBlock, 'deleteSecret helper must exist');
    assert.ok(deleteBlock, 'delete helper must exist');
    assert.match(deleteSecretBlock![0], /delete file\.values\[this\.key\(slug, toStoredKind\(kind\)\)\];/);
    assert.doesNotMatch(deleteSecretBlock![0], /if \([^)]*values\[this\.key/, 'targeted delete should remain idempotent when missing');
    assert.match(deleteBlock![0], /for \(const kind of STORED_CREDENTIAL_KINDS\)/);
    assert.match(source, /'apiKey'[\s\S]*'oauthToken'[\s\S]*'botToken'[\s\S]*'botAppSecret'[\s\S]*'proxyPassword'[\s\S]*'gatewayToken'[\s\S]*'tavilyApiKey'/);
  });

  it('does not start settings migration or change renderer-facing settings masking in this phase', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const helpers = await readRepo('apps/desktop/src/main/settings-ipc-helpers.ts');

    assert.match(main, /ipcMain\.handle\('settings:get', async \(\) => maskAppSettings\(await settingsStore\.get\(\)\)\);/);
    assert.doesNotMatch(main, /credentialStore\.(getBotToken|getBotAppSecret|getProxyPassword|getGatewayToken|getTavilyApiKey)/);
    assert.match(helpers, /password: shouldReveal\(revealPatch\.network\?\.proxy\?\.password\)/);
    assert.match(helpers, /token: shouldReveal\(revealPatch\.botChat\?\.channels\?\.\[provider as BotProvider\]\?\.token\)/);
    assert.match(helpers, /appSecret: shouldReveal\(revealPatch\.botChat\?\.channels\?\.\[provider as BotProvider\]\?\.appSecret\)/);
    assert.match(helpers, /token: shouldReveal\(revealPatch\.openGateway\?\.token\)/);
    assert.match(helpers, /apiKey: maskSensitive\(settings\.webSearch\.providers\.tavily\.apiKey\) \?\? ''/);
  });
});
