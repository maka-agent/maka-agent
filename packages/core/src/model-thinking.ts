/**
 * Controllable thinking level for reasoning-capable models.
 *
 * A `ThinkingLevel` is a user-facing reasoning-depth knob. It is a per-model
 * variant: each model supports a subset of levels (declared here by
 * `thinkingVariantsForModel`), and switching models clears the choice so a
 * level is never sent to a model that does not understand it. `undefined`
 * means "no override" (the model's default behaviour) and is the only value
 * persisted-absent — the UI shows it as "默认".
 *
 * The runtime maps a chosen level to the ai-sdk provider option
 * (`reasoningEffort` / `thinking.budgetTokens` / `thinkingConfig`) in
 * `buildProviderOptions`; this module owns only the vocabulary and the
 * per-model supported set, so the UI and runtime share one source of truth.
 */

import type { ProviderType } from './llm-connections.js';

/**
 * Reasoning-depth variants. Ordered from shallowest to deepest for display.
 * Not every model supports every level — call `thinkingVariantsForModel` for
 * the model-specific subset.
 */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Levels a model supports, in display order. Returns an empty list for
 * non-reasoning models and for provider/model combinations whose reasoning
 * support is not declarable from `providerType` + `modelId` alone (e.g.
 * `openai-compatible`, where the backing model is user-configured and
 * unknown). The UI hides the thinking switcher when this returns `[]`.
 *
 * Heuristics are intentionally conservative: only patterns known to accept the
 * mapped provider option are listed. Refine here as provider support grows —
 * this is the single place that decides which models expose the knob.
 */
export function thinkingVariantsForModel(
  providerType: ProviderType,
  modelId: string,
): readonly ThinkingLevel[] {
  const id = modelId.toLowerCase();
  switch (providerType) {
    // Anthropic-protocol providers all expose `thinking.budgetTokens`; the
    // level maps to a budget in `buildProviderOptions`.
    case 'anthropic':
    case 'kimi-coding-plan':
    case 'MiniMax':
    case 'MiniMax-cn':
    case 'claude-subscription':
      return ['low', 'medium', 'high'];

    // OpenAI gpt-5 family + codex subscription accept `reasoningEffort`,
    // including `minimal`. Non-gpt-5 OpenAI chat models do not.
    case 'openai':
      return /^gpt-5/i.test(id) ? ['minimal', 'low', 'medium', 'high'] : [];
    case 'codex-subscription':
      return ['minimal', 'low', 'medium', 'high'];

    // Gemini 2.5 / 3 / 3.1 expose `thinkingConfig` (thinkingLevel or
    // thinkingBudget). Older Gemini models do not.
    case 'google':
      return /gemini-(2\.5|3\.1|3)/i.test(id) ? ['low', 'medium', 'high'] : [];

    // DeepSeek v3+ exposes `reasoning_effort` over the OpenAI-compatible API.
    case 'deepseek':
      return /deepseek/i.test(id) ? ['low', 'medium', 'high'] : [];

    // Moonshot Kimi K2+ exposes `reasoning_effort`.
    case 'moonshot':
      return /kimi/i.test(id) ? ['low', 'medium', 'high'] : [];

    // Z.AI GLM 4.6+ exposes `reasoning_effort`.
    case 'zai-coding-plan':
      return /glm/i.test(id) ? ['low', 'medium', 'high'] : [];

    // ollama / openai-compatible / gemini-cli back user-configured models we
    // cannot reason about from the id alone — do not offer the knob.
    case 'ollama':
    case 'openai-compatible':
    case 'gemini-cli':
      return [];
  }
}