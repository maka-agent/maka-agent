import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { effectiveBaseUrl, type LlmConnection } from '@maka/core/llm-connections';
import { anthropicV1BaseUrl, codexSubscriptionHeaders } from './subscription-auth.js';

export interface ModelFactoryInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}

const ANTHROPIC_BETA =
  'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';
const CLAUDE_SUBSCRIPTION_BETA =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219';
const CLAUDE_SUBSCRIPTION_USER_AGENT = 'claude-cli/2.1.88 (external, cli)';

export function getAIModel(input: ModelFactoryInput): LanguageModelV3 {
  const { connection, apiKey, modelId, fetch } = input;
  const baseURL = effectiveBaseUrl(connection);

  switch (connection.providerType) {
    case 'anthropic':
      return createAnthropic({
        apiKey,
        baseURL: anthropicV1BaseUrl(baseURL),
        headers: { 'anthropic-beta': ANTHROPIC_BETA },
      }).chat(modelId);

    case 'kimi-coding-plan':
      return createAnthropic({
        apiKey,
        baseURL,
        headers: { 'anthropic-beta': ANTHROPIC_BETA },
      }).chat(modelId);

    case 'claude-subscription':
      return createAnthropic({
        authToken: apiKey,
        baseURL: anthropicV1BaseUrl(baseURL),
        fetch,
        headers: {
          'anthropic-beta': CLAUDE_SUBSCRIPTION_BETA,
          'User-Agent': CLAUDE_SUBSCRIPTION_USER_AGENT,
          'anthropic-dangerous-direct-browser-access': 'true',
          'x-app': 'cli',
        },
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
      return createGoogleGenerativeAI({ apiKey, baseURL }).chat(modelId);

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
  _modelId: string,
): Record<string, unknown> {
  switch (connection.providerType) {
    case 'anthropic':
    case 'kimi-coding-plan':
    case 'claude-subscription':
      return { anthropic: {} };
    case 'codex-subscription':
      return {
        openai: {
          store: false,
          textVerbosity: 'medium',
        },
      };
    case 'openai':
      return { openai: {} };
    case 'google':
      return {
        google: {
          safetySettings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          ],
        },
      };
    default:
      return {};
  }
}
