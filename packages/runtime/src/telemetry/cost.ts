import type { PricingConfig } from '@maka/core/usage-stats/types';

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  /** Backward-compatible alias for cacheHitInputTokens. */
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
}

export function computeCost(usage: CostInput, pricing: PricingConfig | null): CostBreakdown {
  if (!pricing) {
    return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, totalCost: 0 };
  }
  const cacheHitInputTokens = usage.cacheHitInputTokens ?? usage.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  const cacheMissInputTokens =
    usage.cacheMissInputTokens ??
    Math.max(0, usage.inputTokens - cacheHitInputTokens - cacheWriteInputTokens);
  const inputCost = (cacheMissInputTokens / 1_000_000) * pricing.inputUsdPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPer1M;
  const cacheReadCost =
    pricing.cacheReadUsdPer1M && cacheHitInputTokens
      ? (cacheHitInputTokens / 1_000_000) * pricing.cacheReadUsdPer1M
      : 0;
  const cacheWriteCost =
    pricing.cacheWriteUsdPer1M && cacheWriteInputTokens
      ? (cacheWriteInputTokens / 1_000_000) * pricing.cacheWriteUsdPer1M
      : 0;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}
