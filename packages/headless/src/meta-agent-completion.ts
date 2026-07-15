import type { LlmConnection } from '@maka/core';
import { createScriptedMetaAgent, type MetaAgent, type MetaAgentCompletion } from './prompt-candidate-loop.js';
import { runOneShotCompletion } from './one-shot-completion.js';

const META_AGENT_SYSTEM =
  'You optimize a single benchmark system prompt. Reply with exactly one JSON object '
  + '{"systemPrompt":"...","summary":"...","candidateRationale":{"editedSurface":"system_prompt","evidenceRefs":["rsi-sig:id"],"hypothesis":"short plain text","targetedFix":"short plain text","predictedFixes":["held-in-task-id"],"riskTasks":["held-in-task-id"]}} '
  + 'and nothing else - no markdown fences, no prose. '
  + 'Use failurePattern only as a coarse fallback when no evidence id is available.';

export interface CreateAiSdkMetaAgentInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
  system?: string;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** Injectable text generator (default: runOneShotCompletion). Tests pass a fake. */
  generate?: (input: { prompt: string; system?: string }) => Promise<string>;
}

/** A real meta-agent completion backed by a single tool-less model call
 * (deepseek-v4-flash by default), with JSON extracted so the strict
 * parseMetaAgentResult succeeds even when the model adds fences or prose. */
export function createAiSdkMetaAgentCompletion(input: CreateAiSdkMetaAgentInput): MetaAgentCompletion {
  const system = input.system ?? META_AGENT_SYSTEM;
  const generate = input.generate ?? ((args) => runOneShotCompletion({
    connection: input.connection,
    apiKey: input.apiKey,
    modelId: input.modelId,
    prompt: args.prompt,
    ...(args.system !== undefined ? { system: args.system } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  }));
  return async ({ prompt }) => extractJsonObject(await generate({ prompt, system }));
}

export function createAiSdkMetaAgent(input: CreateAiSdkMetaAgentInput): MetaAgent {
  return createScriptedMetaAgent({ complete: createAiSdkMetaAgentCompletion(input) });
}

/** Models often wrap JSON in ```json fences or surround it with prose; extract the
 * single top-level JSON object so the strict parseMetaAgentResult does not throw. */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = (fenced ? fenced[1] : trimmed).trim();
  if (body.startsWith('{') && body.endsWith('}')) return body;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}
