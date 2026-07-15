import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildDefaultContextBudgetPolicy } from '@maka/runtime';

const ACTIVE_PRUNE_ENV_KEYS = [
  'MAKA_CONTEXT_BUDGET',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS',
  'MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER',
  'MAKA_CONTEXT_HISTORY_COMPACT',
  'MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS',
] as const;

const savedEnv: Record<string, string | undefined> = {};

function openaiConnection(): LlmConnection {
  return {
    providerType: 'openai',
    defaultModel: 'gpt-test',
    models: [{ id: 'gpt-test', contextWindow: 128_000 }],
  } as unknown as LlmConnection;
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

  test('enables automatic history compaction by default in read-write mode', () => {
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(policy?.historyCompact?.enabled, true);
    assert.equal(policy?.historyCompact?.mode, 'read_write');
    assert.equal(policy?.historyCompact?.highWaterRatio, 1);
    assert.equal(policy?.historyCompact?.minRecentTurns, 3);
    assert.equal(policy?.historyCompact?.tailEstimatedTokens, 16_384);
  });

  test('uses the selected model context window minus the default reserve as the history budget', () => {
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), {
      name: 'desktop-default-history-budget',
      modelId: 'gpt-test',
    });
    assert.equal(policy?.maxHistoryEstimatedTokens, 128_000 - 16_384);
  });

  test('uses model metadata when provider-fetched model entries omit the context window', () => {
    const policy = buildDefaultContextBudgetPolicy({
      providerType: 'openai',
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5' }],
    } as unknown as LlmConnection, {
      name: 'desktop-default-history-budget',
      modelId: 'gpt-5.5',
    });
    assert.equal(policy?.maxHistoryEstimatedTokens, 1_050_000 - 16_384);
  });

  test('uses provider-specific metadata for Codex subscription models', () => {
    const policy = buildDefaultContextBudgetPolicy({
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5' }],
    } as unknown as LlmConnection, {
      name: 'desktop-default-history-budget',
      modelId: 'gpt-5.5',
    });
    assert.equal(policy?.maxHistoryEstimatedTokens, 272_000 - 16_384);
  });

  test('uses metadata for known DeepSeek models but keeps unknown DeepSeek models unbounded', () => {
    const knownPolicy = buildDefaultContextBudgetPolicy({
      providerType: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      models: [{ id: 'deepseek-v4-flash' }],
    } as unknown as LlmConnection, {
      name: 'desktop-default-history-budget',
      modelId: 'deepseek-v4-flash',
    });
    assert.equal(knownPolicy?.maxHistoryEstimatedTokens, 1_000_000 - 16_384);

    const unknownPolicy = buildDefaultContextBudgetPolicy({
      providerType: 'deepseek',
      defaultModel: 'custom-deepseek-model',
      models: [{ id: 'custom-deepseek-model' }],
    } as unknown as LlmConnection, {
      name: 'desktop-default-history-budget',
      modelId: 'custom-deepseek-model',
    });
    assert.equal(unknownPolicy?.maxHistoryEstimatedTokens, undefined);
  });

  test('respects the automatic compact reserve env override', () => {
    process.env.MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS = '4096';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), {
      name: 'desktop-default-history-budget',
      modelId: 'gpt-test',
    });
    assert.equal(policy?.maxHistoryEstimatedTokens, 128_000 - 4096);
  });
});

const STALE_PRUNE_ENV_KEYS = [
  'MAKA_CONTEXT_BUDGET',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS',
  'MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS',
  'MAKA_CONTEXT_MIN_RECENT_TURNS',
] as const;

describe('desktop staleToolResultPrune policy', () => {
  const savedStaleEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of STALE_PRUNE_ENV_KEYS) {
      savedStaleEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of STALE_PRUNE_ENV_KEYS) {
      if (savedStaleEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedStaleEnv[key];
    }
  });

  test('is enabled by default with the measured 2048-token threshold', () => {
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(policy?.staleToolResultPrune?.enabled, true);
    assert.equal(policy?.staleToolResultPrune?.maxResultEstimatedTokens, 2048);
    assert.equal(policy?.staleToolResultPrune?.minRecentTurnsFull, 2);
  });

  test('can be disabled with explicit false', () => {
    process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE = 'false';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(policy?.staleToolResultPrune, undefined);
  });

  test('can be disabled with explicit off', () => {
    process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE = 'off';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(policy?.staleToolResultPrune, undefined);
  });

  test('accepts standard truthy values as enabled', () => {
    process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE = 'true';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(policy?.staleToolResultPrune?.enabled, true);
  });

  test('rejects malformed boolean values instead of silently disabling', () => {
    process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE = 'maybe';
    assert.throws(
      () => buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' }),
      /MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE must be a boolean/,
    );
  });

  test('respects max result estimated tokens env', () => {
    process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS = '4096';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(policy?.staleToolResultPrune?.maxResultEstimatedTokens, 4096);
  });

  test('respects min recent turns full env with MAKA_CONTEXT_MIN_RECENT_TURNS fallback', () => {
    process.env.MAKA_CONTEXT_MIN_RECENT_TURNS = '3';
    const fallbackPolicy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(fallbackPolicy?.staleToolResultPrune?.minRecentTurnsFull, 3);

    process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS = '5';
    const explicitPolicy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(explicitPolicy?.staleToolResultPrune?.minRecentTurnsFull, 5);
  });

  test('MAKA_CONTEXT_BUDGET=off disables the whole policy including staleToolResultPrune', () => {
    process.env.MAKA_CONTEXT_BUDGET = 'off';
    const policy = buildDefaultContextBudgetPolicy(openaiConnection(), { name: 'desktop-default-history-budget' });
    assert.equal(policy, undefined);
  });
});
