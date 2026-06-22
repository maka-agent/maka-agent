import { generateText } from 'ai';
import type { LlmConnection } from '@maka/core';
import { getAIModel } from './model-factory.js';

/**
 * Single-turn, tool-less text completion over the same provider stack the agent
 * backend uses (getAIModel + the `ai` SDK). Intended for host-side helpers such
 * as the prompt-optimization meta-agent, which only reads a prompt and returns
 * text — no streaming, no tools, no session.
 */
export interface OneShotCompletionInput {
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
    ...(input.system !== undefined ? { system: input.system } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  return result.text;
}
