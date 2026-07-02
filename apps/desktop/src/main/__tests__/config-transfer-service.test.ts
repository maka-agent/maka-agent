import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AppSettings } from '@maka/core';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { CredentialKind } from '@maka/storage';
import { applyConfigImport, gatherConfigExport, type ConfigTransferDeps } from '../config-transfer-service.js';

function conn(slug: string): LlmConnection {
  return {
    slug,
    name: slug,
    providerType: 'deepseek',
    defaultModel: 'deepseek-v4-pro',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function settingsWithSecrets(): AppSettings {
  return {
    theme: 'dark',
    network: { proxy: { password: 'proxy-secret' } },
    botChat: { channels: { telegram: { token: 'bot-secret', appSecret: 'app-secret' } } },
    openGateway: { token: 'gw-secret' },
    webSearch: { providers: { tavily: { apiKey: 'tavily-secret' } } },
  } as unknown as AppSettings;
}

function makeDeps(overrides: Partial<ConfigTransferDeps> = {}): {
  deps: ConfigTransferDeps;
  saved: LlmConnection[];
  updatedSettings: unknown[];
  setCreds: Array<{ slug: string; kind: CredentialKind; value: string }>;
  writtenMemory: string[];
} {
  const saved: LlmConnection[] = [];
  const updatedSettings: unknown[] = [];
  const setCreds: Array<{ slug: string; kind: CredentialKind; value: string }> = [];
  const writtenMemory: string[] = [];
  const secretsBySlugKind = new Map<string, string>([['deepseek-main::api_key', 'sk-real-key']]);
  const deps: ConfigTransferDeps = {
    appVersion: '0.1.0',
    connectionStore: {
      list: async () => [conn('deepseek-main')],
      save: async (c) => {
        saved.push(c);
        return c;
      },
    },
    settingsStore: {
      get: async () => settingsWithSecrets(),
      update: async (patch) => {
        updatedSettings.push(patch);
        return patch as unknown as AppSettings;
      },
    },
    credentialStore: {
      getSecret: async (slug, kind) => secretsBySlugKind.get(`${slug}::${kind}`) ?? null,
      setSecret: async (slug, kind, value) => {
        setCreds.push({ slug, kind, value });
      },
    },
    readMemory: async () => '# MEMORY\n- note',
    writeMemory: async (content) => {
      writtenMemory.push(content);
    },
    ...overrides,
  };
  return { deps, saved, updatedSettings, setCreds, writtenMemory };
}

describe('config-transfer-service', () => {
  it('exports only selected categories', async () => {
    const { deps } = makeDeps();
    const bundle = await gatherConfigExport(['connections'], deps);
    assert.deepEqual(bundle.includedData, ['connections']);
    assert.equal(bundle.data.settings, undefined);
    assert.equal(bundle.data.credentials, undefined);
  });

  it('strips settings secrets when credentials are NOT included', async () => {
    const { deps } = makeDeps();
    const bundle = await gatherConfigExport(['settings'], deps);
    const s = bundle.data.settings as Record<string, any>;
    assert.equal(s.network.proxy.password, '');
    assert.equal(s.botChat.channels.telegram.token, '');
    assert.equal(s.openGateway.token, '');
    assert.equal(s.webSearch.providers.tavily.apiKey, '');
    assert.equal(s.theme, 'dark', 'non-secret fields pass through');
  });

  it('keeps settings secrets and enumerates credentials when credentials ARE included', async () => {
    const { deps } = makeDeps();
    const bundle = await gatherConfigExport(['settings', 'credentials'], deps);
    const s = bundle.data.settings as Record<string, any>;
    assert.equal(s.network.proxy.password, 'proxy-secret', 'secrets retained alongside credentials');
    assert.deepEqual(bundle.data.credentials, [
      { slug: 'deepseek-main', kind: 'api_key', value: 'sk-real-key' },
    ]);
  });

  it('applies an imported bundle to the stores and summarizes', async () => {
    const { deps, saved, updatedSettings, setCreds, writtenMemory } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'settings', 'credentials', 'memory'] as const,
      data: {
        connections: [conn('deepseek-main'), conn('brand-new')],
        settings: { theme: 'light' },
        credentials: [{ slug: 'brand-new', kind: 'api_key', value: 'sk-imported' }],
        memory: '# imported memory',
      },
    };
    const result = await applyConfigImport(bundle as any, 'skip', deps);
    // deepseek-main exists -> skipped; brand-new -> created
    assert.deepEqual(result.connections, { created: 1, overwritten: 0, skipped: 1 });
    assert.deepEqual(saved.map((c) => c.slug), ['brand-new']);
    assert.equal(result.settings?.applied, true);
    assert.equal(updatedSettings.length, 1);
    assert.deepEqual(setCreds, [{ slug: 'brand-new', kind: 'api_key', value: 'sk-imported' }]);
    assert.equal(result.credentials?.applied, 1);
    assert.deepEqual(writtenMemory, ['# imported memory']);
  });
});
