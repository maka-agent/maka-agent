/**
 * LLM provider connection metadata.
 *
 * Connection records are stored on disk without secrets. API keys and OAuth
 * tokens live in the desktop credential store, keyed by connection slug.
 */

import type { BackendKind } from './session.js';
import { SILICONFLOW_PROVIDER_DEFAULTS } from './provider-registry.js';

export type { BackendKind } from './session.js';

export type ProviderType =
  | 'anthropic'
  | 'kimi-coding-plan'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'moonshot'
  | 'zai-coding-plan'
  | 'MiniMax'
  | 'MiniMax-cn'
  | 'siliconflow'
  | 'litellm'
  | 'ollama'
  | 'openai-compatible'
  | 'claude-subscription'
  | 'codex-subscription'
  | 'gemini-cli';

export type ProviderCategory = 'oauth' | 'domestic' | 'overseas' | 'local' | 'custom';
export type ProviderCatalogGroup = 'recommended' | 'plans' | 'api' | 'aggregators' | 'local';
export type ProviderRuntimeAdapter = 'anthropic' | 'openai' | 'openai-compatible' | 'google';

export type ConnectionAuth =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'oauth_token'; oauthToken: string; expiresAt?: number }
  | { kind: 'none' };

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: {
    chat?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    functionCalling?: boolean;
    imageGeneration?: boolean;
  };
}

export type ModelDiscoverySource = 'fetched' | 'fallback';

export interface ModelDiscoveryResult {
  models: ModelInfo[];
  source: ModelDiscoverySource;
  /** Unix ms timestamp when this list was produced. */
  fetchedAt: number;
}

export type ConnectionLastTestStatus = 'verified' | 'needs_reauth' | 'error';

export interface LlmConnection {
  slug: string;
  name: string;
  providerType: ProviderType;
  baseUrl?: string;
  defaultModel: string;
  enabled: boolean;
  models?: ModelInfo[];
  modelSource?: ModelDiscoverySource;
  /** Unix ms timestamp for the last successful model discovery result. */
  modelsFetchedAt?: number;
  lastTestStatus?: ConnectionLastTestStatus;
  /** ISO timestamp of the last explicit connection test. */
  lastTestAt?: string;
  /** Generalized status message; never persist raw provider responses or secrets. */
  lastTestMessage?: string;
  createdAt: number;
  updatedAt: number;
  extras?: Record<string, unknown>;
}

export type ConnectionTestErrorClass =
  | 'auth'
  | 'timeout'
  | 'provider_unavailable'
  | 'network'
  | 'unknown';

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  modelTested?: string;
  errorMessage?: string;
  statusCode?: number;
  errorClass?: ConnectionTestErrorClass;
}

export interface ProviderDefaults {
  label: string;
  description: string;
  baseUrl: string;
  authKind: ConnectionAuth['kind'];
  backendKind: BackendKind;
  fallbackModels: string[];
  status: 'ready' | 'phase3-experimental';
  protocol: 'anthropic' | 'openai' | 'google';
  runtimeAdapter?: ProviderRuntimeAdapter;
  category: ProviderCategory;
  catalogGroup?: ProviderCatalogGroup;
  catalogBadge?: string;
  signupUrl?: string;
  modelsDevId?: string;
}

export const CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS = new Set([
  'gpt-5-codex',
]);

export const PROVIDER_DEFAULTS: Record<ProviderType, ProviderDefaults> = {
  anthropic: {
    label: 'Anthropic',
    description: 'Claude API key access for production agents.',
    baseUrl: 'https://api.anthropic.com',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-1-20250805',
      'claude-haiku-4-5-20251001',
      'claude-3-5-haiku-20241022',
    ],
    status: 'ready',
    protocol: 'anthropic',
    category: 'overseas',
    catalogBadge: 'API',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
  'kimi-coding-plan': {
    label: 'Kimi Coding Plan',
    description: 'Kimi for Coding over Anthropic-compatible protocol.',
    baseUrl: 'https://api.kimi.com/coding/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['kimi-for-coding'],
    status: 'ready',
    protocol: 'anthropic',
    category: 'domestic',
    catalogBadge: 'Coding',
    signupUrl: 'https://www.kimi.com/code/console',
  },
  openai: {
    label: 'OpenAI',
    description: 'GPT API key access, including Responses API models.',
    baseUrl: 'https://api.openai.com/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-5'],
    status: 'ready',
    protocol: 'openai',
    category: 'overseas',
    catalogBadge: 'API',
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  google: {
    label: 'Google Gemini',
    description: 'Gemini API key access from Google AI Studio.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    status: 'ready',
    protocol: 'google',
    category: 'overseas',
    catalogBadge: 'API',
    signupUrl: 'https://aistudio.google.com/app/apikey',
  },
  deepseek: {
    label: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models.',
    baseUrl: 'https://api.deepseek.com',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['deepseek-chat', 'deepseek-reasoner'],
    status: 'ready',
    protocol: 'openai',
    category: 'domestic',
    catalogBadge: 'API',
    signupUrl: 'https://platform.deepseek.com/api_keys',
  },
  moonshot: {
    label: 'Moonshot',
    description: 'Moonshot Kimi API key access.',
    baseUrl: 'https://api.moonshot.cn/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    status: 'ready',
    protocol: 'openai',
    category: 'domestic',
    catalogBadge: 'API',
    signupUrl: 'https://platform.kimi.com/console/api-keys',
  },
  'zai-coding-plan': {
    label: 'Z.AI Coding Plan',
    description: 'GLM coding plan over OpenAI-compatible protocol.',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['glm-4.7', 'glm-4.6', 'glm-4.5-air'],
    status: 'ready',
    protocol: 'openai',
    category: 'domestic',
    catalogBadge: 'Coding',
    signupUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  MiniMax: {
    label: 'MiniMax',
    description: 'MiniMax M-series over Anthropic-compatible protocol.',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['MiniMax-M3'],
    status: 'ready',
    protocol: 'anthropic',
    category: 'overseas',
    catalogBadge: 'API',
    signupUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  'MiniMax-cn': {
    label: 'MiniMax 中国站',
    description: 'MiniMax M-series (China) over Anthropic-compatible protocol.',
    baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['MiniMax-M3'],
    status: 'ready',
    protocol: 'anthropic',
    category: 'domestic',
    catalogBadge: 'API',
    signupUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  siliconflow: SILICONFLOW_PROVIDER_DEFAULTS,
  litellm: {
    label: 'LiteLLM',
    description: 'AI gateway proxy for 100+ LLM providers.',
    baseUrl: 'http://localhost:4000/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [],
    status: 'ready',
    protocol: 'openai',
    category: 'custom',
    catalogBadge: 'Gateway',
    signupUrl: 'https://docs.litellm.ai/',
  },
  ollama: {
    label: 'Ollama',
    description: 'Local models from Ollama on localhost.',
    baseUrl: 'http://localhost:11434/v1',
    authKind: 'none',
    backendKind: 'ai-sdk',
    fallbackModels: ['llama3.2', 'qwen2.5-coder', 'gemma3'],
    status: 'ready',
    protocol: 'openai',
    category: 'local',
    catalogBadge: 'Local',
  },
  'openai-compatible': {
    label: 'OpenAI-compatible (custom)',
    description: 'Custom OpenAI-compatible endpoint or gateway.',
    baseUrl: '',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [],
    status: 'ready',
    protocol: 'openai',
    category: 'custom',
    catalogBadge: 'Custom',
  },
  'claude-subscription': {
    label: 'Claude Subscription (Pro / Max OAuth)',
    description: 'Claude app subscription auth path, hidden behind the internal experimental gate.',
    baseUrl: 'https://api.anthropic.com',
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-1-20250805',
      'claude-haiku-4-5-20251001',
    ],
    status: 'phase3-experimental',
    protocol: 'anthropic',
    category: 'oauth',
    catalogBadge: 'Experimental',
  },
  'codex-subscription': {
    label: 'OpenAI OAuth (ChatGPT / Codex)',
    description: 'ChatGPT/Codex account OAuth path for OpenAI Responses models.',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
    status: 'phase3-experimental',
    protocol: 'openai',
    category: 'oauth',
    catalogBadge: 'Account',
  },
  'gemini-cli': {
    label: 'Gemini CLI OAuth',
    description: 'Google account path is tracked separately from ready API-key providers.',
    baseUrl: '',
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    status: 'phase3-experimental',
    protocol: 'google',
    category: 'oauth',
    catalogBadge: 'Account',
  },
};

export const READY_PROVIDER_TYPES: ProviderType[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'moonshot',
  'zai-coding-plan',
  'MiniMax',
  'MiniMax-cn',
  'siliconflow',
  'ollama',
  'kimi-coding-plan',
  'openai-compatible',
];

export const CATALOG_PROVIDER_TYPES: ProviderType[] = [
  'kimi-coding-plan',
  'deepseek',
  'moonshot',
  'zai-coding-plan',
  'MiniMax',
  'MiniMax-cn',
  'siliconflow',
  'anthropic',
  'openai',
  'google',
  'ollama',
  'litellm',
  'openai-compatible',
];

export function backendKindOf(c: Pick<LlmConnection, 'providerType'>): BackendKind {
  return PROVIDER_DEFAULTS[c.providerType].backendKind;
}

export function effectiveBaseUrl(c: Pick<LlmConnection, 'providerType' | 'baseUrl'>): string {
  if (c.baseUrl && c.baseUrl.trim()) return c.baseUrl.trim();
  return PROVIDER_DEFAULTS[c.providerType].baseUrl;
}

/**
 * Reduce a submitted connection `baseUrl` to the value that should be persisted,
 * or `undefined` if nothing should be stored.
 *
 * The add-form and edit-form pre-fill `defaults.baseUrl` and submit it verbatim
 * when the user does not customize the field. Storing that default as an
 * explicit override would pin the connection to the current default —
 * `effectiveBaseUrl` honors the explicit value first, so future default changes
 * would not reach it. Only a real override (non-empty and differing from the
 * current default) is persisted; the empty/whitespace and equals-default cases
 * collapse to `undefined` so the connection reads back through the live default.
 */
export function persistedBaseUrl(
  providerType: ProviderType,
  baseUrl: string | undefined | null,
): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  if (trimmed === PROVIDER_DEFAULTS[providerType].baseUrl) return undefined;
  return trimmed;
}

export function validateSlug(slug: string): string | null {
  if (!slug.trim()) return 'Slug is required';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return 'Slug must be lowercase letters, digits, and hyphens';
  }
  if (slug.length > 64) return 'Slug must be 64 characters or fewer';
  return null;
}

/**
 * PR-UI-IPC-1 (@kenji msg 35260e29 + 2e495eb7): connection `baseUrl`
 * scheme allowlist gate.
 *
 * The renderer can submit any string for `CreateConnectionInput.baseUrl`
 * / `UpdateConnectionInput.baseUrl`; the AI SDK fetch downstream
 * normally rejects non-HTTP schemes, but the IPC boundary should
 * not depend on that. A successful persist of a bogus baseUrl
 * (`javascript:`, `file:///etc/passwd`, garbage) means the bad URL
 * lives on disk and could later be loaded into an HTTP client
 * configured to honor it (or worse, leak the user's API key to an
 * attacker-controlled scheme handler).
 *
 * This is a credentials-exfiltration boundary, not a usability gate
 * — we intentionally do NOT block private-network / localhost URLs
 * (Ollama, LM Studio, vLLM and other local providers need
 * `http://localhost:11434`, `http://127.0.0.1:8000`, etc. to work).
 * Provider/setupMode-specific further restrictions are a separate
 * future PR.
 *
 * **Pair with `normalizeConnectionBaseUrl` for the IPC site.**
 * This function only validates; it does NOT trim or canonicalize.
 * The IPC handler should use `normalizeConnectionBaseUrl` so the
 * store only ever sees the canonical form (trimmed URL or
 * undefined) — not raw whitespace-padded input. See @kenji msg
 * 8755ffb3.
 *
 * Accepts:
 *   - `undefined` / empty string / whitespace-only: no override,
 *     fall back to provider default. Returns `null` (valid). The
 *     caller treats this as "user wants the provider's canonical
 *     baseUrl".
 *   - `http:` / `https:` schemes parsing as valid `URL` (case-
 *     insensitive scheme via WHATWG URL spec).
 *
 * Rejects (returns error message):
 *   - Any other scheme (`file:`, `javascript:`, `data:`, `vbscript:`,
 *     `chrome-extension:`, `app:`, `maka:`, custom).
 *   - Malformed URL strings the `URL` constructor throws on.
 *   - Pathological lengths (> 2048 chars — defense against
 *     adversarial inputs; real-world baseUrls are < 100 chars).
 *
 * Returns `null` on accept, an error string on reject. Mirrors
 * `validateSlug`'s shape.
 */
export function validateConnectionBaseUrl(baseUrl: string | undefined | null): string | null {
  // No baseUrl override is valid — the caller falls back to the
  // provider default.
  if (baseUrl === undefined || baseUrl === null) return null;
  const trimmed = baseUrl.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 2048) {
    return 'baseUrl must be 2048 characters or fewer';
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'baseUrl must be a valid URL';
  }
  // Closed scheme allowlist. `URL.protocol` includes the trailing
  // colon and is lowercased by the WHATWG URL spec for special
  // schemes.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `baseUrl scheme '${parsed.protocol}' is not allowed (use http: or https:)`;
  }
  return null;
}

/**
 * PR-UI-IPC-1 review fixup v2 (@kenji msg 8755ffb3 + 6b638e08):
 * IPC-site chokepoint that BOTH validates AND normalizes `baseUrl`.
 * Replaces the raw-input passthrough that the validate-only path
 * allowed.
 *
 * The blocker the original v1 had:
 *   - `validateConnectionBaseUrl('   ')` returned `null` ("valid"),
 *     but the IPC handler then passed the raw `'   '` to the store,
 *     which on `update` treats truthy string as set-override and
 *     could persist whitespace.
 *   - `validateConnectionBaseUrl('  https://api.openai.com  ')`
 *     returned `null`, but the store persisted the whitespace-
 *     padded raw string.
 *
 * Caller contract:
 *
 * The caller calls this helper ONLY when it has a string value
 * (the IPC handler already decides whether `baseUrl` is in the
 * patch at all; absent / undefined means "don't touch" for
 * update, "use provider default" for create — neither needs
 * validation).
 *
 * Return shape:
 *   - `{ ok: false, error }` — bad scheme / malformed / oversize.
 *   - `{ ok: true, value: '<trimmed URL>' }` — accepted override.
 *     Caller sets the store payload's `baseUrl` to this value.
 *   - `{ ok: true, value: '' }` — EXPLICIT CLEAR INTENT (user
 *     typed whitespace meaning "remove my override"). Caller must
 *     preserve this as `''` so the store's existing clear semantics
 *     (`patch.baseUrl !== undefined ? patch.baseUrl || undefined :
 *     current.baseUrl`) treat it as "clear existing override". DO
 *     NOT convert to `undefined` — that would be "don't touch" and
 *     silently swallow the user's clear intent.
 *
 * The trim is the only canonicalization performed. We deliberately
 * do NOT change scheme/host case, strip default ports, drop
 * fragments, etc. — that's a different normalization (URL
 * canonicalization) and could surprise users who deliberately
 * configured `https://Example.com:443/V1`. Trim is the minimum
 * needed to prevent whitespace from becoming a stored override.
 */
export function normalizeConnectionBaseUrl(
  baseUrl: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  // PR-UI-IPC-1 review fixup v3 (@kenji msg 57ac8a8c): defensive
  // runtime-type guard. TypeScript signature `(input: string)` is
  // a compile-time guarantee, but IPC payloads from the renderer
  // arrive over a process boundary and could be `null` / number /
  // object / array regardless. Without this guard, `baseUrl.trim()`
  // would throw TypeError on non-string and the IPC handler would
  // surface an opaque crash instead of the typed reject the gate
  // promises.
  if (typeof baseUrl !== 'string') {
    return { ok: false, error: 'baseUrl must be a string' };
  }
  // Validate first so bad schemes / malformed / oversize reject
  // before we report a normalized value.
  const error = validateConnectionBaseUrl(baseUrl);
  if (error !== null) {
    return { ok: false, error };
  }
  // Validate accepted. Trim is the only canonicalization. An empty
  // trimmed value is the explicit-clear intent (user typed
  // whitespace = "remove my override"); preserve it as `''` so the
  // store's existing clear semantics fire. The caller must NOT
  // convert this to `undefined` — see contract note above.
  return { ok: true, value: baseUrl.trim() };
}

export interface CreateConnectionInput {
  slug: string;
  name: string;
  providerType: ProviderType;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
}

export interface UpdateConnectionInput {
  name?: string;
  baseUrl?: string;
  defaultModel?: string;
  enabled?: boolean;
  apiKey?: string;
  models?: ModelInfo[];
  modelSource?: ModelDiscoverySource;
  modelsFetchedAt?: number;
  lastTestStatus?: ConnectionLastTestStatus;
  lastTestAt?: string;
  lastTestMessage?: string;
}

export function migrateConnectionV1ToV2(old: unknown): LlmConnection {
  const value = old as Partial<LlmConnection> & {
    backend?: string;
    authType?: string;
    slug?: string;
    name?: string;
    defaultModel?: string;
    baseUrl?: string;
    createdAt?: number;
  };
  if (value.providerType) return value as LlmConnection;
  if (!value.slug) throw new Error('Cannot migrate connection without slug');

  const now = Date.now();
  if (value.backend === 'claude' && value.authType === 'oauth_token') {
    return {
      slug: value.slug,
      name: value.name ?? value.slug,
      providerType: 'claude-subscription',
      ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}),
      defaultModel: value.defaultModel || 'claude-sonnet-4-5-20250929',
      enabled: false,
      createdAt: value.createdAt ?? now,
      updatedAt: now,
    };
  }

  if (value.backend === 'claude' || value.backend === undefined) {
    return {
      slug: value.slug,
      name: value.name ?? value.slug,
      providerType: 'anthropic',
      ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}),
      defaultModel: value.defaultModel || 'claude-sonnet-4-5-20250929',
      enabled: true,
      createdAt: value.createdAt ?? now,
      updatedAt: now,
    };
  }

  throw new Error(`Cannot migrate connection ${value.slug} with backend=${value.backend}`);
}
