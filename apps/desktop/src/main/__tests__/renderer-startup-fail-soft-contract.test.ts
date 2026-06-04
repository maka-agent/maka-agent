import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('renderer startup fail-soft contract', () => {
  it('catches fire-and-forget app shell settings probes', async () => {
    const main = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');
    const mountEffect = main.match(/useEffect\(\(\) => \{[\s\S]*?const unsubscribeConnections =/)?.[0] ?? '';

    assert.match(mountEffect, /window\.maka\.app\.info\(\)\.then\([\s\S]*?\.catch\(\(\) => setAppInfo\(null\)\)/);
    assert.match(mountEffect, /window\.maka\.memory\.getState\(\)\.then\([\s\S]*?\.catch\(\(\) => setMemoryActive\(false\)\)/);
    assert.match(mountEffect, /window\.maka\.settings\.get\(\)\.then\([\s\S]*?\.catch\(\(\) => \{[\s\S]*applyUiLocale\('auto'\)[\s\S]*applyTheme\('auto'\)[\s\S]*applyDensity\('comfortable'\)[\s\S]*applyThemePalette\('default'\)/);
  });

  it('catches Settings modal status probes that run on page mount', async () => {
    const settings = await readFile(join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'), 'utf8');
    const dataPage = settings.match(/function DataSettingsPage\(\)[\s\S]*?function PersonalizationSettingsPage/)?.[0] ?? '';
    const botPage = settings.match(/function BotChatSettingsPage\([\s\S]*?function UsageSettingsPage/)?.[0] ?? '';

    assert.match(dataPage, /window\.maka\.app\.info\(\)\.then\([\s\S]*?\.catch\(\(\) => \{[\s\S]*setInfo\(null\)/);
    assert.match(dataPage, /catch \(error\) \{[\s\S]*toast\.error\(`无法打开\$\{openPathActionLabel\('workspace'\)\}`, settingsActionErrorMessage\(error\)\)/);
    assert.match(botPage, /window\.maka\.settings\.bots\.listStatuses\(\)\.then\([\s\S]*?\.catch\(\(\) => \{[\s\S]*setStatuses\(null\)/);
  });

  it('keeps Settings modal usable when root settings or usage stats loading fails', async () => {
    const settings = await readFile(join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'), 'utf8');
    const modalBlock = settings.match(/export function SettingsModal\([\s\S]*?function SettingsPage/)?.[0] ?? '';
    const reloadSettingsBlock = modalBlock.match(/async function reloadSettings\(\)[\s\S]*?async function updateSettings/)?.[0] ?? '';
    const reloadUsageBlock = modalBlock.match(/async function reloadUsage[\s\S]*?useEffect\(\(\) => \{[\s\S]*?void reloadSettings/)?.[0] ?? '';

    assert.match(reloadSettingsBlock, /try \{[\s\S]*window\.maka\.settings\.get\(\)/);
    assert.match(reloadSettingsBlock, /catch \(error\) \{[\s\S]*toast\.error\('载入设置失败', settingsActionErrorMessage\(error\)\)/);
    assert.match(reloadSettingsBlock, /finally \{[\s\S]*setLoading\(false\)/);
    assert.match(reloadUsageBlock, /try \{[\s\S]*window\.maka\.settings\.usageStats\(range\)/);
    assert.match(reloadUsageBlock, /catch \(error\) \{[\s\S]*setUsageStats\(null\)[\s\S]*toast\.error\('载入使用统计失败', settingsActionErrorMessage\(error\)\)/);
  });
});
