import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  THINKING_LEVELS,
  isThinkingLevel,
  thinkingVariantsForModel,
} from '../model-thinking.js';

describe('thinkingVariantsForModel', () => {
  test('anthropic-protocol providers expose low/medium/high', () => {
    for (const providerType of ['anthropic', 'kimi-coding-plan', 'MiniMax', 'MiniMax-cn', 'claude-subscription'] as const) {
      assert.deepEqual([...thinkingVariantsForModel(providerType, 'claude-sonnet-4-5')], ['low', 'medium', 'high']);
    }
  });

  test('openai gpt-5 family exposes minimal/low/medium/high; gpt-4o exposes none', () => {
    assert.deepEqual([...thinkingVariantsForModel('openai', 'gpt-5.5')], ['minimal', 'low', 'medium', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('openai', 'gpt-4o')], []);
  });

  test('codex subscription exposes minimal/low/medium/high', () => {
    assert.deepEqual([...thinkingVariantsForModel('codex-subscription', 'gpt-5-codex')], ['minimal', 'low', 'medium', 'high']);
  });

  test('gemini 2.5/3 expose low/medium/high; older gemini exposes none', () => {
    assert.deepEqual([...thinkingVariantsForModel('google', 'gemini-3-pro-preview')], ['low', 'medium', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('google', 'gemini-2.5-flash')], ['low', 'medium', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('google', 'gemini-2.0-flash')], []);
  });

  test('deepseek/moonshot-kimi/zai-glm expose low/medium/high on reasoning ids', () => {
    assert.deepEqual([...thinkingVariantsForModel('deepseek', 'deepseek-chat')], ['low', 'medium', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('moonshot', 'kimi-k2')], ['low', 'medium', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('zai-coding-plan', 'glm-4.6')], ['low', 'medium', 'high']);
  });

  test('ollama / openai-compatible / gemini-cli expose none (cannot infer)', () => {
    assert.deepEqual([...thinkingVariantsForModel('ollama', 'llama3')], []);
    assert.deepEqual([...thinkingVariantsForModel('openai-compatible', 'some-custom-model')], []);
    assert.deepEqual([...thinkingVariantsForModel('gemini-cli', 'gemini-2.5-pro')], []);
  });

  test('moonshot non-kimi id exposes none', () => {
    assert.deepEqual([...thinkingVariantsForModel('moonshot', 'moonshot-v1-8k')], []);
  });
});

describe('isThinkingLevel / THINKING_LEVELS', () => {
  test('accepts the canonical levels and rejects others', () => {
    for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
    assert.equal(isThinkingLevel('xhigh'), false);
    assert.equal(isThinkingLevel('off'), false);
    assert.equal(isThinkingLevel(undefined), false);
    assert.equal(isThinkingLevel(123), false);
  });
});