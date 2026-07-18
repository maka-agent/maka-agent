import type { LlmConnection, UiLocale } from '@maka/core';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core';
import { buildCatalogDailyReviewModelOptions } from './model-catalog-choices.js';

export const DAILY_REVIEW_CONFIG_MODEL_VALUE = '__maka_daily_review_config_model__';

export function dailyReviewExportDefaultName(label: string): string {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const scope = label.includes('30')
    ? '30d'
    : label.includes('7')
      ? '7d'
      : label === '昨天'
        ? 'yesterday'
        : label === '今天'
          ? 'today'
          : 'day';
  return `maka-daily-review-${scope}-${yyyy}-${mm}-${dd}.md`;
}

export function dailyReviewActionErrorMessage(error: unknown, fallback: string, locale: UiLocale): string {
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}

export function buildDailyReviewRunModelOptions(
  connections: readonly LlmConnection[],
): Array<readonly [string, string]> {
  return [
    // Compact default option for the panel's inline 分析模型 picker — a run
    // with no explicit override falls back to the model configured in Settings.
    [DAILY_REVIEW_CONFIG_MODEL_VALUE, '跟随设置'],
    ...buildCatalogDailyReviewModelOptions(connections, ''),
  ];
}
