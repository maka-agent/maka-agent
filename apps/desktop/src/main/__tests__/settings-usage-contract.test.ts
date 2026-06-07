import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Settings usage dashboard contract', () => {
  it('keeps request filters scoped to the request log tab', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage![0], /usageDraft\.activeTab === 'requests'/);
    assert.match(usagePage![0], /settingsUsageFilters/);
    assert.match(usagePage![0], /清除筛选/);
    assert.match(usagePage![0], /status: 'all', modelFilter: ''/);
    assert.match(
      usagePage![0],
      /\{usageDraft\.activeTab === 'requests' && \([\s\S]*?<div className="settingsUsageFilters" role="group" aria-label="请求记录筛选">/,
      'Usage filters must live under the requests-only conditional block',
    );
    assert.doesNotMatch(
      usagePage![0],
      /<div className="settingsUsageFilters">\s*\{usageDraft\.showDetails/,
      'Usage request filters must not regress to an anonymous control cluster',
    );
    assert.match(
      usagePage![0],
      /\{usageDraft\.showDetails && \([\s\S]*?<input value=\{usageDraft\.modelFilter\}/,
      'model/status request filters must be hidden until detail records are enabled',
    );
    assert.match(usagePage![0], /按模型或工具筛选/);
    assert.match(usagePage![0], /log\.model\.toLowerCase\(\)\.includes\(normalizedModelFilter\)/);
    assert.match(usagePage![0], /\(log\.toolName \?\? ''\)\.toLowerCase\(\)\.includes\(normalizedModelFilter\)/);
  });

  it('shows a distinct empty state when request filters hide all logs', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(src, /requestEmpty=\{hasRequestFilters \? '没有符合筛选条件的请求记录' : '暂无请求记录'\}/);
    assert.match(src, /empty=\{props\.requestEmpty\}/);
  });

  it('makes the detail-records toggle control request log rendering', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage![0], /const showRequestDetails = usageDraft\.activeTab === 'requests' && usageDraft\.showDetails/);
    assert.match(usagePage![0], /usageDraft\.activeTab === 'requests' && !usageDraft\.showDetails/);
    assert.match(usagePage![0], /当前仅显示汇总指标/);
    assert.match(usagePage![0], /显示明细/);
    assert.match(usagePage![0], /showDetails: true/);
    assert.match(usagePage![0], /logs=\{showRequestDetails \? filteredLogs : \[\]\}/);
  });

  it('names usage segmented radiogroups for assistive technology', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage![0],
      /<div className="settingsUsageToolbar" role="group" aria-label="使用统计范围与刷新">/,
      'Usage range selector and refresh action must expose a named control group',
    );
    assert.doesNotMatch(
      usagePage![0],
      /<div className="settingsUsageToolbar">\s*<Segmented[\s\S]*ariaLabel="使用统计时间范围"/,
      'Usage toolbar must not regress to an anonymous range/refresh cluster',
    );
    assert.match(
      usagePage![0],
      /<Segmented[\s\S]*value=\{usageDraft\.range\}[\s\S]*ariaLabel="使用统计时间范围"/,
      'range segmented control must expose what the 24h/7天/30天/all group changes',
    );
    assert.match(
      usagePage![0],
      /<Segmented[\s\S]*value=\{usageDraft\.activeTab\}[\s\S]*ariaLabel="使用统计视图"/,
      'tab segmented control must expose what the request/provider/model/tools/pricing group changes',
    );
  });

  it('names the usage summary metrics group', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage![0],
      /<div className="settingsUsageSummary" role="group" aria-label="使用统计汇总指标">/,
      'Usage summary metric cards must expose a named group before the tabbed detail tables',
    );
    assert.doesNotMatch(
      usagePage![0],
      /<div className="settingsUsageSummary">\s*<MetricCard/,
      'Usage summary metrics must not regress to an anonymous card cluster',
    );
  });

  it('keeps usage filters responsive through a local draft while saves run in the background', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage![0], /const persistedUsage = props\.settings\.usage/);
    assert.match(usagePage![0], /const \[usageDraft, setUsageDraft\] = useState\(persistedUsage\)/);
    assert.match(usagePage![0], /const usageDraftRef = useRef\(persistedUsage\)/);
    assert.match(
      usagePage![0],
      /function commitUsageDraft\(next: AppSettings\['usage'\]\) \{[\s\S]*usageDraftRef\.current = next;[\s\S]*setUsageDraft\(next\);[\s\S]*\}/,
      'Usage controls must update a local draft immediately instead of waiting for settings IPC',
    );
    assert.match(
      usagePage![0],
      /async function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean> \{[\s\S]*const nextDraft = \{ \.\.\.usageDraftRef\.current, \.\.\.patch \};[\s\S]*commitUsageDraft\(nextDraft\);[\s\S]*const result = await props\.onUpdate\(\{ usage: patch \}\);[\s\S]*if \(usagePageMountedRef\.current && ticket === usageSaveTicketRef\.current\) \{[\s\S]*commitUsageDraft\(result\.settings\.usage\);[\s\S]*catch \(error\) \{[\s\S]*if \(usagePageMountedRef\.current && ticket === usageSaveTicketRef\.current\) \{[\s\S]*commitUsageDraft\(persistedUsageRef\.current\);/,
      'Usage settings saves must use latest-response draft sync and roll back on failure',
    );
    assert.match(usagePage![0], /<input value=\{usageDraft\.modelFilter\}/);
    assert.match(usagePage![0], /<select value=\{usageDraft\.status\}/);
    assert.doesNotMatch(
      usagePage![0],
      /<input value=\{usage\.modelFilter\}/,
      'Usage model filter must not bind directly to persisted settings while typing',
    );
  });

  it('surfaces usage preference save failures instead of leaving filter controls silent', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage![0], /async function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean>/);
    assert.match(
      usagePage![0],
      /try \{[\s\S]*await props\.onUpdate\(\{ usage: patch \}\)[\s\S]*return usagePageMountedRef\.current && ticket === usageSaveTicketRef\.current;[\s\S]*catch \(error\) \{[\s\S]*if \(usagePageMountedRef\.current && ticket === usageSaveTicketRef\.current\) \{[\s\S]*toast\.error\('保存使用统计设置失败', settingsActionErrorMessage\(error\)\)[\s\S]*return false/,
      'Usage settings updates must toast the latest mounted save failure and report failure to callers',
    );
    assert.match(
      usagePage![0],
      /const saved = await updateUsage\(\{ range \}\);[\s\S]*if \(!saved \|\| !usagePageMountedRef\.current\) return;[\s\S]*await props\.onReload\(range\)/,
      'Changing the usage range must not reload stats after the preference save fails',
    );
    assert.doesNotMatch(
      usagePage![0],
      /void props\.onUpdate\(\{ usage:/,
      'Usage filter controls must not fire-and-forget raw settings updates',
    );
  });

  it('drops late usage preference and refresh UI writes after Settings is closed', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/)?.[0] ?? '';

    assert.match(
      usagePage,
      /const usagePageMountedRef = useRef\(false\);/,
      'Usage settings page must track mounted ownership for async preference and refresh work',
    );
    assert.match(
      usagePage,
      /useEffect\(\(\) => \{[\s\S]*usagePageMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*usagePageMountedRef\.current = false;[\s\S]*usageSaveTicketRef\.current \+= 1;[\s\S]*usageRefreshRunningRef\.current = false;/,
      'Usage settings cleanup must invalidate saves and release manual refresh ownership',
    );
    assert.match(
      usagePage,
      /const result = await props\.onUpdate\(\{ usage: patch \}\);[\s\S]*if \(usagePageMountedRef\.current && ticket === usageSaveTicketRef\.current\) \{[\s\S]*commitUsageDraft\(result\.settings\.usage\);/,
      'Usage save success must not sync draft state after unmount or after a newer request',
    );
    assert.match(
      usagePage,
      /catch \(error\) \{[\s\S]*if \(usagePageMountedRef\.current && ticket === usageSaveTicketRef\.current\) \{[\s\S]*commitUsageDraft\(persistedUsageRef\.current\);[\s\S]*toast\.error\('保存使用统计设置失败', settingsActionErrorMessage\(error\)\);/,
      'Usage save failure must not rollback or toast after unmount or after a newer request',
    );
    assert.match(
      usagePage,
      /const saved = await updateUsage\(\{ range \}\);[\s\S]*if \(!saved \|\| !usagePageMountedRef\.current\) return;[\s\S]*await props\.onReload\(range\);/,
      'Usage range changes must not trigger a stats reload after an unmounted or stale save',
    );
    assert.match(
      usagePage,
      /finally \{[\s\S]*usageRefreshRunningRef\.current = false;[\s\S]*if \(usagePageMountedRef\.current\) \{[\s\S]*setRefreshing\(false\);/,
      'Manual usage refresh cleanup must not write React pending state after unmount',
    );
  });

  it('drops stale usage stats reload responses', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const settingsModal = src.match(/function SettingsSurface\([\s\S]*?function SettingsPage/)?.[0];

    assert.ok(settingsModal, 'Settings surface block must exist');
    assert.match(
      settingsModal!,
      /const usageReloadTicketRef = useRef\(0\);/,
      'Usage stats reloads need a latest-response ticket so rapid range changes cannot show stale stats',
    );
    assert.match(
      settingsModal!,
      /async function reloadUsage\(range: UsageRange = settings\.usage\.range\) \{[\s\S]*const ticket = usageReloadTicketRef\.current \+ 1;[\s\S]*usageReloadTicketRef\.current = ticket;[\s\S]*const next = await window\.maka\.settings\.usageStats\(range\);[\s\S]*if \(settingsModalMountedRef\.current && ticket === usageReloadTicketRef\.current\) \{[\s\S]*setUsageStats\(next\);[\s\S]*\}/,
      'Usage stats reloads must only apply the newest response while Settings is still mounted',
    );
    assert.match(
      settingsModal!,
      /catch \(error\) \{[\s\S]*if \(settingsModalMountedRef\.current && ticket === usageReloadTicketRef\.current\) \{[\s\S]*toast\.error\('载入使用统计失败', settingsActionErrorMessage\(error\)\);[\s\S]*\}/,
      'Stale or unmounted usage reload failures must not toast over a newer range',
    );
  });

  it('gates manual usage refresh and reads the latest draft range', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage![0],
      /const usageRefreshRunningRef = useRef\(false\);/,
      'Manual usage refresh needs a ref gate so fast double-clicks cannot duplicate reloads before React disables the button',
    );
    assert.match(
      usagePage![0],
      /async function refresh\(\) \{\s*if \(usageRefreshRunningRef\.current\) return;[\s\S]*usageRefreshRunningRef\.current = true;[\s\S]*await props\.onReload\(usageDraftRef\.current\.range\)/,
      'Manual usage refresh must lock synchronously and read the latest local draft range',
    );
    assert.match(
      usagePage![0],
      /finally \{[\s\S]*usageRefreshRunningRef\.current = false;[\s\S]*setRefreshing\(false\);[\s\S]*\}/,
      'Manual usage refresh must release the ref gate after reload settles',
    );
    assert.doesNotMatch(
      usagePage![0],
      /props\.onReload\(usageDraft\.range\)/,
      'Manual usage refresh must not read stale React state after a just-clicked range change',
    );
    assert.match(usagePage![0], /aria-busy=\{refreshing\}/, 'Usage refresh button must expose pending state to assistive tech');
    assert.match(usagePage![0], /data-pending=\{refreshing \? 'true' : undefined\}/, 'Usage refresh button must expose a stable pending hook');
    assert.match(usagePage![0], /onClick=\{\(\) => void refresh\(\)\}/, 'Usage refresh click handler must explicitly discard the async promise');
  });

  it('does not render raw request status enums in the usage table', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usageTable = src.match(/function UsageTable\([\s\S]*?function SimpleStatsTable/);

    assert.ok(usageTable, 'Usage table block must exist');
    assert.match(usageTable![0], /usageRequestStatusLabel\(row\.status\)/);
    assert.match(src, /function usageRequestStatusLabel/);
    assert.match(src, /case 'success': return '成功'/);
    assert.match(src, /case 'error': return '错误'/);
    assert.doesNotMatch(
      usageTable![0],
      /,\s*row\.status\]\)/,
      'Usage request table must not render raw `success` / `error` enums directly',
    );
  });

  it('labels model and tool rows without rendering raw request kind enums', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usageTable = src.match(/function UsageTable\([\s\S]*?function usageRequestStatusLabel/);

    assert.ok(usageTable, 'Usage table block must exist');
    assert.match(usageTable![0], /headers=\{\['时间', '类型', '对象', '会话', 'Token', '费用', '延迟', '状态'\]\}/);
    assert.match(usageTable![0], /usageRequestKindLabel\(row\.kind\)/);
    assert.match(usageTable![0], /usageRequestTarget\(row\)/);
    assert.match(usageTable![0], /usageRequestSessionCell\(row, props\.onOpenSession\)/);
    assert.match(usageTable![0], /row\.kind === 'model' \? `\$\$\{\(row\.costUsd \?\? 0\)\.toFixed\(2\)\}` : '-'/);
    assert.match(src, /case 'model': return '模型'/);
    assert.match(src, /case 'tool': return '工具'/);
    assert.match(src, /return row\.kind === 'tool' \? row\.toolName \?\? row\.model : row\.model/);
    assert.match(src, /function usageRequestSessionCell/);
    assert.match(src, /onClick=\{\(\) => onOpenSession\(row\.sessionId\)\}/);
    assert.match(src, /打开 \{label\}/);
    assert.match(src, /function shortUsageSessionId/);
    assert.doesNotMatch(
      usageTable![0],
      /,\s*row\.kind\s*,/,
      'Usage request table must not render raw `model` / `tool` enums directly',
    );
  });

  it('wires usage diagnostics rows back to source sessions through the shell', async () => {
    const settingsSrc = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const mainSrc = await readRepo('apps/desktop/src/renderer/main.tsx');

    assert.match(settingsSrc, /onOpenSession\?\(sessionId: string\): void/);
    assert.match(settingsSrc, /onOpenSession=\{props\.onOpenSession\}/);
    assert.match(mainSrc, /onOpenSession=\{\(sessionId\) => \{/);
    assert.match(
      mainSrc,
      /closeSettings\(\);[\s\S]*openSessionInChat\(sessionId\);/,
      'opening a session from Settings must switch the shell back to the chat surface before selecting it',
    );
    assert.match(
      mainSrc,
      /function openSessionInChat\(sessionId: string, turnId\?: string\): void \{[\s\S]*setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);[\s\S]*setActiveId\(sessionId\);/,
      'openSessionInChat must own the shell route + active-session transition',
    );
  });
});
