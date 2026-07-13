import type { BackendKind } from './session.js';
import {
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_PROVIDER_FACTS,
} from './model-metadata.generated.js';

export type ProviderCategory = 'oauth' | 'domestic' | 'overseas' | 'local' | 'custom';
export type ProviderCatalogGroup = 'recommended' | 'plans' | 'api' | 'aggregators' | 'local';

export type ProviderRuntimeAdapter =
  | { kind: 'anthropic'; auth: 'api-key' | 'bearer'; normalizeBaseUrl: boolean }
  | { kind: 'claude-subscription' }
  | { kind: 'openai' }
  | { kind: 'codex-subscription' }
  | { kind: 'google' }
  | {
      kind: 'openai-compatible';
      name: 'provider' | 'connection';
      apiKeyFallback?: string;
      passFetch?: boolean;
      requireBaseUrl?: boolean;
    }
  | { kind: 'unavailable' };

export type ProviderModelDiscovery =
  | {
      kind: 'protocol';
      auth?: 'claude-subscription';
      query?: Readonly<Record<string, string>>;
      responseShape?: 'array-or-data';
    }
  | { kind: 'fallback' }
  | { kind: 'ollama' };

export interface ProviderDefaults {
  label: string;
  description: string;
  baseUrl: string;
  authKind: 'api_key' | 'oauth_token' | 'none';
  backendKind: BackendKind;
  fallbackModels: string[];
  status: 'ready' | 'phase3-experimental';
  protocol: 'anthropic' | 'openai' | 'google';
  runtimeAdapter: ProviderRuntimeAdapter;
  modelDiscovery: ProviderModelDiscovery;
  category: ProviderCategory;
  catalogGroup?: ProviderCatalogGroup;
  catalogBadge?: string;
  signupUrl?: string;
  modelsDevId?: string;
  readyOrder?: number;
  catalogOrder?: number;
  recommendedOrder?: number;
}

const siliconflow = GENERATED_MODELS_DEV_PROVIDER_FACTS.siliconflow;
if (!siliconflow.api) throw new Error('models.dev SiliconFlow provider facts are missing api');
const siliconflowModelIds = toolCallingModelIds(
  'SiliconFlow',
  GENERATED_MODELS_DEV_METADATA.siliconflow,
  ['moonshotai/Kimi-K2.6'],
);
const minimaxPlanModelIds = toolCallingModelIds('MiniMax', GENERATED_MODELS_DEV_METADATA.MiniMax, ['MiniMax-M3']);

const xai = GENERATED_MODELS_DEV_PROVIDER_FACTS.xai;
if (xai.id !== 'xai') throw new Error('models.dev xAI provider facts are missing stable id xai');
const xaiModelIds = toolCallingModelIds('xAI', GENERATED_MODELS_DEV_METADATA.xai, ['grok-4.5']);
const cerebras = GENERATED_MODELS_DEV_PROVIDER_FACTS.cerebras;
if (cerebras.id !== 'cerebras') throw new Error('models.dev Cerebras provider facts are missing stable id cerebras');

const cerebrasModelIds = toolCallingModelIds('Cerebras', GENERATED_MODELS_DEV_METADATA.cerebras, ['gpt-oss-120b']);

const mistral = GENERATED_MODELS_DEV_PROVIDER_FACTS.mistral;
if (mistral.id !== 'mistral') throw new Error('models.dev Mistral provider facts are missing stable id mistral');
const mistralModelIds = toolCallingModelIds('Mistral', GENERATED_MODELS_DEV_METADATA.mistral, ['mistral-large-latest']);

const together = GENERATED_MODELS_DEV_PROVIDER_FACTS.togetherai;
if (together.id !== 'togetherai') {
  throw new Error('models.dev Together AI provider facts are missing stable id togetherai');
}
const togetherModelIds = toolCallingModelIds(
  'Together AI',
  GENERATED_MODELS_DEV_METADATA.togetherai,
  ['MiniMaxAI/MiniMax-M3'],
);

function toolCallingModelIds(
  providerLabel: string,
  models: Readonly<Record<string, { capabilities?: { functionCalling?: boolean } }>>,
  recommendedIds: readonly string[],
): string[] {
  const entries = Object.entries(models);
  const modelsById = new Map(entries);
  return [
    ...recommendedIds.map((id) => {
      const model = modelsById.get(id);
      if (!model) throw new Error(`models.dev ${providerLabel} snapshot is missing recommended model ${id}`);
      return [id, model] as const;
    }),
    ...entries.filter(([id]) => !recommendedIds.includes(id)),
  ]
    .filter(([, model]) => model.capabilities?.functionCalling)
    .map(([id]) => id);
}

const providerRegistry = {
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
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    readyOrder: 1,
    catalogOrder: 9,
    recommendedOrder: 2,
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
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://www.kimi.com/code/console',
    readyOrder: 15,
    catalogOrder: 1,
    recommendedOrder: 5,
  },
  'minimax-coding-plan': {
    label: 'MiniMax Coding Plan',
    description: 'MiniMax Token Plan over Anthropic-compatible protocol.',
    baseUrl: 'https://api.minimax.io/anthropic',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: minimaxPlanModelIds,
    status: 'ready',
    protocol: 'anthropic',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://platform.minimax.io/subscribe/coding-plan',
    modelsDevId: GENERATED_MODELS_DEV_PROVIDER_FACTS.MiniMax.id,
    readyOrder: 17,
    catalogOrder: 2,
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
    runtimeAdapter: { kind: 'openai' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.openai.com/api-keys',
    readyOrder: 2,
    catalogOrder: 10,
    recommendedOrder: 3,
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
    runtimeAdapter: { kind: 'google' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://aistudio.google.com/app/apikey',
    readyOrder: 3,
    catalogOrder: 11,
    recommendedOrder: 4,
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
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    readyOrder: 4,
    catalogOrder: 3,
    recommendedOrder: 6,
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
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.kimi.com/console/api-keys',
    readyOrder: 5,
    catalogOrder: 4,
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
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    readyOrder: 6,
    catalogOrder: 5,
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
    runtimeAdapter: { kind: 'anthropic', auth: 'bearer', normalizeBaseUrl: false },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    readyOrder: 7,
    catalogOrder: 6,
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
    runtimeAdapter: { kind: 'anthropic', auth: 'bearer', normalizeBaseUrl: false },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    readyOrder: 8,
    catalogOrder: 7,
  },
  siliconflow: {
    label: siliconflow.name,
    description: 'Hosted multi-model API with exact upstream model ids.',
    baseUrl: siliconflow.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: siliconflowModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider', passFetch: true },
    modelDiscovery: { kind: 'protocol', query: { sub_type: 'chat' } },
    category: 'domestic',
    catalogGroup: 'aggregators',
    catalogBadge: 'Aggregator',
    signupUrl: siliconflow.doc,
    modelsDevId: siliconflow.id,
    readyOrder: 9,
    catalogOrder: 8,
    recommendedOrder: 1,
  },
  xai: {
    label: xai.name,
    description: 'Grok models for chat, reasoning, vision, and tool use.',
    baseUrl: 'https://api.x.ai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: xaiModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.x.ai/',
    modelsDevId: xai.id,
    readyOrder: 10,
    catalogOrder: 12,
  },
  cerebras: {
    label: cerebras.name,
    description: 'Fast hosted open-model inference with reasoning and tool use.',
    baseUrl: 'https://api.cerebras.ai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: cerebrasModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://cloud.cerebras.ai/',
    modelsDevId: cerebras.id,
    readyOrder: 11,
    catalogOrder: 13,
  },
  mistral: {
    label: mistral.name,
    description: 'Mistral chat, coding, vision, reasoning, and tool-use models.',
    baseUrl: 'https://api.mistral.ai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: mistralModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', responseShape: 'array-or-data' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.mistral.ai/api-keys/',
    modelsDevId: mistral.id,
    readyOrder: 12,
    catalogOrder: 14,
  },
  togetherai: {
    label: together.name,
    description: 'Hosted open models for chat, reasoning, vision, and tool use.',
    baseUrl: 'https://api.together.ai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: togetherModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://api.together.ai/settings/projects/~current/api-keys',
    modelsDevId: together.id,
    readyOrder: 18,
    catalogOrder: 15,
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
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider', apiKeyFallback: 'ollama' },
    modelDiscovery: { kind: 'ollama' },
    category: 'local',
    catalogGroup: 'local',
    catalogBadge: 'Local',
    readyOrder: 13,
    catalogOrder: 16,
    recommendedOrder: 7,
  },
  'lm-studio': {
    label: 'LM Studio',
    description: 'Local models served by LM Studio on localhost.',
    baseUrl: 'http://localhost:1234/v1',
    authKind: 'none',
    backendKind: 'ai-sdk',
    fallbackModels: [],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'local',
    catalogGroup: 'local',
    catalogBadge: 'Local',
    readyOrder: 14,
    catalogOrder: 17,
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
    runtimeAdapter: { kind: 'openai-compatible', name: 'connection', requireBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'custom',
    catalogGroup: 'aggregators',
    catalogBadge: 'Custom',
    readyOrder: 16,
    catalogOrder: 18,
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
    runtimeAdapter: { kind: 'claude-subscription' },
    modelDiscovery: { kind: 'protocol', auth: 'claude-subscription' },
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
    runtimeAdapter: { kind: 'codex-subscription' },
    modelDiscovery: { kind: 'fallback' },
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
    runtimeAdapter: { kind: 'unavailable' },
    modelDiscovery: { kind: 'protocol' },
    category: 'oauth',
    catalogBadge: 'Account',
  },
} satisfies Record<string, ProviderDefaults>;

export type ProviderType = keyof typeof providerRegistry;
export const PROVIDER_REGISTRY: Readonly<Record<ProviderType, ProviderDefaults>> = providerRegistry;

function providerTypesByOrder(field: 'readyOrder' | 'catalogOrder' | 'recommendedOrder'): ProviderType[] {
  return (Object.entries(PROVIDER_REGISTRY) as Array<[ProviderType, ProviderDefaults]>)
    .filter(([, provider]) => provider[field] !== undefined)
    .sort(([, left], [, right]) => left[field]! - right[field]!)
    .map(([providerType]) => providerType);
}

export const READY_PROVIDER_TYPES = providerTypesByOrder('readyOrder');
export const CATALOG_PROVIDER_TYPES = providerTypesByOrder('catalogOrder');
export const RECOMMENDED_PROVIDER_TYPES = providerTypesByOrder('recommendedOrder');
