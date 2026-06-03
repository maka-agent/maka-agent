import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type LlmConnection,
  type ModelInfo,
} from '@maka/core/llm-connections';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { proxiedFetch } from './bots/proxied-fetch.js';
import { anthropicV1Url } from './subscription-auth.js';

const MODEL_FETCH_TIMEOUT_MS = 10_000;
const CLAUDE_SUBSCRIPTION_BETA =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219';
const CLAUDE_SUBSCRIPTION_USER_AGENT = 'claude-cli/2.1.88 (external, cli)';

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
      const data = await r.json() as { data?: Array<{ id?: string }> };
      return (data.data ?? []).flatMap((model) => model.id ? [{ id: model.id }] : []);
    }
    case 'openai': {
      const r = await proxiedFetch(`${stripTrailing(baseUrl)}/models`, {
        headers: {
          'content-type': 'application/json',
          ...(auth === 'none' ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { data?: Array<{ id?: string }> };
      return (data.data ?? []).flatMap((model) => model.id ? [{ id: model.id }] : []);
    }
    case 'google': {
      const r = await proxiedFetch(
        `${stripTrailing(baseUrl)}/v1beta/models?key=${encodeURIComponent(apiKey)}`,
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

function anthropicModelHeaders(connection: LlmConnection, apiKey: string): Record<string, string> {
  if (connection.providerType === 'claude-subscription') {
    return {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': CLAUDE_SUBSCRIPTION_USER_AGENT,
      'anthropic-beta': CLAUDE_SUBSCRIPTION_BETA,
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
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
