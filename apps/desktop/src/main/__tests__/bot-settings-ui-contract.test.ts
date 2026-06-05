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
    assert.match(settings, /className="settingsBotLogo"[\s\S]*aria-hidden="true"/, 'Bot brand monograms are decorative and must not be read as part of channel names');
    assert.match(settings, /className="settingsBotLogoStatusDot"/, 'Platform logo must include the bottom-right status dot');
    assert.match(settings, /data-active=\{selected === provider\}[\s\S]*aria-current=\{selected === provider \? 'page' : undefined\}/, 'The active bot platform must be exposed to assistive technology');
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
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');
    const updateChannelBlock = settings.match(/async function updateChannel\(patch: Partial<typeof channel>\): Promise<boolean>[\s\S]*?\n\s*useEffect\(\(\) =>/)?.[0] ?? '';
    const testChannelBlock = settings.match(/async function testChannel\(\)[\s\S]*?\n\s*\/\*\*/)?.[0] ?? '';
    const testAndConnectBlock = settings.match(/async function testAndConnect\(\)[\s\S]*?\n\s*async function restartChannel/)?.[0] ?? '';
    const restartChannelBlock = settings.match(/async function restartChannel\(\)[\s\S]*?\n\s*async function refreshBotStatuses/)?.[0] ?? '';
    const actionRowBlock = settings.match(/<div className="settingsBotActionStack">[\s\S]*?<\/div>/)?.[0] ?? '';
    const switchBlock = settings.match(/<Switch\s+ariaLabel=\{`启用\$\{BOT_LABELS\[selected\]\.label\}机器人`\}[\s\S]*?\/>/)?.[0] ?? '';

    assert.match(updateChannelBlock, /try \{[\s\S]*props\.onUpdate\(\{ botChat: \{ channels: \{ \[selected\]: patch \} \} \}\)/, 'Bot channel field saves must catch settings update failures');
    assert.match(updateChannelBlock, /catch \(error\) \{[\s\S]*toast\.error\(`\$\{BOT_LABELS\[selected\]\.label\} 保存失败`, settingsActionErrorMessage\(error\)\)[\s\S]*return false/, 'Bot channel save failures must surface a visible toast instead of rejecting from field handlers');
    assert.match(settings, /function canEnableBotChannel\(readiness: BotReadinessState\): boolean\s*\{[\s\S]*credentials_valid[\s\S]*operational[\s\S]*degraded[\s\S]*\}/, 'Only validated or already-runtime-capable bot states can be enabled directly');
    assert.match(settings, /const enableSwitchDisabled = support === 'planned' \|\| \(!channel\.enabled && !canEnableBotChannel\(readiness\)\)/, 'Unchecked bot channels must keep the enable switch locked until credentials are tested');
    assert.match(settings, /先测试并连接后才能启用。/, 'Locked runtime bot channels must explain the test-first path');
    assert.match(settings, /const enableSwitchHintId = `settings-bot-enable-hint-\$\{selected\}`/, 'Enable-lock hint must have a stable aria-describedby id');
    assert.match(settings, /<small id=\{enableSwitchHintId\} className="settingsBotEnableHint">/, 'Enable-lock hint must be rendered near the switch');
    assert.match(styles, /\.settingsBotEnableHint\s*\{[\s\S]*display:\s*block/, 'Enable-lock hint needs a stable visible style');
    assert.match(switchBlock, /ariaDescribedBy=\{enableSwitchHint \? enableSwitchHintId : undefined\}/, 'Disabled enable switch must point assistive tech at the reason');
    assert.match(switchBlock, /disabled=\{enableSwitchDisabled\}/, 'Bot enable switch must use the guarded disabled state');
    assert.match(testAndConnectBlock, /testBotChannel\(selected\)/, 'Combined action must validate credentials before enabling');
    assert.match(testChannelBlock, /catch \(error\) \{[\s\S]*toast\.error\(`\$\{BOT_LABELS\[selected\]\.label\} 测试出错`, settingsActionErrorMessage\(error\)\)/, 'Separate bot credential tests must scrub thrown IPC failures');
    assert.match(testAndConnectBlock, /catch \(error\) \{[\s\S]*toast\.error\(`\$\{BOT_LABELS\[selected\]\.label\} 测试出错`, settingsActionErrorMessage\(error\)\)/, 'Combined bot credential tests must scrub thrown IPC failures');
    assert.match(testAndConnectBlock, /if \(!testOk \|\| support !== 'runtime'\) return;/, 'Combined action must stop after a failed credential test');
    assert.match(testAndConnectBlock, /const saved = await updateChannel\(\{ enabled: true \}\);[\s\S]*if \(!saved\) return;/, 'Combined action must stop if enabling the runtime channel fails to save');
    assert.match(testAndConnectBlock, /await restartChannel\(\)/, 'Combined action must start the listener after enabling');
    assert.match(restartChannelBlock, /catch \(error\) \{[\s\S]*const message = settingsActionErrorMessage\(error\);[\s\S]*toast\.error\(`\$\{BOT_LABELS\[selected\]\.label\} 启动失败`, message\)/, 'Bot restart failures must use the Settings error scrubber');
    assert.doesNotMatch(`${testChannelBlock}\n${testAndConnectBlock}\n${restartChannelBlock}`, /error instanceof Error \? error\.message : String\(error\)/, 'Bot test/restart actions must not toast raw Error.message');
    assert.match(actionRowBlock, /support === 'runtime' && !selectedStatus\?\.running/, 'Runtime channels that are not listening must use the combined onboarding path');
    assert.match(actionRowBlock, /测试并连接/, 'Runtime onboarding CTA must keep the user-facing combined action label');
    // PR-BOT-RESTART-RACE-0 added `|| restarting` so the button
    // doesn't unmount during the stop→start cycle. Allow the
    // parenthesized form here without abandoning the original
    // intent (running channels still get the restart action).
    assert.match(actionRowBlock, /support === 'runtime' && \(?selectedStatus\?\.running/, 'Already-running channels must keep separate test/restart actions');
  });

  it('opens an in-app WeChat QR login modal instead of handing scan login off to a toast', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const styles = await readRepo('apps/desktop/src/renderer/styles.css');
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/global.d.ts');
    const scanLogin = await readRepo('apps/desktop/src/main/wechat-scan-login.ts');
    const desktopPackage = await readRepo('apps/desktop/package.json');

    assert.match(settings, /function WeChatScanLoginModal\b/, 'WeChat direct scan login must render its own QR modal');
    assert.match(settings, /window\.maka\.settings\.bots\.wechat\.fetchQrcode\(\)/, 'Direct scan login must fetch an iLink QR code through main');
    assert.match(settings, /window\.maka\.settings\.bots\.wechat\.pollQrcodeStatus\(qr\.qrToken\)/, 'Direct scan login must poll iLink status');
    assert.match(settings, /setErrorMessage\(settingsActionErrorMessage\(result\.error\.message\)\)/, 'Direct scan login result failures must use the Settings error scrubber before rendering');
    assert.doesNotMatch(settings, /setErrorMessage\(result\.error\.message\)/, 'Direct scan login must not render raw Result error messages');
    assert.doesNotMatch(settings, /setErrorMessage\(error instanceof Error \? error\.message : String\(error\)\)/, 'Direct scan login thrown failures must not render raw Error.message');
    assert.match(settings, /token:\s*credentials\.botToken[\s\S]*webhookUrl:\s*credentials\.baseUrl[\s\S]*botUserId:\s*credentials\.botId/, 'Confirmed iLink credentials must be persisted into the WeChat channel');
    assert.match(settings, /function WechatQrLoginModal\b/, 'WeChat scan login must render its own QR modal');
    assert.match(settings, /window\.maka\.settings\.bots\.wechatQrCode\(\)/, 'QR modal must call the bridge QR IPC');
    assert.match(settings, /<img src=\{qrDataUrl\} alt="微信扫码登录二维码"/, 'QR modal must render a visible QR image');
    assert.match(settings, /setWechatQrOpen\(true\)/, 'Scan-login button must open the QR modal');
    assert.match(settings, /async function disconnectWechatLogin\(\)/, 'Saved WeChat scan-login credentials must have a visible disconnect path');
    assert.match(settings, /断开微信登录/, 'WeChat action stack must expose the disconnect label after login');
    assert.match(settings, /token:\s*''[\s\S]*connected:\s*false[\s\S]*readiness:\s*'scaffolded'/, 'Disconnect must clear saved scan-login credentials and readiness');
    assert.match(settings, /const saved = await updateChannel\(\{[\s\S]*token:\s*''[\s\S]*\}\);[\s\S]*if \(!saved\) return;[\s\S]*toast\.success\('微信登录已断开'/, 'Disconnect must not report success if clearing saved WeChat credentials fails');
    assert.doesNotMatch(settings, /扫码登录由本机 wechat-bridge 处理/, 'Scan login must not be a toast-only handoff');
    assert.match(styles, /\.settingsWechatQrModal\b/, 'QR modal styles must be present');
    assert.match(styles, /\.settingsWechatQrFrame img\b/, 'QR image must have a stable frame style');
    assert.match(scanLogin, /get_bot_qrcode\?bot_type=3/, 'Main scan-login wrapper must use the Alma-compatible iLink QR endpoint');
    assert.match(scanLogin, /get_qrcode_status\?qrcode=/, 'Main scan-login wrapper must use the Alma-compatible iLink status endpoint');
    assert.match(scanLogin, /X-WECHAT-UIN/, 'Main scan-login wrapper must send the required WeChat UIN header');
    assert.match(scanLogin, /createRequire\(import\.meta\.url\)/, 'Main scan-login wrapper must be able to load the QR renderer from Electron ESM');
    assert.match(scanLogin, /qrcode\.toDataURL\(raw/, 'Alma iLink qrcode_img_content is QR payload content and must be rendered before reaching <img>');
    assert.match(scanLogin, /return \{ qrcodeUrl: await renderWeChatQrcode\(qrcodeContent\), qrToken \}/, 'Direct scan login must return a renderer-safe QR image data URL, not raw iLink content');
    assert.match(desktopPackage, /"qrcode":\s*"\^1\.5\.4"/, 'Desktop main process must declare the QR renderer dependency it uses');
    assert.match(main, /from '\.\/wechat-scan-login\.js'/, 'Electron ESM main import must include the emitted .js extension');
    assert.match(main, /settings:bots:wechat:fetchQrcode/, 'main process must expose direct WeChat QR fetch');
    assert.match(main, /settings:bots:wechat:pollQrcodeStatus/, 'main process must expose direct WeChat QR status polling');
    assert.match(main, /function weChatQrFailureMessage\(error: unknown\): string \{[\s\S]*generalizedErrorMessageChinese\(error, '微信扫码登录暂时不可用，请稍后重试。'\)/, 'main QR IPC must localize scan-login failures before crossing into renderer');
    assert.match(main, /settings:bots:wechat:fetchQrcode[\s\S]*tryWeChatQrResult\(async \(\) => fetchWeChatQrcode\(\), 'WECHAT_QR_FETCH_FAILED'\)/, 'QR fetch IPC must not expose raw iLink response-body errors');
    assert.match(main, /settings:bots:wechat:pollQrcodeStatus[\s\S]*tryWeChatQrResult\(async \(\) => \{[\s\S]*pollWeChatQrcodeStatus\(qrToken\)/, 'QR status IPC must not expose raw iLink response-body errors');
    assert.match(main, /settings:bots:wechatQrCode/, 'main process must expose the WeChat QR IPC');
    assert.match(preload, /wechatQrCode\(\): Promise<WechatBridgeQrCodeResult>/, 'preload must expose the typed QR bridge');
    assert.match(preload, /fetchQrcode\(\): Promise<Result<\{ qrcodeUrl: string; qrToken: string \}>>/, 'preload must expose typed direct QR fetch');
    assert.match(preload, /pollQrcodeStatus\(qrToken: string\): Promise<Result</, 'preload must expose typed direct QR status polling');
    assert.match(globalTypes, /wechatQrCode\(\): Promise<WechatBridgeQrCodeResult>/, 'global types must mirror the QR bridge');
    assert.match(globalTypes, /fetchQrcode\(\): Promise<Result<\{ qrcodeUrl: string; qrToken: string \}>>/, 'global types must mirror direct QR fetch');
    assert.match(globalTypes, /pollQrcodeStatus\(qrToken: string\): Promise<Result</, 'global types must mirror direct QR status polling');
  });
});
