import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  providerAuthSupportsApiKey,
  type LlmConnection,
  type ModelInfo,
} from '@maka/core/llm-connections';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { proxiedFetch } from './bots/proxied-fetch.js';
import { anthropicV1Url, googleApiUrl } from './provider-urls.js';
import { claudeSubscriptionHeaders } from './subscription-auth.js';

const MODEL_FETCH_TIMEOUT_MS = 10_000;

type RawProviderModel = {
  id?: string;
  supports_image_in?: boolean;
  supports_reasoning?: boolean;
  context_length?: number;
};

type RawFireworksModel = {
  name?: string;
  displayName?: string;
  contextLength?: number;
  supportsImageInput?: boolean;
  supportsTools?: boolean;
};

type FireworksModelDiscovery = Extract<
  (typeof PROVIDER_DEFAULTS)[keyof typeof PROVIDER_DEFAULTS]['modelDiscovery'],
  { kind: 'fireworks' }
>;

export async function fetchProviderModels(
  connection: LlmConnection,
  apiKey: string,
): Promise<ModelInfo[]> {
  try {
    return await fetchProviderModelsStrict(connection, apiKey);
  } catch (error) {
    throw new Error(generalizedErrorMessage(error, 'Failed to fetch provider models'));
  }
}

async function fetchProviderModelsStrict(
  connection: LlmConnection,
  apiKey: string,
): Promise<ModelInfo[]> {
  const baseUrl = effectiveBaseUrl(connection);
  const definition = PROVIDER_DEFAULTS[connection.providerType];
  const discovery = definition.modelDiscovery;

  if (discovery.kind === 'fallback') {
    return definition.fallbackModels.map((id) => ({ id }));
  }
  if (discovery.kind === 'ollama') {
    const r = await proxiedFetch(`${ollamaRoot(baseUrl)}/api/tags`, { timeoutMs: MODEL_FETCH_TIMEOUT_MS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as { models?: Array<{ name?: string }> };
    return (data.models ?? []).flatMap((model) => model.name ? [{ id: model.name }] : []);
  }
  if (discovery.kind === 'fireworks') {
    return fetchFireworksModels(baseUrl, apiKey, discovery);
  }

  switch (definition.protocol) {
    case 'anthropic': {
      const r = await proxiedFetch(anthropicV1Url(baseUrl, '/models'), {
        headers: anthropicModelHeaders(discovery.auth, apiKey),
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { data?: RawProviderModel[] };
      const models = (data.data ?? []).map(toModelInfo).filter((model): model is ModelInfo => model !== null);
      return filterDiscoveredModels(models, discovery.filter, definition.fallbackModels);
    }
    case 'openai': {
      const r = await proxiedFetch(modelListUrl(baseUrl, discovery.query), {
        headers: {
          'content-type': 'application/json',
          ...(apiKey && providerAuthSupportsApiKey(connection.providerType)
            ? { authorization: `Bearer ${apiKey}` }
            : {}),
        },
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { data?: RawProviderModel[] } | RawProviderModel[];
      const rawModels = discovery.responseShape === 'array-or-data'
        ? (Array.isArray(data) ? data : data.data ?? [])
        : (Array.isArray(data) ? [] : data.data ?? []);
      const models = rawModels.map(toModelInfo).filter((model): model is ModelInfo => model !== null);
      return filterDiscoveredModels(models, discovery.filter, definition.fallbackModels);
    }
    case 'google': {
      const r = await proxiedFetch(
        googleApiUrl(baseUrl, '/models', apiKey),
        { timeoutMs: MODEL_FETCH_TIMEOUT_MS },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { models?: Array<{ name?: string }> };
      return (data.models ?? []).flatMap((model) => {
        const id = model.name?.split('/').pop();
        return id ? [{ id }] : [];
      });
    }
  }
}

function filterDiscoveredModels(
  models: ModelInfo[],
  filter: 'fallback-models' | undefined,
  fallbackModels: readonly string[],
): ModelInfo[] {
  if (filter !== 'fallback-models') return models;
  const supported = new Set(fallbackModels);
  return models.filter((model) => supported.has(model.id));
}

function modelListUrl(baseUrl: string, query: Readonly<Record<string, string>> | undefined): string {
  const url = `${stripTrailing(baseUrl)}/models`;
  const search = query ? new URLSearchParams(query).toString() : '';
  return search ? `${url}?${search}` : url;
}

async function fetchFireworksModels(
  baseUrl: string,
  apiKey: string,
  discovery: FireworksModelDiscovery,
): Promise<ModelInfo[]> {
  const root = stripTrailing(baseUrl).replace(/\/inference\/v1$/, '');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const fetchPages = async <T>(
    path: string,
    query: Readonly<Record<string, string>>,
    itemKey: 'accounts' | 'models',
  ): Promise<T[]> => {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      const search = new URLSearchParams(query);
      if (pageToken) search.set('pageToken', pageToken);
      const response = await proxiedFetch(
        `${root}${path}?${search.toString()}`,
        { headers, timeoutMs: MODEL_FETCH_TIMEOUT_MS },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as {
        accounts?: T[];
        models?: T[];
        nextPageToken?: string;
      };
      items.push(...(data[itemKey] ?? []));
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
    return items;
  };

  const accounts = await fetchPages<{ name?: string }>(
    discovery.accountsPath,
    { pageSize: '200' },
    'accounts',
  );
  const accountNames = [
    ...accounts.flatMap((account) => (
      account.name && /^accounts\/[^/]+$/.test(account.name) ? [account.name] : []
    )),
    discovery.publicAccount,
  ].filter((name, index, names) => names.indexOf(name) === index);
  const modelLists = await Promise.all(accountNames.map((accountName) => (
    fetchPages<RawFireworksModel>(`/v1/${accountName}/models`, discovery.query, 'models')
  )));

  return modelLists.flat().flatMap((model) => {
    if (!model.name) return [];
    const capabilities: NonNullable<ModelInfo['capabilities']> = {};
    if (typeof model.supportsImageInput === 'boolean') capabilities.vision = model.supportsImageInput;
    if (typeof model.supportsTools === 'boolean') capabilities.functionCalling = model.supportsTools;
    return [{
      id: model.name,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      ...(typeof model.contextLength === 'number' ? { contextWindow: model.contextLength } : {}),
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
    }];
  });
}

function toModelInfo(model: RawProviderModel): ModelInfo | null {
  if (!model.id) return null;
  const capabilities: NonNullable<ModelInfo['capabilities']> = {};
  if (typeof model.supports_image_in === 'boolean') capabilities.vision = model.supports_image_in;
  if (typeof model.supports_reasoning === 'boolean') capabilities.reasoning = model.supports_reasoning;
  return {
    id: model.id,
    ...(typeof model.context_length === 'number' ? { contextWindow: model.context_length } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
  };
}

function anthropicModelHeaders(auth: 'claude-subscription' | undefined, apiKey: string): Record<string, string> {
  if (auth === 'claude-subscription') {
    return {
      ...claudeSubscriptionHeaders(),
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

function stripTrailing(u: string): string {
  return u.replace(/\/+$/, '');
}

function ollamaRoot(baseUrl: string): string {
  return stripTrailing(baseUrl).replace(/\/v1$/, '');
}
