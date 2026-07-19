import type { PricingConfig } from '@maka/core/usage-stats/types';
import { getBuiltinPricing } from './builtin-pricing.js';

export function buildPricingLookup(
  overrides: readonly PricingConfig[] = [],
): (modelKey: string) => PricingConfig | null {
  const overrideMap = new Map(overrides.map((pricing) => [pricing.modelKey, pricing]));
  return (modelKey) => overrideMap.get(modelKey) ?? getBuiltinPricing(modelKey);
}
