import { randomUUID } from 'node:crypto';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { LlmCallRecord, PricingConfig } from '@maka/core/usage-stats/types';
import { computeCost } from './cost.js';
import type { TelemetryRepoLite } from './types.js';

export interface LlmRecorderDeps {
  repo: TelemetryRepoLite;
  lookupPricing: (modelKey: string) => PricingConfig | null;
}

export function recordLlmCall(deps: LlmRecorderDeps, record: LlmCallRecord): void {
  queueMicrotask(() => {
    try {
      const cacheHitInputTokens = record.cacheHitInputTokens ?? record.cachedInputTokens ?? 0;
      const cacheWriteInputTokens = record.cacheWriteInputTokens ?? 0;
      const cacheMissInputTokens =
        record.cacheMissInputTokens
        ?? Math.max(0, record.inputTokens - cacheHitInputTokens - cacheWriteInputTokens);
      const cachedInputTokens = cacheHitInputTokens;
      const reasoningTokens = record.reasoningTokens ?? 0;
      const totalTokens = record.totalTokens ?? record.inputTokens + record.outputTokens + reasoningTokens;
      const costUsd = computeCost(
        {
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheHitInputTokens,
          cacheMissInputTokens,
          cacheWriteInputTokens,
        },
        deps.lookupPricing(`${record.providerId}:${record.modelId}`),
      ).totalCost;
      const ts = record.startedAt + record.latencyMs;
      deps.repo.insertLlmCall({
        ...record,
        id: `usage_${record.turnId ?? randomUUID()}`,
        cacheHitInputTokens,
        cacheMissInputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        reasoningTokens,
        totalTokens,
        costUsd,
        date: new Date(ts).toISOString().slice(0, 10),
        ts,
      });
    } catch (error) {
      console.error(`[telemetry] recordLlmCall failed: ${generalizedErrorMessage(error)}`);
    }
  });
}
