import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const settingsSource = readFileSync(
  join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'),
  'utf8',
);
const mainSource = readFileSync(
  join(process.cwd(), 'src/main/main.ts'),
  'utf8',
);

function blockBetween(start: string, end: string): string {
  return settingsSource.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? '';
}

describe('Settings network and gateway persistence contract', () => {
  it('surfaces network proxy save failures instead of returning raw rejected promises from field handlers', () => {
    const networkBlock = blockBetween('function NetworkSettingsPage', 'function OpenGatewaySettingsPage');

    assert.match(
      networkBlock,
      /async function updateProxy\(patch: Partial<NetworkProxySettings>\) \{[\s\S]*try \{[\s\S]*await props\.onUpdate\(\{ network: \{ proxy: patch \} \}\)[\s\S]*catch \(error\) \{[\s\S]*toast\.error\('保存网络设置失败', settingsActionErrorMessage\(error\)\)/,
      'Network proxy settings updates must show a visible failure toast',
    );
    assert.doesNotMatch(
      networkBlock,
      /onChange=\{\([^)]*\) => updateProxy\(/,
      'Network proxy field handlers must not leak a returned rejected promise',
    );
    assert.match(
      networkBlock,
      /onChange=\{\(enabled\) => void updateProxy\(\{ enabled \}\)\}/,
      'Network proxy enable switch should explicitly fire-and-report via updateProxy',
    );
  });

  it('localizes proxy test failure messages before returning them to Settings', () => {
    const helper = mainSource.match(/function proxyTestFailureMessage\(result: TestProxyResult\): string \{[\s\S]*?\n\}/);
    const handler = mainSource.match(/settings:testNetworkProxy[\s\S]*?satisfies SettingsTestResult;/)?.[0] ?? '';
    const networkBlock = blockBetween('function NetworkSettingsPage', 'function OpenGatewaySettingsPage');

    assert.ok(helper, 'main must normalize proxy test failures at the IPC boundary');
    assert.match(helper![0], /proxy disabled[\s\S]*代理未启用，请先打开代理开关/);
    assert.match(helper![0], /proxy host\/port required[\s\S]*请填写代理服务器地址和端口后再测试/);
    assert.match(helper![0], /proxy test timeout[\s\S]*代理测试超时，请检查代理服务是否可达/);
    assert.match(helper![0], /result\.status[\s\S]*代理测试返回 HTTP \$\{result\.status\}/);
    assert.match(helper![0], /redactSecrets\(result\.error \?\? ''\)/);
    assert.match(helper![0], /generalizedErrorMessageChinese\(raw, ''\)/);
    assert.match(handler, /message: proxyTestFailureMessage\(result\)/);
    assert.doesNotMatch(
      handler,
      /message: result\.error \?\? \(result\.status \? `HTTP \$\{result\.status\}` : '代理不可达'\)/,
      'proxy test IPC must not pass through runtime English/raw failure messages',
    );
    assert.match(
      networkBlock,
      /catch \(error\) \{[\s\S]*toast\.error\('代理测试出错', settingsActionErrorMessage\(error\)\)/,
      'Renderer-side proxy test IPC rejections must use the Settings error scrubber',
    );
    assert.doesNotMatch(
      networkBlock,
      /代理测试出错[\s\S]{0,120}error instanceof Error \? error\.message : String\(error\)/,
      'Renderer-side proxy test must not toast raw Error.message on rejected IPC',
    );
  });

  it('keeps gateway success toasts behind a successful settings save', () => {
    const gatewayBlock = blockBetween('function OpenGatewaySettingsPage', 'function presentGatewayStatus');

    assert.match(
      gatewayBlock,
      /async function updateGateway\(patch: Partial<AppSettings\['openGateway'\]>\): Promise<boolean> \{[\s\S]*await props\.onUpdate\(\{ openGateway: patch \}\);[\s\S]*return true;[\s\S]*catch \(error\) \{[\s\S]*toast\.error\('保存开放网关设置失败', settingsActionErrorMessage\(error\)\)[\s\S]*return false;/,
      'Open Gateway settings updates must return a boolean and surface failures',
    );
    assert.match(
      gatewayBlock,
      /const saved = await updateGateway\(\{ token: nextToken \}\);[\s\S]*if \(!saved\) return;[\s\S]*toast\.success\(nextToken \? '网关 token 已保存' : '网关 token 已清空'\)/,
      'Saving or clearing the gateway token must not show success after a failed save',
    );
    assert.match(
      gatewayBlock,
      /const saved = await updateGateway\(\{ token \}\);[\s\S]*if \(!saved\) return;[\s\S]*toast\.success\('网关 token 已生成'/,
      'Generated gateway tokens must not show success after a failed save',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /onChange=\{\([^)]*\) => updateGateway\(/,
      'Open Gateway field handlers must not leak a returned rejected promise',
    );
  });

  it('renders gateway runtime start errors from closed reasons instead of raw listen errors', () => {
    const helper = blockBetween('function gatewayErrorCopy', 'function generateGatewayToken');

    assert.match(helper, /error === 'start_failed'/);
    assert.match(helper, /开放网关暂时无法启动，请检查监听地址和端口。/);
    assert.match(helper, /EADDRINUSE[\s\S]*端口已被占用/);
    assert.doesNotMatch(
      helper,
      /return error;/,
      'Open Gateway Settings must not render raw runtime lastError strings',
    );
  });
});
