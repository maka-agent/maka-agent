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
      filter?: 'fallback-models';
    }
  | {
      kind: 'fireworks';
      accountsPath: string;
      publicAccount: string;
      query: Readonly<Record<string, string>>;
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
const nvidia = GENERATED_MODELS_DEV_PROVIDER_FACTS.nvidia;
if (nvidia.id !== 'nvidia') throw new Error('models.dev NVIDIA provider facts are missing stable id nvidia');
if (!nvidia.api) throw new Error('models.dev NVIDIA provider facts are missing api');
const nvidiaModelIds = toolCallingModelIds('NVIDIA', GENERATED_MODELS_DEV_METADATA.nvidia, [
  'nvidia/nemotron-3-super-120b-a12b',
]);

const mistral = GENERATED_MODELS_DEV_PROVIDER_FACTS.mistral;
if (mistral.id !== 'mistral') throw new Error('models.dev Mistral provider facts are missing stable id mistral');
const mistralModelIds = toolCallingModelIds('Mistral', GENERATED_MODELS_DEV_METADATA.mistral, ['mistral-large-latest']);
const fireworks = GENERATED_MODELS_DEV_PROVIDER_FACTS['fireworks-ai'];
if (fireworks.id !== 'fireworks-ai') {
  throw new Error('models.dev Fireworks AI provider facts are missing stable id fireworks-ai');
}
if (!fireworks.api) throw new Error('models.dev Fireworks AI provider facts are missing api');
const fireworksModelIds = toolCallingModelIds(
  'Fireworks AI',
  GENERATED_MODELS_DEV_METADATA['fireworks-ai'],
  ['accounts/fireworks/models/kimi-k2p6'],
);
const tencentTokenHub = GENERATED_MODELS_DEV_PROVIDER_FACTS['tencent-tokenhub'];
if (tencentTokenHub.id !== 'tencent-tokenhub') {
  throw new Error('models.dev Tencent TokenHub provider facts are missing stable id tencent-tokenhub');
}
if (!tencentTokenHub.api) throw new Error('models.dev Tencent TokenHub provider facts are missing api');
const tencentTokenHubModelIds = toolCallingModelIds(
  'Tencent TokenHub',
  GENERATED_MODELS_DEV_METADATA['tencent-tokenhub'],
  ['hy3', 'hy3-preview'],
);
const tencentCodingPlan = GENERATED_MODELS_DEV_PROVIDER_FACTS['tencent-coding-plan'];
if (tencentCodingPlan.id !== 'tencent-coding-plan') {
  throw new Error('models.dev Tencent Coding Plan provider facts are missing stable id tencent-coding-plan');
}
if (!tencentCodingPlan.api) throw new Error('models.dev Tencent Coding Plan provider facts are missing api');
const tencentCodingPlanModelIds = [
  'tc-code-latest',
  'glm-5',
  'minimax-m2.5',
  'kimi-k2.5',
] as const;
for (const id of tencentCodingPlanModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['tencent-coding-plan'][id]?.capabilities?.functionCalling) {
    throw new Error(`models.dev Tencent Coding Plan snapshot is missing tool-capable model ${id}`);
  }
}
const stepfun = GENERATED_MODELS_DEV_PROVIDER_FACTS.stepfun;
if (stepfun.id !== 'stepfun') throw new Error('models.dev StepFun provider facts are missing stable id stepfun');
if (!stepfun.api) throw new Error('models.dev StepFun provider facts are missing api');
const stepfunModelIds = toolCallingModelIds(
  'StepFun',
  GENERATED_MODELS_DEV_METADATA.stepfun,
  ['step-3.7-flash', 'step-3.5-flash-2603', 'step-3.5-flash'],
);
const stepfunGlobal = GENERATED_MODELS_DEV_PROVIDER_FACTS['stepfun-ai'];
if (stepfunGlobal.id !== 'stepfun-ai') {
  throw new Error('models.dev StepFun Global provider facts are missing stable id stepfun-ai');
}
if (!stepfunGlobal.api) throw new Error('models.dev StepFun Global provider facts are missing api');
const stepfunGlobalModelIds = [
  'step-3.7-flash',
  'step-3.5-flash-2603',
  'step-3.5-flash',
];
for (const id of stepfunGlobalModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['stepfun-ai'][id]?.capabilities?.functionCalling) {
    throw new Error(`models.dev StepFun Global snapshot is missing documented tool-capable model ${id}`);
  }
}

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
  'tencent-coding-plan': {
    label: tencentCodingPlan.name,
    description: 'Tencent Cloud Coding Plan for interactive coding agents.',
    baseUrl: tencentCodingPlan.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...tencentCodingPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://console.cloud.tencent.com/lkeap/coding-plan',
    modelsDevId: tencentCodingPlan.id,
    readyOrder: 23,
    catalogOrder: 23,
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
  'fireworks-ai': {
    label: fireworks.name,
    description: 'Serverless open models with exact Fireworks model paths.',
    baseUrl: fireworks.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: fireworksModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: {
      kind: 'fireworks',
      accountsPath: '/v1/accounts',
      publicAccount: 'accounts/fireworks',
      query: { filter: 'supports_serverless=true', pageSize: '200' },
    },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    modelsDevId: fireworks.id,
    readyOrder: 19,
    catalogOrder: 19,
  },
  nvidia: {
    label: 'NVIDIA',
    description: 'NVIDIA-hosted models for reasoning, vision, and tool use.',
    baseUrl: nvidia.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: nvidiaModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', filter: 'fallback-models' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://build.nvidia.com/',
    modelsDevId: nvidia.id,
    readyOrder: 20,
    catalogOrder: 20,
  },
  'tencent-tokenhub': {
    label: tencentTokenHub.name,
    description: 'Tencent TokenHub models for reasoning and tool-use agents.',
    baseUrl: tencentTokenHub.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: tencentTokenHubModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://cloud.tencent.com/document/product/1823/130090',
    modelsDevId: tencentTokenHub.id,
    readyOrder: 21,
    catalogOrder: 21,
  },
  stepfun: {
    label: stepfun.name,
    description: 'StepFun China models for multimodal reasoning and tool-use agents.',
    baseUrl: stepfun.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: stepfunModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.stepfun.com/interface-key',
    modelsDevId: stepfun.id,
    readyOrder: 22,
    catalogOrder: 22,
  },
  'stepfun-ai': {
    label: stepfunGlobal.name,
    description: 'StepFun Global models for multimodal reasoning and tool-use agents.',
    baseUrl: stepfunGlobal.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: stepfunGlobalModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.stepfun.ai/interface-key',
    modelsDevId: stepfunGlobal.id,
    readyOrder: 24,
    catalogOrder: 24,
  },
  'volcengine-ark': {
    label: 'Volcengine Ark (China)',
    description: 'Volcengine Ark direct API for reasoning and tool-use agents in China.',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['doubao-seed-2-0-pro-260215'],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/model',
    readyOrder: 25,
    catalogOrder: 25,
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
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
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
