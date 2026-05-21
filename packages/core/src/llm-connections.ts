/**
 * LLM provider connection metadata.
 *
 * Connection records are stored on disk without secrets. API keys and OAuth
 * tokens live in the desktop credential store, keyed by connection slug.
 */

import type { BackendKind } from './session.js';

export type { BackendKind } from './session.js';

export type ProviderType =
  | 'anthropic'
  | 'kimi-coding-plan'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'moonshot'
  | 'zai-coding-plan'
  | 'ollama'
  | 'openai-compatible'
  | 'claude-subscription'
  | 'codex-subscription'
  | 'gemini-cli';

export type ProviderCategory = 'oauth' | 'domestic' | 'overseas' | 'local' | 'custom';

export type ConnectionAuth =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'oauth_token'; oauthToken: string; expiresAt?: number }
  | { kind: 'none' };

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: {
    vision?: boolean;
    reasoning?: boolean;
    functionCalling?: boolean;
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
  category: ProviderCategory;
  catalogBadge?: string;
  signupUrl?: string;
}

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
      'claude-3-5-sonnet-20241022',
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
    baseUrl: 'https://api.moonshot.cn/anthropic',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['kimi-for-coding'],
    status: 'ready',
    protocol: 'anthropic',
    category: 'domestic',
    catalogBadge: 'Coding',
    signupUrl: 'https://platform.moonshot.cn/console/api-keys',
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
    baseUrl: 'https://generativelanguage.googleapis.com',
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
    signupUrl: 'https://platform.moonshot.cn/console/api-keys',
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
    description: 'Claude app subscription via official SDK in a future phase.',
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
    catalogBadge: 'Soon',
  },
  'codex-subscription': {
    label: 'Codex Subscription (ChatGPT OAuth)',
    description: 'ChatGPT/Codex subscription via official CLI in a future phase.',
    baseUrl: '',
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: ['gpt-5-codex'],
    status: 'phase3-experimental',
    protocol: 'openai',
    category: 'oauth',
    catalogBadge: 'Soon',
  },
  'gemini-cli': {
    label: 'Gemini CLI OAuth',
    description: 'Google account access through gemini CLI in a future phase.',
    baseUrl: '',
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    status: 'phase3-experimental',
    protocol: 'google',
    category: 'oauth',
    catalogBadge: 'Soon',
  },
};

export const READY_PROVIDER_TYPES: ProviderType[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'moonshot',
  'zai-coding-plan',
  'ollama',
  'kimi-coding-plan',
  'openai-compatible',
];

export const CATALOG_PROVIDER_TYPES: ProviderType[] = [
  'claude-subscription',
  'codex-subscription',
  'gemini-cli',
  'kimi-coding-plan',
  'deepseek',
  'moonshot',
  'zai-coding-plan',
  'anthropic',
  'openai',
  'google',
  'ollama',
  'openai-compatible',
];

export function backendKindOf(c: Pick<LlmConnection, 'providerType'>): BackendKind {
  return PROVIDER_DEFAULTS[c.providerType].backendKind;
}

export function effectiveBaseUrl(c: Pick<LlmConnection, 'providerType' | 'baseUrl'>): string {
  if (c.baseUrl && c.baseUrl.trim()) return c.baseUrl.trim();
  return PROVIDER_DEFAULTS[c.providerType].baseUrl;
}

export function validateSlug(slug: string): string | null {
  if (!slug.trim()) return 'Slug is required';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return 'Slug must be lowercase letters, digits, and hyphens';
  }
  if (slug.length > 64) return 'Slug must be 64 characters or fewer';
  return null;
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
