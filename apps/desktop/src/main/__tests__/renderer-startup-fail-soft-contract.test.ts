import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('renderer startup fail-soft contract', () => {
  it('catches fire-and-forget app shell settings probes', async () => {
    const main = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');
    const mountEffect = main.match(/useEffect\(\(\) => \{[\s\S]*?const unsubscribeConnections =/)?.[0] ?? '';
    const refreshConnections = main.match(/async function refreshConnections\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const refreshPlanReminders = main.match(/async function refreshPlanReminders\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const refreshSkills = main.match(/async function refreshSkills\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const refreshMemoryActive = main.match(/async function refreshMemoryActive[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(mountEffect, /window\.maka\.app\.info\(\)\.then\([\s\S]*?\.catch\(\(\) => setAppInfo\(null\)\)/);
    assert.match(mountEffect, /void refreshMemoryActive\('载入本地记忆状态失败'\)/);
    assert.match(
      refreshMemoryActive,
      /try \{[\s\S]*window\.maka\.memory\.getState\(\)[\s\S]*setMemoryActive\(next\.agentReadEnabled && next\.status === 'ok' && next\.content\.trim\(\)\.length > 0\)[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\(failureTitle, cleanErrorMessage\(error\)\)/,
      'memory-active refresh failures must be visible and preserve the last known header pill state',
    );
    assert.doesNotMatch(
      main,
      /catch\(\(\) => setMemoryActive\(false\)\)|catch \(error\) \{[\s\S]*setMemoryActive\(false\)/,
      'memory-active refresh failures must not silently hide the existing memory pill',
    );
    assert.match(mountEffect, /window\.maka\.settings\.get\(\)\.then\([\s\S]*?\.catch\(\(\) => \{[\s\S]*applyUiLocale\('auto'\)[\s\S]*applyTheme\('auto'\)[\s\S]*applyDensity\('comfortable'\)[\s\S]*applyThemePalette\('default'\)/);
    assert.match(
      refreshConnections,
      /try \{[\s\S]*window\.maka\.connections\.list\(\)[\s\S]*window\.maka\.connections\.getDefault\(\)[\s\S]*setConnections\(next\)[\s\S]*setDefaultConnection\(nextDefault\)[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\('刷新模型连接失败', cleanErrorMessage\(error\)\)/,
      'startup / connections:event refreshConnections is fire-and-forget and must catch IPC failures',
    );
    assert.match(
      refreshPlanReminders,
      /try \{[\s\S]*window\.maka\.plans\.list\(\)[\s\S]*setPlanReminders\(next\)[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\('刷新计划失败', cleanErrorMessage\(error\)\)/,
      'plan reminder refresh failures must be visible and must preserve the existing list',
    );
    assert.doesNotMatch(
      refreshPlanReminders,
      /catch[\s\S]*setPlanReminders\(\[\]\)/,
      'plan reminder refresh failure must not wipe the current sidebar/panel list',
    );
    assert.match(
      refreshSkills,
      /try \{[\s\S]*window\.maka\.skills\.list\(\)[\s\S]*setSkills\(next\)[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\('刷新技能失败', cleanErrorMessage\(error\)\)/,
      'skills refresh failures must be visible and must preserve the existing list',
    );
    assert.doesNotMatch(
      refreshSkills,
      /catch[\s\S]*setSkills\(\[\]\)|window\.maka\.skills\.list\(\)\.catch\(\(\) => \[\]\)/,
      'skills refresh failure must not replace the current list with an empty fallback',
    );
  });

  it('catches Settings modal status probes that run on page mount', async () => {
    const settings = await readFile(join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'), 'utf8');
    const dataPage = settings.match(/function DataSettingsPage\(\)[\s\S]*?function PersonalizationSettingsPage/)?.[0] ?? '';
    const botPage = settings.match(/function BotChatSettingsPage\([\s\S]*?function UsageSettingsPage/)?.[0] ?? '';

    assert.match(
      dataPage,
      /window\.maka\.app\.info\(\)\.then\([\s\S]*?\.catch\(\(error\) => \{[\s\S]*const message = settingsActionErrorMessage\(error\);[\s\S]*setInfo\(null\);[\s\S]*setInfoError\(message\);[\s\S]*toast\.error\('载入数据目录失败', message\)/,
      'Data settings app-info load failure must surface visibly instead of leaving the path row loading forever',
    );
    assert.match(dataPage, /role="alert"[\s\S]*无法载入工作区路径：\{infoError\}/);
    assert.match(dataPage, /catch \(error\) \{[\s\S]*toast\.error\(`无法打开\$\{openPathActionLabel\('workspace'\)\}`, settingsActionErrorMessage\(error\)\)/);
    assert.match(
      botPage,
      /window\.maka\.settings\.bots\.listStatuses\(\)\.then\([\s\S]*?setStatuses\(next\)[\s\S]*?setStatusLoadError\(null\)[\s\S]*?\.catch\(\(error\) => \{[\s\S]*const message = settingsActionErrorMessage\(error\);[\s\S]*setStatusLoadError\(message\);[\s\S]*toast\.error\('载入机器人运行状态失败', message\)/,
      'bot status probe failures must surface visibly instead of rendering unknown runtime state as stopped',
    );
    assert.doesNotMatch(
      botPage,
      /catch[\s\S]*setStatuses\(null\)/,
      'bot status probe failure must preserve current statuses instead of clearing them',
    );
    assert.match(botPage, /role="alert"[\s\S]*机器人运行状态刷新失败：\{statusLoadError\}/);
    assert.match(
      botPage,
      /async function refreshBotStatuses\(\): Promise<boolean> \{[\s\S]*try \{[\s\S]*window\.maka\.settings\.bots\.listStatuses\(\)[\s\S]*setStatuses\(nextStatuses\)[\s\S]*setStatusLoadError\(null\)[\s\S]*return true;[\s\S]*\} catch \(error\) \{[\s\S]*setStatusLoadError\(message\);[\s\S]*toast\.error\('刷新机器人运行状态失败', message\)[\s\S]*return false;/,
      'manual bot status refresh must catch failures so QR-login callbacks cannot create unhandled rejections',
    );
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
    assert.match(
      reloadUsageBlock,
      /catch \(error\) \{[\s\S]*toast\.error\('载入使用统计失败', settingsActionErrorMessage\(error\)\)/,
      'usage stats reload failures must be visible',
    );
    assert.doesNotMatch(
      reloadUsageBlock,
      /catch \(error\) \{[\s\S]*setUsageStats\(null\)/,
      'usage stats reload failures must preserve the currently visible dashboard',
    );
  });
});
