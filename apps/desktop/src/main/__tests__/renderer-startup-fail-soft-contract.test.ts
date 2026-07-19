import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource, readRendererShellSource } from './renderer-shell-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

describe('renderer startup fail-soft contract', () => {
  it('catches fire-and-forget app shell settings probes', async () => {
    const main = await readRendererShellCombinedSource();
    const effects = await readRendererShellSource('app-shell-effects.ts');
    const mountEffect = effects.match(/export function useAppShellBootstrapSubscriptions[\s\S]*?useEffect\(\(\) => \{[\s\S]*?const unsubscribeConnections =/)?.[0] ?? '';
    const refreshConnections = main.match(/async function refreshConnections\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const refreshAppInfo = main.match(/async function refreshAppInfo\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const refreshPlanReminders = main.match(/async function refreshPlanReminders\([\s\S]*?\n  \}/)?.[0] ?? '';
    const refreshSkills = main.match(/async function refreshSkills\([\s\S]*?\n  \}/)?.[0] ?? '';
    const refreshMemoryActive = main.match(/async function refreshMemoryActive[\s\S]*?\n  \}/)?.[0] ?? '';
    const refreshShellSettings = main.match(/async function refreshShellSettings\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(mountEffect, /void (?:options\.|latest\.)?refreshAppInfo\(\)/);
    assert.match(
      refreshAppInfo,
      /try \{[\s\S]*window\.maka\.app\.info\(\)[\s\S]*setAppInfo\(\{[\s\S]*projectPath: next\.projectPath,[\s\S]*projectGit: next\.projectGit,[\s\S]*\}\)[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\([\s\S]*copy\.readPathFailedTitle,[\s\S]*localizedShellErrorMessage\(error, copy\.readPathFailedFallback, uiLocale\)/,
      'app-info refresh failures must be visible and preserve the last known project badge',
    );
    assert.doesNotMatch(refreshAppInfo, /toastApi\.error\('读取项目路径失败', cleanErrorMessage\(error\)\)/);
    assert.doesNotMatch(
      refreshAppInfo,
      /setAppInfo\(null\)/,
      'app-info refresh failure must not silently hide the existing project badge',
    );
    assert.match(mountEffect, /void (?:options\.|latest\.)?refreshMemoryActive\('load'\)/);
    assert.match(
      refreshMemoryActive,
      /try \{[\s\S]*window\.maka\.memory\.getState\(\)[\s\S]*setMemoryActive\(next\.agentReadEnabled && next\.status === 'ok' && next\.content\.trim\(\)\.length > 0\)[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\([\s\S]*copy\.memoryLoadErrorTitle[\s\S]*copy\.memoryRefreshErrorTitle,[\s\S]*localizedShellErrorMessage\(error, copy\.memoryErrorFallback, uiLocale\)/,
      'memory-active refresh failures must be visible without exposing raw storage details and preserve the last known header pill state',
    );
    assert.doesNotMatch(refreshMemoryActive, /toastApi\.error\(failureTitle, cleanErrorMessage\(error\)\)/);
    assert.doesNotMatch(
      main,
      /catch\(\(\) => setMemoryActive\(false\)\)|catch \(error\) \{[\s\S]*setMemoryActive\(false\)/,
      'memory-active refresh failures must not silently hide the existing memory pill',
    );
    assert.match(mountEffect, /void (?:options\.|latest\.)?refreshShellSettings\(\)/);
    assert.match(
      refreshShellSettings,
      /try \{[\s\S]*window\.maka\.settings\.get\(\)[\s\S]*setUiLocaleOverride\(smoke\?\.locale \?\? null\)[\s\S]*uiLocaleUpdateGate\.commitHydration\([\s\S]*setUiLocalePreference\(preference\)[\s\S]*applyTheme\(pref\)[\s\S]*applyThemePalette\(palette\)[\s\S]*\} catch \(error\) \{[\s\S]*const copy = getShellCopy\(uiLocale\)\.app;[\s\S]*toastApi\.error\([\s\S]*copy\.appearanceLoadErrorTitle,[\s\S]*localizedShellErrorMessage\(error, copy\.appearanceLoadErrorFallback, uiLocale\)/,
      'startup shell settings load failures must surface visibly without exposing raw storage/system details',
    );
    assert.doesNotMatch(refreshShellSettings, /toastApi\.error\('载入外观设置失败', cleanErrorMessage\(error\)\)/);
    assert.doesNotMatch(
      refreshShellSettings,
      /catch \(error\) \{[\s\S]*setUiLocalePreference\('auto'\)|catch \(error\) \{[\s\S]*applyTheme\('auto'\)|catch \(error\) \{[\s\S]*applyThemePalette\('default'\)/,
      'startup shell settings failures must not force default language/theme/palette over unknown persisted settings',
    );
    assert.match(
      refreshConnections,
      /try \{[\s\S]*window\.maka\.connections\.list\(\)[\s\S]*window\.maka\.connections\.getDefault\(\)[\s\S]*setConnections\((?:next|\(prev\) => connectionsEqual\(prev, next\) \? prev : next)\)[\s\S]*setDefaultConnection\(nextDefault\)[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\('刷新模型连接失败', generalizedErrorMessageChinese\(error, '模型连接暂时无法刷新，请稍后重试。'\)\)/,
      'startup / connections:event refreshConnections is fire-and-forget and must catch IPC failures without exposing raw provider/storage details',
    );
    assert.doesNotMatch(refreshConnections, /toastApi\.error\('刷新模型连接失败', cleanErrorMessage\(error\)\)/);
    assert.match(
      refreshPlanReminders,
      /try \{[\s\S]*window\.maka\.plans\.list\(\)[\s\S]*setPlanReminders\(next\)[\s\S]*\} catch \(error\) \{[\s\S]*if \(options\.shouldShowError\?\.\(\) \?\? true\) \{[\s\S]*toastApi\.error\('刷新计划失败', generalizedErrorMessageChinese\(error, '刷新计划提醒失败，请稍后重试。'\)\);[\s\S]*\}/,
      'plan reminder refresh failures must be visible and must preserve the existing list',
    );
    assert.doesNotMatch(
      refreshPlanReminders,
      /catch[\s\S]*setPlanReminders\(\[\]\)/,
      'plan reminder refresh failure must not wipe the current sidebar/panel list',
    );
    assert.match(
      refreshSkills,
      /try \{[\s\S]*window\.maka\.skills\.list\(\)[\s\S]*setSkills\(next\)[\s\S]*\} catch \(error\) \{[\s\S]*if \(options\.shouldShowError\?\.\(\) \?\? true\) \{[\s\S]*toastApi\.error\([\s\S]*copy\.refreshSkillsFailedTitle,[\s\S]*localizedShellErrorMessage\(error, copy\.refreshSkillsFallback, uiLocale\)[\s\S]*\);[\s\S]*\}/,
      'skills refresh failures must be visible and must preserve the existing list',
    );
    assert.doesNotMatch(
      refreshSkills,
      /catch[\s\S]*setSkills\(\[\]\)|window\.maka\.skills\.list\(\)\.catch\(\(\) => \[\]\)/,
      'skills refresh failure must not replace the current list with an empty fallback',
    );
  });

  it('catches Settings modal status probes that run on page mount', async () => {
    const settings = await readSettingsCombinedSource();
    const dataPage = settings.match(/function DataSettingsPage\(\)[\s\S]*?function PersonalizationSettingsPage/)?.[0] ?? '';
    const botPage = settings.match(/function BotChatSettingsPage\([\s\S]*?function UsageSettingsPage/)?.[0] ?? '';

    assert.match(
      dataPage,
      /window\.maka\.app\.info\(\)\.then\([\s\S]*?\.catch\(\(error\) => \{[\s\S]*const message = settingsActionErrorMessage\(error\);[\s\S]*setInfo\(null\);[\s\S]*setInfoError\(message\);[\s\S]*toast\.error\('载入数据目录失败', message\)/,
      'Data settings app-info load failure must surface visibly instead of leaving the path row loading forever',
    );
    assert.match(dataPage, /role="alert"[\s\S]*无法载入工作区路径：\{infoError\}/);
    assert.match(dataPage, /catch \(error\) \{[\s\S]*toast\.error\(`无法打开\$\{openPathActionLabel\('workspace', locale\)\}`, settingsActionErrorMessage\(error\)\)/);
    assert.match(
      botPage,
      /window\.maka\.settings\.bots\.listStatuses\(\)\.then\([\s\S]*?setStatuses\(next\)[\s\S]*?setStatusLoadError\(null\)[\s\S]*?\.catch\(\(error\) => \{[\s\S]*const message = settingsActionErrorMessage\(error\);[\s\S]*setStatusLoadError\(message\);[\s\S]*toast\.error\('载入远程接入状态失败', message\)/,
      'bot status probe failures must surface visibly instead of rendering unknown runtime state as stopped',
    );
    assert.doesNotMatch(
      botPage,
      /catch[\s\S]*setStatuses\(null\)/,
      'bot status probe failure must preserve current statuses instead of clearing them',
    );
    // #1042: the overview/detail views render the page's statusLoadError
    // via props after the bot-chat split.
    assert.match(botPage, /<Alert variant="error">[\s\S]*<AlertTitle>远程接入状态载入失败<\/AlertTitle>[\s\S]*<AlertDescription>\{props\.statusLoadError\}<\/AlertDescription>/);
    assert.match(botPage, /<Alert variant="error">[\s\S]*<AlertTitle>运行状态刷新失败<\/AlertTitle>[\s\S]*<AlertDescription>\{props\.statusLoadError\}<\/AlertDescription>/);
    assert.match(
      botPage,
      /async function refreshBotStatuses\(\): Promise<boolean> \{[\s\S]*try \{[\s\S]*window\.maka\.settings\.bots\.listStatuses\(\)[\s\S]*setStatuses\(nextStatuses\)[\s\S]*setStatusLoadError\(null\)[\s\S]*return true;[\s\S]*\} catch \(error\) \{[\s\S]*setStatusLoadError\(message\);[\s\S]*toast\.error\('刷新远程接入状态失败', message\)[\s\S]*return false;/,
      'manual bot status refresh must catch failures so QR-login callbacks cannot create unhandled rejections',
    );
  });

  it('keeps Settings modal usable when root settings or usage stats loading fails', async () => {
    const settings = await readSettingsCombinedSource();
    const modalBlock = settings.match(/export function SettingsModal\([\s\S]*?function SettingsPage/)?.[0] ?? '';
    const reloadSettingsBlock = modalBlock.match(/async function reloadSettings\(\)[\s\S]*?async function updateSettings/)?.[0] ?? '';
    const reloadUsageBlock = modalBlock.match(/async function reloadUsage[\s\S]*?useEffect\(\(\) => \{[\s\S]*?void reloadSettings/)?.[0] ?? '';

    assert.match(modalBlock, /const settingsModalMountedRef = useMountedRef\(\);/);
    assert.match(modalBlock, /const settingsReloadTicketRef = useRef\(0\);/);
    assert.match(
      modalBlock,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*settingsReloadTicketRef\.current \+= 1;[\s\S]*settingsUpdateTicketRef\.current \+= 1;[\s\S]*usageReloadTicketRef\.current \+= 1;[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'Settings root async work must be invalidated on close and StrictMode effect cleanup',
    );
    assert.match(reloadSettingsBlock, /try \{[\s\S]*window\.maka\.settings\.get\(\)/);
    assert.match(
      reloadSettingsBlock,
      /const ticket = settingsReloadTicketRef\.current \+ 1;[\s\S]*settingsReloadTicketRef\.current = ticket;[\s\S]*if \(settingsModalMountedRef\.current && ticket === settingsReloadTicketRef\.current\) \{[\s\S]*setSettings\(next\);[\s\S]*\}/,
      'root settings load must not write state after close or after a newer reload',
    );
    assert.match(
      reloadSettingsBlock,
      /catch \(error\) \{[\s\S]*if \(settingsModalMountedRef\.current && ticket === settingsReloadTicketRef\.current\) \{[\s\S]*toast\.error\(copy\.settingsLoadFailed, settingsActionErrorMessage\(error, locale\)\)/,
      'root settings load failures must not toast after close',
    );
    assert.match(
      reloadSettingsBlock,
      /finally \{[\s\S]*if \(settingsModalMountedRef\.current && ticket === settingsReloadTicketRef\.current\) \{[\s\S]*setLoading\(false\)/,
      'root settings loading state must not update after close',
    );
    assert.match(reloadUsageBlock, /try \{[\s\S]*window\.maka\.settings\.usageStats\(range\)/);
    assert.match(
      reloadUsageBlock,
      /catch \(error\) \{[\s\S]*if \(settingsModalMountedRef\.current && ticket === usageReloadTicketRef\.current\) \{[\s\S]*toast\.error\(copy\.usageLoadFailed, settingsActionErrorMessage\(error, locale\)\)/,
      'usage stats reload failures must be visible only while Settings is still open',
    );
    assert.doesNotMatch(
      reloadUsageBlock,
      /catch \(error\) \{[\s\S]*setUsageStats\(null\)/,
      'usage stats reload failures must preserve the currently visible dashboard',
    );
  });
});
