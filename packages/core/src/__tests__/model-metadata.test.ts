import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { lookupModelMetadata, resolveModelVisionSupport } from '../model-metadata.js';
import { PROVIDER_DEFAULTS, type ModelInfo, type ProviderType } from '../llm-connections.js';

describe('model-metadata vision capability', () => {
  it('uses Volcengine Coding Plan model facts for its exact fallback allowlist', () => {
    for (const modelId of PROVIDER_DEFAULTS['volcengine-coding-plan'].fallbackModels) {
      assert.equal(
        lookupModelMetadata('volcengine-coding-plan', modelId).capabilities?.functionCalling,
        true,
        modelId,
      );
    }

    const kimi = lookupModelMetadata('volcengine-coding-plan', 'kimi-k2.7-code');
    assert.equal(kimi.capabilities?.vision, true);
    assert.equal(kimi.capabilities?.reasoning, true);
    assert.equal(kimi.contextWindow, 256_000);
    assert.equal(kimi.maxOutputTokens, 32_000);
  });

  it('reuses MiniMax snapshot facts for the Coding Plan access path', () => {
    assert.deepEqual(
      lookupModelMetadata('minimax-coding-plan', 'MiniMax-M3'),
      lookupModelMetadata('MiniMax', 'MiniMax-M3'),
    );
    assert.equal(lookupModelMetadata('minimax-coding-plan', 'MiniMax-M3').capabilities?.vision, true);
  });

  it('uses synchronized facts while preserving access-path overrides', () => {
    const metadata = lookupModelMetadata('anthropic', 'claude-sonnet-4-5');
    assert.equal(metadata.contextWindow, 200_000);
    assert.equal(lookupModelMetadata('anthropic', 'claude-sonnet-4-5-20250929').contextWindow, 200_000);
    assert.deepEqual(metadata.thinkingOptions, { toggle: true, offBehavior: 'anthropic-thinking-disabled' });
  });

  it('reports vision true for vision-capable models', () => {
    assert.equal(lookupModelMetadata('anthropic', 'claude-sonnet-4-5-20250929').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('anthropic', 'claude-opus-4-8').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('openai', 'gpt-4o').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('openai', 'gpt-5.5').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('google', 'gemini-2.5-pro').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('zai-coding-plan', 'glm-5v-turbo').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('moonshot', 'kimi-k2.6').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('kimi-coding-plan', 'kimi-for-coding').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('kimi-coding-plan', 'kimi-for-coding-highspeed').capabilities?.vision, true);
  });

  it('reports vision false for text-only models', () => {
    assert.equal(lookupModelMetadata('deepseek', 'deepseek-chat').capabilities?.vision, false);
    assert.equal(lookupModelMetadata('zai-coding-plan', 'glm-5.2').capabilities?.vision, false);
    assert.equal(lookupModelMetadata('zai-coding-plan', 'glm-4.7').capabilities?.vision, false);
  });

  it('keeps Tencent Coding Plan text-only even when an upstream model supports vision elsewhere', () => {
    const capabilities = lookupModelMetadata('tencent-coding-plan', 'kimi-k2.5').capabilities;
    assert.equal(capabilities?.vision, false);
    assert.equal(capabilities?.reasoning, true);
    assert.equal(capabilities?.functionCalling, true);
    assert.equal(
      resolveModelVisionSupport('tencent-coding-plan', [{ id: 'kimi-k2.5' }], 'kimi-k2.5'),
      false,
    );
  });

  it('keeps complete metadata for every Codex subscription model alias', () => {
    for (const modelId of PROVIDER_DEFAULTS['openai-codex'].fallbackModels) {
      const metadata = lookupModelMetadata('openai-codex', modelId);
      assert.ok(metadata.displayName);
      assert.equal(metadata.capabilities?.vision, true);
    }
  });
});

describe('resolveModelVisionSupport', () => {
  it('returns stored vision when the connection model declares it', () => {
    const visionTrue: ModelInfo[] = [{ id: 'gpt-4o', capabilities: { vision: true } }];
    assert.equal(resolveModelVisionSupport('openai', visionTrue, 'gpt-4o'), true);
    const textOnly: ModelInfo[] = [{ id: 'gpt-4o', capabilities: { vision: false } }];
    assert.equal(resolveModelVisionSupport('openai', textOnly, 'gpt-4o'), false);
  });

  it('falls back to in-repo metadata when stored models are bare ids (post-fetch)', () => {
    assert.equal(resolveModelVisionSupport('anthropic', [{ id: 'claude-sonnet-4-5-20250929' }], 'claude-sonnet-4-5-20250929'), true);
    assert.equal(resolveModelVisionSupport('deepseek', [{ id: 'deepseek-chat' }], 'deepseek-chat'), false);
    assert.equal(resolveModelVisionSupport('moonshot', [{ id: 'kimi-k2.6' }], 'kimi-k2.6'), true);
    assert.equal(resolveModelVisionSupport('kimi-coding-plan', [{ id: 'kimi-for-coding' }], 'kimi-for-coding'), true);
  });

  it('falls back to metadata when the model list is empty or missing', () => {
    assert.equal(resolveModelVisionSupport('zai-coding-plan' as ProviderType, [], 'glm-5v-turbo'), true);
    assert.equal(resolveModelVisionSupport('zai-coding-plan' as ProviderType, undefined, 'glm-5.2'), false);
  });
});
