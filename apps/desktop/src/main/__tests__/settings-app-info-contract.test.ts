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

describe('Settings app-info loading contract', () => {
  it('does not leave the About page in an endless skeleton when app info fails', () => {
    const aboutBlock = blockBetween('function AboutSettingsPage', 'function SettingsSkeleton');

    assert.match(aboutBlock, /const \[infoError, setInfoError\] = useState<string \| null>\(null\)/);
    assert.match(
      aboutBlock,
      /catch\(\(error\) => \{[\s\S]*const message = settingsActionErrorMessage\(error\);[\s\S]*setInfoError\(message\);[\s\S]*toast\.error\('载入关于信息失败', message\);/,
      'About page app.info failures must be visible to the user',
    );
    assert.match(
      aboutBlock,
      /if \(!info && !infoError\) \{[\s\S]*aria-label="正在加载关于页"/,
      'About page skeleton should only render while no error has occurred',
    );
    assert.match(
      aboutBlock,
      /if \(!info\) \{[\s\S]*role="alert"[\s\S]*无法载入关于信息[\s\S]*\{infoError\}/,
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
    assert.match(dataBlock, /会话记录、外观与账号设置、本地使用统计，以及系统安全存储加密的模型密钥/);
    assert.match(dataBlock, /模型密钥使用系统安全存储加密/);
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
    assert.match(dataBlock, /const pendingDataActionRef = useRef<string \| null>\(null\)/);
    assert.match(dataBlock, /const dataPageMountedRef = useRef\(false\)/);
    assert.match(
      dataBlock,
      /useEffect\(\(\) => \{[\s\S]*dataPageMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*dataPageMountedRef\.current = false;[\s\S]*pendingDataActionRef\.current = null;[\s\S]*\};[\s\S]*\}, \[toast\]\);/,
      'Data page actions must be invalidated when the page unmounts',
    );
    assert.match(
      dataBlock,
      /async function runDataAction\(action: string, run: \(\) => Promise<void>\) \{[\s\S]*if \(pendingDataActionRef\.current\) return;[\s\S]*pendingDataActionRef\.current = action;[\s\S]*setPendingDataAction\(action\);[\s\S]*await run\(\);[\s\S]*pendingDataActionRef\.current = null;[\s\S]*if \(dataPageMountedRef\.current\) \{[\s\S]*setPendingDataAction\(null\);[\s\S]*\}/,
      'Data page open/copy actions need a shared pending guard and must not clean UI state after unmount',
    );
    assert.match(
      dataBlock,
      /const result = await window\.maka\.app\.openPath\('workspace'\);[\s\S]*if \(!dataPageMountedRef\.current\) return;[\s\S]*toast\.error\(`无法打开\$\{openPathActionLabel\('workspace'\)\}`/,
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

  it('keeps About page privacy and storage copy Chinese-first and accessible', () => {
    const aboutBlock = blockBetween('function AboutSettingsPage', 'function SettingsSkeleton');

    assert.match(aboutBlock, /<ul aria-label="隐私与安全说明">/);
    assert.match(aboutBlock, /所有会话、设置、凭据和 Skill 指令文件/);
    assert.match(aboutBlock, /模型供应商密钥通过系统安全存储加密保存/);
    assert.match(aboutBlock, /权限策略会判断工具调用风险/);
    assert.match(aboutBlock, /每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录/);
    assert.match(aboutBlock, /会话记录、设置文件、SQLite 使用统计和系统安全存储加密的模型密钥/);
    assert.match(aboutBlock, /可直接粘贴到问题报告/);
    assert.match(aboutBlock, /const envSummaryHelpId = useId\(\)/);
    assert.match(
      aboutBlock,
      /<button type="button" className="maka-button" disabled=\{copyingEnvSummary\} aria-describedby=\{envSummaryHelpId\}/,
      'About page copy button must be programmatically described by the privacy note',
    );
    assert.match(
      aboutBlock,
      /<p id=\{envSummaryHelpId\} className="settingsHelpText">[\s\S]*复制内容不包含工作区路径/,
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
    assert.match(aboutBlock, /const copyingEnvSummaryRef = useRef\(false\)/);
    assert.match(aboutBlock, /const aboutPageMountedRef = useRef\(false\)/);
    assert.match(
      aboutBlock,
      /useEffect\(\(\) => \{[\s\S]*aboutPageMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*aboutPageMountedRef\.current = false;[\s\S]*copyingEnvSummaryRef\.current = false;[\s\S]*\};[\s\S]*\}, \[toast\]\);/,
      'About page copy actions must be invalidated when the page unmounts',
    );
    assert.match(
      aboutBlock,
      /async function copyEnvSummary\(\) \{[\s\S]*if \(copyingEnvSummaryRef\.current\) return;[\s\S]*copyingEnvSummaryRef\.current = true;[\s\S]*setCopyingEnvSummary\(true\);[\s\S]*await navigator\.clipboard\.writeText\(summary\);[\s\S]*if \(aboutPageMountedRef\.current\) \{[\s\S]*toast\.success\('已复制环境信息', '可直接粘贴到问题报告'\);[\s\S]*\}[\s\S]*catch \{[\s\S]*if \(aboutPageMountedRef\.current\) \{[\s\S]*toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\);[\s\S]*\}[\s\S]*finally \{[\s\S]*copyingEnvSummaryRef\.current = false;[\s\S]*if \(aboutPageMountedRef\.current\) \{[\s\S]*setCopyingEnvSummary\(false\);[\s\S]*\}/,
      'About page environment copy should not allow repeated clipboard requests and must not update UI after unmount',
    );
    assert.match(aboutBlock, /disabled=\{copyingEnvSummary\}/);
    assert.match(aboutBlock, /copyingEnvSummary \? '复制中…' : '复制环境信息'/);
    assert.match(aboutBlock, /toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\)/);
    assert.doesNotMatch(aboutBlock, /toast\.error\('复制失败', '剪贴板不可用'\)/);
  });
});
