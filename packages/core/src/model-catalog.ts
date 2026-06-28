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

export type ChatModelAvailabilityReason =
  | 'missing_model'
  | 'empty_model_list'
  | Exclude<ModelUnavailableReason, 'none' | 'stale'>;

export type ChatModelAvailabilityResult =
  | {
      ok: true;
      model: string;
      entry?: ModelInfo;
      warning?: Extract<ModelUnavailableReason, 'stale'>;
    }
  | {
      ok: false;
      reason: ChatModelAvailabilityReason;
      entry?: ModelInfo;
    };

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

export type ModelCatalogUserChoiceSource =
  | 'connection_default'
  | 'saved_model'
  | 'session_model'
  | 'daily_review_model';

export type SavedModelChoice =
  | string
  | {
      id: string;
      source: Exclude<ModelCatalogUserChoiceSource, 'connection_default'>;
    };

export interface ModelCatalogProvenanceSources {
  providerInventory?: true;
  staticCatalog?: true;
  userChoice?: ModelCatalogUserChoiceSource[];
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
    sources?: ModelCatalogProvenanceSources;
  };
}

export interface BuildConnectionModelCatalogInput {
  connection: Pick<
    LlmConnection,
    'slug' | 'providerType' | 'defaultModel' | 'models' | 'modelSource' | 'modelsFetchedAt'
  >;
  savedModelIds?: Iterable<SavedModelChoice | undefined | null>;
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
  savedModelIds?: Iterable<SavedModelChoice | undefined | null>;
}

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function buildModelCatalogEntries(input: BuildModelCatalogInput): ModelCatalogEntry[] {
  const liveModels = input.models;
  const modelSource = input.modelSource ?? (liveModels ? 'fetched' : 'fallback');
  const normalizedDefaultModel = input.defaultModel?.trim();
  const source = liveModels
    ? modelSource === 'fetched' ? 'provider_api' : 'static_catalog'
    : 'static_catalog';
  const rawModels = liveModels ?? (input.fallbackModels ?? []).map((id) => ({
    id,
    ...displayNameForKnownModel(input.providerType, id),
  }));
  const savedChoiceSources = savedChoiceSourcesById(input.savedModelIds);
  const seen = new Set<string>();
  const entries = rawModels
    .filter((model) => {
      const id = model.id.trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((model) => makeEntry(input, model, source, modelSource, savedChoiceSources, normalizedDefaultModel));

  if (normalizedDefaultModel && !seen.has(normalizedDefaultModel)) {
    entries.unshift(makeMissingDefaultEntry(input, normalizedDefaultModel, modelSource, savedChoiceSources, normalizedDefaultModel));
    seen.add(normalizedDefaultModel);
  }

  for (const id of savedChoiceSources.keys()) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(makeMissingUserChoiceEntry(input, id, modelSource, savedChoiceSources, normalizedDefaultModel));
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

export function evaluateChatModelAvailability(input: {
  model?: string;
  models?: ModelInfo[];
  modelSource?: ModelDiscoverySource;
  modelsFetchedAt?: number;
  now?: number;
  staleAfterMs?: number;
  providerAvailable?: boolean;
  authOk?: boolean;
}): ChatModelAvailabilityResult {
  const model = input.model?.trim();
  if (!model) return { ok: false, reason: 'missing_model' };
  const providerOrAuthReason = providerOrAuthUnavailableReason(input);
  if (providerOrAuthReason) return { ok: false, reason: providerOrAuthReason };
  if (input.models) {
    const entries = new Map(
      input.models
        .map((entry): [string, ModelInfo] => [entry.id.trim(), entry])
        .filter(([id]) => id.length > 0),
    );
    if (entries.size === 0) return { ok: false, reason: 'empty_model_list' };
    const entry = entries.get(model);
    if (!entry) return { ok: false, reason: 'not_in_live_list' };
    const unavailableReason = deriveModelUnavailableReason(input, entry);
    const blockingReason = blockingChatAvailabilityReason(unavailableReason);
    if (blockingReason) {
      return { ok: false, reason: blockingReason, entry };
    }
    return {
      ok: true,
      model,
      entry,
      ...(unavailableReason === 'stale' ? { warning: unavailableReason } : {}),
    };
  }

  const unavailableReason = deriveModelUnavailableReason(input, { id: model });
  const blockingReason = blockingChatAvailabilityReason(unavailableReason);
  if (blockingReason) {
    return { ok: false, reason: blockingReason };
  }
  return {
    ok: true,
    model,
    ...(unavailableReason === 'stale' ? { warning: unavailableReason } : {}),
  };
}

function makeEntry(
  input: BuildModelCatalogInput,
  model: ModelInfo,
  source: ModelCatalogEntry['source'],
  modelSource: ModelDiscoverySource,
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
): ModelCatalogEntry {
  const normalizedModel = { ...model, id: model.id.trim() };
  const unavailableReason = deriveUnavailableReason(input, normalizedModel);
  const pricing = findPricing(input, normalizedModel.id);
  return {
    id: normalizedModel.id,
    ...displayNameForModel(input.providerType, normalizedModel),
    providerType: input.providerType,
    ...(input.connectionSlug ? { connectionSlug: input.connectionSlug } : {}),
    source,
    capabilitySource: model.capabilities ? source : 'unknown',
    unavailableReason,
    availability: availabilityOf(unavailableReason),
    canUseAsChatDefault: canUseUnavailableReasonAsDefault(unavailableReason),
    isDefault: normalizedModel.id === normalizedDefaultModel,
    capabilities: normalizeCapabilities(normalizedModel),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(pricing ? { pricing } : {}),
    provenance: {
      modelSource,
      ...(input.modelsFetchedAt ? { modelsFetchedAt: input.modelsFetchedAt } : {}),
      ...(pricing ? { pricingModelKey: `${input.providerType}:${normalizedModel.id}` } : {}),
      sources: provenanceSources(input, normalizedModel.id, source, savedChoiceSources, normalizedDefaultModel),
    },
  };
}

function makeMissingDefaultEntry(
  input: BuildModelCatalogInput,
  id: string,
  modelSource: ModelDiscoverySource,
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
): ModelCatalogEntry {
  const unavailableReason = missingEntryUnavailableReason(input, modelSource);
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
      sources: provenanceSources(input, id, 'unknown', savedChoiceSources, normalizedDefaultModel),
    },
  };
}

function makeMissingUserChoiceEntry(
  input: BuildModelCatalogInput,
  id: string,
  modelSource: ModelDiscoverySource,
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
): ModelCatalogEntry {
  const unavailableReason = missingEntryUnavailableReason(input, modelSource);
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
    isDefault: id === normalizedDefaultModel,
    capabilities: {},
    provenance: {
      modelSource,
      ...(input.modelsFetchedAt ? { modelsFetchedAt: input.modelsFetchedAt } : {}),
      userChoice: true,
      sources: provenanceSources(input, id, 'unknown', savedChoiceSources, normalizedDefaultModel),
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

function provenanceSources(
  input: Pick<BuildModelCatalogInput, 'providerType'>,
  id: string,
  source: ModelCatalogEntry['source'],
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
): ModelCatalogProvenanceSources {
  const userChoice = userChoiceSources(id, savedChoiceSources, normalizedDefaultModel);
  return {
    ...(source === 'provider_api' ? { providerInventory: true as const } : {}),
    ...(source === 'static_catalog' || hasStaticModelMetadata(input.providerType, id)
      ? { staticCatalog: true as const }
      : {}),
    ...(userChoice.length > 0 ? { userChoice } : {}),
  };
}

function hasStaticModelMetadata(providerType: ProviderType, id: string): boolean {
  return Object.keys(lookupModelMetadata(providerType, id)).length > 0;
}

function userChoiceSources(
  id: string,
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
): ModelCatalogUserChoiceSource[] {
  const sources: ModelCatalogUserChoiceSource[] = [];
  if (id === normalizedDefaultModel) sources.push('connection_default');
  for (const source of savedChoiceSources.get(id) ?? []) {
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

function deriveUnavailableReason(input: BuildModelCatalogInput, model: ModelInfo): ModelUnavailableReason {
  return deriveModelUnavailableReason(input, model);
}

function deriveModelUnavailableReason(
  input: Pick<
    BuildModelCatalogInput,
    'providerAvailable' | 'authOk' | 'modelSource' | 'modelsFetchedAt' | 'now' | 'staleAfterMs'
  >,
  model: ModelInfo,
): ModelUnavailableReason {
  const providerOrAuthReason = providerOrAuthUnavailableReason(input);
  if (providerOrAuthReason) return providerOrAuthReason;
  if (isModelExplicitlyUnsupportedForChat(model)) return 'unsupported_for_chat';
  if (isStale(input)) return 'stale';
  return 'none';
}

function providerOrAuthUnavailableReason(
  input: Pick<BuildModelCatalogInput, 'providerAvailable' | 'authOk'>,
): Extract<ModelUnavailableReason, 'provider_removed' | 'auth'> | null {
  if (input.providerAvailable === false) return 'provider_removed';
  if (input.authOk === false) return 'auth';
  return null;
}

function missingEntryUnavailableReason(
  input: Pick<BuildModelCatalogInput, 'providerAvailable' | 'authOk'>,
  modelSource: ModelDiscoverySource,
): ModelUnavailableReason {
  const providerOrAuthReason = providerOrAuthUnavailableReason(input);
  if (providerOrAuthReason) return providerOrAuthReason;
  return modelSource === 'fetched' ? 'not_in_live_list' : 'none';
}

function blockingChatAvailabilityReason(
  reason: ModelUnavailableReason,
): Exclude<ModelUnavailableReason, 'none' | 'stale'> | null {
  return reason === 'none' || reason === 'stale' ? null : reason;
}

function isStale(input: Pick<BuildModelCatalogInput, 'modelSource' | 'modelsFetchedAt' | 'now' | 'staleAfterMs'>): boolean {
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

function savedChoiceSourcesById(
  choices: Iterable<SavedModelChoice | undefined | null> | undefined,
): Map<string, ModelCatalogUserChoiceSource[]> {
  const result = new Map<string, ModelCatalogUserChoiceSource[]>();
  if (!choices) return result;
  for (const choice of choices) {
    if (!choice) continue;
    const id = typeof choice === 'string' ? choice.trim() : choice.id.trim();
    if (!id) continue;
    const source = typeof choice === 'string' ? 'saved_model' : choice.source;
    const sources = result.get(id) ?? [];
    if (!sources.includes(source)) sources.push(source);
    result.set(id, sources);
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
