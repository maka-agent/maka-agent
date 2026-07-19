import { useEffect, useMemo, useState } from 'react';
import type { DailyReviewConfig, DailyReviewMode, LlmConnection } from '@maka/core';
import { Alert, AlertDescription, Button, Input, SettingsSelect, SettingsSwitch as Switch, useMountedRef, useToast } from '@maka/ui';
import { buildCatalogDailyReviewModelOptions } from '../model-catalog-choices';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsRows } from './settings-rows';
import { useActionGuard } from './use-action-guard';

/**
 * PR-DAILY-REVIEW-MVP-0 follow-up: Settings → 每日回顾 is no longer
 * a roadmap page. The sidebar panel handles browsing/usage; this
 * page summarizes what it does, the privacy boundary, and offers a
 * one-click jump to the sidebar.
 */
const DAILY_REVIEW_SECTION_LABELS: ReadonlyArray<{
  key: 'summary' | 'gaps' | 'usage' | 'code';
  title: string;
  detail: string;
}> = [
  { key: 'summary', title: '对话摘要', detail: '昨天聊了什么，关键结论是什么。' },
  { key: 'gaps', title: '遗漏提醒', detail: '开始但未完成的讨论、可能忽略的要点。' },
  { key: 'usage', title: '使用洞察', detail: '模型选择、Token 消耗、工具使用效率。' },
  { key: 'code', title: '代码建议', detail: '基于对话中的代码讨论，给出优化建议。' },
];

const DAILY_REVIEW_DEFAULT_MODEL_VALUE = '__maka_daily_review_default_model__';

function buildDailyReviewModelOptions(
  connections: readonly LlmConnection[],
  currentModelKey: string,
): Array<readonly [string, string]> {
  const options: Array<readonly [string, string]> = [
    [DAILY_REVIEW_DEFAULT_MODEL_VALUE, '跟随对话默认'],
  ];
  options.push(...buildCatalogDailyReviewModelOptions(
    connections,
    currentModelKey.trim() === DAILY_REVIEW_DEFAULT_MODEL_VALUE ? '' : currentModelKey,
  ));
  return options;
}

export function DailyReviewSettingsPage(props: { connections: readonly LlmConnection[]; onOpenDailyReview?: () => void }) {
  const toast = useToast();
  const dailyReviewIpc = window.maka.dailyReview;
  const hasConfigIpc = Boolean(dailyReviewIpc.getConfig && dailyReviewIpc.setConfig);
  const hasRunOnceIpc = Boolean(dailyReviewIpc.runOnce);

  const [config, setConfig] = useState<DailyReviewConfig | null>(null);
  const [loading, setLoading] = useState<boolean>(hasConfigIpc);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [runningMode, setRunningMode] = useState<DailyReviewMode | null>(null);
  const mountedRef = useMountedRef();
  const saveConfigGuard = useActionGuard<string>();
  const runModeGuard = useActionGuard<DailyReviewMode>();

  useEffect(() => {
    if (!hasConfigIpc || !dailyReviewIpc.getConfig) {
      setConfig(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    dailyReviewIpc
      .getConfig()
      .then((next) => {
        if (!cancelled && mountedRef.current) {
          setConfig(next);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled && mountedRef.current) {
          setLoadError(settingsActionErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasConfigIpc, dailyReviewIpc]);

  async function patchConfig(key: string, patch: Partial<DailyReviewConfig>) {
    if (!dailyReviewIpc.setConfig || !config || saveConfigGuard.current !== null) return;
    saveConfigGuard.begin(key);
    setSavingKey(key);
    try {
      const next = await dailyReviewIpc.setConfig(patch);
      if (mountedRef.current && saveConfigGuard.current === key) setConfig(next);
    } catch (err) {
      if (mountedRef.current && saveConfigGuard.current === key) {
        toast.error('保存每日回顾设置失败', settingsActionErrorMessage(err));
      }
    } finally {
      if (saveConfigGuard.current === key) {
        saveConfigGuard.finish();
      }
      if (mountedRef.current) setSavingKey(null);
    }
  }

  async function triggerRun(mode: DailyReviewMode) {
    if (!dailyReviewIpc.runOnce || runModeGuard.current !== null) return;
    runModeGuard.begin(mode);
    setRunningMode(mode);
    try {
      await dailyReviewIpc.runOnce({ mode });
      if (mountedRef.current && runModeGuard.current === mode) {
        toast.success(mode === 'daily' ? '已生成每日回顾' : '已生成深度分析', '可在「每日回顾」面板查看。');
      }
    } catch (err) {
      if (mountedRef.current && runModeGuard.current === mode) {
        toast.error('生成回顾失败', settingsActionErrorMessage(err));
      }
    } finally {
      if (runModeGuard.current === mode) {
        runModeGuard.finish();
      }
      if (mountedRef.current) setRunningMode(null);
    }
  }

  const effectiveConfig = config;
  const formDisabled = !hasConfigIpc || loading || Boolean(loadError) || !effectiveConfig || savingKey !== null;
  const modelOptions = useMemo(
    () => buildDailyReviewModelOptions(props.connections, effectiveConfig?.modelKey ?? ''),
    [effectiveConfig?.modelKey, props.connections],
  );
  const selectedModelValue = effectiveConfig?.modelKey?.trim()
    ? effectiveConfig.modelKey.trim()
    : DAILY_REVIEW_DEFAULT_MODEL_VALUE;

  return (
    <section className="settingsFeatureStatusPage" aria-label="每日回顾">
      {/* Detail audit: the always-on feature banner repeated the page
          subtitle — report by exception instead: only the not-wired
          fallback state warrants a banner. */}
      {!hasConfigIpc && (
        <header className="settingsFeatureStatusBanner" role="status">
          <span className="settingsFeatureStatusBannerDot" aria-hidden="true" />
          <span>当前版本仅本地数字聚合，定时生成 / LLM 摘要尚未连接到后端。</span>
        </header>
      )}

      {loadError ? (
        <Alert variant="error" className="settingsSurfaceAlert">
          <AlertDescription>读取每日回顾设置失败：{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsRows>
        <div className="settingsRow">
          <div>
            <strong>启用每日回顾</strong>
            <small>每天自动分析前一天的工作内容，提供摘要与建议。</small>
          </div>
          <Switch
            ariaLabel="启用每日回顾"
            checked={effectiveConfig?.enabled ?? false}
            disabled={formDisabled || savingKey === 'enabled'}
            onChange={(enabled) => void patchConfig('enabled', { enabled })}
          />
        </div>

        <div className="settingsRow" data-control-width="compact">
          <div>
            <strong>执行时间</strong>
            <small>默认 08:00 本地时间触发。</small>
          </div>
          <Input
            type="time"
            aria-label="每日回顾执行时间"
            className="settingsTimeInput"
            value={effectiveConfig?.executeTime ?? '08:00'}
            disabled={formDisabled || savingKey === 'executeTime'}
            onChange={(event) => {
              // Native time-pickers only fire `change` once the value
              // is a complete HH:MM (or cleared); the earlier hand-
              // rolled regex would silently drop any intermediate
              // state the user typed (e.g. `08:0`), making the picker
              // feel stuck. Trust the browser.
              void patchConfig('executeTime', { executeTime: event.target.value });
            }}
          />
        </div>

        {DAILY_REVIEW_SECTION_LABELS.map((item) => (
          <div key={item.key} className="settingsRow">
            <div>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </div>
            <Switch
              ariaLabel={item.title}
              checked={effectiveConfig?.sections[item.key] ?? false}
              disabled={formDisabled || savingKey === `section:${item.key}` || !(effectiveConfig?.enabled ?? false)}
              onChange={(next) =>
                void patchConfig(`section:${item.key}`, {
                  sections: {
                    ...(effectiveConfig?.sections ?? { summary: false, gaps: false, usage: false, code: false }),
                    [item.key]: next,
                  },
                })
              }
            />
          </div>
        ))}

        <div className="settingsRow">
          <div>
            <strong>深度分析</strong>
            <small>消耗更多资源，对更长时间周期进行深入调研。</small>
          </div>
          <Switch
            ariaLabel="深度分析"
            checked={effectiveConfig?.deepEnabled ?? false}
            disabled={formDisabled || savingKey === 'deepEnabled'}
            onChange={(deepEnabled) => void patchConfig('deepEnabled', { deepEnabled })}
          />
        </div>

        <div className="settingsRow" data-control-width="select">
          <div>
            <strong>分析模型</strong>
            <small>
              用于生成回顾和分析的模型连接；默认跟随当前对话默认模型。
            </small>
          </div>
          <SettingsSelect
            value={selectedModelValue}
            ariaLabel="分析模型连接"
            options={modelOptions}
            disabled={formDisabled || savingKey === 'modelKey' || modelOptions.length === 0}
            onChange={(value) => {
              void patchConfig('modelKey', {
                modelKey: value === DAILY_REVIEW_DEFAULT_MODEL_VALUE ? '' : value,
              });
            }}
          />
        </div>

        <div className="settingsRow">
          <div>
            <strong>包含 Claude Code CLI 会话</strong>
            <small>将已同步的 Claude Code 对话纳入分析范围。</small>
          </div>
          <Switch
            ariaLabel="包含 Claude Code CLI 会话"
            checked={effectiveConfig?.includeClaudeCode ?? false}
            disabled={formDisabled || savingKey === 'includeClaudeCode'}
            onChange={(includeClaudeCode) => void patchConfig('includeClaudeCode', { includeClaudeCode })}
          />
        </div>

        <div className="settingsRow">
          <div>
            <strong>生成后发送外部通知</strong>
            <small>
              当前运行时尚未接入报告自动推送。机器人通道可以在「机器人对话」里配置，但每日回顾不会假装已发送。
            </small>
          </div>
          <Switch
            ariaLabel="生成后发送外部通知"
            checked={false}
            disabled={true}
            onChange={() => undefined}
          />
        </div>
      </SettingsRows>

      {(props.onOpenDailyReview || hasRunOnceIpc) && (
        <div className="settingsPageFooterActions" role="toolbar" aria-label="每日回顾操作">
          {hasRunOnceIpc && (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void triggerRun('deep')}
                disabled={runningMode !== null}
              >
                {runningMode === 'deep' ? '生成中…' : '生成深度分析'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void triggerRun('daily')}
                disabled={runningMode !== null}
              >
                {runningMode === 'daily' ? '生成中…' : '生成每日回顾'}
              </Button>
            </>
          )}
          {props.onOpenDailyReview && (
            <Button
              type="button"
              onClick={props.onOpenDailyReview}
            >
              打开每日回顾
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
