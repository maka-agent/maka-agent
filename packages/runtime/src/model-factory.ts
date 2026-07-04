import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { effectiveBaseUrl, type LlmConnection, type ProviderType } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { thinkingVariantsForModel } from '@maka/core/model-thinking';
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

  switch (connection.providerType) {
    case 'anthropic':
    case 'kimi-coding-plan':
      // Both send through the Anthropic SDK, normalizing the base URL to /v1
      // (anthropicV1BaseUrl) so a baseUrl override omitting `/v1` sends to
      // `<root>/v1/messages` instead of 404ing on `<root>/messages`, matching
      // the probe/model-fetch paths.
      return createAnthropic({
        apiKey,
        baseURL: anthropicV1BaseUrl(baseURL),
        headers: { 'anthropic-beta': ANTHROPIC_BETA },
      }).chat(modelId);

    case 'MiniMax':
    case 'MiniMax-cn':
      // MiniMax's Anthropic-compatible API accepts both x-api-key and Bearer,
      // but documents Bearer as recommended (and it takes precedence when both
      // are sent), so pass the key as authToken to emit `Authorization: Bearer`.
      return createAnthropic({
        authToken: apiKey,
        baseURL,
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

    case 'gemini-cli':
      throw new Error(`${connection.providerType} is experimental and not wired yet`);

    case 'openai': {
      const openai = createOpenAI({ apiKey, baseURL });
      if (/^gpt-5/i.test(modelId)) return openai.responses(modelId);
      return openai.chat(modelId);
    }

    case 'google':
      // Normalize to /v1beta so a baseUrl override omitting it still hits
      // `<root>/v1beta/models/{model}` instead of 404ing.
      return createGoogleGenerativeAI({ apiKey, baseURL: googleV1BetaBaseUrl(baseURL) }).chat(modelId);

    case 'deepseek':
      return createOpenAICompatible({
        name: 'deepseek',
        apiKey,
        baseURL: baseURL || 'https://api.deepseek.com',
      }).chatModel(modelId);

    case 'moonshot':
      return createOpenAICompatible({
        name: 'moonshot',
        apiKey,
        baseURL: baseURL || 'https://api.moonshot.cn/v1',
      }).chatModel(modelId);

    case 'zai-coding-plan':
      return createOpenAICompatible({
        name: 'zai-coding-plan',
        apiKey,
        baseURL: baseURL || 'https://api.z.ai/api/coding/paas/v4',
      }).chatModel(modelId);

    case 'ollama':
      return createOpenAICompatible({
        name: 'ollama',
        apiKey: apiKey || 'ollama',
        baseURL: baseURL || 'http://localhost:11434/v1',
      }).chatModel(modelId);

    case 'openai-compatible':
      if (!baseURL) {
        throw new Error(`openai-compatible connection ${connection.slug} requires a base URL`);
      }
      return createOpenAICompatible({
        name: connection.slug,
        apiKey,
        baseURL,
      }).chatModel(modelId);
  }
}

export function buildProviderOptions(
  connection: LlmConnection,
  modelId: string,
  thinkingLevel?: ThinkingLevel,
): Record<string, unknown> {
  const variants = thinkingVariantsForModel(connection.providerType, modelId);
  const level = thinkingLevel && variants.includes(thinkingLevel) ? thinkingLevel : undefined;
  switch (connection.providerType) {
    case 'anthropic':
    case 'kimi-coding-plan':
    case 'MiniMax':
    case 'MiniMax-cn':
    case 'claude-subscription':
      return {
        anthropic: level
          ? { thinking: { type: 'enabled' as const, budgetTokens: anthropicBudgetTokens(level) } }
          : {},
      };
    case 'codex-subscription':
      return {
        openai: {
          store: false,
          textVerbosity: 'medium',
          ...(level ? { reasoningEffort: level } : {}),
        },
      };
    case 'openai':
      return { openai: level ? { reasoningEffort: level } : {} };
    case 'google':
      return {
        google: {
          safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          ],
          ...(level
            ? isGemini3Model(modelId)
              ? { thinkingConfig: { includeThoughts: true, thinkingLevel: level } }
              : { thinkingConfig: { includeThoughts: true, thinkingBudget: googleBudgetTokens(level) } }
            : {}),
        },
      };
    case 'deepseek':
    case 'moonshot':
    case 'zai-coding-plan':
    case 'ollama':
      return level ? { [openaiCompatibleNamespace(connection.providerType)]: { reasoningEffort: level } } : {};
    case 'openai-compatible':
      return level ? { [connection.slug]: { reasoningEffort: level } } : {};
    default:
      return {};
  }
}

/** Anthropic extended-thinking budget for a semantic level. Tunable; conservative defaults. */
function anthropicBudgetTokens(level: ThinkingLevel): number {
  switch (level) {
    case 'low':
      return 4096;
    case 'medium':
      return 10000;
    case 'high':
      return 20000;
    case 'minimal':
      // Anthropic has no `minimal` effort; map to the smallest budget we send.
      return 2048;
  }
}

/** Gemini 2.5 uses a numeric thinking budget; Gemini 3 uses `thinkingLevel`. */
function googleBudgetTokens(level: ThinkingLevel): number {
  switch (level) {
    case 'minimal':
      return 512;
    case 'low':
      return 2048;
    case 'medium':
      return 8000;
    case 'high':
      return 16000;
  }
}

function isGemini3Model(modelId: string): boolean {
  return /gemini-3/i.test(modelId);
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
