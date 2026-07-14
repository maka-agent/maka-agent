import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDailyReviewMainService } from '../daily-review-main.js';

test('Daily Review uses the Settings usage authority including legacy fallback', async () => {
  const service = createDailyReviewMainService({
    archiveStore: {},
    connectionStore: {},
    telemetryRepo: {
      load: async () => {},
      buckets: () => [],
    },
    settingsStore: {
      usageStats: async () => ({
        summary: {
          totalRequests: 1,
          totalCostUsd: 0.02,
          totalTokens: 15,
          inputTokens: 10,
          outputTokens: 5,
          cacheTokens: 2,
          cacheMiss: 8,
          cacheRead: 2,
          cacheCreation: 0,
          reasoning: 0,
          usageUnavailableRequests: 0,
        },
        logs: [{
          id: 'legacy-usage', ts: Date.now(), kind: 'model', sessionId: 'session-1',
          turnId: 'turn-1', provider: 'legacy-provider', model: 'legacy-model',
          inputTokens: 10, outputTokens: 5, cacheRead: 2, costUsd: 0.02,
          status: 'success',
        }],
        byProvider: [{ provider: 'legacy-provider', requests: 1, tokens: 15, costUsd: 0.02 }],
        byModel: [{ model: 'legacy-model', requests: 1, tokens: 15, costUsd: 0.02 }],
        byTool: [],
        pricing: [],
      }),
    },
    listSessions: async () => [],
    resolveConnectionSecret: async () => null,
    buildSubscriptionModelFetch: () => undefined,
  } as never);

  const summary = await service.buildSummaryForRange(0, 1);

  assert.equal(summary.totals.requestCount, 1);
  assert.equal(summary.totals.totalTokens, 15);
  assert.equal(summary.totals.costUsd, 0.02);
  assert.equal(summary.topModels[0]?.key, 'legacy-model');
});
