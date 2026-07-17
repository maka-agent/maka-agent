import { useMemo, useState, type ReactNode } from 'react';
import type { AppSettings, UpdateAppSettingsResult, UsageRange, UsageStats } from '@maka/core';
import { Button, Input, Segmented, SettingsSelect, SettingsSwitch as Switch, useToast } from '@maka/ui';
import { RefreshCcw } from '@maka/ui/icons';
import { MetricCard } from './settings-metric-card';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';
import { useOptimisticSettingsDraft } from './use-optimistic-settings-draft';

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
            page refresh (one action, one shape everywhere). */}
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

      <Segmented
        value={usageDraft.activeTab}
        ariaLabel="使用统计视图"
        options={[
          ['requests', '请求日志'],
          ['providers', '供应商统计'],
          ['models', '模型统计'],
          ['tools', '工具统计'],
          ['pricing', '定价配置'],
        ]}
        onChange={(activeTab) => void updateUsage({ activeTab: activeTab as typeof usageDraft.activeTab })}
      />

      {showRequestDetails && (
        <div className="settingsUsageFilters" role="group" aria-label="请求记录筛选">
          <Input value={usageDraft.modelFilter} onChange={(event) => void updateUsage({ modelFilter: event.currentTarget.value })} placeholder="按模型或工具筛选…" aria-label="按模型或工具筛选请求记录" />
          <SettingsSelect
            value={usageDraft.status}
            ariaLabel="请求状态筛选"
            options={[
              ['all', '全部状态'],
              ['success', '成功'],
              ['error', '错误'],
            ] satisfies Array<readonly [typeof usageDraft.status, string]>}
            onChange={(status) => void updateUsage({ status })}
          />
          <label className="settingsUsageDetailToggle">
            <span>详情记录</span>
            <Switch
              ariaLabel="显示使用统计详情记录"
              checked={usageDraft.showDetails}
              onChange={(showDetails) => void updateUsage({ showDetails })}
            />
          </label>
          <small className="settingsUsageRecordCount">共 {filteredLogs.length} 条记录</small>
          <Button
            className="settingsUsageClearFilter"
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasRequestFilters}
            aria-hidden={!hasRequestFilters ? 'true' : undefined}
            tabIndex={!hasRequestFilters ? -1 : undefined}
            onClick={hasRequestFilters ? clearRequestFilters : undefined}
          >
            清除筛选
          </Button>
        </div>
      )}

      {usageDraft.activeTab === 'requests' && !usageDraft.showDetails ? (
        <div className="settingsNotice">
          当前仅显示汇总指标。打开详情记录后，可以查看逐条模型请求和工具调用，按模型、工具或状态筛选，并用于排查费用与失败请求。
          <div className="settingsActionRow settingsNoticeAction">
            <Button type="button" variant="secondary" size="sm" onClick={() => void updateUsage({ showDetails: true })}>
              显示明细
            </Button>
          </div>
        </div>
      ) : (
        <UsageTable
          activeTab={usageDraft.activeTab}
          stats={stats}
          logs={showRequestDetails ? filteredLogs : []}
          requestEmpty={hasRequestFilters ? '没有符合筛选条件的请求记录' : '暂无请求记录'}
          onOpenSession={props.onOpenSession}
        />
      )}
    </div>
  );
}

function UsageTable(props: { activeTab: AppSettings['usage']['activeTab']; stats: UsageStats | null; logs: UsageStats['logs']; requestEmpty: string; onOpenSession?(sessionId: string): void }) {
  if (props.activeTab === 'providers') {
    return <SimpleStatsTable ariaLabel="使用统计供应商统计表" headers={['供应商', '请求', 'Token', '费用']} rows={(props.stats?.byProvider ?? []).map((row) => [row.provider, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])} />;
  }
  if (props.activeTab === 'models') {
    return <SimpleStatsTable ariaLabel="使用统计模型统计表" headers={['模型', '请求', 'Token', '费用']} rows={(props.stats?.byModel ?? []).map((row) => [row.model, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])} />;
  }
  if (props.activeTab === 'tools') {
    return <SimpleStatsTable ariaLabel="使用统计工具统计表" headers={['工具', '调用', '成功', '错误', '平均耗时']} rows={(props.stats?.byTool ?? []).map((row) => [row.tool, row.calls, row.success, row.errors, `${row.avgDurationMs}ms`])} />;
  }
  if (props.activeTab === 'pricing') {
    return <SimpleStatsTable ariaLabel="使用统计定价配置表" headers={['供应商', '模型', '输入 / 1M', '输出 / 1M']} rows={(props.stats?.pricing ?? []).map((row) => [row.provider, row.model, `$${row.inputPerMTokUsd}`, `$${row.outputPerMTokUsd}`])} empty="暂无定价覆盖配置" />;
  }
  return <SimpleStatsTable ariaLabel="使用统计请求日志表" headers={['时间', '类型', '对象', '会话', 'Token', '费用', '延迟', '状态']} rows={props.logs.map((row) => [new Date(row.ts).toLocaleString(), usageRequestKindLabel(row.kind), usageRequestTarget(row), usageRequestSessionCell(row, props.onOpenSession), row.inputTokens + row.outputTokens, row.kind === 'model' ? `$${(row.costUsd ?? 0).toFixed(2)}` : '-', row.latencyMs ? `${row.latencyMs}ms` : '-', usageRequestStatusLabel(row.status)])} empty={props.requestEmpty} />;
}

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

function SimpleStatsTable(props: { ariaLabel: string; headers: string[]; rows: Array<Array<ReactNode>>; empty?: string }) {
  // Local table styles reproduce the retired Table primitive (now removed — a
  // single consumer did not justify a public primitive). Values are inline so
  // the stats surface stays self-contained until a second HTML <table> consumer
  // appears, at which point this can lift back to packages/ui.
  const headClass = "border-b border-border px-[var(--space-2)] py-[var(--space-1)] text-left align-middle font-semibold text-foreground-secondary [font-variant-numeric:tabular-nums]";
  const cellClass = "border-b border-border px-[var(--space-2)] py-[var(--space-1)] text-left align-middle text-foreground-secondary [font-variant-numeric:tabular-nums]";
  return (
    <table
      aria-label={props.ariaLabel}
      className="w-full border-collapse overflow-hidden rounded-[var(--radius-surface)] border border-border text-[length:var(--font-size-caption)]"
    >
      <thead>
        <tr>{props.headers.map((header) => <th key={header} scope="col" className={headClass}>{header}</th>)}</tr>
      </thead>
      <tbody>
        {props.rows.length === 0 ? (
          <tr><td colSpan={props.headers.length} className={cellClass}>{props.empty ?? '暂无请求记录'}</td></tr>
        ) : props.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row" className={headClass}>{cell}</th>
              ) : (
                <td key={cellIndex} className={cellClass}>{cell}</td>
              )
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
