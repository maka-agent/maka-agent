import type { HarborBillingMode, HarborTaskPricing } from './harbor-task-runner.js';

export interface RuntimePolicyAbExecutionProfile {
  schemaVersion: 1;
  id: string;
  llmConnectionSlug: string;
  provider: string;
  baseUrl: string;
  model: string;
  billingMode?: HarborBillingMode;
  pricing: HarborTaskPricing & { source: string };
  taskBudgetSec: number;
  harborTimeoutMs: number;
  observedCostStopUsd: number;
  maxConcurrentAttempts: number;
}

export function parseRuntimePolicyAbExecutionProfile(
  value: unknown,
): RuntimePolicyAbExecutionProfile {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error('runtime policy A/B execution profile schemaVersion must be 1');
  for (const key of ['id', 'llmConnectionSlug', 'provider', 'baseUrl', 'model'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0)
      throw new Error(`runtime policy A/B execution profile ${key} must be a non-empty string`);
  }
  if (!String(value.model).startsWith(`${String(value.provider)}/`)) {
    throw new Error('runtime policy A/B execution profile model must be qualified by its provider');
  }
  if (
    value.billingMode !== undefined &&
    value.billingMode !== 'metered' &&
    value.billingMode !== 'account-plan'
  ) {
    throw new Error(
      'runtime policy A/B execution profile billingMode must be metered or account-plan',
    );
  }
  if (
    !isRecord(value.pricing) ||
    typeof value.pricing.source !== 'string' ||
    value.pricing.source.length === 0
  ) {
    throw new Error(
      'runtime policy A/B execution profile pricing.source must be a non-empty string',
    );
  }
  if (value.pricing.source !== value.id)
    throw new Error('runtime policy A/B execution profile pricing.source must equal profile id');
  for (const key of [
    'inputUsdPer1M',
    'outputUsdPer1M',
    'cacheReadUsdPer1M',
    'cacheWriteUsdPer1M',
  ] as const) {
    const rate = value.pricing[key];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)
      throw new Error(
        `runtime policy A/B execution profile pricing.${key} must be a finite non-negative number`,
      );
  }
  for (const key of ['taskBudgetSec', 'harborTimeoutMs'] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0)
      throw new Error(`runtime policy A/B execution profile ${key} must be a positive integer`);
  }
  if (
    typeof value.observedCostStopUsd !== 'number' ||
    !Number.isFinite(value.observedCostStopUsd) ||
    value.observedCostStopUsd <= 0
  ) {
    throw new Error(
      'runtime policy A/B execution profile observedCostStopUsd must be a finite positive number',
    );
  }
  if (
    !Number.isSafeInteger(value.maxConcurrentAttempts) ||
    Number(value.maxConcurrentAttempts) < 2 ||
    Number(value.maxConcurrentAttempts) % 2 !== 0
  ) {
    throw new Error(
      'runtime policy A/B execution profile maxConcurrentAttempts must be an even integer of at least 2',
    );
  }
  return value as unknown as RuntimePolicyAbExecutionProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
