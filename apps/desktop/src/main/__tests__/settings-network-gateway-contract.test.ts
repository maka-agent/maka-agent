import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const settingsSource = readFileSync(
  join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'),
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
});
