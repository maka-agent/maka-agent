import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildDefaultContextBudgetPolicy } from '@maka/runtime';

const ACTIVE_PRUNE_ENV_KEYS = [
  'MAKA_CONTEXT_BUDGET',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER',
] as const;

const savedEnv: Record<string, string | undefined> = {};

function openaiConnection(): LlmConnection {
  return { providerType: 'openai' } as unknown as LlmConnection;
}

describe('desktop activeToolResultPrune policy', () => {
  beforeEach(() => {
    for (const key of ACTIVE_PRUNE_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ACTIVE_PRUNE_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test('is enabled by default with the measured 2048-token threshold', () => {
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: "desktop-default-history-budget" });
    assert.equal(policy?.activeToolResultPrune?.enabled, true);
    assert.equal(policy?.activeToolResultPrune?.maxCurrentResultEstimatedTokens, 2048);
    assert.equal(policy?.activeToolResultPrune?.minStepNumber, 1);
  });

  test('can be disabled with explicit false', () => {
    process.env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE = 'false';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: "desktop-default-history-budget" });
    assert.equal(policy?.activeToolResultPrune, undefined);
  });

  test('can be disabled with explicit off', () => {
    process.env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE = 'off';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: "desktop-default-history-budget" });
    assert.equal(policy?.activeToolResultPrune, undefined);
  });

  test('respects max current result estimated tokens env', () => {
    process.env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS = '4096';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: "desktop-default-history-budget" });
    assert.equal(policy?.activeToolResultPrune?.maxCurrentResultEstimatedTokens, 4096);
  });

  test('respects min step number env', () => {
    process.env.MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER = '3';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: "desktop-default-history-budget" });
    assert.equal(policy?.activeToolResultPrune?.minStepNumber, 3);
  });

  test('MAKA_CONTEXT_BUDGET=off disables the whole policy including activeToolResultPrune', () => {
    process.env.MAKA_CONTEXT_BUDGET = 'off';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: "desktop-default-history-budget" });
    assert.equal(policy, undefined);
  });
});