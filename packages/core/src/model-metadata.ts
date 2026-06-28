import type { ProviderType } from './llm-connections.js';

export interface ModelMetadata {
  displayName?: string;
  lifecycle?: 'active' | 'deprecated' | 'retired';
  docsUrl?: string;
}

export function lookupModelMetadata(providerType: ProviderType, modelId: string): ModelMetadata {
  return MODELS_DEV_METADATA[providerType]?.[modelId.trim()] ?? {};
}

export function catalogFallbackModelsForProvider(providerType: ProviderType): readonly string[] | undefined {
  return CATALOG_FALLBACK_MODELS[providerType];
}

const ANTHROPIC_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
  'claude-opus-4-8': { displayName: 'Claude Opus 4.8', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
  'claude-fable-5': { displayName: 'Claude Fable 5', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
  'claude-sonnet-4-5': { displayName: 'Claude Sonnet 4.5 (latest)', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
  'claude-sonnet-4-5-20250929': { displayName: 'Claude Sonnet 4.5', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
  'claude-opus-4-1-20250805': { displayName: 'Claude Opus 4.1', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
  'claude-haiku-4-5': { displayName: 'Claude Haiku 4.5 (latest)', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
  'claude-haiku-4-5-20251001': { displayName: 'Claude Haiku 4.5', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
  'claude-3-5-sonnet-20241022': { displayName: 'Claude Sonnet 3.5 v2', lifecycle: 'deprecated', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
};

const GOOGLE_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'gemini-3.5-flash': { displayName: 'Gemini 3.5 Flash', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  'gemini-3.1-pro-preview': { displayName: 'Gemini 3.1 Pro Preview', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  'gemini-3.1-flash-lite': { displayName: 'Gemini 3.1 Flash Lite', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro Preview', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  'gemini-3-flash-preview': { displayName: 'Gemini 3 Flash Preview', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  'gemini-2.5-flash': { displayName: 'Gemini 2.5 Flash', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  'gemini-2.0-flash': { displayName: 'Gemini 2.0 Flash', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
};

// Curated from https://models.dev/api.json. Keep this small: the model catalog
// consumes only stable display names here, while request routing keeps raw ids.
const MODELS_DEV_METADATA: Partial<Record<ProviderType, Record<string, ModelMetadata>>> = {
  anthropic: ANTHROPIC_MODELS_DEV_METADATA,
  'claude-subscription': ANTHROPIC_MODELS_DEV_METADATA,
  openai: {
    'gpt-5.5': { displayName: 'GPT-5.5', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.5-pro': { displayName: 'GPT-5.5 Pro', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.4': { displayName: 'GPT-5.4', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.4-mini': { displayName: 'GPT-5.4 mini', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.3-codex-spark': { displayName: 'GPT-5.3 Codex Spark', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.3-codex': { displayName: 'GPT-5.3 Codex', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.2': { displayName: 'GPT-5.2', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.2-codex': { displayName: 'GPT-5.2 Codex', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.1-codex-mini': { displayName: 'GPT-5.1 Codex mini', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-4o-mini': { displayName: 'GPT-4o mini', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-4o': { displayName: 'GPT-4o', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-4-turbo': { displayName: 'GPT-4 Turbo', lifecycle: 'deprecated', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5': { displayName: 'GPT-5', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
  },
  google: GOOGLE_MODELS_DEV_METADATA,
  'gemini-cli': GOOGLE_MODELS_DEV_METADATA,
  'codex-subscription': {
    'gpt-5.5': { displayName: 'GPT-5.5', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.5-pro': { displayName: 'GPT-5.5 Pro', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.4': { displayName: 'GPT-5.4', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.4-mini': { displayName: 'GPT-5.4 mini', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
    'gpt-5.3-codex-spark': { displayName: 'GPT-5.3 Codex Spark', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models' },
  },
  deepseek: {
    'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash', lifecycle: 'active', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing' },
    'deepseek-v4-pro': { displayName: 'DeepSeek V4 Pro', lifecycle: 'active', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing' },
    'deepseek-reasoner': { displayName: 'DeepSeek Reasoner', lifecycle: 'deprecated', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing' },
    'deepseek-chat': { displayName: 'DeepSeek Chat', lifecycle: 'deprecated', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing' },
  },
  'zai-coding-plan': {
    'glm-5.2': { displayName: 'GLM-5.2', lifecycle: 'active', docsUrl: 'https://docs.z.ai' },
    'glm-5.1': { displayName: 'GLM-5.1', lifecycle: 'active', docsUrl: 'https://docs.z.ai' },
    'glm-5-turbo': { displayName: 'GLM-5-Turbo', lifecycle: 'active', docsUrl: 'https://docs.z.ai' },
    'glm-5v-turbo': { displayName: 'GLM-5V-Turbo', lifecycle: 'active', docsUrl: 'https://docs.z.ai' },
    'glm-4.7': { displayName: 'GLM-4.7', lifecycle: 'active', docsUrl: 'https://docs.z.ai' },
    'glm-4.5-air': { displayName: 'GLM-4.5-Air', lifecycle: 'deprecated', docsUrl: 'https://docs.z.ai' },
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
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-chat'],
  google: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'gemini-cli': ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'zai-coding-plan': ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'],
};
