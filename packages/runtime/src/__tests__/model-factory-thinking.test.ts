import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
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