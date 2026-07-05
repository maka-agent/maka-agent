import type { ModelInfo, ProviderType } from './llm-connections.js';
import type { ThinkingOptions } from './model-thinking.js';

export interface ModelMetadata {
  displayName?: string;
  lifecycle?: 'active' | 'deprecated' | 'retired';
  docsUrl?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: ModelInfo['capabilities'];
  /**
   * Per-model reasoning controls, mirroring models.dev `reasoning_options`.
   * Omitted on models with no declarable thinking knob (miss → no menu).
   */
  thinkingOptions?: ThinkingOptions;
}

export function lookupModelMetadata(providerType: ProviderType, modelId: string): ModelMetadata {
  return MODELS_DEV_METADATA[providerType]?.[modelId.trim()] ?? {};
}

/**
 * Resolve whether a model accepts image input for the send path.
 *
 * Stored `connection.models` win when they declare `vision` explicitly
 * (provider-fetched facts). But `model-fetcher` stores bare `{ id }` entries
 * for many providers, and older connections predate any enrichment — so when
 * `vision` is unknown we fall back to the in-repo metadata, which is the only
 * authoritative source for image capability (provider /models APIs do not
 * return it). Unknown (no stored value, no metadata entry) resolves to false,
 * keeping the send path fail-closed for text-only models.
 */
export function resolveModelVisionSupport(
  providerType: ProviderType,
  models: readonly ModelInfo[] | undefined,
  modelId: string,
): boolean {
  const stored = models?.find((entry) => entry.id === modelId);
  if (stored?.capabilities?.vision !== undefined) {
    return stored.capabilities.vision === true;
  }
  return lookupModelMetadata(providerType, modelId).capabilities?.vision === true;
}

export function curatedCatalogFallbackModelsForProvider(providerType: ProviderType): readonly string[] | undefined {
  return CURATED_CATALOG_FALLBACK_MODELS[providerType];
}

const REASONING_FUNCTION_CALLING = { reasoning: true, functionCalling: true } satisfies ModelInfo['capabilities'];
const FUNCTION_CALLING_ONLY = { functionCalling: true } satisfies ModelInfo['capabilities'];

const ANTHROPIC_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['low', 'medium', 'high', 'max'] }},
  'claude-opus-4-8': { displayName: 'Claude Opus 4.8', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }},
  'claude-fable-5': { displayName: 'Claude Fable 5', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }},
  'claude-sonnet-4-5': { displayName: 'Claude Sonnet 4.5 (latest)', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' }},
  'claude-sonnet-4-5-20250929': { displayName: 'Claude Sonnet 4.5', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' }},
  'claude-opus-4-1-20250805': { displayName: 'Claude Opus 4.1', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 200_000, maxOutputTokens: 32_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' }},
  'claude-haiku-4-5': { displayName: 'Claude Haiku 4.5 (latest)', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' }},
  'claude-haiku-4-5-20251001': { displayName: 'Claude Haiku 4.5', lifecycle: 'active', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' }},
  'claude-3-5-sonnet-20241022': { displayName: 'Claude Sonnet 3.5 v2', lifecycle: 'deprecated', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', contextWindow: 200_000, maxOutputTokens: 8_192, capabilities: { ...FUNCTION_CALLING_ONLY, vision: true } },
};

const CLAUDE_SUBSCRIPTION_MODELS_DEV_METADATA = displayMetadataOnly(ANTHROPIC_MODELS_DEV_METADATA);

const GOOGLE_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'gemini-3.5-flash': { displayName: 'Gemini 3.5 Flash', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models', contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] }},
  'gemini-3.1-pro-preview': { displayName: 'Gemini 3.1 Pro Preview', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models', contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['low', 'medium', 'high'] }},
  'gemini-3.1-flash-lite': { displayName: 'Gemini 3.1 Flash Lite', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models', contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro Preview', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models', contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['low', 'high'] }},
  'gemini-3-flash-preview': { displayName: 'Gemini 3 Flash Preview', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models', contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] }},
  'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models', contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gemini-2.5-flash': { displayName: 'Gemini 2.5 Flash', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models', contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { toggle: true, offBehavior: 'google-thinking-budget-zero' }},
  'gemini-2.0-flash': { displayName: 'Gemini 2.0 Flash', lifecycle: 'active', docsUrl: 'https://ai.google.dev/gemini-api/docs/models', contextWindow: 1_048_576, maxOutputTokens: 8_192, capabilities: { ...FUNCTION_CALLING_ONLY, vision: true } },
};

const OPENAI_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'gpt-5.5': { displayName: 'GPT-5.5', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] }},
  'gpt-5.5-pro': { displayName: 'GPT-5.5 Pro', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gpt-5.4': { displayName: 'GPT-5.4', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gpt-5.4-mini': { displayName: 'GPT-5.4 mini', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gpt-5.3-codex-spark': { displayName: 'GPT-5.3 Codex Spark', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 128_000, maxOutputTokens: 32_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gpt-5.3-codex': { displayName: 'GPT-5.3 Codex', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gpt-5.2': { displayName: 'GPT-5.2', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gpt-5.2-codex': { displayName: 'GPT-5.2 Codex', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gpt-5.1-codex-mini': { displayName: 'GPT-5.1 Codex mini', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  'gpt-4o-mini': { displayName: 'GPT-4o mini', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 128_000, maxOutputTokens: 16_384, capabilities: { ...FUNCTION_CALLING_ONLY, vision: true } },
  'gpt-4o': { displayName: 'GPT-4o', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 128_000, maxOutputTokens: 16_384, capabilities: { ...FUNCTION_CALLING_ONLY, vision: true } },
  'gpt-4-turbo': { displayName: 'GPT-4 Turbo', lifecycle: 'deprecated', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 128_000, maxOutputTokens: 4_096, capabilities: { ...FUNCTION_CALLING_ONLY, vision: true } },
  'gpt-5': { displayName: 'GPT-5', lifecycle: 'active', docsUrl: 'https://platform.openai.com/docs/models', contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] }},
};

const OPENAI_OAUTH_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'gpt-5.5': { ...OPENAI_MODELS_DEV_METADATA['gpt-5.5']!, contextWindow: 400_000, maxOutputTokens: 128_000 },
  'gpt-5.5-pro': { ...OPENAI_MODELS_DEV_METADATA['gpt-5.5-pro']!, contextWindow: 400_000, maxOutputTokens: 128_000 },
  'gpt-5.4': { ...OPENAI_MODELS_DEV_METADATA['gpt-5.4']!, contextWindow: 400_000, maxOutputTokens: 128_000 },
  'gpt-5.4-mini': OPENAI_MODELS_DEV_METADATA['gpt-5.4-mini']!,
  'gpt-5.3-codex-spark': OPENAI_MODELS_DEV_METADATA['gpt-5.3-codex-spark']!,
};

const MINIMAX_MODELS_DEV_METADATA: Record<string, ModelMetadata> = {
  'MiniMax-M3': { displayName: 'MiniMax-M3', lifecycle: 'active', docsUrl: 'https://platform.minimax.io/docs/guides/text-generation', contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } },
};

// Provider/access-path-specific static facts. Keep limits unset unless the
// source is authoritative for that provider path; request routing keeps raw ids.
const MODELS_DEV_METADATA: Partial<Record<ProviderType, Record<string, ModelMetadata>>> = {
  anthropic: ANTHROPIC_MODELS_DEV_METADATA,
  'claude-subscription': CLAUDE_SUBSCRIPTION_MODELS_DEV_METADATA,
  openai: OPENAI_MODELS_DEV_METADATA,
  google: GOOGLE_MODELS_DEV_METADATA,
  'gemini-cli': GOOGLE_MODELS_DEV_METADATA,
  'codex-subscription': OPENAI_OAUTH_MODELS_DEV_METADATA,
  deepseek: {
    'deepseek-v4-flash': { displayName: 'DeepSeek V4 Flash', lifecycle: 'active', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing', contextWindow: 1_000_000, maxOutputTokens: 384_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } , thinkingOptions: { efforts: ['high', 'max'], toggle: true }},
    'deepseek-v4-pro': { displayName: 'DeepSeek V4 Pro', lifecycle: 'active', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing', contextWindow: 1_000_000, maxOutputTokens: 384_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } },
    'deepseek-reasoner': { displayName: 'DeepSeek Reasoner', lifecycle: 'deprecated', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing', contextWindow: 1_000_000, maxOutputTokens: 384_000, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } },
    'deepseek-chat': { displayName: 'DeepSeek Chat', lifecycle: 'deprecated', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing', contextWindow: 1_000_000, maxOutputTokens: 384_000, capabilities: { ...FUNCTION_CALLING_ONLY, vision: false } },
  },
  'zai-coding-plan': {
    'glm-5.2': { displayName: 'GLM-5.2', lifecycle: 'active', docsUrl: 'https://docs.z.ai', contextWindow: 1_000_000, maxOutputTokens: 131_072, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } , thinkingOptions: { efforts: ['high', 'max'] }},
    'glm-5.1': { displayName: 'GLM-5.1', lifecycle: 'active', docsUrl: 'https://docs.z.ai', contextWindow: 200_000, maxOutputTokens: 131_072, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } , thinkingOptions: { toggle: true }},
    'glm-5-turbo': { displayName: 'GLM-5-Turbo', lifecycle: 'active', docsUrl: 'https://docs.z.ai', contextWindow: 200_000, maxOutputTokens: 131_072, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } , thinkingOptions: { toggle: true }},
    'glm-5v-turbo': { displayName: 'GLM-5V-Turbo', lifecycle: 'active', docsUrl: 'https://docs.z.ai', contextWindow: 200_000, maxOutputTokens: 131_072, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } , thinkingOptions: { toggle: true }},
    'glm-4.7': { displayName: 'GLM-4.7', lifecycle: 'active', docsUrl: 'https://docs.z.ai', contextWindow: 204_800, maxOutputTokens: 131_072, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } },
    'glm-4.5-air': { displayName: 'GLM-4.5-Air', lifecycle: 'deprecated', docsUrl: 'https://docs.z.ai', contextWindow: 131_072, maxOutputTokens: 98_304, capabilities: { ...REASONING_FUNCTION_CALLING, vision: false } , thinkingOptions: { toggle: true }},
  },
  MiniMax: MINIMAX_MODELS_DEV_METADATA,
  'MiniMax-cn': MINIMAX_MODELS_DEV_METADATA,
};

function displayMetadataOnly(source: Record<string, ModelMetadata>): Record<string, ModelMetadata> {
  return Object.fromEntries(Object.entries(source).map(([id, metadata]) => [id, {
    displayName: metadata.displayName,
    lifecycle: metadata.lifecycle,
    docsUrl: metadata.docsUrl,
    thinkingOptions: metadata.thinkingOptions,
  }])) as Record<string, ModelMetadata>;
}

const CURATED_CATALOG_FALLBACK_MODELS: Partial<Record<ProviderType, readonly string[]>> = {
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
  MiniMax: ['MiniMax-M3'],
  'MiniMax-cn': ['MiniMax-M3'],
};
