import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3, SharedV3ProviderOptions } from '@ai-sdk/provider';
import { PROVIDER_DEFAULTS, effectiveBaseUrl, type LlmConnection, type ProviderType } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { thinkingOptionsForModel, thinkingVariantsForModel } from '@maka/core/model-thinking';
import { anthropicV1BaseUrl, googleV1BetaBaseUrl } from './provider-urls.js';
import {
  claudeSubscriptionHeaders,
  codexSubscriptionHeaders,
} from './subscription-auth.js';

export interface ModelFactoryInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}

const ANTHROPIC_BETA =
  'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
export function getAIModel(input: ModelFactoryInput): LanguageModelV3 {
  const { connection, apiKey, modelId, fetch } = input;
  const baseURL = effectiveBaseUrl(connection);
  const definition = PROVIDER_DEFAULTS[connection.providerType];
  const adapter = definition.runtimeAdapter;

  switch (adapter.kind) {
    case 'anthropic':
      return createAnthropic({
        ...(adapter.auth === 'bearer' ? { authToken: apiKey } : { apiKey }),
        baseURL: adapter.normalizeBaseUrl ? anthropicV1BaseUrl(baseURL) : baseURL,
        headers: { 'anthropic-beta': ANTHROPIC_BETA },
      }).chat(modelId);

    case 'claude-subscription':
      return createAnthropic({
        authToken: apiKey,
        baseURL: anthropicV1BaseUrl(baseURL),
        fetch,
        headers: claudeSubscriptionHeaders(),
      }).chat(modelId);

    case 'codex-subscription':
      return createOpenAI({
        apiKey,
        baseURL,
        fetch,
        headers: codexSubscriptionHeaders(apiKey),
      }).responses(modelId);

    case 'unavailable':
      throw new Error(`${connection.providerType} is experimental and not wired yet`);

    case 'openai': {
      const openai = createOpenAI({ apiKey, baseURL });
      if (/^gpt-5/i.test(modelId)) return openai.responses(modelId);
      return openai.chat(modelId);
    }

    case 'google':
      return createGoogleGenerativeAI({
        apiKey,
        baseURL: googleV1BetaBaseUrl(baseURL),
      }).chat(modelId);

    case 'openai-compatible': {
      if (adapter.requireBaseUrl && !baseURL) {
        throw new Error(`${connection.providerType} connection ${connection.slug} requires a base URL`);
      }
      const name = adapter.name === 'connection' ? connection.slug : connection.providerType;
      return createOpenAICompatible({
        name,
        apiKey,
        baseURL,
        ...(adapter.passFetch ? { fetch } : {}),
      }).chatModel(modelId);
    }
  }
}

export function buildProviderOptions(
  connection: LlmConnection,
  modelId: string,
  thinkingLevel?: ThinkingLevel,
): SharedV3ProviderOptions {
  const thinkingOptions = thinkingOptionsForModel(connection.providerType, modelId);
  const variants = thinkingVariantsForModel(connection.providerType, modelId);
  const level = thinkingLevel && variants.includes(thinkingLevel) ? thinkingLevel : undefined;
  switch (connection.providerType) {
    // Anthropic-protocol: effort enum models send `effort`; toggle/budget
    // models send `thinking.disabled` for off. No budget-token mapping — the
    // provider's native effort values pass through unchanged.
    case 'anthropic':
    case 'kimi-coding-plan':
    case 'MiniMax':
    case 'MiniMax-cn':
    case 'claude-subscription':
      return {
        anthropic: level
          ? level === 'off'
            ? thinkingOptions?.offBehavior === 'anthropic-thinking-disabled'
              ? { thinking: { type: 'disabled' as const } }
              : {}
            : { effort: level }
          : {},
      };
    case 'codex-subscription':
      return {
        openai: {
          store: false,
          textVerbosity: 'medium',
          ...(level ? { reasoningEffort: level === 'off' ? 'none' : level } : {}),
        },
      };
    case 'openai':
      return { openai: level ? { reasoningEffort: level === 'off' ? 'none' : level } : {} };
    case 'volcengine-ark':
      return {
        [openaiCompatibleNamespace(connection.providerType)]: {
          thinking: { type: level === 'off' ? 'disabled' : 'enabled' },
          ...(level && level !== 'off' ? { reasoningEffort: level } : {}),
        },
      };
    case 'google':
      return {
        google: {
          safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          ],
          // Google effort models use thinkingLevel; Gemini 2.5 Flash disables
          // thinking via the budget-zero wire. Omitting thinkingConfig means
          // provider default, not "off".
          ...(level === 'off' && thinkingOptions?.offBehavior === 'google-thinking-budget-zero'
            ? { thinkingConfig: { thinkingBudget: 0 } }
            : level && level !== 'off'
              ? { thinkingConfig: { includeThoughts: true, thinkingLevel: level } }
              : {}),
        },
      };
    // OpenAI-compatible: effort levels pass through as reasoningEffort under
    // the raw provider namespace. `off` has no ai-sdk openai-compatible wire
    // (no thinking.disabled field), so it is a no-op override here.
    case 'deepseek':
    case 'moonshot':
    case 'zai-coding-plan':
      return level && level !== 'off'
        ? { [openaiCompatibleNamespace(connection.providerType)]: { reasoningEffort: level } }
        : {};
    default:
      return {};
  }
}

/** providerOptions namespace matches the `name` passed to `createOpenAICompatible` in `getAIModel`. */
function openaiCompatibleNamespace(providerType: ProviderType): string {
  switch (providerType) {
    case 'deepseek':
      return 'deepseek';
    case 'moonshot':
      return 'moonshot';
    case 'zai-coding-plan':
      return 'zai-coding-plan';
    case 'ollama':
      return 'ollama';
    default:
      return providerType;
  }
}
