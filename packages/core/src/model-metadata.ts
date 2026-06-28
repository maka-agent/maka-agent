import type { ProviderType } from './llm-connections.js';

export interface ModelMetadata {
  displayName?: string;
}

export function lookupModelMetadata(providerType: ProviderType, modelId: string): ModelMetadata {
  return MODELS_DEV_METADATA[providerType]?.[modelId.trim()] ?? {};
}

export function catalogFallbackModelsForProvider(providerType: ProviderType): readonly string[] | undefined {
  return CATALOG_FALLBACK_MODELS[providerType];
}

const ANTHROPIC_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6' },
  'claude-opus-4-8': { displayName: 'Claude Opus 4.8' },
  'claude-fable-5': { displayName: 'Claude Fable 5' },
  'claude-sonnet-4-5': { displayName: 'Claude Sonnet 4.5 (latest)' },
  'claude-sonnet-4-5-20250929': { displayName: 'Claude Sonnet 4.5' },
  'claude-opus-4-1-20250805': { displayName: 'Claude Opus 4.1' },
  'claude-haiku-4-5': { displayName: 'Claude Haiku 4.5 (latest)' },
  'claude-haiku-4-5-20251001': { displayName: 'Claude Haiku 4.5' },
  'claude-3-5-sonnet-20241022': { displayName: 'Claude Sonnet 3.5 v2' },
};

const GOOGLE_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'gemini-3.5-flash': { displayName: 'Gemini 3.5 Flash' },
  'gemini-3.1-pro-preview': { displayName: 'Gemini 3.1 Pro Preview' },
  'gemini-3.1-flash-lite': { displayName: 'Gemini 3.1 Flash Lite' },
  'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro Preview' },
  'gemini-3-flash-preview': { displayName: 'Gemini 3 Flash Preview' },
  'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro' },
  'gemini-2.5-flash': { displayName: 'Gemini 2.5 Flash' },
  'gemini-2.0-flash': { displayName: 'Gemini 2.0 Flash' },
};

// Curated from https://models.dev/api.json. Keep this small: the model catalog
// consumes only stable display names here, while request routing keeps raw ids.
const MODELS_DEV_METADATA: Partial<Record<ProviderType, Record<string, ModelMetadata>>> = {
  anthropic: ANTHROPIC_MODELS_DEV_METADATA,
  'claude-subscription': ANTHROPIC_MODELS_DEV_METADATA,
  openai: {
    'gpt-5.5': { displayName: 'GPT-5.5' },
    'gpt-5.5-pro': { displayName: 'GPT-5.5 Pro' },
    'gpt-5.4': { displayName: 'GPT-5.4' },
    'gpt-5.4-mini': { displayName: 'GPT-5.4 mini' },
    'gpt-5.3-codex-spark': { displayName: 'GPT-5.3 Codex Spark' },
    'gpt-5.3-codex': { displayName: 'GPT-5.3 Codex' },
    'gpt-5.2': { displayName: 'GPT-5.2' },
    'gpt-5.2-codex': { displayName: 'GPT-5.2 Codex' },
    'gpt-5.1-codex-mini': { displayName: 'GPT-5.1 Codex mini' },
    'gpt-4o-mini': { displayName: 'GPT-4o mini' },
    'gpt-4o': { displayName: 'GPT-4o' },
    'gpt-4-turbo': { displayName: 'GPT-4 Turbo' },
    'gpt-5': { displayName: 'GPT-5' },
  },
  google: GOOGLE_MODELS_DEV_METADATA,
  'gemini-cli': GOOGLE_MODELS_DEV_METADATA,
  'codex-subscription': {
    'gpt-5.5': { displayName: 'GPT-5.5' },
    'gpt-5.5-pro': { displayName: 'GPT-5.5 Pro' },
    'gpt-5.4': { displayName: 'GPT-5.4' },
    'gpt-5.4-mini': { displayName: 'GPT-5.4 mini' },
    'gpt-5.3-codex-spark': { displayName: 'GPT-5.3 Codex Spark' },
  },
  deepseek: {
    'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash' },
    'deepseek-v4-pro': { displayName: 'DeepSeek V4 Pro' },
    'deepseek-reasoner': { displayName: 'DeepSeek Reasoner' },
    'deepseek-chat': { displayName: 'DeepSeek Chat' },
  },
  'zai-coding-plan': {
    'glm-5.2': { displayName: 'GLM-5.2' },
    'glm-5.1': { displayName: 'GLM-5.1' },
    'glm-5-turbo': { displayName: 'GLM-5-Turbo' },
    'glm-5v-turbo': { displayName: 'GLM-5V-Turbo' },
    'glm-4.7': { displayName: 'GLM-4.7' },
    'glm-4.5-air': { displayName: 'GLM-4.5-Air' },
  },
};

const CATALOG_FALLBACK_MODELS: Partial<Record<ProviderType, readonly string[]>> = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-1-20250805',
  ],
  'claude-subscription': [
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-haiku-4-5',
    'claude-sonnet-4-5-20250929',
  ],
  openai: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5'],
  google: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'gemini-cli': ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'zai-coding-plan': ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'],
};
