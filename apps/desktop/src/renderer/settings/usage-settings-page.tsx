import { useMemo, useState, type ReactNode } from 'react';
import type { AppSettings, UpdateAppSettingsResult, UsageRange, UsageStats } from '@maka/core';
import {
  Alert,
  AlertAction,
  AlertDescription,
  Button,
  EmptyState,
  Input,
  Segmented,
  SettingsSelect,
  SettingsSwitch as Switch,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
  useToast,
} from '@maka/ui';
import { Activity, BarChart3, Cpu, Database, RefreshCcw, Search } from '@maka/ui/icons';
import { MetricCard } from './settings-metric-card';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';
import { useOptimisticSettingsDraft } from './use-optimistic-settings-draft';

type UsageActiveTab = AppSettings['usage']['activeTab'];

export function UsageSettingsPage(props: {
  settings: AppSettings;
  stats: UsageStats | null;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReload(range?: UsageRange): Promise<void>;
  onOpenSession?(sessionId: string): void;
}) {
  const persistedUsage = props.settings.usage;
  const [refreshing, setRefreshing] = useState(false);
  const usageRefreshGuard = useActionGuard<'refresh'>();
  const stats = props.stats;
  const toast = useToast();
  const {
    draft: usageDraft,
    draftRef: usageDraftRef,
    mountedRef: usagePageMountedRef,
    update,
  } = useOptimisticSettingsDraft<AppSettings['usage']>(
    persistedUsage,
    (patch) => props.onUpdate({ usage: patch }).then((result) => result.settings.usage),
    { onError: (error) => toast.error('保存使用统计设置失败', settingsActionErrorMessage(error)) },
  );

  const normalizedModelFilter = usageDraft.modelFilter.trim().toLowerCase();
  const hasRequestFilters = usageDraft.status !== 'all' || normalizedModelFilter.length > 0;
  const showRequestDetails = usageDraft.activeTab === 'requests' && usageDraft.showDetails;
  const filteredLogs = useMemo(() => {
    const logs = stats?.logs ?? [];
    return logs
      .filter((log) => usageDraft.status === 'all' || log.status === usageDraft.status)
      .filter((log) =>
        normalizedModelFilter.length === 0 ||
        log.model.toLowerCase().includes(normalizedModelFilter) ||
        (log.toolName ?? '').toLowerCase().includes(normalizedModelFilter)
      );
  }, [stats, usageDraft.status, normalizedModelFilter]);

  const tabCounts: Record<UsageActiveTab, number> = {
    requests: stats?.logs.length ?? 0,
    providers: stats?.byProvider.length ?? 0,
    models: stats?.byModel.length ?? 0,
    tools: stats?.byTool.length ?? 0,
    pricing: stats?.pricing.length ?? 0,
  };

  async function setRange(range: UsageRange) {
    const saved = await updateUsage({ range });
    if (!saved || !usagePageMountedRef.current) return;
    await props.onReload(range);
  }

  function updateUsage(patch: Partial<AppSettings['usage']>): Promise<boolean> {
    return update(patch);
  }

  async function refresh() {
    if (!usageRefreshGuard.begin('refresh')) return;
    setRefreshing(true);
    try {
      await props.onReload(usageDraftRef.current.range);
    } finally {
      usageRefreshGuard.finish();
      if (usagePageMountedRef.current) {
        setRefreshing(false);
      }
    }
  }

  function clearRequestFilters() {
    void updateUsage({ status: 'all', modelFilter: '' });
  }

  return (
    <div className="settingsUsagePage">
      <div className="settingsUsageToolbar" role="group" aria-label="使用统计范围与刷新">
        <Segmented
          value={usageDraft.range}
          ariaLabel="使用统计时间范围"
          options={[
            ['24h', '24h'],
            ['7d', '7天'],
            ['30d', '30天'],
            ['all', '全部'],
          ]}
          onChange={(value) => void setRange(value as UsageRange)}
        />
        {/* Detail audit: 刷新 was a primary --action chip glued to the
            segmented — two control styles fighting in one row for a
            low-frequency utility. Same quiet icon form as the automations
            page refresh (one action, one shape everywhere); pinned to the
            row's trailing edge so the time cluster reads as a single
            left-aligned group. */}
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          disabled={refreshing}
          aria-busy={refreshing}
          data-pending={refreshing ? 'true' : undefined}
          aria-label={refreshing ? '正在刷新使用统计' : '刷新使用统计'}
          title={refreshing ? '正在刷新使用统计' : '刷新使用统计'}
          onClick={() => void refresh()}
        >
          <RefreshCcw size={15} aria-hidden="true" />
        </Button>
      </div>

      <div className="settingsUsageSummary" role="group" aria-label="使用统计汇总指标">
        <MetricCard title="总请求" value={String(stats?.summary.totalRequests ?? 0)} />
        <MetricCard title="总费用" value={`$${(stats?.summary.totalCostUsd ?? 0).toFixed(2)}`} detail="以模型供应商最终结算为准" />
        <MetricCard title="总 Token" value={String(stats?.summary.totalTokens ?? 0)} detail={`输入 ${stats?.summary.inputTokens ?? 0} / 输出 ${stats?.summary.outputTokens ?? 0}`} />
        <MetricCard title="缓存 Token" value={String(stats?.summary.cacheTokens ?? 0)} detail={`新 ${stats?.summary.cacheMiss ?? 0} / 命中 ${stats?.summary.cacheRead ?? 0} / 创建 ${stats?.summary.cacheCreation ?? 0}`} />
      </div>

      <TabsRoot
        value={usageDraft.activeTab}
        onValueChange={(activeTab) => void updateUsage({ activeTab: activeTab as UsageActiveTab })}
      >
        <div className="settingsUsageTabsBar">
          <TabsList variant="underline" className="settingsUsageTabs" aria-label="使用统计视图">
            <TabsTrigger className="settingsUsageTab" value="requests">请求日志 <span>{tabCounts.requests}</span></TabsTrigger>
            <TabsTrigger className="settingsUsageTab" value="providers">供应商统计 <span>{tabCounts.providers}</span></TabsTrigger>
            <TabsTrigger className="settingsUsageTab" value="models">模型统计 <span>{tabCounts.models}</span></TabsTrigger>
            <TabsTrigger className="settingsUsageTab" value="tools">工具统计 <span>{tabCounts.tools}</span></TabsTrigger>
            <TabsTrigger className="settingsUsageTab" value="pricing">定价配置 <span>{tabCounts.pricing}</span></TabsTrigger>
          </TabsList>
        </div>

        <TabsPanel className="settingsUsageTabPanel" value="requests">
          <UsageRequestsPanel
            stats={stats}
            logs={showRequestDetails ? filteredLogs : []}
            showDetails={usageDraft.showDetails}
            modelFilter={usageDraft.modelFilter}
            status={usageDraft.status}
            recordCount={filteredLogs.length}
            hasRequestFilters={hasRequestFilters}
            requestEmpty={hasRequestFilters ? '没有符合筛选条件的请求记录' : '暂无请求记录'}
            onOpenSession={props.onOpenSession}
            onEnableDetails={() => void updateUsage({ showDetails: true })}
            onModelFilterChange={(modelFilter) => void updateUsage({ modelFilter })}
            onStatusChange={(status) => void updateUsage({ status })}
            onToggleDetails={(showDetails) => void updateUsage({ showDetails })}
            onClearFilters={clearRequestFilters}
          />
        </TabsPanel>

        <TabsPanel className="settingsUsageTabPanel" value="providers">
          <UsageProvidersPanel stats={stats} />
        </TabsPanel>

        <TabsPanel className="settingsUsageTabPanel" value="models">
          <UsageModelsPanel stats={stats} />
        </TabsPanel>

        <TabsPanel className="settingsUsageTabPanel" value="tools">
          <UsageToolsPanel stats={stats} />
        </TabsPanel>

        <TabsPanel className="settingsUsageTabPanel" value="pricing">
          <UsagePricingPanel stats={stats} />
        </TabsPanel>
      </TabsRoot>
    </div>
  );
}

// ── Per-tab panels ─────────────────────────────────────────────────────────
// Each tab owns its own component so the panel structure (filters, tables,
// empty states) reads top-to-bottom instead of hiding inside one switch.
// They all funnel their rows through the shared UsageStatsTable so every tab
// inherits the same hairline / column-rhythm / tabular-nums recipe.

function UsageRequestsPanel(props: {
  stats: UsageStats | null;
  logs: UsageStats['logs'];
  showDetails: boolean;
  modelFilter: string;
  status: AppSettings['usage']['status'];
  recordCount: number;
  hasRequestFilters: boolean;
  requestEmpty: string;
  onOpenSession?(sessionId: string): void;
  onEnableDetails(): void;
  onModelFilterChange(value: string): void;
  onStatusChange(status: AppSettings['usage']['status']): void;
  onToggleDetails(showDetails: boolean): void;
  onClearFilters(): void;
}) {
  if (!props.showDetails) {
    return (
      <Alert variant="info">
        <AlertDescription>当前仅显示汇总指标。打开详情记录后，可以查看逐条模型请求和工具调用，按模型、工具或状态筛选，并用于排查费用与失败请求。</AlertDescription>
        <AlertAction>
          <Button type="button" variant="secondary" size="sm" onClick={props.onEnableDetails}>
            显示明细
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <>
      <div className="settingsUsageFilters" role="group" aria-label="请求记录筛选">
        <Input value={props.modelFilter} onChange={(event) => props.onModelFilterChange(event.currentTarget.value)} placeholder="按模型或工具筛选…" aria-label="按模型或工具筛选请求记录" />
        <SettingsSelect
          value={props.status}
          ariaLabel="请求状态筛选"
          options={[
            ['all', '全部状态'],
            ['success', '成功'],
            ['error', '错误'],
          ] satisfies Array<readonly [AppSettings['usage']['status'], string]>}
          onChange={props.onStatusChange}
        />
        <label className="settingsUsageDetailToggle">
          <span>详情记录</span>
          <Switch
            ariaLabel="显示使用统计详情记录"
            checked={props.showDetails}
            onChange={props.onToggleDetails}
          />
        </label>
        <small className="settingsUsageRecordCount">共 {props.recordCount} 条记录</small>
        <Button
          className="settingsUsageClearFilter"
          type="button"
          variant="ghost"
          size="sm"
          disabled={!props.hasRequestFilters}
          aria-hidden={!props.hasRequestFilters ? 'true' : undefined}
          tabIndex={!props.hasRequestFilters ? -1 : undefined}
          onClick={props.hasRequestFilters ? props.onClearFilters : undefined}
        >
          清除筛选
        </Button>
      </div>
      <UsageStatsTable
        ariaLabel="使用统计请求日志表"
        columns={[
          { header: '时间' },
          { header: '类型' },
          { header: '对象', grow: true },
          { header: '会话' },
          { header: 'Token', numeric: true },
          { header: '费用', numeric: true },
          { header: '延迟', numeric: true },
          { header: '状态' },
        ]}
        rows={props.logs.map((row) => [
          new Date(row.ts).toLocaleString(),
          usageRequestKindLabel(row.kind),
          usageRequestTarget(row),
          usageRequestSessionCell(row, props.onOpenSession),
          row.inputTokens + row.outputTokens,
          row.kind === 'model' ? `$${(row.costUsd ?? 0).toFixed(2)}` : '-',
          row.latencyMs ? `${row.latencyMs}ms` : '-',
          usageRequestStatusLabel(row.status),
        ])}
        empty={{ Icon: props.hasRequestFilters ? Search : Activity, title: props.requestEmpty }}
      />
    </>
  );
}

function UsageProvidersPanel(props: { stats: UsageStats | null }) {
  return (
    <UsageStatsTable
      ariaLabel="使用统计供应商统计表"
      columns={[
        { header: '供应商', grow: true },
        { header: '请求', numeric: true },
        { header: 'Token', numeric: true },
        { header: '费用', numeric: true },
      ]}
      rows={(props.stats?.byProvider ?? []).map((row) => [row.provider, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])}
      empty={{ Icon: Database, title: '暂无供应商用量', body: '完成一次模型请求后，这里会按供应商聚合请求数、Token 与费用。' }}
    />
  );
}

function UsageModelsPanel(props: { stats: UsageStats | null }) {
  return (
    <UsageStatsTable
      ariaLabel="使用统计模型统计表"
      columns={[
        { header: '模型', grow: true },
        { header: '请求', numeric: true },
        { header: 'Token', numeric: true },
        { header: '费用', numeric: true },
      ]}
      rows={(props.stats?.byModel ?? []).map((row) => [row.model, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])}
      empty={{ Icon: Cpu, title: '暂无模型用量', body: '完成一次模型请求后，这里会按模型聚合请求数、Token 与费用。' }}
    />
  );
}

function UsageToolsPanel(props: { stats: UsageStats | null }) {
  return (
    <UsageStatsTable
      ariaLabel="使用统计工具统计表"
      columns={[
        { header: '工具', grow: true },
        { header: '调用', numeric: true },
        { header: '成功', numeric: true },
        { header: '错误', numeric: true },
        { header: '平均耗时', numeric: true },
      ]}
      rows={(props.stats?.byTool ?? []).map((row) => [row.tool, row.calls, row.success, row.errors, `${row.avgDurationMs}ms`])}
      empty={{ Icon: Activity, title: '暂无工具调用', body: '智能体调用工具后，这里会按工具聚合调用次数、成功、错误与平均耗时。' }}
    />
  );
}

function UsagePricingPanel(props: { stats: UsageStats | null }) {
  return (
    <UsageStatsTable
      ariaLabel="使用统计定价配置表"
      columns={[
        { header: '供应商', grow: true },
        { header: '模型' },
        { header: '输入 / 1M', numeric: true },
        { header: '输出 / 1M', numeric: true },
      ]}
      rows={(props.stats?.pricing ?? []).map((row) => [row.provider, row.model, `$${row.inputPerMTokUsd}`, `$${row.outputPerMTokUsd}`])}
      empty={{ Icon: BarChart3, title: '暂无定价覆盖配置', body: '未配置定价覆盖时，费用按内置模型定价表结算；在此可为特定模型登记自定义价格。' }}
    />
  );
}

// ── Request-log cell helpers ────────────────────────────────────────────────

function usageRequestKindLabel(kind: UsageStats['logs'][number]['kind']) {
  switch (kind) {
    case 'model': return '模型';
    case 'tool': return '工具';
  }
}

function usageRequestTarget(row: UsageStats['logs'][number]) {
  return row.kind === 'tool' ? row.toolName ?? row.model : row.model;
}

function usageRequestSessionCell(row: UsageStats['logs'][number], onOpenSession?: (sessionId: string) => void) {
  const label = shortUsageSessionId(row.sessionId);
  if (!onOpenSession) return label;
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => onOpenSession(row.sessionId)}>
      打开 {label}
    </Button>
  );
}

function shortUsageSessionId(sessionId: string) {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function usageRequestStatusLabel(status: UsageStats['logs'][number]['status']) {
  switch (status) {
    case 'success': return '成功';
    case 'error': return '错误';
  }
}

// ── Shared table primitive ─────────────────────────────────────────────────
// The local table recipe reproduces the retired public Table primitive (a
// single HTML <table> surface did not justify one in packages/ui). All five
// usage tabs render through it so the column rhythm, hairline separators,
// muted+medium header row, and per-column alignment stay identical.
//
// Column model: the `grow` column absorbs the row's slack so numeric columns
// shrink to content (no floating giant gaps); numeric columns right-align and
// force tabular-nums; the first column is a scoped row header.

interface UsageColumn {
  header: string;
  /** Numeric columns right-align and force tabular-nums. */
  numeric?: boolean;
  /** The column that absorbs slack so the others size to content. */
  grow?: boolean;
}

interface UsageEmpty {
  /** A lucide icon (same shape EmptyState accepts). */
  Icon: typeof Search;
  title: string;
  body?: string;
}

function UsageStatsTable(props: {
  ariaLabel: string;
  columns: UsageColumn[];
  rows: Array<Array<ReactNode>>;
  empty: UsageEmpty;
}) {
  if (props.rows.length === 0) {
    return (
      <EmptyState
        Icon={props.empty.Icon}
        title={props.empty.title}
        body={props.empty.body ?? ''}
        extraClassName="settingsUsageEmpty"
      />
    );
  }
  const base = 'border-b border-border px-[var(--space-2)] py-[var(--space-1-5)] align-middle';
  // Only the grow column wraps; every other column stays on one line and sizes
  // to its content (no per-character header wrapping, no floating giant gaps).
  const shape = (column: UsageColumn) =>
    [
      column.numeric ? 'text-right [font-variant-numeric:tabular-nums]' : 'text-left',
      column.grow ? 'w-full' : 'whitespace-nowrap',
    ].join(' ');
  const cellClass = (column: UsageColumn) => `${base} text-foreground-secondary ${shape(column)}`;
  const headClass = (column: UsageColumn) => `${base} font-medium text-muted-foreground ${shape(column)}`;
  return (
    <table
      aria-label={props.ariaLabel}
      className="settingsUsageTable w-full border-collapse overflow-hidden rounded-[var(--radius-surface)] border border-border text-[length:var(--font-size-caption)]"
    >
      <thead>
        <tr>
          {props.columns.map((column) => (
            <th key={column.header} scope="col" className={headClass(column)}>{column.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row" className={`${cellClass(props.columns[cellIndex])} font-medium text-foreground`}>{cell}</th>
              ) : (
                <td key={cellIndex} className={cellClass(props.columns[cellIndex])}>{cell}</td>
              )
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
