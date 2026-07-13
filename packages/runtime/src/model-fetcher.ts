import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
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

  switch (definition.protocol) {
    case 'anthropic': {
      const r = await proxiedFetch(anthropicV1Url(baseUrl, '/models'), {
        headers: anthropicModelHeaders(discovery.auth, apiKey),
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { data?: RawProviderModel[] };
      return (data.data ?? []).map(toModelInfo).filter((model): model is ModelInfo => model !== null);
    }
    case 'openai': {
      const r = await proxiedFetch(modelListUrl(baseUrl, discovery.query), {
        headers: {
          'content-type': 'application/json',
          ...(definition.authKind === 'none' ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { data?: RawProviderModel[] } | RawProviderModel[];
      const models = discovery.responseShape === 'array-or-data'
        ? (Array.isArray(data) ? data : data.data ?? [])
        : (Array.isArray(data) ? [] : data.data ?? []);
      return models.map(toModelInfo).filter((model): model is ModelInfo => model !== null);
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

function modelListUrl(baseUrl: string, query: Readonly<Record<string, string>> | undefined): string {
  const url = `${stripTrailing(baseUrl)}/models`;
  const search = query ? new URLSearchParams(query).toString() : '';
  return search ? `${url}?${search}` : url;
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
