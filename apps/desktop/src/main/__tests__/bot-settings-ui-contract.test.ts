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
    const actionRowBlock = settings.match(/<div className="settingsBotActionStack">[\s\S]*?<\/div>/)?.[0] ?? '';

    assert.match(testAndConnectBlock, /testBotChannel\(selected\)/, 'Combined action must validate credentials before enabling');
    assert.match(testAndConnectBlock, /if \(!testOk \|\| support !== 'runtime'\) return;/, 'Combined action must stop after a failed credential test');
    assert.match(testAndConnectBlock, /updateChannel\(\{ enabled: true \}\)/, 'Combined action must enable a runtime channel only after validation');
    assert.match(testAndConnectBlock, /await restartChannel\(\)/, 'Combined action must start the listener after enabling');
    assert.match(actionRowBlock, /support === 'runtime' && !selectedStatus\?\.running/, 'Runtime channels that are not listening must use the combined onboarding path');
    assert.match(actionRowBlock, /测试并连接/, 'Runtime onboarding CTA must keep the user-facing combined action label');
    assert.match(actionRowBlock, /support === 'runtime' && selectedStatus\?\.running/, 'Already-running channels must keep separate test/restart actions');
  });

  it('opens an in-app WeChat QR login modal instead of handing scan login off to a toast', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');
    const scanLogin = await readRepo('apps/desktop/src/main/wechat-scan-login.ts');

    assert.match(settings, /function WeChatScanLoginModal\b/, 'WeChat direct scan login must render its own QR modal');
    assert.match(settings, /window\.maka\.settings\.bots\.wechat\.fetchQrcode\(\)/, 'Direct scan login must fetch an iLink QR code through main');
    assert.match(settings, /window\.maka\.settings\.bots\.wechat\.pollQrcodeStatus\(qr\.qrToken\)/, 'Direct scan login must poll iLink status');
    assert.match(settings, /token:\s*credentials\.botToken[\s\S]*webhookUrl:\s*credentials\.baseUrl[\s\S]*botUserId:\s*credentials\.botId/, 'Confirmed iLink credentials must be persisted into the WeChat channel');
    assert.match(settings, /function WechatQrLoginModal\b/, 'WeChat scan login must render its own QR modal');
    assert.match(settings, /window\.maka\.settings\.bots\.wechatQrCode\(\)/, 'QR modal must call the bridge QR IPC');
    assert.match(settings, /<img src=\{qrDataUrl\} alt="微信扫码登录二维码"/, 'QR modal must render a visible QR image');
    assert.match(settings, /setWechatQrOpen\(true\)/, 'Scan-login button must open the QR modal');
    assert.match(settings, /async function disconnectWechatLogin\(\)/, 'Saved WeChat scan-login credentials must have a visible disconnect path');
    assert.match(settings, /断开微信登录/, 'WeChat action stack must expose the disconnect label after login');
    assert.match(settings, /token:\s*''[\s\S]*connected:\s*false[\s\S]*readiness:\s*'scaffolded'/, 'Disconnect must clear saved scan-login credentials and readiness');
    assert.doesNotMatch(settings, /扫码登录由本机 wechat-bridge 处理/, 'Scan login must not be a toast-only handoff');
    assert.match(styles, /\.settingsWechatQrModal\b/, 'QR modal styles must be present');
    assert.match(styles, /\.settingsWechatQrFrame img\b/, 'QR image must have a stable frame style');
    assert.match(scanLogin, /get_bot_qrcode\?bot_type=3/, 'Main scan-login wrapper must use the Alma-compatible iLink QR endpoint');
    assert.match(scanLogin, /get_qrcode_status\?qrcode=/, 'Main scan-login wrapper must use the Alma-compatible iLink status endpoint');
    assert.match(scanLogin, /X-WECHAT-UIN/, 'Main scan-login wrapper must send the required WeChat UIN header');
    assert.match(main, /from '\.\/wechat-scan-login\.js'/, 'Electron ESM main import must include the emitted .js extension');
    assert.match(main, /settings:bots:wechat:fetchQrcode/, 'main process must expose direct WeChat QR fetch');
    assert.match(main, /settings:bots:wechat:pollQrcodeStatus/, 'main process must expose direct WeChat QR status polling');
    assert.match(main, /settings:bots:wechatQrCode/, 'main process must expose the WeChat QR IPC');
    assert.match(preload, /wechatQrCode\(\): Promise<WechatBridgeQrCodeResult>/, 'preload must expose the typed QR bridge');
    assert.match(preload, /fetchQrcode\(\): Promise<Result<\{ qrcodeUrl: string; qrToken: string \}>>/, 'preload must expose typed direct QR fetch');
    assert.match(preload, /pollQrcodeStatus\(qrToken: string\): Promise<Result</, 'preload must expose typed direct QR status polling');
    assert.match(globalTypes, /wechatQrCode\(\): Promise<WechatBridgeQrCodeResult>/, 'global types must mirror the QR bridge');
    assert.match(globalTypes, /fetchQrcode\(\): Promise<Result<\{ qrcodeUrl: string; qrToken: string \}>>/, 'global types must mirror direct QR fetch');
    assert.match(globalTypes, /pollQrcodeStatus\(qrToken: string\): Promise<Result</, 'global types must mirror direct QR status polling');
  });
});
