import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSettingsCombinedSourceSync } from './settings-contract-source-helpers.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';

const settingsSource = readSettingsCombinedSourceSync();

function blockBetween(start: string, end: string): string {
  return settingsSource.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? '';
}

describe('Settings app-info loading contract', () => {
  it('does not leave the About page in an endless skeleton when app info fails', () => {
    const aboutBlock = blockBetween('function AboutSettingsPage', 'function SettingsSkeleton');

    assert.match(aboutBlock, /const \[infoError, setInfoError\] = useState<string \| null>\(null\)/);
    assert.match(
      aboutBlock,
      /catch\(\(error\) => \{[\s\S]*const message = settingsActionErrorMessage\(error, locale\);[\s\S]*setInfoError\(message\);[\s\S]*toast\.error\(copy\.loadFailed, message\);/,
      'About page app.info failures must be visible to the user',
    );
    assert.match(
      aboutBlock,
      /if \(!info && !infoError\) \{[\s\S]*label=\{copy\.loading\}/,
      'About page skeleton should only render while no error has occurred',
    );
    assert.match(
      aboutBlock,
      /if \(!info\) \{[\s\S]*role="alert"[\s\S]*\{copy\.unavailable\}[\s\S]*\{infoError\}/,
      'About page should render an alert state after app.info fails',
    );
    assert.doesNotMatch(aboutBlock, /catch\(\(\) => \{\}\)/, 'About page must not swallow app.info errors');
  });

  it('surfaces Data page workspace-path load failures instead of showing loading forever', () => {
    const dataBlock = blockBetween('function DataSettingsPage', 'function PersonalizationSettingsPage');

    assert.match(dataBlock, /const \[infoError, setInfoError\] = useState<string \| null>\(null\)/);
    assert.match(
      dataBlock,
      /catch\(\(error\) => \{[\s\S]*const message = settingsActionErrorMessage\(error\);[\s\S]*setInfo\(null\);[\s\S]*setInfoError\(message\);[\s\S]*toast\.error\('载入数据目录失败', message\);/,
      'Data page app.info failures must be visible to the user',
    );
    assert.match(
      dataBlock,
      /value=\{info\?\.workspacePath \?\? \(infoError \? '载入失败' : '正在加载…'\)\}/,
      'Data page should stop presenting the workspace path as still loading after failure',
    );
    assert.match(
      dataBlock,
      /role="alert"[\s\S]*无法载入工作区路径：\{infoError\}/,
      'Data page should render an alert with the workspace-path load failure',
    );
  });

  it('keeps Data page copy Mac-polished and Chinese-first', () => {
    const dataBlock = blockBetween('function DataSettingsPage', 'function PersonalizationSettingsPage');

    assert.match(dataBlock, /打开工作区文件夹/);
    assert.match(dataBlock, /会话、设置、凭据和技能文件/);
    assert.match(dataBlock, /会话记录、外观与账号设置、本地使用统计，以及本机凭据文件/);
    assert.match(dataBlock, /模型连接凭据随工作区恢复后需要重新测试/);
    assert.doesNotMatch(dataBlock, /资源管理器/);
    assert.doesNotMatch(dataBlock, /credentials/);
    assert.doesNotMatch(dataBlock, /usage stats/);
    assert.doesNotMatch(dataBlock, /settings\.json/);
    assert.doesNotMatch(dataBlock, /safeStorage/);
    assert.doesNotMatch(dataBlock, /API key/);
  });

  it('gates Data page workspace actions while one action is pending', () => {
    const dataBlock = blockBetween('function DataSettingsPage', 'function PersonalizationSettingsPage');

    assert.match(dataBlock, /const \[pendingDataAction, setPendingDataAction\] = useState<string \| null>\(null\)/);
    assert.match(dataBlock, /const dataActionGuard = useActionGuard<string>\(\)/);
    assert.match(dataBlock, /const dataPageMountedRef = useMountedRef\(\)/);
    assert.match(
      dataBlock,
      /async function runDataAction\(action: string, run: \(\) => Promise<void>\) \{[\s\S]*if \(!dataActionGuard\.begin\(action\)\) return;[\s\S]*setPendingDataAction\(action\);[\s\S]*await run\(\);[\s\S]*dataActionGuard\.finish\(\);[\s\S]*if \(dataPageMountedRef\.current\) \{[\s\S]*setPendingDataAction\(null\);[\s\S]*\}/,
      'Data page open/copy actions need a shared pending guard and must not clean UI state after unmount (the shared guard hook releases on unmount)',
    );
    assert.match(
      dataBlock,
      /const result = await window\.maka\.app\.openPath\('workspace'\);[\s\S]*if \(!dataPageMountedRef\.current\) return;[\s\S]*toast\.error\([\s\S]*openPathActionLabel\('workspace', locale\)/,
      'Late workspace-open failures must not toast after Settings is closed',
    );
    assert.match(
      dataBlock,
      /await navigator\.clipboard\.writeText\(info\.workspacePath\);[\s\S]*if \(dataPageMountedRef\.current\) \{[\s\S]*toast\.success\('已复制工作区路径'\);[\s\S]*\}[\s\S]*catch \{[\s\S]*if \(dataPageMountedRef\.current\) \{[\s\S]*toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\)/,
      'Late workspace-path copy success/failure toasts must not fire after Settings is closed',
    );
    assert.match(dataBlock, /disabled=\{!info \|\| dataActionDisabled\}/);
    assert.match(dataBlock, /isDataActionPending\('workspace:open'\) \? '打开中…' : '打开工作区文件夹'/);
    assert.match(dataBlock, /isDataActionPending\('workspace:path:copy'\) \? '复制中…' : '复制路径'/);
    assert.match(dataBlock, /toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\)/);
    assert.doesNotMatch(dataBlock, /toast\.error\('复制失败', '剪贴板不可用'\)/);
  });

  it('labels the Data page workspace action group for assistive tech', () => {
    const dataBlock = blockBetween('function DataSettingsPage', 'function PersonalizationSettingsPage');

    assert.match(
      dataBlock,
      /<div className="settingsActionRow" role="group" aria-label="工作区数据操作">/,
      'Data page workspace open/copy actions must expose a shared group name',
    );
    assert.doesNotMatch(
      dataBlock,
      /<div className="settingsActionRow">\s*<button[\s\S]*?打开工作区文件夹[\s\S]*?复制路径/,
      'Data page workspace actions must not regress to an anonymous button cluster',
    );
  });

  it('keeps About page privacy and storage copy bilingual and accessible', () => {
    const aboutBlock = blockBetween('function AboutSettingsPage', 'function SettingsSkeleton');

    const zh = getSettingsPreferencesCopy('zh').about;
    const en = getSettingsPreferencesCopy('en').about;
    assert.match(aboutBlock, /<ul aria-label=\{copy\.privacyLabel\}>/);
    assert.equal(zh.privacyPoints.length, 5);
    assert.match(zh.privacyPoints.join('\n'), /本机工作区/);
    assert.match(zh.storageDetail, /凭据/);
    assert.doesNotMatch(JSON.stringify(en), /[\u3400-\u9fff]/u);
    assert.match(aboutBlock, /const envSummaryHelpId = useId\(\)/);
    assert.match(
      aboutBlock,
      /<Button type="button" disabled=\{copyingEnvSummary\} aria-describedby=\{envSummaryHelpId\}/,
      'About page copy button must be programmatically described by the privacy note',
    );
    assert.match(
      aboutBlock,
      /<p id=\{envSummaryHelpId\} className="settingsHelpText">[\s\S]*\{copy\.copyHelp\}/,
      'About page copy privacy note must be the target of the button description',
    );
    assert.doesNotMatch(aboutBlock, /settings、credentials、skills/);
    assert.doesNotMatch(aboutBlock, /provider API key/);
    assert.doesNotMatch(aboutBlock, /safeStorage/);
    assert.doesNotMatch(aboutBlock, /risk 分类/);
    assert.doesNotMatch(aboutBlock, /chat 内/);
    assert.doesNotMatch(aboutBlock, /tool 调用/);
    assert.doesNotMatch(aboutBlock, /mode_change/);
    assert.doesNotMatch(aboutBlock, /SQLite usage stats/);
    assert.doesNotMatch(aboutBlock, /provider credentials/);
    assert.doesNotMatch(aboutBlock, /bug report/);
  });

  it('gates About page environment copy while the clipboard request is pending', () => {
    const aboutBlock = blockBetween('function AboutSettingsPage', 'function SettingsSkeleton');

    assert.match(aboutBlock, /const \[copyingEnvSummary, setCopyingEnvSummary\] = useState\(false\)/);
    assert.match(aboutBlock, /const envSummaryCopyGuard = useActionGuard<'copy'>\(\)/);
    assert.match(aboutBlock, /const aboutPageMountedRef = useMountedRef\(\)/);
    assert.match(
      aboutBlock,
      /async function copyEnvSummary\(\) \{[\s\S]*if \(!envSummaryCopyGuard\.begin\('copy'\)\) return;[\s\S]*setCopyingEnvSummary\(true\);/,
      'About page environment copy should not allow repeated clipboard requests (the shared guard hook releases on unmount)',
    );
    assert.match(
      aboutBlock,
      /await navigator\.clipboard\.writeText\(summary\);[\s\S]*if \(aboutPageMountedRef\.current\) \{[\s\S]*toast\.success\(copy\.copied, copy\.pasteHint\);[\s\S]*\}[\s\S]*catch \{[\s\S]*if \(aboutPageMountedRef\.current\) \{[\s\S]*toast\.error\(copy\.copyFailed, copy\.clipboardUnavailable\);[\s\S]*\}[\s\S]*finally \{[\s\S]*envSummaryCopyGuard\.finish\(\);[\s\S]*if \(aboutPageMountedRef\.current\) \{[\s\S]*setCopyingEnvSummary\(false\);[\s\S]*\}/,
      'About page environment copy must not update UI after unmount',
    );
    assert.match(aboutBlock, /disabled=\{copyingEnvSummary\}/);
    assert.match(aboutBlock, /copyingEnvSummary \? copy\.copying : copy\.copyEnvironment/);
    assert.match(aboutBlock, /toast\.error\(copy\.copyFailed, copy\.clipboardUnavailable\)/);
    assert.doesNotMatch(aboutBlock, /toast\.error\('复制失败', '剪贴板不可用'\)/);
  });
});
