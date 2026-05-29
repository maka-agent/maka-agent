import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Bot settings UI contract', () => {
  it('keeps platform rows scannable with brand badges and status dots', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');

    assert.match(settings, /const BOT_BRAND\b/, 'Bot settings must keep per-platform brand presentation metadata');
    for (const provider of ['telegram', 'feishu', 'wecom', 'wechat', 'discord', 'dingtalk', 'qq']) {
      assert.match(settings, new RegExp(`${provider}:\\s*\\{[\\s\\S]*?configDocUrl:`), `${provider} needs a visible configuration-document link target`);
      assert.match(styles, new RegExp(`\\.settingsBotHero\\[data-provider="${provider}"\\]`), `${provider} hero must export a brand color CSS variable`);
    }
    assert.match(settings, /function BotBrandLogo\b/, 'Bot settings must use the shared brand-logo component');
    assert.match(settings, /className="settingsBotLogoStatusDot"/, 'Platform logo must include the bottom-right status dot');
    assert.match(styles, /\.settingsBotLogoStatusDot\s*\{[\s\S]*position:\s*absolute/, 'Status dot must be visually attached to the platform logo');
    assert.match(styles, /\.settingsBotLogoStatusDot\[data-tone="success"\]/, 'Status dot tone mapping must include the connected state');
  });

  it('keeps the detail hero as a branded current-state surface with external docs link', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');

    assert.match(settings, /className="settingsBotHero"\s+data-provider=\{selected\}\s+data-support=\{support\}/, 'Selected platform detail must render the brand-aware hero card');
    assert.match(settings, /<BotStatusPill tone=\{copy\.tone\} label=\{copy\.label\}/, 'Hero title must include an inline current-state pill');
    assert.match(settings, /className="settingsBotConfigDocLink"[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"[\s\S]*查看配置文档 →/, 'Configuration docs link must be visible and external-link safe');
    assert.doesNotMatch(settings, /iframe|webview|dangerouslySetInnerHTML/, 'Bot docs must not be embedded into the renderer');
    assert.match(styles, /\.settingsBotHero\s*\{[\s\S]*background:\s*color-mix/, 'Hero card must use a subtle brand-color tint');
    assert.match(styles, /\.settingsBotStatusPill\b/, 'Hero current-state pill styling must be present');
  });

  it('keeps runtime channel onboarding as test-then-enable-then-restart', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const testAndConnectBlock = settings.match(/async function testAndConnect\(\)[\s\S]*?\n\s*async function restartChannel/)?.[0] ?? '';
    const actionRowBlock = settings.match(/<div className="settingsActionRow">[\s\S]*?<\/div>\n\s*<\/section>/)?.[0] ?? '';

    assert.match(testAndConnectBlock, /testBotChannel\(selected\)/, 'Combined action must validate credentials before enabling');
    assert.match(testAndConnectBlock, /if \(!testOk \|\| support !== 'runtime'\) return;/, 'Combined action must stop after a failed credential test');
    assert.match(testAndConnectBlock, /updateChannel\(\{ enabled: true \}\)/, 'Combined action must enable a runtime channel only after validation');
    assert.match(testAndConnectBlock, /await restartChannel\(\)/, 'Combined action must start the listener after enabling');
    assert.match(actionRowBlock, /support === 'runtime' && !selectedStatus\?\.running/, 'Runtime channels that are not listening must use the combined onboarding path');
    assert.match(actionRowBlock, /测试并连接/, 'Runtime onboarding CTA must keep the user-facing combined action label');
    assert.match(actionRowBlock, /support === 'runtime' && selectedStatus\?\.running/, 'Already-running channels must keep separate test/restart actions');
  });
});
