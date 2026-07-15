import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_DEFAULTS,
  buildConnectionModelCatalogEntries,
  type LlmConnection,
  type ModelCatalogEntry,
  type ProviderType,
  type SavedModelChoice,
} from '@maka/core';
import type { ChatModelChoice } from '@maka/ui';

const DAILY_REVIEW_MODEL_KEY_SEPARATOR = '::';

export function buildCatalogRecommendedDefaultModel(providerType: ProviderType): string {
  const entry = selectableCatalogEntries({
    slug: providerType,
    providerType,
    defaultModel: '',
  })[0];
  return entry?.id ?? '';
}

export function pickCatalogDefaultChatModel(connection: Pick<
  LlmConnection,
  'slug' | 'providerType' | 'defaultModel' | 'models' | 'modelSource' | 'modelsFetchedAt'
>): { llmConnectionSlug: string; model: string } | undefined {
  const entry = selectableCatalogEntries(connection).find((choice) => choice.isDefault && choice.canUseAsChatDefault);
  return entry ? { llmConnectionSlug: connection.slug, model: entry.id } : undefined;
}

export function buildCatalogChatModelChoices(connections: readonly LlmConnection[]): ChatModelChoice[] {
  const choices: ChatModelChoice[] = [];
  for (const connection of connections) {
    if (!isModelConsumerConnection(connection)) continue;
    // Only non-OAuth connections get their user-chosen name surfaced in the
    // menu heading — see `ChatModelChoice.connectionName`. OAuth providers'
    // `connection.name` embeds the account email, so this stays undefined
    // for them and the menu falls back to the provider label.
    const connectionName = PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token'
      ? undefined
      : connection.name;
    for (const entry of selectableCatalogEntries(connection)) {
      choices.push({
        connectionSlug: connection.slug,
        providerType: connection.providerType,
        model: entry.id,
        label: modelDisplayLabel(entry),
        connectionName,
      });
    }
  }
  return choices;
}

export function buildCatalogModelChoices(connection: Pick<
  LlmConnection,
  'slug' | 'providerType' | 'defaultModel' | 'models' | 'modelSource' | 'modelsFetchedAt'
>): ModelCatalogEntry[] {
  return buildConnectionModelCatalogEntries({ connection });
}

export function buildCatalogDailyReviewModelOptions(
  connections: readonly LlmConnection[],
  currentModelKey: string,
): Array<readonly [string, string]> {
  const current = parseDailyReviewModelKey(currentModelKey);
  const candidates: Array<{ key: string; label: string; safeSourceLabel: string }> = [];
  const seenKeys = new Set<string>();
  const providerCounts = enabledProviderCounts(connections);

  for (const connection of connections) {
    if (!isModelConsumerConnection(connection)) continue;
    const savedModelIds: SavedModelChoice[] = current?.connectionSlug === connection.slug
      ? [{ id: current.model, source: 'daily_review_model' }]
      : [];
    const safeSourceLabel = safeConnectionLabel(connection.providerType, connection.slug, providerCounts);
    for (const entry of dailyReviewCatalogEntries(connection, savedModelIds)) {
      const key = dailyReviewModelKey(connection.slug, entry.id);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      candidates.push({ key, label: dailyReviewModelDisplayLabel(entry), safeSourceLabel });
    }
  }

  const options: Array<readonly [string, string]> = [];
  const modelCounts = new Map<string, number>();
  for (const candidate of candidates) {
    modelCounts.set(candidate.label, (modelCounts.get(candidate.label) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    const label = (modelCounts.get(candidate.label) ?? 0) > 1
      ? `${candidate.label} · ${candidate.safeSourceLabel}`
      : candidate.label;
    options.push([candidate.key, label]);
  }

  const trimmedCurrent = currentModelKey.trim();
  if (trimmedCurrent && !options.some(([value]) => value === trimmedCurrent)) {
    const label = current?.model || trimmedCurrent.split(DAILY_REVIEW_MODEL_KEY_SEPARATOR).pop() || trimmedCurrent;
    const sourceLabel = current?.connectionSlug ? ` · ${current.connectionSlug}` : '';
    options.push([trimmedCurrent, `${label}${sourceLabel} · 当前不可用`]);
  }

  return options;
}

function dailyReviewCatalogEntries(
  connection: Pick<
    LlmConnection,
    'slug' | 'providerType' | 'defaultModel' | 'models' | 'modelSource' | 'modelsFetchedAt'
  >,
  savedModelIds: Iterable<SavedModelChoice | undefined | null>,
): ModelCatalogEntry[] {
  return filterUnsupportedCodexModels(
    connection.providerType,
    buildConnectionModelCatalogEntries({ connection, savedModelIds }),
  ).filter((entry) => entry.canUseAsChatDefault || entry.provenance.sources?.userChoice?.includes('daily_review_model'));
}

function selectableCatalogEntries(
  connection: Pick<
    LlmConnection,
    'slug' | 'providerType' | 'defaultModel' | 'models' | 'modelSource' | 'modelsFetchedAt'
  >,
  savedModelIds?: Iterable<string | undefined | null>,
): ModelCatalogEntry[] {
  const entries = filterUnsupportedCodexModels(
    connection.providerType,
    buildConnectionModelCatalogEntries({ connection, savedModelIds }),
  ).filter((entry) => entry.canUseAsChatDefault);
  if (entries.length > 0 || connection.providerType !== 'openai-codex') return entries;
  return filterUnsupportedCodexModels(
    connection.providerType,
    buildConnectionModelCatalogEntries({
      connection: {
        ...connection,
        defaultModel: '',
        models: undefined,
        modelSource: undefined,
        modelsFetchedAt: undefined,
      },
      savedModelIds,
    }),
  ).filter((entry) => entry.canUseAsChatDefault);
}

function filterUnsupportedCodexModels(providerType: ProviderType, entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  if (providerType !== 'openai-codex') return entries;
  return entries.filter((entry) => !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id.trim()));
}

function modelDisplayLabel(entry: Pick<ModelCatalogEntry, 'id' | 'displayName'>): string {
  return entry.displayName?.trim() || entry.id;
}

function dailyReviewModelDisplayLabel(
  entry: Pick<ModelCatalogEntry, 'id' | 'displayName' | 'canUseAsChatDefault'>,
): string {
  const label = modelDisplayLabel(entry);
  return entry.canUseAsChatDefault ? label : `${label} · 当前不可用`;
}

function isModelConsumerConnection(connection: Pick<LlmConnection, 'enabled' | 'providerType'>): boolean {
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType (legacy seed, or a connection persisted on a branch
  // that registers a provider this build doesn't know) → not a model consumer.
  // Mirrors `isFakeBackend` in connection-readiness.ts; without this guard the
  // `.backendKind` read below throws on load for an orphan connection.
  if (!connection.enabled || !defaults || defaults.backendKind !== 'ai-sdk') return false;
  if (
    defaults.authKind === 'oauth_token' &&
    connection.providerType !== 'claude-subscription' &&
    connection.providerType !== 'openai-codex'
  ) {
    return false;
  }
  return true;
}

function enabledProviderCounts(connections: readonly LlmConnection[]): Map<ProviderType, number> {
  const counts = new Map<ProviderType, number>();
  for (const connection of connections) {
    if (!isModelConsumerConnection(connection)) continue;
    counts.set(connection.providerType, (counts.get(connection.providerType) ?? 0) + 1);
  }
  return counts;
}

function safeConnectionLabel(
  providerType: ProviderType,
  connectionSlug: string,
  providerCounts: ReadonlyMap<ProviderType, number>,
): string {
  const label = PROVIDER_DEFAULTS[providerType].label;
  return (providerCounts.get(providerType) ?? 0) > 1 ? `${label} · ${connectionSlug}` : label;
}

function dailyReviewModelKey(connectionSlug: string, model: string): string {
  return `${connectionSlug}${DAILY_REVIEW_MODEL_KEY_SEPARATOR}${model}`;
}

function parseDailyReviewModelKey(value: string): { connectionSlug: string; model: string } | undefined {
  const trimmed = value.trim();
  const index = trimmed.indexOf(DAILY_REVIEW_MODEL_KEY_SEPARATOR);
  if (index <= 0) return undefined;
  const connectionSlug = trimmed.slice(0, index);
  const model = trimmed.slice(index + DAILY_REVIEW_MODEL_KEY_SEPARATOR.length);
  if (!connectionSlug || !model) return undefined;
  return { connectionSlug, model };
}
