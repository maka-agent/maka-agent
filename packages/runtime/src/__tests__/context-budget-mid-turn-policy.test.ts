import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { buildDefaultContextBudgetPolicy } from '../context-budget-policy.js';

describe('mid-turn history compact policy env plumbing', () => {
  test('defaults off: no midTurn subconfig without an explicit opt-in', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: { MAKA_CONTEXT_HISTORY_COMPACT: 'on' },
    });
    assert.equal(policy?.historyCompact?.enabled, true);
    assert.equal(policy?.historyCompact?.midTurn, undefined);
  });

  test('opts in with MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN=on and the shared reserve', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: {
        MAKA_CONTEXT_HISTORY_COMPACT: 'on',
        MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN: 'on',
      },
    });
    assert.deepEqual(policy?.historyCompact?.midTurn, { enabled: true, reserveTokens: 16_384 });
  });

  test('honors explicit reserve and tail-event overrides', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: {
        MAKA_CONTEXT_HISTORY_COMPACT: 'on',
        MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN: 'on',
        MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS: '8000',
        MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN_TAIL_EVENTS: '2',
      },
    });
    assert.deepEqual(policy?.historyCompact?.midTurn, {
      enabled: true,
      reserveTokens: 8_000,
      reserveTailEvents: 2,
    });
  });

  test('mid_turn=off keeps it disabled even with history compact on', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: {
        MAKA_CONTEXT_HISTORY_COMPACT: 'on',
        MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN: 'off',
      },
    });
    assert.equal(policy?.historyCompact?.midTurn, undefined);
  });
});

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
