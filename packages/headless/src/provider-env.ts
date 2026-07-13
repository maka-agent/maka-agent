import type { ProviderType } from '@maka/core';

export interface ProviderCredentialEnv {
  apiKeys: readonly string[];
  apiKeyFile: string;
  baseUrls: readonly string[];
}

const PROVIDER_CREDENTIAL_ENV = {
  anthropic: env('ANTHROPIC', ['ANTHROPIC_BASE_URL']),
  'kimi-coding-plan': env('ANTHROPIC'),
  'minimax-coding-plan': env('MINIMAX_CODING_PLAN', ['MINIMAX_CODING_PLAN_BASE_URL']),
  openai: env('OPENAI', ['OPENAI_BASE_URL']),
  google: env('GOOGLE', ['GOOGLE_BASE_URL']),
  deepseek: env('DEEPSEEK', ['DEEPSEEK_BASE_URL', 'OPENAI_BASE_URL'], ['OPENAI_API_KEY']),
  moonshot: env('MOONSHOT', ['MOONSHOT_BASE_URL'], ['OPENAI_API_KEY']),
  'zai-coding-plan': env('ZAI', ['ZAI_BASE_URL'], ['ZAI_CODING_CN_API_KEY', 'OPENAI_API_KEY']),
  MiniMax: env('MINIMAX', ['MINIMAX_BASE_URL']),
  'MiniMax-cn': env('MINIMAX', ['MINIMAX_BASE_URL']),
  siliconflow: env('SILICONFLOW', ['SILICONFLOW_BASE_URL']),
  xai: env('XAI', ['XAI_BASE_URL']),
  cerebras: env('CEREBRAS', ['CEREBRAS_BASE_URL']),
  mistral: env('MISTRAL', ['MISTRAL_BASE_URL']),
  togetherai: env('TOGETHER', ['TOGETHER_BASE_URL']),
  'fireworks-ai': env('FIREWORKS', ['FIREWORKS_BASE_URL']),
  nvidia: env('NVIDIA', ['NVIDIA_BASE_URL']),
  'tencent-tokenhub': env('TENCENT_TOKENHUB', ['TENCENT_TOKENHUB_BASE_URL']),
  stepfun: env('STEPFUN', ['STEPFUN_BASE_URL']),
  'stepfun-ai': env('STEPFUN_AI', ['STEPFUN_AI_BASE_URL']),
  'volcengine-ark': env('ARK', ['ARK_BASE_URL']),
  'openai-compatible': env('OPENAI', ['OPENAI_BASE_URL']),
  'claude-subscription': env('ANTHROPIC'),
} satisfies Partial<Record<ProviderType, ProviderCredentialEnv>>;

export function providerCredentialEnv(provider: string): ProviderCredentialEnv | undefined {
  return PROVIDER_CREDENTIAL_ENV[provider as keyof typeof PROVIDER_CREDENTIAL_ENV];
}

export function requireProviderCredentialEnv(provider: string): ProviderCredentialEnv {
  const definition = providerCredentialEnv(provider);
  if (!definition) throw new Error(`provider does not support API key files: ${provider}`);
  return definition;
}

function env(
  prefix: string,
  baseUrls: readonly string[] = [],
  fallbackApiKeys: readonly string[] = [],
): ProviderCredentialEnv {
  return {
    apiKeys: [`${prefix}_API_KEY`, ...fallbackApiKeys],
    apiKeyFile: `${prefix}_API_KEY_FILE`,
    baseUrls,
  };
}
