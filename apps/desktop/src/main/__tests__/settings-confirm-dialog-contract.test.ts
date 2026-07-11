import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readProviderSettingsCombinedSource } from './provider-contract-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

describe('Settings destructive confirm contract', () => {
  it('does not use native confirm dialogs in Settings renderer flows', async () => {
    const [settings, providers] = await Promise.all([
      readSettingsCombinedSource(),
      readProviderSettingsCombinedSource(),
    ]);
    const source = `${settings}\n${providers}`;

    assert.doesNotMatch(
      source,
      /(^|[^\w.])confirm\s*\(/,
      'Settings flows must use toast.confirm instead of the native blocking confirm() dialog',
    );
    assert.doesNotMatch(
      source,
      /window\.confirm\s*\(/,
      'Settings flows must not call window.confirm directly',
    );
  });

  it('routes OAuth, provider, memory restore, and WeChat destructive actions through toast.confirm', async () => {
    const [settings, providers, loginFlowHook] = await Promise.all([
      readSettingsCombinedSource(),
      readProviderSettingsCombinedSource(),
      // The browser-loopback logout confirm moved into the shared login-flow
      // hook when SubscriptionLoginModal was thinned onto useOAuthLoginFlow.
      readRepo('apps/desktop/src/renderer/settings/use-oauth-login-flow.ts'),
    ]);
    const providerSources = `${providers}\n${loginFlowHook}`;

    for (const title of [
      '退出 ${display.name} 登录？',
      '删除供应商 ${connection.name}？',
      '退出 Claude Code 登录？',
    ]) {
      assert.ok(providerSources.includes(`title: \`${title}\``) || providerSources.includes(`title: '${title}'`));
    }
    assert.match(loginFlowHook, /destructive:\s*true/, 'shared OAuth logout confirm must use destructive styling');

    for (const title of [
      '恢复上一版 MEMORY.md？',
      '恢复这个 MEMORY.md 备份？',
      '断开微信登录？',
    ]) {
      assert.ok(settings.includes(`title: '${title}'`), `SettingsModal must confirm "${title}" with the themed dialog`);
    }

    assert.match(providers, /destructive:\s*true/, 'provider destructive confirms must use destructive styling');
    assert.match(settings, /destructive:\s*true/, 'settings destructive confirms must use destructive styling');
  });
});
