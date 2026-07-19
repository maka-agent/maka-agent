import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

// The usage page splits into an orchestrator (UsageSettingsPage) plus one
// component per tab, then a shared table primitive. Contract assertions scope
// to the block that owns each concern so a regression in one tab cannot be
// masked by a matching string in another.
const usagePageBlock = (src: string) =>
  src.match(/function UsageSettingsPage\([\s\S]*?function UsageRequestsPanel/)?.[0] ?? '';
const requestsPanelBlock = (src: string) =>
  src.match(/function UsageRequestsPanel\([\s\S]*?function UsageProvidersPanel/)?.[0] ?? '';
const statsTableBlock = (src: string) =>
  src.match(/function UsageStatsTable\([\s\S]*?function MetricCard/)?.[0] ?? '';

describe('Settings usage dashboard contract', () => {
  it('keeps request filters scoped to the request log tab', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.ok(requestsPanel, 'Usage requests panel block must exist');
    // Only the request-log tab computes/derives detail rows; the aggregate
    // tabs never see the request filters.
    assert.match(usagePage, /const showRequestDetails = usageDraft\.activeTab === 'requests' && usageDraft\.showDetails/);
    assert.match(usagePage, /status: 'all', modelFilter: ''/);
    assert.match(usagePage, /log\.model\.toLowerCase\(\)\.includes\(normalizedModelFilter\)/);
    assert.match(usagePage, /\(log\.toolName \?\? ''\)\.toLowerCase\(\)\.includes\(normalizedModelFilter\)/);
    // The filter cluster lives in the requests panel, behind its own details
    // guard — it can never render under an aggregate tab.
    assert.match(requestsPanel, /if \(!props\.showDetails\)/);
    assert.match(requestsPanel, /<div className="settingsUsageFilters" role="group" aria-label="请求记录筛选">/);
    assert.match(requestsPanel, /清除筛选/);
    assert.match(requestsPanel, /<Input value=\{props\.modelFilter\}/);
    assert.match(requestsPanel, /按模型或工具筛选/);
    assert.match(requestsPanel, /className="settingsUsageDetailToggle"/);
    assert.match(requestsPanel, /className="settingsUsageRecordCount"/);
    assert.match(requestsPanel, /className="settingsUsageClearFilter"/);
    assert.match(requestsPanel, /disabled=\{!props\.hasRequestFilters\}/);
    assert.match(requestsPanel, /tabIndex=\{!props\.hasRequestFilters \? -1 : undefined\}/);
    assert.doesNotMatch(
      requestsPanel,
      /<div className="settingsUsageFilters">/,
      'Usage request filters must not regress to an anonymous control cluster',
    );
  });

  it('shows a distinct empty state when request filters hide all logs', async () => {
    const src = await readSettingsCombinedSource();
    const requestsPanel = requestsPanelBlock(src);

    // The orchestrator decides the empty copy from the filter state; the panel
    // routes it into the shared table's EmptyState title.
    assert.match(src, /requestEmpty=\{hasRequestFilters \? '没有符合筛选条件的请求记录' : '暂无请求记录'\}/);
    assert.match(requestsPanel, /title: props\.requestEmpty/);
    assert.match(
      requestsPanel,
      /empty=\{\{ Icon: props\.hasRequestFilters \? Search : Activity, title: props\.requestEmpty \}\}/,
      'The empty request log must surface through the shared EmptyState (icon + copy), not a bare table row',
    );
  });

  it('makes the detail-records toggle control request log rendering', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage, /const showRequestDetails = usageDraft\.activeTab === 'requests' && usageDraft\.showDetails/);
    assert.match(usagePage, /logs=\{showRequestDetails \? filteredLogs : \[\]\}/);
    assert.match(usagePage, /showDetails: true/);
    // With details off the panel returns the summary-only prompt; the alert +
    // 显示明细 CTA live in the requests panel now.
    assert.match(requestsPanel, /if \(!props\.showDetails\)/);
    assert.match(requestsPanel, /当前仅显示汇总指标/);
    assert.match(requestsPanel, /显示明细/);
    assert.match(requestsPanel, /onClick=\{props\.onEnableDetails\}/);
  });

  it('names the usage range selector and tab views for assistive technology', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage,
      /<div className="settingsUsageToolbar" role="group" aria-label="使用统计范围与刷新">/,
      'Usage range selector and refresh action must expose a named control group',
    );
    assert.doesNotMatch(
      usagePage,
      /<div className="settingsUsageToolbar">\s*<Segmented/,
      'Usage toolbar must not regress to an anonymous range/refresh cluster',
    );
    assert.match(
      usagePage,
      /<Segmented[\s\S]*value=\{usageDraft\.range\}[\s\S]*ariaLabel="使用统计时间范围"/,
      'range segmented control must expose what the 24h/7天/30天/all group changes',
    );
    // The tab row converged to the house underline TabsList (skills / MCP
    // language) with count pills — not a second segmented toggle.
    assert.match(
      usagePage,
      /<TabsRoot[\s\S]*value=\{usageDraft\.activeTab\}/,
      'tab views must be driven by the shared TabsRoot bound to the active tab',
    );
    assert.match(
      usagePage,
      /<TabsList variant="underline" className="settingsUsageTabs" aria-label="使用统计视图">/,
      'the tab row must use the underline TabsList so it reads as tabs, not a toggle chip',
    );
    assert.doesNotMatch(
      // Bounded so it only fires when a single <Segmented …/> tag itself binds
      // activeTab — not when the range Segmented merely precedes the TabsRoot.
      usagePage,
      /<Segmented\b(?:(?!\/>)[\s\S])*?value=\{usageDraft\.activeTab\}/,
      'the view switcher must not regress to a segmented toggle',
    );
    for (const [value, label] of [
      ['requests', '请求日志'],
      ['providers', '供应商统计'],
      ['models', '模型统计'],
      ['tools', '工具统计'],
      ['pricing', '定价配置'],
    ] as const) {
      assert.match(
        usagePage,
        new RegExp(`<TabsTrigger className="settingsUsageTab" value="${value}">${label} <span>`),
        `tab ${value} must render its ${label} label with a count pill`,
      );
    }
  });

  it('names the usage summary metrics group', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage,
      /<div className="settingsUsageSummary" role="group" aria-label="使用统计汇总指标">/,
      'Usage summary metric cards must expose a named group before the tabbed detail tables',
    );
    assert.doesNotMatch(
      usagePage,
      /<div className="settingsUsageSummary">\s*<MetricCard/,
      'Usage summary metrics must not regress to an anonymous card cluster',
    );
  });

  it('names every usage stats table and boxes it in the shared table primitive', async () => {
    const src = await readSettingsCombinedSource();
    const statsTable = statsTableBlock(src);

    for (const label of [
      '使用统计请求日志表',
      '使用统计供应商统计表',
      '使用统计模型统计表',
      '使用统计工具统计表',
      '使用统计定价配置表',
    ]) {
      assert.match(src, new RegExp(`ariaLabel="${label}"`), `A usage tab must name its ${label}`);
    }
    // Every tab funnels through the one shared table so the column rhythm /
    // hairline / tabular-nums recipe stays in a single place.
    assert.match(
      statsTable,
      /function UsageStatsTable\(props: \{\s*ariaLabel: string;\s*columns: UsageColumn\[\];\s*rows: Array<Array<ReactNode>>;\s*empty: UsageEmpty;\s*\}\)/,
      'UsageStatsTable callers must provide a table-specific accessible name, typed columns, and an EmptyState config',
    );
    assert.match(
      statsTable,
      /<table\s+aria-label=\{props\.ariaLabel\}/,
      'Usage stats table must expose its caller-provided name',
    );
    assert.match(
      statsTable,
      /<th key=\{column\.header\} scope="col"/,
      'Usage stats table column headers must expose column scope',
    );
    assert.match(
      statsTable,
      /cellIndex === 0 \? \(\s*<th key=\{cellIndex\} scope="row"/,
      'Usage stats table rows must expose the first data cell as a scoped row header',
    );
    // Numeric columns right-align + tabular-nums; every non-grow column stays on
    // one line and sizes to content, while the grow column absorbs slack and
    // wraps — so numeric columns never float apart and headers never wrap.
    assert.match(
      statsTable,
      /column\.numeric \? 'text-right \[font-variant-numeric:tabular-nums\]' : 'text-left'/,
      'Usage stats columns must right-align numeric data with tabular-nums',
    );
    assert.match(
      statsTable,
      /column\.grow \? 'w-full' : 'whitespace-nowrap'/,
      'Usage stats tables must let one column absorb slack while the rest size to content on one line',
    );
    // Empty tabs render the shared EmptyState rather than a header-only table.
    assert.match(
      statsTable,
      /if \(props\.rows\.length === 0\) \{\s*return \(\s*<EmptyState/,
      'An empty usage tab must render the EmptyState primitive, not a bare header row',
    );
    assert.doesNotMatch(
      statsTable,
      /<table className="settingsStatsTable">\s*<thead>/,
      'Usage stats tables must not regress to anonymous tables',
    );
  });

  it('keeps usage filters responsive through a local draft while saves run in the background', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage, /const persistedUsage = props\.settings\.usage/);
    assert.match(
      usagePage,
      /useOptimisticSettingsDraft<AppSettings\['usage'\]>\([\s\S]*persistedUsage,[\s\S]*\(patch\) => props\.onUpdate\(\{ usage: patch \}\)\.then\(\(result\) => result\.settings\.usage\)/,
      'Usage controls must drive their local draft through the shared optimistic draft hook instead of waiting for settings IPC',
    );
    assert.match(
      usagePage,
      /draft: usageDraft,[\s\S]*draftRef: usageDraftRef,[\s\S]*mountedRef: usagePageMountedRef,[\s\S]*update,/,
      'Usage must read its rendered draft, synchronous draft ref, and mounted ref from the shared hook',
    );
    assert.match(
      usagePage,
      /\{ onError: \(error\) => toast\.error\('保存使用统计设置失败', settingsActionErrorMessage\(error\)\) \},[\s\S]*function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean> \{[\s\S]*return update\(patch\);/,
      'Usage settings saves must route through the shared draft update (latest-response sync + rollback owned by the hook)',
    );
    // The filter controls bind to the panel props (fed from the live draft),
    // never straight to persisted settings while typing.
    assert.match(requestsPanel, /<Input value=\{props\.modelFilter\}/);
    assert.match(requestsPanel, /<SettingsSelect[\s\S]*value=\{props\.status\}[\s\S]*ariaLabel="请求状态筛选"/);
    assert.match(usagePage, /modelFilter=\{usageDraft\.modelFilter\}/);
    assert.match(usagePage, /status=\{usageDraft\.status\}/);
    assert.doesNotMatch(
      requestsPanel,
      /<(?:input|Input) value=\{usage\.modelFilter\}/,
      'Usage model filter must not bind directly to persisted settings while typing',
    );
  });

  it('surfaces usage preference save failures instead of leaving filter controls silent', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage, /function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean>/);
    assert.match(
      usagePage,
      /\{ onError: \(error\) => toast\.error\('保存使用统计设置失败', settingsActionErrorMessage\(error\)\) \},[\s\S]*function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean> \{[\s\S]*return update\(patch\);/,
      'Usage settings updates must surface the save failure through the shared hook (which gates on the latest mounted save) and report failure to callers',
    );
    assert.match(
      usagePage,
      /const saved = await updateUsage\(\{ range \}\);[\s\S]*if \(!saved \|\| !usagePageMountedRef\.current\) return;[\s\S]*await props\.onReload\(range\)/,
      'Changing the usage range must not reload stats after the preference save fails',
    );
    assert.doesNotMatch(
      usagePage,
      /void props\.onUpdate\(\{ usage:/,
      'Usage filter controls must not fire-and-forget raw settings updates',
    );
  });

  it('drops late usage preference and refresh UI writes after Settings is closed', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.match(
      usagePage,
      /mountedRef: usagePageMountedRef,/,
      'Usage settings page must track mounted ownership (from the shared draft hook) for async preference and refresh work',
    );
    assert.match(
      usagePage,
      /const usageRefreshGuard = useActionGuard<'refresh'>\(\)/,
      'Usage settings must hold its manual refresh guard from the shared hook (which releases it on unmount and invalidates saves)',
    );
    assert.match(
      usagePage,
      /const saved = await updateUsage\(\{ range \}\);[\s\S]*if \(!saved \|\| !usagePageMountedRef\.current\) return;[\s\S]*await props\.onReload\(range\);/,
      'Usage range changes must not trigger a stats reload after an unmounted or stale save',
    );
    assert.match(
      usagePage,
      /finally \{[\s\S]*usageRefreshGuard\.finish\(\);[\s\S]*if \(usagePageMountedRef\.current\) \{[\s\S]*setRefreshing\(false\);/,
      'Manual usage refresh cleanup must not write React pending state after unmount',
    );
  });

  it('drops stale usage stats reload responses', async () => {
    const src = await readSettingsCombinedSource();
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
      /catch \(error\) \{[\s\S]*if \(settingsModalMountedRef\.current && ticket === usageReloadTicketRef\.current\) \{[\s\S]*toast\.error\(copy\.usageLoadFailed, settingsActionErrorMessage\(error, locale\)\);[\s\S]*\}/,
      'Stale or unmounted usage reload failures must not toast over a newer range',
    );
  });

  it('gates manual usage refresh and reads the latest draft range', async () => {
    const src = await readSettingsCombinedSource();
    const usagePage = usagePageBlock(src);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(
      usagePage,
      /const usageRefreshGuard = useActionGuard<'refresh'>\(\)/,
      'Manual usage refresh needs a synchronous guard so fast double-clicks cannot duplicate reloads before React disables the button',
    );
    assert.match(
      usagePage,
      /async function refresh\(\) \{\s*if \(!usageRefreshGuard\.begin\('refresh'\)\) return;[\s\S]*await props\.onReload\(usageDraftRef\.current\.range\)/,
      'Manual usage refresh must lock synchronously and read the latest local draft range',
    );
    assert.match(
      usagePage,
      /finally \{[\s\S]*usageRefreshGuard\.finish\(\);[\s\S]*setRefreshing\(false\);[\s\S]*\}/,
      'Manual usage refresh must release the guard after reload settles',
    );
    assert.doesNotMatch(
      usagePage,
      /props\.onReload\(usageDraft\.range\)/,
      'Manual usage refresh must not read stale React state after a just-clicked range change',
    );
    assert.match(usagePage, /aria-busy=\{refreshing\}/, 'Usage refresh button must expose pending state to assistive tech');
    assert.match(usagePage, /data-pending=\{refreshing \? 'true' : undefined\}/, 'Usage refresh button must expose a stable pending hook');
    assert.match(usagePage, /onClick=\{\(\) => void refresh\(\)\}/, 'Usage refresh click handler must explicitly discard the async promise');
  });

  it('does not render raw request status enums in the usage table', async () => {
    const src = await readSettingsCombinedSource();
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(requestsPanel, 'Usage requests panel block must exist');
    assert.match(requestsPanel, /usageRequestStatusLabel\(row\.status\)/);
    assert.match(src, /function usageRequestStatusLabel/);
    assert.match(src, /case 'success': return '成功'/);
    assert.match(src, /case 'error': return '错误'/);
    assert.doesNotMatch(
      requestsPanel,
      /,\s*row\.status\]/,
      'Usage request table must not render raw `success` / `error` enums directly',
    );
  });

  it('labels model and tool rows without rendering raw request kind enums', async () => {
    const src = await readSettingsCombinedSource();
    const requestsPanel = requestsPanelBlock(src);

    assert.ok(requestsPanel, 'Usage requests panel block must exist');
    // Columns are objects now (per-column alignment); the request log keeps
    // its full 时间→状态 shape.
    for (const header of ['时间', '类型', '会话', 'Token', '费用', '延迟', '状态']) {
      assert.match(requestsPanel, new RegExp(`header: '${header}'`), `request log must keep the ${header} column`);
    }
    assert.match(requestsPanel, /\{ header: '对象', grow: true \}/, 'the 对象 column must absorb slack so numeric columns size to content');
    assert.match(requestsPanel, /usageRequestKindLabel\(row\.kind\)/);
    assert.match(requestsPanel, /usageRequestTarget\(row\)/);
    assert.match(requestsPanel, /usageRequestSessionCell\(row, props\.onOpenSession\)/);
    assert.match(requestsPanel, /row\.kind === 'model' \? `\$\$\{\(row\.costUsd \?\? 0\)\.toFixed\(2\)\}` : '-'/);
    assert.match(src, /case 'model': return '模型'/);
    assert.match(src, /case 'tool': return '工具'/);
    assert.match(src, /return row\.kind === 'tool' \? row\.toolName \?\? row\.model : row\.model/);
    assert.match(src, /function usageRequestSessionCell/);
    assert.match(src, /onClick=\{\(\) => onOpenSession\(row\.sessionId\)\}/);
    assert.match(src, /打开 \{label\}/);
    assert.match(src, /function shortUsageSessionId/);
    assert.doesNotMatch(
      requestsPanel,
      /,\s*row\.kind\s*,/,
      'Usage request table must not render raw `model` / `tool` enums directly',
    );
  });

  it('wires usage diagnostics rows back to source sessions through the shell', async () => {
    const settingsSrc = await readSettingsCombinedSource();
    const mainSrc = await readRendererShellCombinedSource();

    assert.match(settingsSrc, /onOpenSession\?\(sessionId: string\): void/);
    assert.match(settingsSrc, /onOpenSession=\{props\.onOpenSession\}/);
    assert.match(mainSrc, /onOpenSession=\{props\.onOpenSettingsSession\}/);
    assert.match(mainSrc, /onOpenSettingsSession=\{\(sessionId\) => \{/);
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
