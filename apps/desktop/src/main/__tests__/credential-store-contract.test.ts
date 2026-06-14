import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/main/credential-store.ts'), 'utf8');

describe('credential store secret-kind expansion contract', () => {
  it('keeps legacy connection secret key names backward compatible', () => {
    assert.match(source, /case 'api_key':\s*return 'apiKey';/);
    assert.match(source, /case 'oauth_token':\s*return 'oauthToken';/);
  });

  it('declares the Phase 1 settings secret kinds', () => {
    for (const kind of [
      'bot_token',
      'app_secret',
      'proxy_password',
      'gateway_token',
      'tavily_api_key',
    ]) {
      assert.match(source, new RegExp(`'${kind}'`), `${kind} must be a public CredentialKind`);
    }
  });

  it('exposes typed helpers for future settings migration without changing settings consumers', () => {
    for (const method of [
      'getBotToken',
      'setBotToken',
      'deleteBotToken',
      'getBotAppSecret',
      'setBotAppSecret',
      'deleteBotAppSecret',
      'getProxyPassword',
      'setProxyPassword',
      'deleteProxyPassword',
      'getGatewayToken',
      'setGatewayToken',
      'deleteGatewayToken',
      'getTavilyApiKey',
      'setTavilyApiKey',
      'deleteTavilyApiKey',
    ]) {
      assert.match(source, new RegExp(`${method}\\(`), `${method} must be present`);
    }
  });

  it('uses deterministic non-secret slugs for provider-scoped and global settings secrets', () => {
    assert.match(source, /const BOT_SECRET_SLUG_PREFIX = 'settings:bot';/);
    assert.match(source, /function botSecretSlug\(provider: BotProvider\): string \{\s*return `\$\{BOT_SECRET_SLUG_PREFIX\}:\$\{provider\}`;\s*\}/);
    assert.match(source, /const GLOBAL_PROXY_SECRET_SLUG = 'settings:network-proxy';/);
    assert.match(source, /const GLOBAL_GATEWAY_SECRET_SLUG = 'settings:open-gateway';/);
    assert.match(source, /const GLOBAL_TAVILY_SECRET_SLUG = 'settings:web-search:tavily';/);
    assert.doesNotMatch(source, /token\}:/, 'raw bot tokens must not be interpolated into key names');
    assert.doesNotMatch(source, /password\}:/, 'raw proxy passwords must not be interpolated into key names');
    assert.doesNotMatch(source, /secret\}:/, 'raw app secrets must not be interpolated into key names');
  });
});
