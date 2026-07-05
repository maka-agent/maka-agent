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
  test('anthropic-protocol sends thinking.budgetTokens only when a level is set', () => {
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-sonnet-4-5'), { anthropic: {} });
    const withLevel = buildProviderOptions(conn('anthropic'), 'claude-sonnet-4-5', 'high');
    assert.equal((withLevel.anthropic as { thinking: { type: string } }).thinking.type, 'enabled');
    assert.ok(((withLevel.anthropic as { thinking: { budgetTokens: number } }).thinking.budgetTokens) > 0);
  });

  test('openai gpt-5 sends reasoningEffort; gpt-4o ignores the level (no variants)', () => {
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-4o', 'high'), { openai: {} });
    const withLevel = buildProviderOptions(conn('openai'), 'gpt-5.5', 'medium');
    assert.equal((withLevel.openai as { reasoningEffort: string }).reasoningEffort, 'medium');
  });

  test('codex-subscription preserves store:false / textVerbosity and merges reasoningEffort', () => {
    const base = buildProviderOptions(conn('codex-subscription'), 'gpt-5-codex');
    assert.deepEqual(base, { openai: { store: false, textVerbosity: 'medium' } });
    const withLevel = buildProviderOptions(conn('codex-subscription'), 'gpt-5-codex', 'high');
    assert.equal((withLevel.openai as { reasoningEffort: string }).reasoningEffort, 'high');
    assert.equal((withLevel.openai as { store: boolean }).store, false);
    assert.equal((withLevel.openai as { textVerbosity: string }).textVerbosity, 'medium');
  });

  test('google preserves safetySettings and adds thinkingConfig for gemini-3 vs thinkingBudget for 2.5', () => {
    const g3 = buildProviderOptions(conn('google'), 'gemini-3-pro-preview', 'high');
    const g3Config = (g3.google as { thinkingConfig: { thinkingLevel?: string; thinkingBudget?: number } }).thinkingConfig;
    assert.equal(g3Config.thinkingLevel, 'high');
    assert.equal(g3Config.thinkingBudget, undefined);
    const g25 = buildProviderOptions(conn('google'), 'gemini-2.5-flash', 'low');
    const g25Config = (g25.google as { thinkingConfig: { thinkingBudget: number } }).thinkingConfig;
    assert.ok(g25Config.thinkingBudget > 0);
    // safetySettings survive the merge
    assert.ok((g25.google as { safetySettings: unknown[] }).safetySettings.length > 0);
  });

  test('openai-compatible family sends reasoningEffort under the provider namespace only when the model has variants', () => {
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-chat', 'low'), { deepseek: { reasoningEffort: 'low' } });
    assert.deepEqual(buildProviderOptions(conn('moonshot'), 'moonshot-v1-8k', 'high'), {});
    assert.deepEqual(buildProviderOptions(conn('openai-compatible', 'my-slug'), 'some-model', 'high'), {});
  });

  test('a level the model does not support is dropped (defensive)', () => {
    // gpt-4o has no variants; passing a level is a no-op.
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-4o', 'high'), { openai: {} });
  });

  test('off switches reasoning off: anthropic disabled, openai/codex reasoningEffort none', () => {
    const a = buildProviderOptions(conn('anthropic'), 'claude-sonnet-4-5', 'off');
    assert.equal((a.anthropic as { thinking: { type: string } }).thinking.type, 'disabled');
    const o = buildProviderOptions(conn('openai'), 'gpt-5.5', 'off');
    assert.equal((o.openai as { reasoningEffort: string }).reasoningEffort, 'none');
    const c = buildProviderOptions(conn('codex-subscription'), 'gpt-5-codex', 'off');
    assert.equal((c.openai as { reasoningEffort: string }).reasoningEffort, 'none');
    assert.equal((c.openai as { store: boolean }).store, false);
  });

  test('providers without a clean off switch drop off (their variants do not list it)', () => {
    // google / deepseek / zai do not list `off`, so the variants guard drops
    // it and reasoning_effort:'none' is never sent to them.
    const g = buildProviderOptions(conn('google'), 'gemini-3-pro-preview', 'off');
    assert.deepEqual((g.google as { thinkingConfig?: unknown }).thinkingConfig, undefined);
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-chat', 'off'), {});
    assert.deepEqual(buildProviderOptions(conn('zai-coding-plan', 'zai-coding-plan'), 'glm-4.6', 'off'), {});
  });
});

describe('buildProviderOptions: resolver/options drift guard', () => {
  // Every level a model declares in `thinkingVariantsForModel` must map to a
  // non-empty providerOptions fragment from `buildProviderOptions`. If the
  // resolver and the wire mapper drift (resolver lists a level the switch
  // never handles), this fails — guarding the coupling without merging them
  // into one declarative table.
  const cases: Array<{ providerType: LlmConnection['providerType']; model: string; slug?: string }> = [
    { providerType: 'anthropic', model: 'claude-sonnet-4-5' },
    { providerType: 'kimi-coding-plan', model: 'claude-sonnet-4-5' },
    { providerType: 'MiniMax', model: 'mb1' },
    { providerType: 'claude-subscription', model: 'claude-sonnet-4-5' },
    { providerType: 'openai', model: 'gpt-5.5' },
    { providerType: 'openai', model: 'gpt-4o' },
    { providerType: 'codex-subscription', model: 'gpt-5-codex' },
    { providerType: 'google', model: 'gemini-3-pro-preview' },
    { providerType: 'google', model: 'gemini-2.5-flash' },
    { providerType: 'google', model: 'gemini-2.0-flash' },
    { providerType: 'deepseek', model: 'deepseek-chat' },
    { providerType: 'moonshot', model: 'kimi-k2' },
    { providerType: 'zai-coding-plan', model: 'glm-4.6' },
    { providerType: 'ollama', model: 'llama3' },
    { providerType: 'openai-compatible', model: 'some-model', slug: 'my-slug' },
    { providerType: 'gemini-cli', model: 'gemini-2.5-pro' },
  ];
  for (const { providerType, model, slug } of cases) {
    test(`every declared level for ${providerType}/${model} maps to a non-empty fragment`, () => {
      const connection = conn(providerType, slug ?? providerType);
      for (const level of thinkingVariantsForModel(providerType, model)) {
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

describe('buildProviderOptions: openai-compatible namespace', () => {
  // The ai-sdk `@ai-sdk/openai-compatible` reads providerOptions under BOTH the
  // raw `name` (e.g. 'zai-coding-plan') and its camelCase form, merging raw
  // first then camelCase. We emit the raw dashed key, which the sdk reads on its
  // first `parseProviderOptions` pass, so `reasoning_effort` reaches the GLM
  // request body. This test pins the contract so the namespace is not silently
  // changed to camelCase (which the review P1-1 claimed was required).
  test('zai-coding-plan emits reasoningEffort under the raw dashed namespace', () => {
    const opts = buildProviderOptions(conn('zai-coding-plan', 'zai-coding-plan'), 'glm-4.6', 'high');
    assert.deepEqual(opts, { 'zai-coding-plan': { reasoningEffort: 'high' } });
  });
  test('deepseek / moonshot use their own raw namespaces', () => {
    assert.deepEqual(buildProviderOptions(conn('deepseek', 'deepseek'), 'deepseek-chat', 'high'), { deepseek: { reasoningEffort: 'high' } });
    assert.deepEqual(buildProviderOptions(conn('moonshot', 'moonshot'), 'kimi-k2', 'high'), { moonshot: { reasoningEffort: 'high' } });
  });
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