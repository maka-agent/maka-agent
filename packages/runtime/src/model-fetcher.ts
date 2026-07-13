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
  const auth = PROVIDER_DEFAULTS[connection.providerType].authKind;
  if (connection.providerType === 'codex-subscription') {
    return PROVIDER_DEFAULTS['codex-subscription'].fallbackModels.map((id) => ({ id }));
  }
  if (connection.providerType === 'ollama') {
    const r = await proxiedFetch(`${ollamaRoot(baseUrl)}/api/tags`, { timeoutMs: MODEL_FETCH_TIMEOUT_MS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as { models?: Array<{ name?: string }> };
    return (data.models ?? []).flatMap((model) => model.name ? [{ id: model.name }] : []);
  }

  switch (PROVIDER_DEFAULTS[connection.providerType].protocol) {
    case 'anthropic': {
      const r = await proxiedFetch(anthropicV1Url(baseUrl, '/models'), {
        headers: anthropicModelHeaders(connection, apiKey),
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { data?: RawProviderModel[] };
      return (data.data ?? []).map(toModelInfo).filter((model): model is ModelInfo => model !== null);
    }
    case 'openai': {
      const r = await proxiedFetch(openAiModelListUrl(connection, baseUrl), {
        headers: {
          'content-type': 'application/json',
          ...(auth === 'none' ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { data?: RawProviderModel[] };
      return (data.data ?? []).map(toModelInfo).filter((model): model is ModelInfo => model !== null);
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

function openAiModelListUrl(connection: LlmConnection, baseUrl: string): string {
  const url = `${stripTrailing(baseUrl)}/models`;
  return connection.providerType === 'siliconflow' ? `${url}?sub_type=chat` : url;
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

function anthropicModelHeaders(connection: LlmConnection, apiKey: string): Record<string, string> {
  if (connection.providerType === 'claude-subscription') {
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
