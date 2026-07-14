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
      const usageAvailable = record.usageAvailable !== false;
      const inputTokens = usageAvailable ? record.inputTokens : 0;
      const outputTokens = usageAvailable ? record.outputTokens : 0;
      const cacheHitInputTokens = usageAvailable
        ? record.cacheHitInputTokens ?? record.cachedInputTokens ?? 0
        : 0;
      const cacheWriteInputTokens = usageAvailable ? record.cacheWriteInputTokens ?? 0 : 0;
      const derivedCacheMissInputTokens = record.cacheMissInputTokens === undefined;
      const cacheMissInputTokens = usageAvailable
        ? record.cacheMissInputTokens ?? Math.max(0, inputTokens - cacheHitInputTokens - cacheWriteInputTokens)
        : 0;
      const cacheMissInputSource = usageAvailable
        ? record.cacheMissInputSource ?? (derivedCacheMissInputTokens ? 'derived' : undefined)
        : undefined;
      const cachedInputTokens = cacheHitInputTokens;
      const reasoningTokens = usageAvailable ? record.reasoningTokens ?? 0 : 0;
      const totalTokens = usageAvailable ? record.totalTokens ?? inputTokens + outputTokens + reasoningTokens : 0;
      const costUsd = usageAvailable
        ? record.costUsd ?? computeCost(
          {
            inputTokens,
            outputTokens,
            cacheHitInputTokens,
            cacheMissInputTokens,
            cacheWriteInputTokens,
          },
          deps.lookupPricing(`${record.providerId}:${record.modelId}`),
        ).totalCost
        : 0;
      const ts = record.startedAt + record.latencyMs;
      const recordId = record.callId
        ? `usage_${record.callId}`
        : `usage_${record.turnId ?? randomUUID()}`;
      deps.repo.insertLlmCall({
        ...record,
        id: recordId,
        usageAvailable,
        inputTokens,
        outputTokens,
        cacheHitInputTokens,
        cacheMissInputTokens,
        ...(cacheMissInputSource !== undefined ? { cacheMissInputSource } : {}),
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
