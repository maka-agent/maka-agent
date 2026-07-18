import { useEffect, useMemo, useRef, useState } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { useMountedRef } from './use-mounted-ref.js';
import { CalendarDays, ChevronLeft, ChevronRight } from './icons.js';
import { SettingsSelect } from './primitives/settings-select.js';
import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewMode,
  DailyReviewSummary,
  DailyReviewTopEntry,
} from '@maka/core';
import {
  type DailyReviewRange,
  dailyReviewPanelErrorMessage,
  dailyReviewScopeKey,
  formatDailyReviewArchiveGeneratedAt,
  formatDailyReviewArchiveTitle,
  formatDailyReviewMarkdown,
  formatDailyReviewModelLabel,
} from './daily-review-helpers.js';
import { Button as UiButton } from './ui.js';
import { Chip, type ChipProps } from './primitives/chip.js';
import { Segmented } from './primitives/segmented.js';
import { Alert, AlertAction, AlertDescription } from './primitives/alert.js';
import { EmptyState } from './empty-state.js';
import { StatTile } from './primitives/stat-tile.js';
import { SectionHeader } from './primitives/section-header.js';
import { PageHeader } from './primitives/page-header.js';
import type { DailyReviewBridge, DailyReviewMarkdownActionInput } from './module-panel-types.js';
import { RelativeTime } from './relative-time.js';
import { Markdown } from './markdown.js';

type DailyReviewArchiveSectionKey = keyof DailyReviewArchive['sections'];

const DAILY_REVIEW_ARCHIVE_SECTION_LABEL: Record<DailyReviewArchiveSectionKey, string> = {
  summary: '对话摘要',
  gaps: '遗漏提醒',
  usage: '使用洞察',
  code: '代码建议',
};

const DAILY_REVIEW_ARCHIVE_STATUS_LABEL: Record<DailyReviewArchive['status'], string> = {
  ok: '已生成',
  no_model: '缺少模型',
  no_data: '无数据',
  failed: '生成失败',
  skipped: '已跳过',
};

const DAILY_REVIEW_ARCHIVE_TRIGGER_LABEL: Record<DailyReviewArchive['trigger'], string> = {
  cron: '定时',
  manual: '手动',
};

const EMPTY_MODEL_OPTIONS: ReadonlyArray<readonly [string, string]> = [];

// Archive-status Chip tone. ok = generated cleanly (success), failed /
// no_model = the run could not produce a report (destructive). no_data /
// skipped are expected non-events and stay neutral (exception-only color).
function dailyReviewArchiveChipTone(status: DailyReviewArchive['status']): ChipProps['variant'] {
  // Status-color restraint (#651 rule): 已生成 is the EXPECTED outcome —
  // neutral ink, matching 健康 正常 and 权限 已授权. Color stays reserved
  // for the failures that need attention.
  if (status === 'failed' || status === 'no_model') return 'destructive';
  return 'neutral';
}

export function DailyReviewPanel(props: {
  bridge: DailyReviewBridge;
  onSelectSession?: (sessionId: string) => void;
  onCopyMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onAppendMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
  onSaveMarkdown?: (input: DailyReviewMarkdownActionInput) => Promise<void> | void;
}) {
  const [offsetDays, setOffsetDays] = useState(0);
  // PR-DAILY-REVIEW-RANGE-0: 今日 / 本周 / 本月 tabs that map to a
  // 1 / 7 / 30 day aggregation. When span > 1, the day-stepper
  // navigates by the same span (一个 30 天 window steps back 30 days).
  const [range, setRange] = useState<DailyReviewRange>(1);
  const [summary, setSummary] = useState<DailyReviewSummary | null>(null);
  const [summaryScopeKey, setSummaryScopeKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingDailyReviewAction, setPendingDailyReviewAction] = useState<string | null>(null);
  const [archives, setArchives] = useState<DailyReviewArchiveSummary[]>([]);
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null);
  const [selectedArchive, setSelectedArchive] = useState<DailyReviewArchive | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveReloadToken, setArchiveReloadToken] = useState(0);
  const modelOptions = useMemo(() => props.bridge.modelOptions ?? EMPTY_MODEL_OPTIONS, [props.bridge.modelOptions]);
  const [selectedModelKey, setSelectedModelKey] = useState<string>(modelOptions[0]?.[0] ?? '');
  const dailyReviewMountedRef = useMountedRef();
  const summaryScopeKeyRef = useRef<string | null>(null);
  const pendingDailyReviewActionRef = useRef<string | null>(null);
  const archiveLoadRequestRef = useRef(0);
  // PR-582-FOLLOWUP: bridge methods (fetchDay, listArchives, getArchive)
  // are thin IPC wrappers that don't depend on the connections array.
  // Track the latest bridge via ref so effects don't re-fire when the
  // bridge object is recreated due to an unrelated connections change
  // (e.g. updatedAt timestamp bump from a provider status refresh).
  const bridgeRef = useRef(props.bridge);
  bridgeRef.current = props.bridge;
  const currentSummaryScopeKey = dailyReviewScopeKey(offsetDays, range);
  const visibleSummary = summaryScopeKey === currentSummaryScopeKey ? summary : null;
  const canLoadArchives = Boolean(props.bridge.listArchives && props.bridge.getArchive);

  useEffect(() => {
    return () => {
      pendingDailyReviewActionRef.current = null;
      archiveLoadRequestRef.current += 1;
    };
  }, []);

  function chooseDailyReviewArchive(archiveId: string) {
    archiveLoadRequestRef.current += 1;
    setSelectedArchiveId(archiveId);
    setSelectedArchive(null);
    setArchiveLoading(Boolean(props.bridge.getArchive));
    setArchiveError(null);
  }

  useEffect(() => {
    let cancelled = false;
    const scopeKey = dailyReviewScopeKey(offsetDays, range);
    setLoading(true);
    setError(null);
    bridgeRef.current
      .fetchDay(offsetDays, range)
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        summaryScopeKeyRef.current = scopeKey;
        setSummaryScopeKey(scopeKey);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (summaryScopeKeyRef.current !== scopeKey) {
          summaryScopeKeyRef.current = null;
          setSummary(null);
          setSummaryScopeKey(null);
        }
        setError(dailyReviewPanelErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [offsetDays, range, reloadToken]);

  useEffect(() => {
    const listArchives = bridgeRef.current.listArchives;
    if (!listArchives) {
      setArchives([]);
      setSelectedArchiveId(null);
      setSelectedArchive(null);
      return;
    }
    let cancelled = false;
    setArchiveError(null);
    listArchives()
      .then((next) => {
        if (cancelled) return;
        setArchives(next);
        setSelectedArchiveId((current) => {
          if (current && next.some((archive) => archive.id === current)) return current;
          return next[0]?.id ?? null;
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setArchiveError(dailyReviewPanelErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [archiveReloadToken]);

  useEffect(() => {
    const getArchive = bridgeRef.current.getArchive;
    if (!getArchive || !selectedArchiveId) {
      archiveLoadRequestRef.current += 1;
      setSelectedArchive(null);
      setArchiveLoading(false);
      return;
    }
    let cancelled = false;
    const archiveId = selectedArchiveId;
    const archiveRequestId = ++archiveLoadRequestRef.current;
    setSelectedArchive(null);
    setArchiveLoading(true);
    setArchiveError(null);
    getArchive(archiveId)
      .then((next) => {
        if (cancelled) return;
        if (archiveLoadRequestRef.current !== archiveRequestId) return;
        setSelectedArchive(next);
        setArchiveLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (archiveLoadRequestRef.current !== archiveRequestId) return;
        setSelectedArchive(null);
        setArchiveError(dailyReviewPanelErrorMessage(err));
        setArchiveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [archiveReloadToken, selectedArchiveId]);

  useEffect(() => {
    if (modelOptions.length === 0) {
      setSelectedModelKey('');
      return;
    }
    setSelectedModelKey((current) => {
      if (modelOptions.some(([value]) => value === current)) return current;
      return modelOptions[0]?.[0] ?? '';
    });
  }, [modelOptions]);

  const dayLabel = (() => {
    if (range === 1) {
      if (offsetDays === 0) return '今天';
      if (offsetDays === -1) return '昨天';
      return `${-offsetDays} 天前`;
    }
    const rangeText = range === 7 ? '最近 7 天' : '最近 30 天';
    if (offsetDays === 0) return rangeText;
    return `${rangeText}（往前 ${-offsetDays} 天）`;
  })();

  // Stepper step matches the range size — for 7-day mode the user
  // skips a whole week at a time, not a single day.
  const stepperLabel = range === 1 ? '天' : range === 7 ? '周' : '月';
  // IA restructure: the 概览 section is ALWAYS rendered (honest zeros +
  // this one inline hint) so a no-activity scope no longer collapses the
  // page to a floating orphan line at the bottom. The hint absorbs the old
  // bottom-of-page orphan into the 概览 header's flow. Copy keeps the endorsed
  // waiting-state framing (等待记录今天活动 / 无活动 — visible-copy-hygiene).
  const emptyOverviewTitle = offsetDays === 0 && range === 1
    ? '等待记录今天活动'
    : `${dayLabel}无活动`;
  const emptyOverviewBody = offsetDays === 0 && range === 1
    ? '今天还没有发起对话，也没有调用模型。'
    : `${dayLabel}范围内没有发起对话，也没有调用模型。`;

  async function runDailyReviewAction(actionKey: string, action: () => void | Promise<void>) {
    if (pendingDailyReviewActionRef.current !== null) return;
    pendingDailyReviewActionRef.current = actionKey;
    setPendingDailyReviewAction(actionKey);
    try {
      await action();
    } finally {
      if (pendingDailyReviewActionRef.current === actionKey) {
        pendingDailyReviewActionRef.current = null;
        if (dailyReviewMountedRef.current) setPendingDailyReviewAction(null);
      }
    }
  }

  function isDailyReviewActionCurrent(actionKey: string): boolean {
    return dailyReviewMountedRef.current && pendingDailyReviewActionRef.current === actionKey;
  }

  const dailyReviewActionBusy = pendingDailyReviewAction !== null;
  const hasDailyReviewActions = Boolean(props.onCopyMarkdown || props.onAppendMarkdown || props.onSaveMarkdown);
  const canManualRun = Boolean(props.bridge.runOnce);

  async function triggerManualRun(mode: DailyReviewMode) {
    const runOnce = props.bridge.runOnce;
    if (!runOnce) return;
    const actionKey = `run:${mode}`;
    await runDailyReviewAction(actionKey, async () => {
      try {
        const result = await runOnce({ mode, modelKey: selectedModelKey });
        if (!isDailyReviewActionCurrent(actionKey)) return;
        chooseDailyReviewArchive(result.archiveId);
        setArchiveReloadToken((n) => n + 1);
        setReloadToken((n) => n + 1);
      } catch (err) {
        if (isDailyReviewActionCurrent(actionKey)) setError(dailyReviewPanelErrorMessage(err));
      }
    });
  }

  // Export actions ride with the 概览 stats they serialize; the guard keeps
  // them off an all-zero scope (nothing to export). Shape pinned by the
  // daily-review-copy-feedback contract — do not restructure the condition.
  const overviewActions =
    visibleSummary && visibleSummary.totals.sessionCount + visibleSummary.totals.requestCount > 0 && hasDailyReviewActions ? (
      <div className="maka-daily-review-actions" aria-label="回顾导出操作">
        {props.onCopyMarkdown && (
          <UiButton
            type="button"
            variant="secondary"
            size="sm"
            className="maka-daily-review-copy min-w-[4rem]"
            onClick={() => void runDailyReviewAction('copy', async () => {
              const md = formatDailyReviewMarkdown(visibleSummary, dayLabel);
              await props.onCopyMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
            })}
            disabled={dailyReviewActionBusy}
            data-pending={pendingDailyReviewAction === 'copy' ? 'true' : undefined}
            aria-busy={pendingDailyReviewAction === 'copy' ? 'true' : undefined}
            title="复制为 Markdown 摘要，方便分享 / 贴到笔记"
          >
            {pendingDailyReviewAction === 'copy' ? '复制中…' : '复制'}
          </UiButton>
        )}
        {props.onAppendMarkdown && (
          <UiButton
            type="button"
            variant="secondary"
            size="sm"
            className="maka-daily-review-append min-w-[5rem]"
            onClick={() => void runDailyReviewAction('append', async () => {
              const md = formatDailyReviewMarkdown(visibleSummary, dayLabel);
              await props.onAppendMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
            })}
            disabled={dailyReviewActionBusy}
            data-pending={pendingDailyReviewAction === 'append' ? 'true' : undefined}
            aria-busy={pendingDailyReviewAction === 'append' ? 'true' : undefined}
            title="追加到当前输入框草稿"
          >
            {pendingDailyReviewAction === 'append' ? '追加中…' : '粘到输入框'}
          </UiButton>
        )}
        {props.onSaveMarkdown && (
          <UiButton
            type="button"
            variant="secondary"
            size="sm"
            className="maka-daily-review-save min-w-[4rem]"
            onClick={() => void runDailyReviewAction('save', async () => {
              const md = formatDailyReviewMarkdown(visibleSummary, dayLabel);
              await props.onSaveMarkdown?.({ markdown: md, label: dayLabel, summary: visibleSummary });
            })}
            disabled={dailyReviewActionBusy}
            data-pending={pendingDailyReviewAction === 'save' ? 'true' : undefined}
            aria-busy={pendingDailyReviewAction === 'save' ? 'true' : undefined}
            title="保存为 Markdown 文件"
          >
            {pendingDailyReviewAction === 'save' ? '保存中…' : '保存'}
          </UiButton>
        )}
      </div>
    ) : null;

  return (
    <div className="maka-daily-review-panel" data-loading={loading ? 'true' : undefined}>
      {/* IA redesign (owner: 每日回顾 页面很乱): the PageHeader is THE page
          shell — title + subtitle, and the 生成 actions ride its actions slot
          (same pattern as the skills page's 添加). The analysis-model select is
          now a COMPACT generation option inside that same cluster, not a
          page-wide row. */}
      <PageHeader
        className="maka-module-main-header"
        as="h2"
        title="每日回顾"
        subtitle="自动汇总本机对话，生成摘要、遗漏提醒与深度分析；可在设置中开启定时执行。"
        actions={canManualRun ? (
          <div className="maka-daily-review-generate" role="group" aria-label="生成回顾">
            {modelOptions.length > 0 && (
              <SettingsSelect
                value={selectedModelKey}
                ariaLabel="分析模型"
                options={modelOptions}
                onChange={setSelectedModelKey}
                disabled={dailyReviewActionBusy}
                width="compact"
                className="maka-daily-review-model-select"
              />
            )}
            <UiButton
              type="button"
              variant="default"
              size="sm"
              className="maka-daily-review-quick-run min-w-[6rem]"
              onClick={() => void triggerManualRun('daily')}
              disabled={dailyReviewActionBusy}
              data-pending={pendingDailyReviewAction === 'run:daily' ? 'true' : undefined}
              aria-busy={pendingDailyReviewAction === 'run:daily' ? 'true' : undefined}
            >
              {pendingDailyReviewAction === 'run:daily' ? '生成中…' : '生成每日回顾'}
            </UiButton>
            <UiButton
              type="button"
              variant="secondary"
              size="sm"
              className="maka-daily-review-quick-run min-w-[6rem]"
              onClick={() => void triggerManualRun('deep')}
              disabled={dailyReviewActionBusy}
              data-pending={pendingDailyReviewAction === 'run:deep' ? 'true' : undefined}
              aria-busy={pendingDailyReviewAction === 'run:deep' ? 'true' : undefined}
            >
              {pendingDailyReviewAction === 'run:deep' ? '生成中…' : '生成深度分析'}
            </UiButton>
          </div>
        ) : undefined}
      />

      {/* One time-scope row directly under the header: the 今日/本周/本月
          segmented + the day-stepper are BOTH time navigation, so they form a
          single visual cluster (was two floating rows at opposite corners). */}
      <div className="maka-daily-review-scope" aria-label="时间范围">
        <Segmented
          value={String(range)}
          options={[['1', '今日'], ['7', '本周'], ['30', '本月']]}
          onChange={(v) => {
            setRange(Number(v) as DailyReviewRange);
            setOffsetDays(0);
          }}
          ariaLabel="时间范围切换"
          className="maka-daily-review-range-tabs"
        />
        <div className="maka-daily-review-scope-stepper">
          <UiButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="maka-daily-review-stepper"
            onClick={() => setOffsetDays((n) => n - range)}
            aria-label={`查看更早一${stepperLabel}`}
          >
            <ChevronLeft aria-hidden="true" />
          </UiButton>
          <div className="maka-daily-review-day">{dayLabel}</div>
          <UiButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="maka-daily-review-stepper"
            onClick={() => setOffsetDays((n) => Math.min(0, n + range))}
            disabled={offsetDays >= 0}
            aria-label={`查看更晚一${stepperLabel}`}
          >
            <ChevronRight aria-hidden="true" />
          </UiButton>
        </div>
      </div>

      {/* 概览 — ALWAYS rendered for the selected scope. Honest zeros + one
          inline hint replace the old bottom orphan line, so a no-activity
          scope no longer collapses the page to nothing. */}
      <section className="maka-daily-review-overview" aria-label={`${dayLabel}概览`}>
        <SectionHeader as="h4" accent title="概览" action={overviewActions} />
        {error && visibleSummary ? (
          <Alert variant="warning" className="maka-daily-review-alert">
            <AlertDescription>每日回顾刷新失败：{error}</AlertDescription>
            <AlertAction>
              <UiButton
                type="button"
                variant="ghost"
                size="sm"
                className="maka-daily-review-alert-retry"
                onClick={() => setReloadToken((n) => n + 1)}
                disabled={loading}
              >
                重试
              </UiButton>
            </AlertAction>
          </Alert>
        ) : null}

        {error && !visibleSummary ? (
          <EmptyState
            Icon={CalendarDays}
            title="读取失败"
            body={error}
            cta={{ label: '重试', onClick: () => setReloadToken((n) => n + 1) }}
            extraClassName="maka-daily-review-summary-empty"
          />
        ) : !visibleSummary ? (
          <div className="maka-daily-review-loading" aria-busy="true">
            <div className="maka-skeleton maka-skeleton-line" style={{ width: '60%' }} />
            <div className="maka-skeleton maka-skeleton-line" style={{ width: '90%' }} />
            <div className="maka-skeleton maka-skeleton-line" style={{ width: '75%' }} />
          </div>
        ) : (
          <>
            <div className="maka-daily-review-totals">
              <DailyReviewTotalsCell label="对话" value={visibleSummary.totals.sessionCount.toString()} />
              <DailyReviewTotalsCell label="请求" value={visibleSummary.totals.requestCount.toString()} />
              <DailyReviewTotalsCell
                label="Token"
                value={visibleSummary.totals.totalTokens.toLocaleString()}
              />
              <DailyReviewTotalsCell
                label="费用"
                value={`$${visibleSummary.totals.costUsd.toFixed(2)}`}
              />
              {visibleSummary.totals.errorCount > 0 && (
                <DailyReviewTotalsCell
                  label="错误"
                  value={visibleSummary.totals.errorCount.toString()}
                  tone="error"
                />
              )}
            </div>

            {visibleSummary.totals.sessionCount === 0 && visibleSummary.totals.requestCount === 0 ? (
              <EmptyState variant="inline" title={emptyOverviewTitle} body={emptyOverviewBody} />
            ) : (
              <>
                {visibleSummary.sessions.length > 0 && (
                  <section className="maka-daily-review-section" aria-label="活跃对话">
                    <SectionHeader as="h4" accent title="活跃对话" />
                    <ul className="maka-daily-review-list" aria-label="活跃对话列表">
                      {visibleSummary.sessions.map((session) => (
                        <li key={session.id} className="maka-daily-review-list-item">
                          {/* Active-conversation rows are composite navigation
                              controls. Their semantic row seam owns layout and state;
                              they are not a shared Button size or variant. */}
                          <BaseButton
                            type="button"
                            className="maka-daily-review-session-button"
                            onClick={() => props.onSelectSession?.(session.id)}
                            disabled={!props.onSelectSession}
                          >
                            <span className="maka-daily-review-session-name">{session.name}</span>
                            <RelativeTime
                              ts={session.lastMessageAt}
                              className="maka-daily-review-session-time"
                            />
                          </BaseButton>
                          {session.lastMessagePreview && (
                            <span className="maka-daily-review-session-preview">
                              {session.lastMessagePreview}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {visibleSummary.topModels.length > 0 && (
                  <DailyReviewTopList title="模型使用" entries={visibleSummary.topModels} />
                )}

                {visibleSummary.topTools.length > 0 && (
                  <DailyReviewTopList title="工具调用" entries={visibleSummary.topTools} />
                )}
              </>
            )}
          </>
        )}
      </section>

      {/* 报告 — stacked, newest-first. Each report is a full-width surface
          whose meta header (date · 模式 · N 对话 · 触发+时间 · 模型) is always
          visible; the selected one expands its four content sections below.
          This replaces the broken left-list / right-body master-detail that
          left the list column half-empty. Body loads stay single-selection
          (getArchive) — the archive-body-load contract pins that lazy path. */}
      {canLoadArchives && (
        <section className="maka-daily-review-reports" aria-label="报告">
          <SectionHeader
            as="h4"
            accent
            title="报告"
            count={<span className="maka-daily-review-archive-count">{archives.length} 份</span>}
          />
          {archiveError && (
            <Alert variant="warning" className="maka-daily-review-alert">
              <AlertDescription>回顾报告读取失败：{archiveError}</AlertDescription>
              <AlertAction>
                <UiButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="maka-daily-review-alert-retry"
                  onClick={() => setArchiveReloadToken((n) => n + 1)}
                  disabled={archiveLoading}
                >
                  重试
                </UiButton>
              </AlertAction>
            </Alert>
          )}
          {archives.length === 0 && !archiveError ? (
            <EmptyState
              Icon={CalendarDays}
              title="还没有生成报告"
              body="点击「生成每日回顾」后，报告会保存到本机并显示在这里。"
              cta={canManualRun ? {
                label: '生成每日回顾',
                onClick: () => void triggerManualRun('daily'),
                disabled: dailyReviewActionBusy,
              } : undefined}
              extraClassName="maka-daily-review-summary-empty"
            />
          ) : (
            <ul className="maka-daily-review-report-list" aria-label="回顾报告历史">
              {archives.map((archive) => {
                const selected = selectedArchiveId === archive.id;
                // Status color is exception-only (#651): 已生成 / 无数据 / 已跳过
                // are EXPECTED outcomes and stay as muted prose meta. Only a
                // failed / no_model run raises a colored Chip that needs eyes.
                const exceptional = archive.status === 'failed' || archive.status === 'no_model';
                const meta = [
                  `${archive.totals.sessionCount} 对话`,
                  `${DAILY_REVIEW_ARCHIVE_TRIGGER_LABEL[archive.trigger]}生成 ${formatDailyReviewArchiveGeneratedAt(archive.generatedAt)}`,
                  archive.modelKey ? formatDailyReviewModelLabel(archive.modelKey) : '默认对话模型',
                ].join(' · ');
                return (
                  <li key={archive.id}>
                    <article className="maka-daily-review-report" data-selected={selected ? '' : undefined}>
                      <button
                        type="button"
                        className="maka-daily-review-report-head"
                        onClick={() => chooseDailyReviewArchive(archive.id)}
                        aria-expanded={selected}
                      >
                        <span className="maka-daily-review-report-heading">
                          <span className="maka-daily-review-report-title">
                            {formatDailyReviewArchiveTitle(archive)}
                          </span>
                          <span className="maka-daily-review-archive-row-meta">{meta}</span>
                        </span>
                        {exceptional && (
                          <Chip
                            size="sm"
                            variant={dailyReviewArchiveChipTone(archive.status)}
                            className="maka-daily-review-report-status"
                            data-status={archive.status}
                          >
                            {DAILY_REVIEW_ARCHIVE_STATUS_LABEL[archive.status]}
                          </Chip>
                        )}
                      </button>
                      {selected && (
                        <DailyReviewArchiveBody archive={selectedArchive} loading={archiveLoading} />
                      )}
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function DailyReviewArchiveBody(props: { archive: DailyReviewArchive | null; loading: boolean }) {
  if (props.loading) {
    return (
      <div className="maka-daily-review-report-body" aria-busy="true">
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '58%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '92%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '74%' }} />
      </div>
    );
  }
  if (!props.archive) {
    return (
      <div className="maka-daily-review-report-body maka-daily-review-archive-empty">
        正在打开这份报告…
      </div>
    );
  }
  const archive = props.archive;
  const sections = (Object.keys(DAILY_REVIEW_ARCHIVE_SECTION_LABEL) as DailyReviewArchiveSectionKey[])
    .map((key) => {
      const content = archive.sections[key]?.trim();
      return content ? { key, content } : null;
    })
    .filter((entry): entry is { key: DailyReviewArchiveSectionKey; content: string } => entry !== null);
  // The report's date / 模式 / 触发 / 时间 / 模型 meta now lives in the surface
  // head above this body (no repeated header, no 已生成 status chip on the
  // expected state) — the body carries only the report substance.
  return (
    <div className="maka-daily-review-report-body" aria-label={formatDailyReviewArchiveTitle(archive)}>
      {archive.errorMessage && (
        <p className="maka-daily-review-archive-error">{archive.errorMessage}</p>
      )}
      {sections.length > 0 ? (
        <div className="maka-daily-review-archive-sections">
          {sections.map((section) => (
            <section key={section.key} className="maka-daily-review-archive-section">
              <SectionHeader as="h4" accent title={DAILY_REVIEW_ARCHIVE_SECTION_LABEL[section.key]} />
              {/* Reports are LLM-generated markdown — bullet lists and
                  inline code rendered as flat pre-wrap text read as mush.
                  Reuse the shared Markdown pipeline (same one chat uses). */}
              <div className="maka-daily-review-archive-section-body maka-prose">
                <Markdown text={section.content} />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <p className="maka-daily-review-archive-empty">
          这份报告没有生成正文内容。
        </p>
      )}
    </div>
  );
}

function DailyReviewTotalsCell(props: { label: string; value: string; tone?: 'error' }) {
  // Convergence R4: shared StatTile, filled emphasis; the error tone maps
  // to the primitive's destructive ink + this cell's tinted wash (CSS).
  return (
    <StatTile
      className="maka-daily-review-totals-cell"
      emphasis="filled"
      label={props.label}
      value={props.value}
      tone={props.tone === 'error' ? 'destructive' : 'neutral'}
    />
  );
}

function DailyReviewTopList(props: { title: string; entries: ReadonlyArray<DailyReviewTopEntry> }) {
  return (
    <section className="maka-daily-review-section" aria-label={props.title}>
      <SectionHeader as="h4" accent title={props.title} />
      <ul className="maka-daily-review-list" aria-label={`${props.title}列表`}>
        {props.entries.map((entry) => (
          <li key={entry.key} className="maka-daily-review-list-item">
            <span className="maka-daily-review-top-label">{entry.label}</span>
            <span className="maka-daily-review-top-meta">
              {entry.requests} 次 · {entry.totalTokens.toLocaleString()} tok
              {entry.costUsd > 0 ? ` · $${entry.costUsd.toFixed(2)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
