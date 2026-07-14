import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DailyReviewSummary } from '@maka/core';
import { formatDailyReviewMarkdown } from './daily-review-helpers.js';

test('Daily Review Markdown labels partial usage totals', () => {
  const summary = {
    day: { fromMs: 0, toMs: 1 },
    totals: {
      sessionCount: 1,
      requestCount: 2,
      totalTokens: 10,
      costUsd: 0.01,
      errorCount: 0,
      usageUnavailableRequests: 1,
    },
    sessions: [],
    topTools: [],
    topModels: [],
  } satisfies DailyReviewSummary;

  assert.match(formatDailyReviewMarkdown(summary, '今天'), /部分统计：1 次请求缺少 provider usage/);
});
