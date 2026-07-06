import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays } from './icons.js';
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
import { SettingsSegmented } from './primitives/settings-segmented.js';
import { Alert, AlertAction, AlertDescription } from './primitives/alert.js';
import { EmptyState } from './empty-state.js';
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
  const dailyReviewMountedRef = useRef(true);
  const summaryScopeKeyRef = useRef<string | null>(null);
  const pendingDailyReviewActionRef = useRef<string | null>(null);
  const archiveLoadRequestRef = useRef(0);
  const currentSummaryScopeKey = dailyReviewScopeKey(offsetDays, range);
  const visibleSummary = summaryScopeKey === currentSummaryScopeKey ? summary : null;
  const canLoadArchives = Boolean(props.bridge.listArchives && props.bridge.getArchive);

  useEffect(() => {
    dailyReviewMountedRef.current = true;
    return () => {
      dailyReviewMountedRef.current = false;
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
    props.bridge
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
  }, [offsetDays, range, reloadToken, props.bridge]);

  useEffect(() => {
    const listArchives = props.bridge.listArchives;
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
  }, [archiveReloadToken, props.bridge]);

  useEffect(() => {
    const getArchive = props.bridge.getArchive;
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
  }, [archiveReloadToken, selectedArchiveId, props.bridge]);

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
  const emptyActivityTitle = offsetDays === 0 && range === 1
    ? '等待记录今天活动'
    : `${dayLabel}无活动`;
  const emptyActivityBody = range === 1
    ? '这一天没有发起对话，也没有调用模型。'
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

  return (
    <div className="maka-daily-review-panel" data-loading={loading ? 'true' : undefined}>
      {/* IA restructure (owner: 页面太乱不直观): time context — the
          day/week/month tabs and the date stepper — now lives in ONE
          header bar instead of the tabs floating mid-page above the
          stats they control. */}
      <header className="maka-daily-review-header">
        <div className="maka-daily-review-header-time">
          <UiButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="maka-daily-review-stepper"
            onClick={() => setOffsetDays((n) => n - range)}
            aria-label={`查看更早一${stepperLabel}`}
          >
            ‹
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
            ›
          </UiButton>
        </div>
        <SettingsSegmented
          value={String(range)}
          options={[['1', '今日'], ['7', '本周'], ['30', '本月']]}
          onChange={(v) => {
            setRange(Number(v) as DailyReviewRange);
            setOffsetDays(0);
          }}
          ariaLabel="时间范围切换"
          className="maka-daily-review-range-tabs"
        />
      </header>
      {canManualRun && (
        <div className="maka-daily-review-quick-runs" aria-label="手动触发回顾">
          {modelOptions.length > 0 && (
            <SettingsSelect
              value={selectedModelKey}
              ariaLabel="每日回顾分析模型"
              options={modelOptions}
              onChange={setSelectedModelKey}
              disabled={dailyReviewActionBusy}
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
            variant="outline"
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
      )}
      {canLoadArchives && (
        <section className="maka-daily-review-archives" aria-label="已生成报告">
          <div className="maka-daily-review-archives-header">
            <h4 className="maka-daily-review-section-title">已生成报告</h4>
            <span className="maka-daily-review-archive-count">{archives.length} 份</span>
          </div>
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
            <p className="maka-daily-review-archive-empty">
              还没有生成报告。点击上方按钮后，报告会保存到本机并显示在这里。
            </p>
          ) : (
            <div className="maka-daily-review-archive-layout">
              {/* PR-DAILYREVIEW-ARCHIVE-ROW-A11Y-0 (round 7/30):
                  the archive list was a `<div role="list">` with
                  `<button role="listitem">` children. `role` doesn't
                  layer like that — a `<button>` is already a button,
                  so giving it `role="listitem"` either gets ignored
                  by ATs or produces inconsistent announcements.
                  Switched to semantic `<ul>` / `<li>` and routed the
                  click target through UiButton so disabled-state +
                  focus-visible + `:active` come from the shared
                  contract. */}
              <ul className="maka-daily-review-archive-list" aria-label="回顾报告历史">
                {archives.map((archive) => (
                  <li key={archive.id}>
                    <UiButton
                      type="button"
                      variant="quiet"
                      className="maka-daily-review-archive-row"
                      data-active={selectedArchiveId === archive.id ? 'true' : undefined}
                      onClick={() => chooseDailyReviewArchive(archive.id)}
                    >
                      <span className="maka-daily-review-archive-row-title">
                        {formatDailyReviewArchiveTitle(archive)}
                      </span>
                      <span className="maka-daily-review-archive-row-meta">
                        {DAILY_REVIEW_ARCHIVE_STATUS_LABEL[archive.status]} · {archive.totals.sessionCount} 对话 · {formatDailyReviewArchiveGeneratedAt(archive.generatedAt)}
                      </span>
                    </UiButton>
                  </li>
                ))}
              </ul>
              <DailyReviewArchiveBody archive={selectedArchive} loading={archiveLoading} />
            </div>
          )}
        </section>
      )}
      {/* Export actions ride with the stats they export (tabs moved to
          the header above), so the old mid-page nav bar is gone. */}
      {visibleSummary && visibleSummary.totals.sessionCount + visibleSummary.totals.requestCount > 0 && hasDailyReviewActions && (
        <div className="maka-daily-review-actions" aria-label="回顾导出操作">
          {props.onCopyMarkdown && (
              <UiButton
                type="button"
                variant="ghost"
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
                variant="ghost"
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
                variant="ghost"
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
      )}

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
      ) : visibleSummary.totals.sessionCount === 0 && visibleSummary.totals.requestCount === 0 ? (
        // When saved reports already fill the page, a second full-height
        // empty card below them read as a broken half-loaded section
        // (designer audit P0-4). Collapse to a one-line note in that case;
        // keep the full empty state only when it is the page's sole content.
        canLoadArchives && archives.length > 0 ? (
          <p className="maka-daily-review-activity-note" role="status">
            {emptyActivityTitle} · {emptyActivityBody}
          </p>
        ) : (
          <EmptyState
            Icon={CalendarDays}
            title={emptyActivityTitle}
            body={emptyActivityBody}
            extraClassName="maka-daily-review-summary-empty"
          />
        )
      ) : (
        <>
          <section className="maka-daily-review-totals" aria-label={`${dayLabel}总览`}>
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
          </section>

          {visibleSummary.sessions.length > 0 && (
            <section className="maka-daily-review-section" aria-label="活跃对话">
              <h4 className="maka-daily-review-section-title">活跃对话</h4>
              <ul className="maka-daily-review-list" aria-label="活跃对话列表">
                {visibleSummary.sessions.map((session) => (
                  <li key={session.id} className="maka-daily-review-list-item">
                    {/* PR-DAILYREVIEW-SESSION-BUTTON-PRIMITIVE-0
                        (round 6/30): the active-conversation row
                        used a raw <button>. Routed through UiButton
                        variant="quiet" so disabled-state styling +
                        focus-visible + :active scale come from the
                        shared button contract. Custom class still
                        owns the in-row layout (name left, relative
                        time right). */}
                    <UiButton
                      type="button"
                      variant="quiet"
                      className="maka-daily-review-session-button"
                      onClick={() => props.onSelectSession?.(session.id)}
                      disabled={!props.onSelectSession}
                    >
                      <span className="maka-daily-review-session-name">{session.name}</span>
                      <RelativeTime
                        ts={session.lastMessageAt}
                        className="maka-daily-review-session-time"
                      />
                    </UiButton>
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
    </div>
  );
}

function DailyReviewArchiveBody(props: { archive: DailyReviewArchive | null; loading: boolean }) {
  if (props.loading) {
    return (
      <div className="maka-daily-review-archive-body" aria-busy="true">
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '58%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '92%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '74%' }} />
      </div>
    );
  }
  if (!props.archive) {
    return (
      <div className="maka-daily-review-archive-body" data-empty="true">
        选择一份报告查看生成内容。
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
  return (
    <article className="maka-daily-review-archive-body" aria-label={formatDailyReviewArchiveTitle(archive)}>
      <header className="maka-daily-review-archive-body-header">
        <div>
          <h4>{formatDailyReviewArchiveTitle(archive)}</h4>
          <p>
            {DAILY_REVIEW_ARCHIVE_TRIGGER_LABEL[archive.trigger]}生成 · {formatDailyReviewArchiveGeneratedAt(archive.generatedAt)}
            {archive.modelKey ? ` · ${formatDailyReviewModelLabel(archive.modelKey)}` : ' · 默认对话模型'}
          </p>
        </div>
        <span className="maka-daily-review-archive-status" data-status={archive.status}>
          {DAILY_REVIEW_ARCHIVE_STATUS_LABEL[archive.status]}
        </span>
      </header>
      {archive.errorMessage && (
        <p className="maka-daily-review-archive-error">{archive.errorMessage}</p>
      )}
      {sections.length > 0 ? (
        <div className="maka-daily-review-archive-sections">
          {sections.map((section) => (
            <section key={section.key} className="maka-daily-review-archive-section">
              <h5>{DAILY_REVIEW_ARCHIVE_SECTION_LABEL[section.key]}</h5>
              {/* Reports are LLM-generated markdown — bullet lists and
                  inline code rendered as flat pre-wrap text read as mush.
                  Reuse the shared Markdown pipeline (same one chat uses). */}
              <div className="maka-daily-review-archive-section-body">
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
    </article>
  );
}

function DailyReviewTotalsCell(props: { label: string; value: string; tone?: 'error' }) {
  return (
    <div className="maka-daily-review-totals-cell" data-tone={props.tone}>
      <span className="maka-daily-review-totals-value">{props.value}</span>
      <span className="maka-daily-review-totals-label">{props.label}</span>
    </div>
  );
}

function DailyReviewTopList(props: { title: string; entries: ReadonlyArray<DailyReviewTopEntry> }) {
  return (
    <section className="maka-daily-review-section" aria-label={props.title}>
      <h4 className="maka-daily-review-section-title">{props.title}</h4>
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
