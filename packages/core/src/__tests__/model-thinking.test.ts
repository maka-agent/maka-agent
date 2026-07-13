import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  THINKING_LEVELS,
  deriveThinkingChoices,
  isThinkingLevel,
  thinkingOptionsForModel,
  thinkingVariantsForModel,
} from '../model-thinking.js';

describe('deriveThinkingChoices', () => {
  test('effort "none" surfaces as off; other efforts map to same-named levels', () => {
    // gpt-5.5: efforts [none,low,medium,high,xhigh]
    assert.deepEqual([...deriveThinkingChoices({ efforts: ['none', 'low', 'medium', 'high', 'xhigh'] })], ['off', 'low', 'medium', 'high', 'xhigh']);
  });

  test('toggle alone does not expose off; only declared wireable off behavior does', () => {
    // deepseek-v4-flash: models.dev has toggle + efforts [high,max], but the
    // openai-compatible adapter has no real disabled wire, so UI must not show off.
    assert.deepEqual([...deriveThinkingChoices({ efforts: ['high', 'max'], toggle: true })], ['high', 'max']);
    assert.deepEqual([...deriveThinkingChoices({ toggle: true, offBehavior: 'google-thinking-budget-zero' })], ['off']);
  });

  test('efforts without none or toggle expose no off (gpt-5 cannot disable)', () => {
    assert.deepEqual([...deriveThinkingChoices({ efforts: ['minimal', 'low', 'medium', 'high'] })], ['minimal', 'low', 'medium', 'high']);
  });

  test('toggle-only model without a declared off wire exposes no choices', () => {
    assert.deepEqual([...deriveThinkingChoices({ toggle: true })], []);
  });

  test('effort model with no toggle and no none exposes no off (claude-opus-4-8)', () => {
    assert.deepEqual([...deriveThinkingChoices({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })], ['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('toggle + full effort set exposes off only when a real off wire is declared', () => {
    assert.deepEqual(
      [...deriveThinkingChoices({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'], toggle: true, offBehavior: 'anthropic-thinking-disabled' })],
      ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
  });

  test('unknown effort values are dropped (not in ThinkingLevel)', () => {
    assert.deepEqual([...deriveThinkingChoices({ efforts: ['low', 'turbo', 'max'] })], ['low', 'max']);
  });

  test('undefined options (miss) yields empty list', () => {
    assert.deepEqual([...deriveThinkingChoices(undefined)], []);
  });

  test('empty options yields empty list', () => {
    assert.deepEqual([...deriveThinkingChoices({})], []);
  });

  test('choices are returned in THINKING_LEVELS display order regardless of input order', () => {
    assert.deepEqual([...deriveThinkingChoices({ efforts: ['max', 'low', 'high'] })], ['low', 'high', 'max']);
  });
});

describe('thinkingOptionsForModel', () => {
  test('StepFun Step Plan declares official effort levels per exact model id', () => {
    assert.deepEqual(thinkingOptionsForModel('stepfun-step-plan', 'step-3.7-flash'), {
      efforts: ['low', 'medium', 'high'],
    });
    assert.deepEqual(thinkingOptionsForModel('stepfun-step-plan', 'step-3.5-flash-2603'), {
      efforts: ['low', 'high'],
    });
    assert.equal(thinkingOptionsForModel('stepfun-step-plan', 'step-router-v1'), undefined);
  });

  test('openai gpt-5.5 exposes none/low/medium/high/xhigh; gpt-5 exposes minimal/low/medium/high', () => {
    assert.deepEqual(thinkingOptionsForModel('openai', 'gpt-5.5'), { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] });
    assert.deepEqual(thinkingOptionsForModel('openai', 'gpt-5'), { efforts: ['minimal', 'low', 'medium', 'high'] });
  });

  test('openai gpt-4o (non-reasoning) has no thinking options', () => {
    assert.equal(thinkingOptionsForModel('openai', 'gpt-4o'), undefined);
  });

  test('zai glm-5.2 exposes high/max (not low/medium); glm-4.5-air is toggle-only', () => {
    assert.deepEqual(thinkingOptionsForModel('zai-coding-plan', 'glm-5.2'), { efforts: ['high', 'max'] });
    assert.deepEqual(thinkingOptionsForModel('zai-coding-plan', 'glm-4.5-air'), { toggle: true });
  });

  test('anthropic claude-opus-4-8 exposes efforts without toggle (cannot disable); fable-5 same', () => {
    assert.deepEqual(thinkingOptionsForModel('anthropic', 'claude-opus-4-8'), { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    assert.deepEqual(thinkingOptionsForModel('anthropic', 'claude-fable-5'), { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  });

  test('anthropic claude-haiku-4.5 is budget-only but can disable (toggle); sonnet-4-5 same', () => {
    assert.deepEqual(thinkingOptionsForModel('anthropic', 'claude-haiku-4-5'), { toggle: true, offBehavior: 'anthropic-thinking-disabled' });
    assert.deepEqual(thinkingOptionsForModel('anthropic', 'claude-sonnet-4-5'), { toggle: true, offBehavior: 'anthropic-thinking-disabled' });
  });

  test('anthropic non-reasoning (3.5 sonnet) has no thinking options', () => {
    assert.equal(thinkingOptionsForModel('anthropic', 'claude-3-5-sonnet-20241022'), undefined);
  });

  test('google gemini-3.5-flash exposes efforts; gemini-3-pro-preview exposes low/high only', () => {
    assert.deepEqual(thinkingOptionsForModel('google', 'gemini-3.5-flash'), { efforts: ['minimal', 'low', 'medium', 'high'] });
    assert.deepEqual(thinkingOptionsForModel('google', 'gemini-3-pro-preview'), { efforts: ['low', 'high'] });
  });

  test('google gemini-2.5-pro (budget-only, no toggle) has no thinking options; 2.5-flash is toggle-only', () => {
    assert.equal(thinkingOptionsForModel('google', 'gemini-2.5-pro'), undefined);
    assert.deepEqual(thinkingOptionsForModel('google', 'gemini-2.5-flash'), { toggle: true, offBehavior: 'google-thinking-budget-zero' });
  });

  test('deepseek-v4-flash records toggle + high/max efforts but exposes only wireable efforts', () => {
    assert.deepEqual(thinkingOptionsForModel('deepseek', 'deepseek-v4-flash'), { efforts: ['high', 'max'], toggle: true });
  });

  test('claude-subscription inherits anthropic thinking options (displayMetadataOnly preserves them)', () => {
    assert.deepEqual(thinkingOptionsForModel('claude-subscription', 'claude-opus-4-8'), { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    assert.deepEqual(thinkingOptionsForModel('claude-subscription', 'claude-haiku-4-5'), { toggle: true, offBehavior: 'anthropic-thinking-disabled' });
  });

  test('miss (unknown provider/model) returns undefined', () => {
    assert.equal(thinkingOptionsForModel('ollama', 'llama3'), undefined);
    assert.equal(thinkingOptionsForModel('openai', 'unknown-model'), undefined);
  });
});

describe('thinkingVariantsForModel', () => {
  test('openai gpt-5.5 exposes off/low/medium/high/xhigh; gpt-5 minimal/low/medium/high; gpt-4o none', () => {
    assert.deepEqual([...thinkingVariantsForModel('openai', 'gpt-5.5')], ['off', 'low', 'medium', 'high', 'xhigh']);
    assert.deepEqual([...thinkingVariantsForModel('openai', 'gpt-5')], ['minimal', 'low', 'medium', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('openai', 'gpt-4o')], []);
  });

  test('anthropic opus-4-8 exposes efforts (no off, cannot disable); haiku-4-5 off only; sonnet-4-5 off only; non-reasoning none', () => {
    assert.deepEqual([...thinkingVariantsForModel('anthropic', 'claude-opus-4-8')], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual([...thinkingVariantsForModel('anthropic', 'claude-haiku-4-5')], ['off']);
    assert.deepEqual([...thinkingVariantsForModel('anthropic', 'claude-sonnet-4-5')], ['off']);
    assert.deepEqual([...thinkingVariantsForModel('anthropic', 'claude-3-5-sonnet-20241022')], []);
  });

  test('google gemini-3-pro-preview low/high; 3.5-flash minimal/low/medium/high; 2.5-flash off only via budget zero; 2.5-pro/2.0-flash none', () => {
    assert.deepEqual([...thinkingVariantsForModel('google', 'gemini-3-pro-preview')], ['low', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('google', 'gemini-3.5-flash')], ['minimal', 'low', 'medium', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('google', 'gemini-2.5-flash')], ['off']);
    assert.deepEqual([...thinkingVariantsForModel('google', 'gemini-2.5-pro')], []);
    assert.deepEqual([...thinkingVariantsForModel('google', 'gemini-2.0-flash')], []);
  });

  test('deepseek-v4-flash exposes high/max only because openai-compatible has no off wire; deepseek-chat none', () => {
    assert.deepEqual([...thinkingVariantsForModel('deepseek', 'deepseek-v4-flash')], ['high', 'max']);
    assert.deepEqual([...thinkingVariantsForModel('deepseek', 'deepseek-chat')], []);
  });

  test('Tencent Token Plan HY 3 models expose the documented low/medium/high efforts', () => {
    assert.deepEqual([...thinkingVariantsForModel('tencent-token-plan', 'hy3')], ['low', 'medium', 'high']);
    assert.deepEqual([...thinkingVariantsForModel('tencent-token-plan', 'hy3-preview')], ['low', 'medium', 'high']);
  });

  test('zai glm-5.2 high/max; toggle-only GLM models expose none until an off wire is declared', () => {
    assert.deepEqual([...thinkingVariantsForModel('zai-coding-plan', 'glm-5.2')], ['high', 'max']);
    assert.deepEqual([...thinkingVariantsForModel('zai-coding-plan', 'glm-5.1')], []);
    assert.deepEqual([...thinkingVariantsForModel('zai-coding-plan', 'glm-4.5-air')], []);
  });

  test('codex-subscription inherits openai gpt-5.5 thinking options', () => {
    assert.deepEqual([...thinkingVariantsForModel('codex-subscription', 'gpt-5.5')], ['off', 'low', 'medium', 'high', 'xhigh']);
  });

  test('claude-subscription inherits anthropic thinking options', () => {
    assert.deepEqual([...thinkingVariantsForModel('claude-subscription', 'claude-opus-4-8')], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual([...thinkingVariantsForModel('claude-subscription', 'claude-haiku-4-5')], ['off']);
  });

  test('providers without metadata yield none (miss → no menu)', () => {
    assert.deepEqual([...thinkingVariantsForModel('ollama', 'llama3')], []);
    assert.deepEqual([...thinkingVariantsForModel('openai-compatible', 'some-model')], []);
    assert.deepEqual([...thinkingVariantsForModel('gemini-cli', 'gemini-2.5-pro')], []);
    assert.deepEqual([...thinkingVariantsForModel('moonshot', 'kimi-k2')], []);
  });
});

describe('isThinkingLevel / THINKING_LEVELS', () => {
  test('accepts the canonical levels and rejects others', () => {
    for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
    assert.equal(isThinkingLevel('xhigh'), true);
    assert.equal(isThinkingLevel('default'), false);
    assert.equal(isThinkingLevel(undefined), false);
    assert.equal(isThinkingLevel(123), false);
  });
});
