import type { ModelInfo, ProviderType } from './llm-connections.js';
import type { ThinkingOptions } from './model-thinking.js';
import { GENERATED_MODELS_DEV_METADATA } from './model-metadata.generated.js';

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

const generatedMetadata: Partial<Record<ProviderType, Record<string, ModelMetadata>>> = GENERATED_MODELS_DEV_METADATA;

export function lookupModelMetadata(providerType: ProviderType, modelId: string): ModelMetadata {
  const id = modelId.trim();
  const generated = generatedMetadata[providerType]?.[id];
  const override = STATIC_MODEL_METADATA[providerType]?.[id];
  if (!generated) return override ?? {};
  if (!override) return generated;
  return {
    ...generated,
    ...override,
    capabilities: { ...generated.capabilities, ...override.capabilities },
  };
}

/**
 * Resolve whether a model accepts image input for the send path.
 *
 * Stored `connection.models` win when they declare `vision` explicitly
 * (provider-fetched facts). But `model-fetcher` stores bare `{ id }` entries
 * for many providers, and older connections predate any enrichment — so when
 * `vision` is unknown we fall back to the generated models.dev snapshot and
 * access-path-specific in-repo overrides. Unknown (no stored value, no
 * metadata entry) resolves to false,
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

const ANTHROPIC_MODEL_OVERRIDES: Record<string, ModelMetadata> = {
  'claude-sonnet-4-6': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'max'] } },
  'claude-opus-4-8': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'claude-fable-5': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  // Anthropic retired Sonnet 4.5's 1M beta on 2026-04-30; the standard API limit is 200K.
  'claude-sonnet-4-5': { contextWindow: 200_000, thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' } },
  'claude-sonnet-4-5-20250929': { contextWindow: 200_000, thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' } },
  'claude-opus-4-1-20250805': { thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' } },
  'claude-haiku-4-5': { thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' } },
  'claude-haiku-4-5-20251001': { thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' } },
};

const CLAUDE_SUBSCRIPTION_MODEL_METADATA = displayMetadataOnly(
  GENERATED_MODELS_DEV_METADATA.anthropic,
  ANTHROPIC_MODEL_OVERRIDES,
);

const GOOGLE_MODEL_OVERRIDES: Record<string, ModelMetadata> = {
  'gemini-3.5-flash': { thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] } },
  'gemini-3.1-pro-preview': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'gemini-3-pro-preview': { thinkingOptions: { efforts: ['low', 'high'] } },
  'gemini-3-flash-preview': { thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] } },
  'gemini-2.5-flash': { thinkingOptions: { toggle: true, offBehavior: 'google-thinking-budget-zero' } },
};

const OPENAI_MODEL_OVERRIDES: Record<string, ModelMetadata> = {
  'gpt-5.5': { thinkingOptions: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] } },
  'gpt-5': { thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] } },
};

const OPENAI_OAUTH_MODEL_METADATA: Record<string, ModelMetadata> = {
  'gpt-5.5': { ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.5']!, ...OPENAI_MODEL_OVERRIDES['gpt-5.5']!, contextWindow: 400_000 },
  'gpt-5.5-pro': { ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.5-pro']!, contextWindow: 400_000 },
  'gpt-5.4': { ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.4']!, contextWindow: 400_000 },
  'gpt-5.4-mini': GENERATED_MODELS_DEV_METADATA.openai['gpt-5.4-mini']!,
  'gpt-5.3-codex-spark': GENERATED_MODELS_DEV_METADATA.openai['gpt-5.3-codex-spark']!,
};

const SILICONFLOW_MODEL_OVERRIDES: Record<string, ModelMetadata> = Object.fromEntries(
  Object.entries(GENERATED_MODELS_DEV_METADATA.siliconflow)
    .filter(([, metadata]) => metadata.capabilities?.functionCalling)
    .map(([id]) => [id, { capabilities: { chat: true } }]),
);

// Facts that models.dev cannot express: provider wire controls and
// access-path-specific aliases/limits. Standard model facts stay generated.
const STATIC_MODEL_METADATA: Partial<Record<ProviderType, Record<string, ModelMetadata>>> = {
  anthropic: ANTHROPIC_MODEL_OVERRIDES,
  'minimax-coding-plan': GENERATED_MODELS_DEV_METADATA.MiniMax,
  'claude-subscription': CLAUDE_SUBSCRIPTION_MODEL_METADATA,
  openai: OPENAI_MODEL_OVERRIDES,
  google: GOOGLE_MODEL_OVERRIDES,
  'gemini-cli': GOOGLE_MODEL_OVERRIDES,
  'codex-subscription': OPENAI_OAUTH_MODEL_METADATA,
  siliconflow: SILICONFLOW_MODEL_OVERRIDES,
  'tencent-coding-plan': {
    'kimi-k2.5': { capabilities: { vision: false } },
  },
  'volcengine-ark': {
    'doubao-seed-2-0-pro-260215': {
      displayName: 'Doubao Seed 2.0 Pro',
      lifecycle: 'active',
      docsUrl: 'https://www.volcengine.com/docs/82379',
      capabilities: { reasoning: true, functionCalling: true },
      thinkingOptions: {
        efforts: ['minimal', 'low', 'medium', 'high'],
        toggle: true,
        offBehavior: 'volcengine-thinking-disabled',
      },
    },
  },
  deepseek: {
    'deepseek-v4-flash': { thinkingOptions: { efforts: ['high', 'max'], toggle: true } },
  },
  'zai-coding-plan': {
    'glm-5.2': { thinkingOptions: { efforts: ['high', 'max'] } },
    'glm-5.1': { thinkingOptions: { toggle: true } },
    'glm-5-turbo': { thinkingOptions: { toggle: true } },
    'glm-5v-turbo': { thinkingOptions: { toggle: true } },
    'glm-4.5-air': { thinkingOptions: { toggle: true } },
  },
  'kimi-coding-plan': {
    'kimi-for-coding': { displayName: 'Kimi for Coding', lifecycle: 'active', docsUrl: 'https://www.kimi.com/code/docs/en/', contextWindow: 262_144, maxOutputTokens: 32_768, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
    'kimi-for-coding-highspeed': { displayName: 'Kimi for Coding (HighSpeed)', lifecycle: 'active', docsUrl: 'https://www.kimi.com/code/docs/en/', contextWindow: 262_144, maxOutputTokens: 32_768, capabilities: { ...REASONING_FUNCTION_CALLING, vision: true } },
  },
};

function displayMetadataOnly(
  source: Record<string, ModelMetadata>,
  overrides: Record<string, ModelMetadata>,
): Record<string, ModelMetadata> {
  return Object.fromEntries(Object.entries(source).map(([id, metadata]) => [id, {
    displayName: metadata.displayName,
    lifecycle: metadata.lifecycle,
    docsUrl: metadata.docsUrl,
    thinkingOptions: overrides[id]?.thinkingOptions,
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
