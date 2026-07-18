import { generateText } from 'ai';
import type { LlmConnection } from '@maka/core';
import { getAIModel } from '@maka/runtime/model-factory';

interface OneShotCompletionInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  fetch?: typeof globalThis.fetch;
  abortSignal?: AbortSignal;
}

export async function runOneShotCompletion(input: OneShotCompletionInput): Promise<string> {
  const model = getAIModel({
    connection: input.connection,
    apiKey: input.apiKey,
    modelId: input.modelId,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const result = await generateText({
    model,
    prompt: input.prompt,
    ...(input.system !== undefined ? { instructions: input.system } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  return result.text;
}
