import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Card,
  EmptyState,
  FormLayout,
  NumberInput,
  SegmentedControl,
  SegmentedControlItem,
  Tab,
  TabList,
  Table,
  type TableColumn,
  type TablePlugin,
  pixel,
  proportional,
} from '@astryxdesign/core';
import {
  uiLocaleToIntlLocale,
  type AppSettings,
  type PricingConfig,
  type UpdateAppSettingsResult,
  type UsageRange,
  type UsageStats,
} from '@maka/core';
import {
  Button,
  IconButton,
  TextInput,
  Selector,
  Switch,
  useToast,
  useUiLocale,
  Banner,
} from '@maka/ui';
import type { EffectivePricingEntry, PricingMutation } from '@maka/runtime-host/protocol';
import { Activity, BarChart3, Cpu, Database, RefreshCcw, Search } from '@maka/ui/icons';
import {
  getUsageSettingsCopy,
  type UsageSettingsCopy,
} from '../locales/settings-usage-copy';
import { MetricCard } from './settings-metric-card';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage } from './settings-section';
import { useActionGuard } from './use-action-guard';
import { useOptimisticSettingsDraft } from './use-optimistic-settings-draft';
import type {
  DesktopPricingMutationOutcome,
  DesktopPricingSettingsPort,
  DesktopPricingSnapshot,
} from '../../shared/runtime-host-pricing';

type UsageActiveTab = AppSettings['usage']['activeTab'];
type PricingIssue =
  | { kind: 'load_failed'; detail: string }
  | { kind: 'saved_refresh_failed' | 'reconciliation_unavailable'; detail: string };

export function UsageSettingsPage(props: {
  settings: AppSettings;
  stats: UsageStats | null;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReload(range?: UsageRange): Promise<void>;
  onOpenSession?(sessionId: string): void;
  pricingPort?: DesktopPricingSettingsPort;
}) {
  const locale = useUiLocale();
  const copy = getUsageSettingsCopy(locale);
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
    { onError: (error) => toast.error(copy.saveFailed, settingsActionErrorMessage(error, locale)) },
  );
  const [pricingSnapshot, setPricingSnapshot] = useState<DesktopPricingSnapshot | null>(null);
  const pricingSnapshotRef = useRef<DesktopPricingSnapshot | null>(null);
  const [pricingLoading, setPricingLoading] = useState(true);
  const [pricingIssue, setPricingIssue] = useState<PricingIssue | null>(null);
  const pricingReloadTicketRef = useRef(0);

  function replacePricingSnapshot(next: DesktopPricingSnapshot | null) {
    pricingSnapshotRef.current = next;
    setPricingSnapshot(next);
  }

  const reloadPricingSnapshot = useCallback(async () => {
    const ticket = pricingReloadTicketRef.current + 1;
    pricingReloadTicketRef.current = ticket;
    if (usagePageMountedRef.current) setPricingLoading(true);
    if (!props.pricingPort) {
      if (usagePageMountedRef.current && ticket === pricingReloadTicketRef.current) {
        replacePricingSnapshot(null);
        setPricingIssue({ kind: 'load_failed', detail: copy.pricing.unavailable });
        setPricingLoading(false);
      }
      return;
    }
    try {
      const next = await props.pricingPort.loadPricingSnapshot();
      if (usagePageMountedRef.current && ticket === pricingReloadTicketRef.current) {
        replacePricingSnapshot(next);
        setPricingIssue(null);
      }
    } catch (error) {
      if (usagePageMountedRef.current && ticket === pricingReloadTicketRef.current) {
        setPricingIssue({
          kind: 'load_failed',
          detail: settingsActionErrorMessage(error, locale),
        });
      }
    } finally {
      if (usagePageMountedRef.current && ticket === pricingReloadTicketRef.current) {
        setPricingLoading(false);
      }
    }
  }, [copy.pricing.unavailable, locale, props.pricingPort, usagePageMountedRef]);

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
    pricing: pricingSnapshot?.entries.length ?? 0,
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
      await Promise.all([
        props.onReload(usageDraftRef.current.range),
        reloadPricingSnapshot(),
      ]);
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

  useEffect(() => {
    void reloadPricingSnapshot();
  }, [reloadPricingSnapshot]);

  async function putPricingOverride(pricing: PricingConfig) {
    return applyPricingMutation({ kind: 'upsert', pricing });
  }

  async function resetPricingOverride(entry: EffectivePricingEntry) {
    return applyPricingMutation({ kind: 'delete', modelKey: entry.pricing.modelKey });
  }

  async function applyPricingMutation(
    mutation: PricingMutation,
  ): Promise<DesktopPricingMutationOutcome> {
    const port = props.pricingPort;
    const base = pricingSnapshotRef.current;
    if (!port || !base) throw new Error(copy.pricing.unavailable);
    const outcome = await port.applyPricingMutation({ base, mutation });
    if (outcome.kind === 'saved' || outcome.kind === 'synchronized') {
      replacePricingSnapshot(outcome.snapshot);
      setPricingIssue(null);
      return outcome;
    }
    if (outcome.kind === 'review_required') {
      replacePricingSnapshot(outcome.snapshot);
      setPricingIssue(null);
      return outcome;
    }
    if (outcome.kind === 'saved_refresh_failed') {
      setPricingIssue({
        kind: 'saved_refresh_failed',
        detail: copy.pricing.reconciliationRequired,
      });
      return outcome;
    }
    setPricingIssue({
      kind: 'reconciliation_unavailable',
      detail: copy.pricing.reconciliationRequired,
    });
    return outcome;
  }

  return (
    <SettingsPage className="settingsUsagePage">
      <div className="settingsUsageOverview">
        <div className="settingsUsageToolbar" role="group" aria-label={copy.toolbarAria}>
          <SegmentedControl
            value={usageDraft.range}
            label={copy.rangeAria}
            onChange={(value) => void setRange(value as UsageRange)}
          >
            {(['24h', '7d', '30d', 'all'] as const).map((value, index) => (
              <SegmentedControlItem key={value} value={value} label={copy.ranges[index]} />
            ))}
          </SegmentedControl>
          {/* Detail audit: 刷新 was a primary --action chip glued to the
              segmented — two control styles fighting in one row for a
              low-frequency utility. Same quiet icon form as the automations
              page refresh (one action, one shape everywhere); pinned to the
              row's trailing edge so the time cluster reads as a single
              left-aligned group. */}
          <IconButton
            variant="ghost"
            size="sm"
            isDisabled={refreshing}
            aria-busy={refreshing}
            data-pending={refreshing ? 'true' : undefined}
            label={refreshing ? copy.refreshingAria : copy.refreshAria}
            tooltip={refreshing ? copy.refreshingAria : copy.refreshAria}
            onClick={() => void refresh()}
            icon={<RefreshCcw size={15} aria-hidden="true" />}
          />
        </div>

        <div className="settingsUsageSummary" role="group" aria-label={copy.summaryAria}>
          <MetricCard title={copy.totalRequests} value={String(stats?.summary.totalRequests ?? 0)} />
          <MetricCard title={copy.totalCost} value={`$${(stats?.summary.totalCostUsd ?? 0).toFixed(2)}`} detail={copy.costHelp} />
          <MetricCard title={copy.totalTokens} value={String(stats?.summary.totalTokens ?? 0)} detail={copy.tokenDetail(stats?.summary.inputTokens ?? 0, stats?.summary.outputTokens ?? 0)} />
          <MetricCard title={copy.cacheTokens} value={String(stats?.summary.cacheTokens ?? 0)} detail={copy.cacheDetail(stats?.summary.cacheMiss ?? 0, stats?.summary.cacheRead ?? 0, stats?.summary.cacheCreation ?? 0)} />
        </div>
      </div>

      <div className="settingsUsageBreakdown">
        <div className="settingsUsageTabsBar">
          <TabList
            value={usageDraft.activeTab}
            onChange={(activeTab) => void updateUsage({ activeTab: activeTab as UsageActiveTab })}
            hasDivider
            aria-label={copy.viewAria}
          >
            <Tab value="requests" label={copy.tabs[0]} endContent={<span>{tabCounts.requests}</span>} />
            <Tab value="providers" label={copy.tabs[1]} endContent={<span>{tabCounts.providers}</span>} />
            <Tab value="models" label={copy.tabs[2]} endContent={<span>{tabCounts.models}</span>} />
            <Tab value="tools" label={copy.tabs[3]} endContent={<span>{tabCounts.tools}</span>} />
            <Tab value="pricing" label={copy.tabs[4]} endContent={<span>{tabCounts.pricing}</span>} />
          </TabList>
        </div>

        {usageDraft.activeTab === 'requests' ? (
          <div className="settingsUsageTabPanel">
            <UsageRequestsPanel
            stats={stats}
            logs={showRequestDetails ? filteredLogs : []}
            showDetails={usageDraft.showDetails}
            modelFilter={usageDraft.modelFilter}
            status={usageDraft.status}
            recordCount={filteredLogs.length}
            hasRequestFilters={hasRequestFilters}
            requestEmpty={hasRequestFilters ? copy.filteredEmpty : copy.requestEmpty}
            copy={copy}
            locale={locale}
            onOpenSession={props.onOpenSession}
            onEnableDetails={() => void updateUsage({ showDetails: true })}
            onModelFilterChange={(modelFilter) => void updateUsage({ modelFilter })}
            onStatusChange={(status) => void updateUsage({ status })}
            onToggleDetails={(showDetails) => void updateUsage({ showDetails })}
            onClearFilters={clearRequestFilters}
            />
          </div>
        ) : null}

        {usageDraft.activeTab === 'providers' ? (
          <div className="settingsUsageTabPanel">
            <UsageProvidersPanel stats={stats} copy={copy} />
          </div>
        ) : null}

        {usageDraft.activeTab === 'models' ? (
          <div className="settingsUsageTabPanel">
            <UsageModelsPanel stats={stats} copy={copy} />
          </div>
        ) : null}

        {usageDraft.activeTab === 'tools' ? (
          <div className="settingsUsageTabPanel">
            <UsageToolsPanel stats={stats} copy={copy} />
          </div>
        ) : null}

        {usageDraft.activeTab === 'pricing' ? (
          <div className="settingsUsageTabPanel">
            {props.pricingPort ? (
              <UsagePricingPanel
                entries={pricingSnapshot?.entries ?? []}
                isLoading={pricingLoading}
                isReady={Boolean(pricingSnapshot) && !pricingIssue && !pricingLoading}
                pricingIssue={pricingIssue}
                copy={copy}
                onPut={putPricingOverride}
                onReset={resetPricingOverride}
                onReloadPricing={reloadPricingSnapshot}
              />
            ) : (
              <UsagePricingUnavailablePanel copy={copy} />
            )}
          </div>
        ) : null}
      </div>
    </SettingsPage>
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
  copy: UsageSettingsCopy;
  locale: ReturnType<typeof useUiLocale>;
  onOpenSession?(sessionId: string): void;
  onEnableDetails(): void;
  onModelFilterChange(value: string): void;
  onStatusChange(status: AppSettings['usage']['status']): void;
  onToggleDetails(showDetails: boolean): void;
  onClearFilters(): void;
}) {
  if (!props.showDetails) {
    return (
      <Banner
        status="info"
        title={props.copy.summaryOnly}
        endContent={<Button variant="secondary" size="sm" onClick={props.onEnableDetails} label={props.copy.showDetails} />} />
    );
  }
  return (
    <>
      <div className="settingsUsageFilters" role="group" aria-label={props.copy.filtersAria}>
        <div className="settingsUsageModelFilter">
          <TextInput
            value={props.modelFilter}
            onChange={(value) => props.onModelFilterChange(value)}
            placeholder={props.copy.filterPlaceholder}
            label={props.copy.filterAria}
            isLabelHidden
            width="100%"
          />
        </div>
        <Selector
          value={props.status}
          label={props.copy.statusAria}
          isLabelHidden
          options={[
            { value: 'all', label: props.copy.statuses[0] },
            { value: 'success', label: props.copy.statuses[1] },
            { value: 'error', label: props.copy.statuses[2] },
          ]}
          width={320}
          onChange={(value) => props.onStatusChange(value as AppSettings['usage']['status'])}
        />
        <div className="settingsUsageDetailToggle">
          <span>{props.copy.details}</span>
          <Switch
            label={props.copy.detailsAria}
            isLabelHidden
            value={props.showDetails}
            onChange={props.onToggleDetails}
          />
        </div>
        <small className="settingsUsageRecordCount">{props.copy.recordCount(props.recordCount)}</small>
        <Button
          className="settingsUsageClearFilter"
          variant="ghost"
          size="sm"
          isDisabled={!props.hasRequestFilters}
          aria-hidden={!props.hasRequestFilters ? 'true' : undefined}
          tabIndex={!props.hasRequestFilters ? -1 : undefined}
          onClick={props.hasRequestFilters ? props.onClearFilters : undefined}
          label={props.copy.clearFilters}
        />
      </div>
      <UsageStatsTable
        ariaLabel={props.copy.tables.requestsAria}
        columns={[
          { header: props.copy.tables.requestHeaders[0] },
          { header: props.copy.tables.requestHeaders[1] },
          { header: props.copy.tables.requestHeaders[2], grow: true },
          { header: props.copy.tables.requestHeaders[3] },
          { header: props.copy.tables.requestHeaders[4], numeric: true },
          { header: props.copy.tables.requestHeaders[5], numeric: true },
          { header: props.copy.tables.requestHeaders[6], numeric: true },
          { header: props.copy.tables.requestHeaders[7] },
        ]}
        rows={props.logs.map((row) => [
          new Date(row.ts).toLocaleString(uiLocaleToIntlLocale(props.locale)),
          usageRequestKindLabel(row.kind, props.copy),
          usageRequestTarget(row),
          usageRequestSessionCell(row, props.copy, props.onOpenSession),
          row.inputTokens + row.outputTokens,
          row.kind === 'model' ? `$${(row.costUsd ?? 0).toFixed(2)}` : '-',
          row.latencyMs ? `${row.latencyMs}ms` : '-',
          usageRequestStatusLabel(row.status, props.copy),
        ])}
        empty={{ Icon: props.hasRequestFilters ? Search : Activity, title: props.requestEmpty }}
      />
    </>
  );
}

function UsageProvidersPanel(props: { stats: UsageStats | null; copy: UsageSettingsCopy }) {
  return (
    <UsageStatsTable
      ariaLabel={props.copy.tables.providersAria}
      columns={[
        { header: props.copy.tables.providerHeaders[0], grow: true },
        { header: props.copy.tables.providerHeaders[1], numeric: true },
        { header: props.copy.tables.providerHeaders[2], numeric: true },
        { header: props.copy.tables.providerHeaders[3], numeric: true },
      ]}
      rows={(props.stats?.byProvider ?? []).map((row) => [row.provider, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])}
      empty={{ Icon: Database, title: props.copy.tables.providerEmptyTitle, body: props.copy.tables.providerEmptyBody }}
    />
  );
}

function UsageModelsPanel(props: { stats: UsageStats | null; copy: UsageSettingsCopy }) {
  return (
    <UsageStatsTable
      ariaLabel={props.copy.tables.modelsAria}
      columns={[
        { header: props.copy.tables.modelHeaders[0], grow: true },
        { header: props.copy.tables.modelHeaders[1], numeric: true },
        { header: props.copy.tables.modelHeaders[2], numeric: true },
        { header: props.copy.tables.modelHeaders[3], numeric: true },
      ]}
      rows={(props.stats?.byModel ?? []).map((row) => [row.model, row.requests, row.tokens, `$${row.costUsd.toFixed(2)}`])}
      empty={{ Icon: Cpu, title: props.copy.tables.modelEmptyTitle, body: props.copy.tables.modelEmptyBody }}
    />
  );
}

function UsageToolsPanel(props: { stats: UsageStats | null; copy: UsageSettingsCopy }) {
  return (
    <UsageStatsTable
      ariaLabel={props.copy.tables.toolsAria}
      columns={[
        { header: props.copy.tables.toolHeaders[0], grow: true },
        { header: props.copy.tables.toolHeaders[1], numeric: true },
        { header: props.copy.tables.toolHeaders[2], numeric: true },
        { header: props.copy.tables.toolHeaders[3], numeric: true },
        { header: props.copy.tables.toolHeaders[4], numeric: true },
      ]}
      rows={(props.stats?.byTool ?? []).map((row) => [row.tool, row.calls, row.success, row.errors, `${row.avgDurationMs}ms`])}
      empty={{ Icon: Activity, title: props.copy.tables.toolEmptyTitle, body: props.copy.tables.toolEmptyBody }}
    />
  );
}

function UsagePricingUnavailablePanel(props: { copy: UsageSettingsCopy }) {
  return (
    <UsageStatsTable
      ariaLabel={props.copy.tables.pricingAria}
      columns={[
        { header: props.copy.tables.pricingHeaders[0], grow: true },
        { header: props.copy.tables.pricingHeaders[1], grow: true },
        { header: props.copy.tables.pricingHeaders[2] },
        { header: props.copy.tables.pricingHeaders[3], numeric: true },
        { header: props.copy.tables.pricingHeaders[4], numeric: true },
        { header: props.copy.tables.pricingHeaders[5], numeric: true },
        { header: props.copy.tables.pricingHeaders[6], numeric: true },
        { header: props.copy.tables.pricingHeaders[7] },
      ]}
      rows={[]}
      empty={{ Icon: BarChart3, title: props.copy.tables.noPricing, body: props.copy.tables.pricingEmptyBody }}
    />
  );
}

interface PricingDraft {
  originalModelKey: string | null;
  modelKey: string;
  inputUsdPer1M: number | null;
  outputUsdPer1M: number | null;
  cacheReadUsdPer1M: number | null;
  cacheWriteUsdPer1M: number | null;
}

function emptyPricingDraft(): PricingDraft {
  return {
    originalModelKey: null,
    modelKey: '',
    inputUsdPer1M: null,
    outputUsdPer1M: null,
    cacheReadUsdPer1M: null,
    cacheWriteUsdPer1M: null,
  };
}

function pricingDraftFromEntry(entry: EffectivePricingEntry): PricingDraft {
  const pricing = entry.pricing;
  return {
    // Builtin entries are being customized, not edited in place. Custom
    // entries keep their exact key and are edited as overrides.
    originalModelKey: entry.source === 'custom' ? pricing.modelKey : null,
    modelKey: pricing.modelKey,
    inputUsdPer1M: pricing.inputUsdPer1M,
    outputUsdPer1M: pricing.outputUsdPer1M,
    cacheReadUsdPer1M: pricing.cacheReadUsdPer1M ?? null,
    cacheWriteUsdPer1M: pricing.cacheWriteUsdPer1M ?? null,
  };
}

function pricingConfigFromDraft(draft: PricingDraft): PricingConfig | null {
  const modelKey = draft.modelKey.trim();
  if (!modelKey || draft.inputUsdPer1M === null || draft.outputUsdPer1M === null) return null;
  return {
    modelKey,
    inputUsdPer1M: draft.inputUsdPer1M,
    outputUsdPer1M: draft.outputUsdPer1M,
    ...(draft.cacheReadUsdPer1M === null ? {} : { cacheReadUsdPer1M: draft.cacheReadUsdPer1M }),
    ...(draft.cacheWriteUsdPer1M === null ? {} : { cacheWriteUsdPer1M: draft.cacheWriteUsdPer1M }),
  };
}

function splitPricingModelKey(modelKey: string): { provider: string; model: string } {
  const separator = modelKey.indexOf(':');
  if (separator <= 0) return { provider: '', model: modelKey };
  return { provider: modelKey.slice(0, separator), model: modelKey.slice(separator + 1) };
}

function formatPricingRate(rate: number | undefined, empty: string): string {
  return rate === undefined ? empty : `$${rate}`;
}

function UsagePricingPanel(props: {
  entries: readonly EffectivePricingEntry[];
  isLoading: boolean;
  isReady: boolean;
  pricingIssue: PricingIssue | null;
  copy: UsageSettingsCopy;
  onPut(pricing: PricingConfig): Promise<DesktopPricingMutationOutcome>;
  onReset(entry: EffectivePricingEntry): Promise<DesktopPricingMutationOutcome>;
  onReloadPricing(): Promise<void>;
}) {
  const locale = useUiLocale();
  const toast = useToast();
  const pricingActionGuard = useActionGuard<'put' | 'reset'>();
  const [draft, setDraft] = useState<PricingDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openAddForm() {
    if (!props.isReady) return;
    setFormError(null);
    setDraft(emptyPricingDraft());
  }

  function openEditForm(entry: EffectivePricingEntry) {
    if (!props.isReady) return;
    setFormError(null);
    setDraft(pricingDraftFromEntry(entry));
  }

  function closeForm() {
    if (!busy) {
      setDraft(null);
      setFormError(null);
    }
  }

  async function savePricing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !props.isReady || !pricingActionGuard.begin('put')) return;
    const pricing = pricingConfigFromDraft(draft);
    if (!pricing) {
      setFormError(props.copy.pricing.invalid);
      pricingActionGuard.finish();
      return;
    }
    setBusy(true);
    try {
      const outcome = await props.onPut(pricing);
      if (outcome.kind === 'saved' || outcome.kind === 'synchronized') {
        setDraft(null);
        setFormError(null);
        toast.success(props.copy.pricing.saved);
      } else if (outcome.kind === 'review_required') {
        setDraft(null);
        setFormError(null);
        toast.warning(props.copy.pricing.reviewRequired);
      } else if (outcome.kind === 'saved_refresh_failed') {
        toast.warning(
          props.copy.pricing.savedRefreshFailed,
          props.copy.pricing.reconciliationRequired,
        );
      } else {
        toast.warning(
          props.copy.pricing.outcomeUnknown,
          props.copy.pricing.reconciliationRequired,
        );
      }
    } catch (error) {
      toast.error(props.copy.pricing.saveFailed, settingsActionErrorMessage(error, locale));
    } finally {
      pricingActionGuard.finish();
      setBusy(false);
    }
  }

  async function removePricing(entry: EffectivePricingEntry) {
    if (entry.source !== 'custom' || !props.isReady) return;
    const modelKey = entry.pricing.modelKey;
    const resetEffect = entry.resetEffect;
    if (!pricingActionGuard.begin('reset')) return;
    setBusy(true);
    try {
      const confirmed = await toast.confirm({
        title: props.copy.pricing.removeTitle(modelKey),
        description: props.copy.pricing.removeDescription(modelKey, resetEffect),
        confirmLabel: resetEffect === 'restore_builtin' ? props.copy.pricing.reset : props.copy.pricing.remove,
        cancelLabel: props.copy.pricing.cancel,
        destructive: true,
      });
      if (!confirmed || !props.isReady) return;
      const outcome = await props.onReset(entry);
      if (outcome.kind === 'saved' || outcome.kind === 'synchronized') {
        if (draft?.originalModelKey === modelKey) {
          setDraft(null);
          setFormError(null);
        }
        toast.success(props.copy.pricing.removed);
      } else if (outcome.kind === 'review_required') {
        setDraft(null);
        setFormError(null);
        toast.warning(props.copy.pricing.reviewRequired);
      } else if (outcome.kind === 'saved_refresh_failed') {
        toast.warning(
          props.copy.pricing.savedRefreshFailed,
          props.copy.pricing.reconciliationRequired,
        );
      } else {
        toast.warning(
          props.copy.pricing.outcomeUnknown,
          props.copy.pricing.reconciliationRequired,
        );
      }
    } catch (error) {
      toast.error(props.copy.pricing.deleteFailed, settingsActionErrorMessage(error, locale));
    } finally {
      pricingActionGuard.finish();
      setBusy(false);
    }
  }

  const controlsDisabled = busy || props.isLoading || !props.isReady;
  const pricingIssueTitle = props.pricingIssue?.kind === 'load_failed'
    ? props.copy.pricing.loadFailed
    : props.pricingIssue?.kind === 'saved_refresh_failed'
      ? props.copy.pricing.savedRefreshFailed
      : props.copy.pricing.outcomeUnknown;
  return (
    <>
      <div className="settingsUsagePricingHeader">
        <div>
          <strong>{props.copy.pricing.title}</strong>
          <small>{props.copy.pricing.description}</small>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          isDisabled={controlsDisabled}
          onClick={openAddForm}
          label={props.copy.pricing.add}
        />
      </div>

      {props.pricingIssue ? (
        <Banner
          status={props.pricingIssue.kind === 'load_failed' ? 'error' : 'warning'}
          title={pricingIssueTitle}
          description={props.pricingIssue.detail}
          endContent={(
            <Button
              variant="ghost"
              size="sm"
              isDisabled={props.isLoading}
              aria-busy={props.isLoading}
              onClick={() => void props.onReloadPricing()}
              label={props.isLoading ? props.copy.pricing.retrying : props.copy.pricing.retry}
            />
          )}
        />
      ) : null}

      {draft ? (
        <form
          className="settingsUsagePricingForm"
          aria-label={props.copy.pricing.formAria}
          aria-busy={busy}
          onSubmit={(event) => void savePricing(event)}
        >
          <FormLayout>
            <TextInput
              value={draft.modelKey}
              onChange={(modelKey) => setDraft((current) => current ? { ...current, modelKey } : current)}
              placeholder={props.copy.pricing.modelKeyPlaceholder}
              label={props.copy.pricing.modelKey}
              isRequired
              isDisabled={controlsDisabled || draft.originalModelKey !== null}
              width="100%"
            />
            <div className="settingsUsagePricingRateFields">
              <NumberInput
                label={props.copy.pricing.inputRate}
                value={draft.inputUsdPer1M}
                min={0}
                step={0.000001}
                hasClear
                isRequired
                isDisabled={controlsDisabled}
                onChange={(inputUsdPer1M) => setDraft((current) => current ? { ...current, inputUsdPer1M } : current)}
              />
              <NumberInput
                label={props.copy.pricing.outputRate}
                value={draft.outputUsdPer1M}
                min={0}
                step={0.000001}
                hasClear
                isRequired
                isDisabled={controlsDisabled}
                onChange={(outputUsdPer1M) => setDraft((current) => current ? { ...current, outputUsdPer1M } : current)}
              />
              <NumberInput
                label={props.copy.pricing.cacheReadRate}
                value={draft.cacheReadUsdPer1M}
                min={0}
                step={0.000001}
                hasClear
                isOptional
                isDisabled={controlsDisabled}
                onChange={(cacheReadUsdPer1M) => setDraft((current) => current ? { ...current, cacheReadUsdPer1M } : current)}
              />
              <NumberInput
                label={props.copy.pricing.cacheWriteRate}
                value={draft.cacheWriteUsdPer1M}
                min={0}
                step={0.000001}
                hasClear
                isOptional
                isDisabled={controlsDisabled}
                onChange={(cacheWriteUsdPer1M) => setDraft((current) => current ? { ...current, cacheWriteUsdPer1M } : current)}
              />
            </div>
          </FormLayout>
          {formError ? <p className="settingsUsagePricingError" role="alert">{formError}</p> : null}
          <div className="settingsUsagePricingFormActions">
            <Button type="button" variant="ghost" size="sm" isDisabled={busy} onClick={closeForm} label={props.copy.pricing.cancel} />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isDisabled={controlsDisabled}
              aria-busy={busy}
              data-pending={busy ? 'true' : undefined}
              label={busy ? props.copy.pricing.saving : props.copy.pricing.save}
            />
          </div>
        </form>
      ) : null}

      {props.isLoading && props.entries.length === 0 ? (
        <p className="settingsUsagePricingLoading" role="status">{props.copy.pricing.loading}</p>
      ) : (
        <UsageStatsTable
          ariaLabel={props.copy.tables.pricingAria}
          columns={[
            { header: props.copy.tables.pricingHeaders[0], grow: true },
            { header: props.copy.tables.pricingHeaders[1], grow: true },
            { header: props.copy.tables.pricingHeaders[2] },
            { header: props.copy.tables.pricingHeaders[3], numeric: true },
            { header: props.copy.tables.pricingHeaders[4], numeric: true },
            { header: props.copy.tables.pricingHeaders[5], numeric: true },
            { header: props.copy.tables.pricingHeaders[6], numeric: true },
            { header: props.copy.tables.pricingHeaders[7] },
          ]}
          rows={props.entries.map((entry) => {
            const pricing = entry.pricing;
            const { provider, model } = splitPricingModelKey(pricing.modelKey);
            const source = entry.source === 'builtin'
              ? props.copy.pricing.sourceBuiltin
              : entry.resetEffect === 'restore_builtin'
                ? props.copy.pricing.sourceCustomWithFallback
                : props.copy.pricing.sourceCustomOnly;
            return [
              provider || '—',
              model,
              source,
              formatPricingRate(pricing.inputUsdPer1M, props.copy.pricing.noCache),
              formatPricingRate(pricing.outputUsdPer1M, props.copy.pricing.noCache),
              formatPricingRate(pricing.cacheReadUsdPer1M, props.copy.pricing.noCache),
              formatPricingRate(pricing.cacheWriteUsdPer1M, props.copy.pricing.noCache),
              <span className="settingsUsagePricingRowActions" role="group" aria-label={props.copy.pricing.actionsAria}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  isDisabled={controlsDisabled}
                  onClick={() => openEditForm(entry)}
                  label={entry.source === 'builtin' ? props.copy.pricing.customize : props.copy.pricing.edit}
                />
                {entry.source === 'custom' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    isDisabled={controlsDisabled}
                    onClick={() => void removePricing(entry)}
                    label={busy
                      ? props.copy.pricing.removing
                      : entry.resetEffect === 'restore_builtin' ? props.copy.pricing.reset : props.copy.pricing.remove}
                  />
                ) : null}
              </span>,
            ];
          })}
          empty={{ Icon: BarChart3, title: props.copy.tables.noPricing, body: props.copy.tables.pricingEmptyBody }}
        />
      )}
    </>
  );
}

// ── Request-log cell helpers ────────────────────────────────────────────────

function usageRequestKindLabel(kind: UsageStats['logs'][number]['kind'], copy: UsageSettingsCopy) {
  switch (kind) {
    case 'model': return copy.tables.modelKind;
    case 'tool': return copy.tables.toolKind;
  }
}

function usageRequestTarget(row: UsageStats['logs'][number]) {
  return row.kind === 'tool' ? row.toolName ?? row.model : row.model;
}

function usageRequestSessionCell(row: UsageStats['logs'][number], copy: UsageSettingsCopy, onOpenSession?: (sessionId: string) => void) {
  const label = shortUsageSessionId(row.sessionId);
  if (!onOpenSession) return label;
  return (
    <Button variant="ghost" size="sm" onClick={() => onOpenSession(row.sessionId)} label={copy.tables.openSession(label)} />
  );
}

function shortUsageSessionId(sessionId: string) {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function usageRequestStatusLabel(status: UsageStats['logs'][number]['status'], copy: UsageSettingsCopy) {
  switch (status) {
    case 'success': return copy.tables.success;
    case 'error': return copy.tables.error;
  }
}

// ── Usage table mapping ─────────────────────────────────────────────────────
// Astryx Table owns table geometry, scrolling, dividers, density, and cell
// semantics. This page only maps its product rows and empty-state copy into
// that public API.

interface UsageColumn {
  header: string;
  numeric?: boolean;
  grow?: boolean;
}

type UsageTableRow = Record<string, unknown> & {
  id: number;
  cells: Array<ReactNode>;
};

const usageTablePlugins = {
  rowHeader: {
    transformBodyCell: (cell, _column, _row, columnIndex) => columnIndex === 0
      ? { ...cell, htmlProps: { ...cell.htmlProps, role: 'rowheader' } }
      : cell,
  },
} satisfies Record<string, TablePlugin<UsageTableRow>>;

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
        icon={<props.empty.Icon />}
        title={props.empty.title}
        description={props.empty.body ?? ''}
        className="settingsUsageEmpty"
      />
    );
  }
  const data: UsageTableRow[] = props.rows.map((cells, id) => ({ id, cells }));
  const columns: Array<TableColumn<UsageTableRow>> = props.columns.map((column, index) => ({
    key: `cell-${index}`,
    header: column.header,
    align: column.numeric ? 'end' : 'start',
    width: column.grow ? proportional(1) : pixel(column.numeric ? 88 : 120),
    renderCell: (row) => (
      <span className={column.numeric ? 'settingsUsageNumericCell' : undefined}>
        {row.cells[index]}
      </span>
    ),
  }));

  return (
    <Card className="settingsUsageTable" padding={3}>
      <Table
        aria-label={props.ariaLabel}
        data={data}
        columns={columns}
        idKey="id"
        density="compact"
        dividers="rows"
        textOverflow="truncate"
        plugins={usageTablePlugins}
      />
    </Card>
  );
}
