import type {
  LlmConnection,
  ModelDiscoverySource,
  ModelInfo,
  ProviderType,
} from './llm-connections.js';
import { PROVIDER_DEFAULTS } from './llm-connections.js';
import type { PricingConfig } from './usage-stats/types.js';
import { catalogFallbackModelsForProvider, lookupModelMetadata } from './model-metadata.js';

export type ModelCapabilitySource =
  | 'provider_api'
  | 'static_catalog'
  | 'user_override'
  | 'unknown';

export type ModelUnavailableReason =
  | 'none'
  | 'not_in_live_list'
  | 'unsupported_for_chat'
  | 'provider_removed'
  | 'auth'
  | 'stale';

export type ModelCatalogAvailability = 'available' | 'warning' | 'blocked';

export interface KnownModelCapabilities {
  chat?: true;
  vision?: true;
  reasoning?: true;
  functionCalling?: true;
  imageGeneration?: true;
}

export interface ModelCatalogPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
  source: 'builtin' | 'user_override';
}

export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  providerType: ProviderType;
  connectionSlug?: string;
  source: 'provider_api' | 'static_catalog' | 'unknown';
  capabilitySource: ModelCapabilitySource;
  unavailableReason: ModelUnavailableReason;
  availability: ModelCatalogAvailability;
  canUseAsChatDefault: boolean;
  isDefault: boolean;
  capabilities: KnownModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelCatalogPricing;
  provenance: {
    modelSource?: ModelDiscoverySource;
    modelsFetchedAt?: number;
    pricingModelKey?: string;
    userChoice?: true;
  };
}

export interface BuildConnectionModelCatalogInput {
  connection: Pick<
    LlmConnection,
    'slug' | 'providerType' | 'defaultModel' | 'models' | 'modelSource' | 'modelsFetchedAt'
  >;
  savedModelIds?: Iterable<string | undefined | null>;
  fallbackModels?: string[];
  now?: number;
  staleAfterMs?: number;
  providerAvailable?: boolean;
  authOk?: boolean;
  pricing?: Iterable<PricingConfig>;
  pricingSource?: 'builtin' | 'user_override';
}

export interface BuildModelCatalogInput {
  providerType: ProviderType;
  connectionSlug?: string;
  defaultModel?: string;
  models?: ModelInfo[];
  modelSource?: ModelDiscoverySource;
  modelsFetchedAt?: number;
  fallbackModels?: string[];
  now?: number;
  staleAfterMs?: number;
  providerAvailable?: boolean;
  authOk?: boolean;
  pricing?: Iterable<PricingConfig>;
  pricingSource?: 'builtin' | 'user_override';
  savedModelIds?: Iterable<string | undefined | null>;
}

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function buildModelCatalogEntries(input: BuildModelCatalogInput): ModelCatalogEntry[] {
  const liveModels = input.models;
  const modelSource = input.modelSource ?? (liveModels ? 'fetched' : 'fallback');
  const source = liveModels
    ? modelSource === 'fetched' ? 'provider_api' : 'static_catalog'
    : 'static_catalog';
  const rawModels = liveModels ?? (input.fallbackModels ?? []).map((id) => ({
    id,
    ...displayNameForKnownModel(input.providerType, id),
  }));
  const seen = new Set<string>();
  const entries = rawModels
    .filter((model) => {
      const id = model.id.trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((model) => makeEntry(input, model, source, modelSource));

  const defaultModel = input.defaultModel?.trim();
  if (defaultModel && !seen.has(defaultModel)) {
    entries.unshift(makeMissingDefaultEntry(input, defaultModel, source, modelSource));
    seen.add(defaultModel);
  }

  for (const id of normalizedSavedModelIds(input.savedModelIds)) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(makeMissingUserChoiceEntry(input, id, source, modelSource));
  }

  return entries;
}

export function buildConnectionModelCatalogEntries(input: BuildConnectionModelCatalogInput): ModelCatalogEntry[] {
  const { connection } = input;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const catalogFallbackModels = catalogFallbackModelsForProvider(connection.providerType);
  return buildModelCatalogEntries({
    providerType: connection.providerType,
    connectionSlug: connection.slug,
    defaultModel: connection.defaultModel,
    models: connection.models,
    modelSource: connection.modelSource,
    modelsFetchedAt: connection.modelsFetchedAt,
    fallbackModels: input.fallbackModels ?? [...(catalogFallbackModels ?? defaults.fallbackModels)],
    now: input.now,
    staleAfterMs: input.staleAfterMs,
    providerAvailable: input.providerAvailable,
    authOk: input.authOk,
    pricing: input.pricing,
    pricingSource: input.pricingSource,
    savedModelIds: input.savedModelIds,
  });
}

export function validateChatDefaultModel(input: BuildModelCatalogInput): {
  ok: true;
  entry: ModelCatalogEntry;
} | {
  ok: false;
  reason: Exclude<ModelUnavailableReason, 'none' | 'stale'>;
  entry?: ModelCatalogEntry;
} {
  const defaultModel = input.defaultModel?.trim();
  if (!defaultModel) {
    return { ok: false, reason: 'not_in_live_list' };
  }
  const entry = buildModelCatalogEntries(input).find((candidate) => candidate.id === defaultModel);
  if (!entry) {
    return { ok: false, reason: 'not_in_live_list' };
  }
  if (entry.canUseAsChatDefault) return { ok: true, entry };
  const reason = entry.unavailableReason === 'stale' || entry.unavailableReason === 'none'
    ? 'unsupported_for_chat'
    : entry.unavailableReason;
  return { ok: false, reason, entry };
}

function makeEntry(
  input: BuildModelCatalogInput,
  model: ModelInfo,
  source: ModelCatalogEntry['source'],
  modelSource: ModelDiscoverySource,
): ModelCatalogEntry {
  const unavailableReason = deriveUnavailableReason(input, model);
  const pricing = findPricing(input, model.id);
  return {
    id: model.id,
    ...displayNameForModel(input.providerType, model),
    providerType: input.providerType,
    ...(input.connectionSlug ? { connectionSlug: input.connectionSlug } : {}),
    source,
    capabilitySource: model.capabilities ? source : 'unknown',
    unavailableReason,
    availability: availabilityOf(unavailableReason),
    canUseAsChatDefault: canUseUnavailableReasonAsDefault(unavailableReason),
    isDefault: model.id === input.defaultModel,
    capabilities: normalizeCapabilities(model),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(pricing ? { pricing } : {}),
    provenance: {
      modelSource,
      ...(input.modelsFetchedAt ? { modelsFetchedAt: input.modelsFetchedAt } : {}),
      ...(pricing ? { pricingModelKey: `${input.providerType}:${model.id}` } : {}),
    },
  };
}

function makeMissingDefaultEntry(
  input: BuildModelCatalogInput,
  id: string,
  source: ModelCatalogEntry['source'],
  modelSource: ModelDiscoverySource,
): ModelCatalogEntry {
  const unavailableReason = input.providerAvailable === false
    ? 'provider_removed'
    : input.authOk === false
      ? 'auth'
      : source === 'provider_api'
        ? 'not_in_live_list'
        : 'none';
  return {
    id,
    ...displayNameForKnownModel(input.providerType, id),
    providerType: input.providerType,
    ...(input.connectionSlug ? { connectionSlug: input.connectionSlug } : {}),
    source: 'unknown',
    capabilitySource: 'unknown',
    unavailableReason,
    availability: availabilityOf(unavailableReason),
    canUseAsChatDefault: canUseUnavailableReasonAsDefault(unavailableReason),
    isDefault: true,
    capabilities: {},
    provenance: {
      modelSource,
      ...(input.modelsFetchedAt ? { modelsFetchedAt: input.modelsFetchedAt } : {}),
    },
  };
}

function makeMissingUserChoiceEntry(
  input: BuildModelCatalogInput,
  id: string,
  source: ModelCatalogEntry['source'],
  modelSource: ModelDiscoverySource,
): ModelCatalogEntry {
  const unavailableReason = input.providerAvailable === false
    ? 'provider_removed'
    : input.authOk === false
      ? 'auth'
      : source === 'provider_api'
        ? 'not_in_live_list'
        : 'none';
  return {
    id,
    ...displayNameForKnownModel(input.providerType, id),
    providerType: input.providerType,
    ...(input.connectionSlug ? { connectionSlug: input.connectionSlug } : {}),
    source: 'unknown',
    capabilitySource: 'unknown',
    unavailableReason,
    availability: availabilityOf(unavailableReason),
    canUseAsChatDefault: canUseUnavailableReasonAsDefault(unavailableReason),
    isDefault: id === input.defaultModel,
    capabilities: {},
    provenance: {
      modelSource,
      ...(input.modelsFetchedAt ? { modelsFetchedAt: input.modelsFetchedAt } : {}),
      userChoice: true,
    },
  };
}

function displayNameForModel(providerType: ProviderType, model: ModelInfo): { displayName?: string } {
  const displayName = model.displayName?.trim();
  if (displayName && displayName !== model.id) return { displayName };
  return displayNameForKnownModel(providerType, model.id);
}

function displayNameForKnownModel(providerType: ProviderType, id: string): { displayName?: string } {
  const displayName = lookupModelMetadata(providerType, id).displayName;
  return displayName ? { displayName } : {};
}

function deriveUnavailableReason(input: BuildModelCatalogInput, model: ModelInfo): ModelUnavailableReason {
  if (input.providerAvailable === false) return 'provider_removed';
  if (input.authOk === false) return 'auth';
  if (isModelExplicitlyUnsupportedForChat(model)) return 'unsupported_for_chat';
  if (isStale(input)) return 'stale';
  return 'none';
}

function isStale(input: BuildModelCatalogInput): boolean {
  if (input.modelSource !== 'fetched' || input.modelsFetchedAt === undefined) return false;
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return now - input.modelsFetchedAt > staleAfterMs;
}

export function isModelExplicitlyUnsupportedForChat(model: ModelInfo): boolean {
  const caps = model.capabilities;
  if (!caps) return false;
  if (caps.chat === false) return true;
  return caps.imageGeneration === true &&
    caps.chat !== true &&
    caps.reasoning !== true &&
    caps.functionCalling !== true;
}

function normalizeCapabilities(model: ModelInfo): KnownModelCapabilities {
  const caps = model.capabilities;
  if (!caps) return {};
  return {
    ...(caps.chat === true ? { chat: true as const } : {}),
    ...(caps.vision === true ? { vision: true as const } : {}),
    ...(caps.reasoning === true ? { reasoning: true as const } : {}),
    ...(caps.functionCalling === true ? { functionCalling: true as const } : {}),
    ...(caps.imageGeneration === true ? { imageGeneration: true as const } : {}),
  };
}

function availabilityOf(reason: ModelUnavailableReason): ModelCatalogAvailability {
  if (reason === 'none') return 'available';
  if (reason === 'stale') return 'warning';
  return 'blocked';
}

function canUseUnavailableReasonAsDefault(reason: ModelUnavailableReason): boolean {
  return reason === 'none' || reason === 'stale';
}

function normalizedSavedModelIds(ids: Iterable<string | undefined | null> | undefined): string[] {
  if (!ids) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function findPricing(input: BuildModelCatalogInput, id: string): ModelCatalogPricing | null {
  if (!input.pricing) return null;
  const modelKey = `${input.providerType}:${id}`;
  for (const item of input.pricing) {
    if (item.modelKey !== modelKey) continue;
    return {
      inputUsdPer1M: item.inputUsdPer1M,
      outputUsdPer1M: item.outputUsdPer1M,
      ...(item.cacheReadUsdPer1M !== undefined ? { cacheReadUsdPer1M: item.cacheReadUsdPer1M } : {}),
      ...(item.cacheWriteUsdPer1M !== undefined ? { cacheWriteUsdPer1M: item.cacheWriteUsdPer1M } : {}),
      source: input.pricingSource ?? 'builtin',
    };
  }
  return null;
}
