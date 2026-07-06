import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { lookupModelMetadata, resolveModelVisionSupport } from '../model-metadata.js';
import type { ModelInfo, ProviderType } from '../llm-connections.js';

describe('model-metadata vision capability', () => {
  it('reports vision true for vision-capable models', () => {
    assert.equal(lookupModelMetadata('anthropic', 'claude-sonnet-4-5-20250929').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('anthropic', 'claude-opus-4-8').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('openai', 'gpt-4o').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('openai', 'gpt-5.5').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('google', 'gemini-2.5-pro').capabilities?.vision, true);
    assert.equal(lookupModelMetadata('zai-coding-plan', 'glm-5v-turbo').capabilities?.vision, true);
  });

  it('reports vision false for text-only models', () => {
    assert.equal(lookupModelMetadata('deepseek', 'deepseek-chat').capabilities?.vision, false);
    assert.equal(lookupModelMetadata('zai-coding-plan', 'glm-5.2').capabilities?.vision, false);
    assert.equal(lookupModelMetadata('zai-coding-plan', 'glm-4.7').capabilities?.vision, false);
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
  });

  it('falls back to metadata when the model list is empty or missing', () => {
    assert.equal(resolveModelVisionSupport('zai-coding-plan' as ProviderType, [], 'glm-5v-turbo'), true);
    assert.equal(resolveModelVisionSupport('zai-coding-plan' as ProviderType, undefined, 'glm-5.2'), false);
  });
});
