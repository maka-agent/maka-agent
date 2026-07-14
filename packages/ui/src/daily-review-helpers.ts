/**
 * Pure helpers backing the DailyReviewPanel — formatters, error
 * mappers, and the Markdown serializer.
 *
 * PR-UI-LIB-EXTRACT-2 (WAWQAQ msg `510fef52`, round 3/10): pulled
 * out of `components.tsx`. `formatDailyReviewMarkdown` was already
 * a public export from `@maka/ui` (consumed by the desktop
 * renderer's main.tsx + the `daily-review-copy-feedback-contract`
 * test); the other four were internal to the panel file. byte-
 * for-byte equivalent; behavior unchanged; `index.ts` re-exports
 * everything from the new module so the public API surface stays
 * identical.
 *
 * Why this seam: serializing a Daily Review to Markdown is a pure
 * `summary → string` transform that has nothing to do with React.
 * Living next to ~600 lines of DailyReviewPanel JSX made it hard
 * to test (or even find) the formatter in isolation.
 */

import type {
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewSummary,
} from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';

/** Visible day-range options on the Daily Review panel. */
export type DailyReviewRange = 1 | 7 | 30;

export function dailyReviewScopeKey(offsetDays: number, range: DailyReviewRange): string {
  return `${offsetDays}:${range}`;
}

export function dailyReviewPanelErrorMessage(error: unknown): string {
  return generalizedErrorMessageChinese(error, '每日回顾暂时不可用，请稍后重试。');
}

export function formatDailyReviewArchiveTitle(archive: DailyReviewArchive | DailyReviewArchiveSummary): string {
  const d = new Date(archive.day.fromMs);
  const date = d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  return `${date} · ${archive.mode === 'deep' ? '深度分析' : '每日回顾'}`;
}

export function formatDailyReviewArchiveGeneratedAt(generatedAt: number): string {
  return new Date(generatedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * PR-DAILY-REVIEW-COPY-0: produce a Markdown summary of the current
 * Daily Review for clipboard share. Sessions list is title-only —
 * we deliberately skip lastMessagePreview because the message body
 * may contain content the user does not want in a shared note.
 */
export function formatDailyReviewMarkdown(
  summary: DailyReviewSummary,
  dayLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`# Maka · 每日回顾 · ${dayLabel}`);
  lines.push('');
  lines.push(`- 对话：${summary.totals.sessionCount}`);
  lines.push(`- 请求：${summary.totals.requestCount}`);
  lines.push(`- Token：${summary.totals.totalTokens.toLocaleString()}`);
  lines.push(`- 费用：$${summary.totals.costUsd.toFixed(2)}`);
  if (summary.totals.errorCount > 0) {
    lines.push(`- 错误：${summary.totals.errorCount}`);
  }
  if (summary.sessions.length > 0) {
    lines.push('');
    lines.push('## 活跃对话');
    for (const session of summary.sessions) {
      lines.push(`- ${session.name}`);
    }
  }
  if (summary.topModels.length > 0) {
    lines.push('');
    lines.push('## 模型使用');
    for (const entry of summary.topModels) {
      const cost = entry.costUsd > 0 ? ` · $${entry.costUsd.toFixed(2)}` : '';
      lines.push(`- ${entry.label}：${entry.requests} 次 · ${entry.totalTokens.toLocaleString()} tok${cost}`);
    }
  }
  if (summary.topTools.length > 0) {
    lines.push('');
    lines.push('## 工具调用');
    for (const entry of summary.topTools) {
      lines.push(`- ${entry.label}：${entry.requests} 次`);
    }
  }
  return lines.join('\n');
}

/**
 * Archive headers used to print the raw internal model key
 * (`<connectionSlug>::<modelId>`, e.g. `zai-live::glm-4.5`) — an
 * implementation detail leaking into UI copy (designer audit P1-8).
 * Show just the model id; the connection is not something the reader
 * needs to decode a report.
 */
export function formatDailyReviewModelLabel(modelKey: string): string {
  const separatorIndex = modelKey.lastIndexOf('::');
  if (separatorIndex === -1) return modelKey;
  const modelId = modelKey.slice(separatorIndex + 2).trim();
  return modelId.length > 0 ? modelId : modelKey;
}
