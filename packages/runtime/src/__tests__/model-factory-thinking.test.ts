import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { thinkingVariantsForModel, type ThinkingLevel } from '@maka/core';
import { changesBackendConfig, buildProviderOptions } from '@maka/runtime';

function conn(providerType: LlmConnection['providerType'], slug = 'test'): LlmConnection {
  return {
    slug,
    name: slug,
    providerType,
    defaultModel: 'm',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('buildProviderOptions: thinking level', () => {
  test('anthropic effort model (opus-4-8) sends effort field directly; no budgetTokens mapping', () => {
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8'), { anthropic: {} });
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8', 'high'), { anthropic: { effort: 'high' } });
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8', 'max'), { anthropic: { effort: 'max' } });
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8', 'xhigh'), { anthropic: { effort: 'xhigh' } });
  });

  test('anthropic budget/toggle model (haiku-4-5) sends thinking.disabled for off; drops unsupported effort', () => {
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-haiku-4-5', 'off'), { anthropic: { thinking: { type: 'disabled' } } });
    // haiku-4-5 has no effort variants, only off → high is dropped
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-haiku-4-5', 'high'), { anthropic: {} });
  });

  test('anthropic effort model without toggle (opus-4-8) drops off (cannot disable)', () => {
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8', 'off'), { anthropic: {} });
  });

  test('openai gpt-5.5 sends reasoningEffort (none for off, max for max); gpt-4o drops level', () => {
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-4o', 'high'), { openai: {} });
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-5.5', 'medium'), { openai: { reasoningEffort: 'medium' } });
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-5.5', 'xhigh'), { openai: { reasoningEffort: 'xhigh' } });
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-5.5', 'off'), { openai: { reasoningEffort: 'none' } });
  });

  test('codex-subscription (gpt-5.5) preserves store:false / textVerbosity and merges reasoningEffort', () => {
    assert.deepEqual(buildProviderOptions(conn('codex-subscription'), 'gpt-5.5'), { openai: { store: false, textVerbosity: 'medium' } });
    assert.deepEqual(buildProviderOptions(conn('codex-subscription'), 'gpt-5.5', 'high'), { openai: { store: false, textVerbosity: 'medium', reasoningEffort: 'high' } });
    assert.deepEqual(buildProviderOptions(conn('codex-subscription'), 'gpt-5.5', 'off'), { openai: { store: false, textVerbosity: 'medium', reasoningEffort: 'none' } });
  });

  test('google effort model (gemini-3) sends thinkingLevel; off/undefined omit thinkingConfig; safetySettings always present', () => {
    const g3 = buildProviderOptions(conn('google'), 'gemini-3-pro-preview', 'high');
    assert.equal((g3.google as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig.thinkingLevel, 'high');
    assert.ok((g3.google as { safetySettings: unknown[] }).safetySettings.length > 0);
    // off not in gemini-3-pro-preview variants (only low/high) → dropped → no thinkingConfig
    const g3off = buildProviderOptions(conn('google'), 'gemini-3-pro-preview', 'off');
    assert.equal((g3off.google as { thinkingConfig?: unknown }).thinkingConfig, undefined);
    // gemini-2.5-flash is toggle-only (off); off omits thinkingConfig
    const g25 = buildProviderOptions(conn('google'), 'gemini-2.5-flash', 'off');
    assert.equal((g25.google as { thinkingConfig?: unknown }).thinkingConfig, undefined);
    assert.ok((g25.google as { safetySettings: unknown[] }).safetySettings.length > 0);
  });

  test('openai-compatible sends reasoningEffort for effort levels; off omits (no clean off switch via ai-sdk)', () => {
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'high'), { deepseek: { reasoningEffort: 'high' } });
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'max'), { deepseek: { reasoningEffort: 'max' } });
    // off → no reasoningEffort (ai-sdk openai-compatible has no thinking.disabled; off falls back to no override)
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'off'), {});
    // miss model (deepseek-chat non-reasoning) drops level
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-chat', 'high'), {});
  });

  test('a level the model does not support is dropped (defensive)', () => {
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-4o', 'high'), { openai: {} });
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-haiku-4-5', 'max'), { anthropic: {} });
  });
});

describe('buildProviderOptions: openai-compatible namespace', () => {
  test('zai-coding-plan emits reasoningEffort under the raw dashed namespace', () => {
    assert.deepEqual(buildProviderOptions(conn('zai-coding-plan', 'zai-coding-plan'), 'glm-5.2', 'high'), { 'zai-coding-plan': { reasoningEffort: 'high' } });
    assert.deepEqual(buildProviderOptions(conn('zai-coding-plan', 'zai-coding-plan'), 'glm-5.2', 'max'), { 'zai-coding-plan': { reasoningEffort: 'max' } });
  });
  test('deepseek uses its own raw namespace', () => {
    assert.deepEqual(buildProviderOptions(conn('deepseek', 'deepseek'), 'deepseek-v4-flash', 'high'), { deepseek: { reasoningEffort: 'high' } });
  });
});

describe('buildProviderOptions: resolver/options drift guard', () => {
  // Every effort level a model declares must map to a non-empty providerOptions
  // fragment. 'off' is excluded — it is a disable switch, not an effort level,
  // and some providers (openai-compatible) have no ai-sdk wire for it.
  const cases: Array<{ providerType: LlmConnection['providerType']; model: string; slug?: string }> = [
    { providerType: 'anthropic', model: 'claude-opus-4-8' },
    { providerType: 'anthropic', model: 'claude-haiku-4-5' },
    { providerType: 'claude-subscription', model: 'claude-opus-4-8' },
    { providerType: 'openai', model: 'gpt-5.5' },
    { providerType: 'openai', model: 'gpt-5' },
    { providerType: 'codex-subscription', model: 'gpt-5.5' },
    { providerType: 'google', model: 'gemini-3-pro-preview' },
    { providerType: 'google', model: 'gemini-3.5-flash' },
    { providerType: 'deepseek', model: 'deepseek-v4-flash' },
    { providerType: 'zai-coding-plan', model: 'glm-5.2', slug: 'zai-coding-plan' },
  ];
  for (const { providerType, model, slug } of cases) {
    test(`every effort level for ${providerType}/${model} maps to a non-empty fragment`, () => {
      const connection = conn(providerType, slug ?? providerType);
      for (const level of thinkingVariantsForModel(providerType, model)) {
        if (level === 'off') continue;
        const opts = buildProviderOptions(connection, model, level as ThinkingLevel);
        const nonEmpty = Object.keys(opts).some((k) => {
          const v = (opts as Record<string, unknown>)[k];
          return v !== null && typeof v === 'object' && Object.keys(v as object).length > 0;
        });
        assert.equal(nonEmpty, true, `${providerType}/${model} level=${level} produced no options`);
      }
    });
  }
});

describe('changesBackendConfig', () => {
  test('thinkingLevel change triggers backend reconfiguration', () => {
    assert.equal(changesBackendConfig({ thinkingLevel: 'high' }), true);
    assert.equal(changesBackendConfig({ thinkingLevel: undefined }), true);
  });

  test('unrelated patches do not', () => {
    assert.equal(changesBackendConfig({ name: 'x' }), false);
    assert.equal(changesBackendConfig({}), false);
  });

  test('backend / llmConnectionSlug / model still trigger', () => {
    assert.equal(changesBackendConfig({ backend: 'ai-sdk' }), true);
    assert.equal(changesBackendConfig({ llmConnectionSlug: 'a' }), true);
    assert.equal(changesBackendConfig({ model: 'm' }), true);
  });
});
