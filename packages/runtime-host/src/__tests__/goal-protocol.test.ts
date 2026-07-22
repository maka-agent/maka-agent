import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  encodeGoalClearResult,
  encodeGoalQueryResult,
  GOAL_CONDITION_MAX_BYTES,
  GOAL_REASON_MAX_BYTES,
  GOAL_RESULT_MAX_BYTES,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
} from '../protocol/index.js';
import {
  createUnavailableDomainOperationHandlers,
  type GoalOperationHandlerMap,
} from '../server/operation-dispatcher.js';

const GOAL_STATUSES = [
  'active',
  'waiting',
  'achieved',
  'impossible',
  'cleared',
  'paused',
  'stalled',
  'budget_limited',
  'max_iterations',
] as const;

describe('Goal protocol', () => {
  test('registers the closed query and clear family with typed handler keys', () => {
    const query = HOST_OPERATION_SPECS['goal.query'];
    assert.equal(query.mode, 'query');
    assert.equal(query.retry, 'safe');
    assert.equal(query.admission, 'session');
    assert.deepEqual(query.errors, [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'invalid_request',
      'internal_failure',
    ]);

    const clear = HOST_OPERATION_SPECS['goal.clear'];
    assert.equal(clear.mode, 'command');
    assert.equal(clear.retry, 'semantic');
    assert.equal(clear.admission, 'session');
    assert.deepEqual(clear.errors, [...query.errors, 'not_found', 'operation_conflict']);
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter((key) => key.startsWith('goal.')),
      ['goal.query', 'goal.clear'],
    );

    const handlers = createUnavailableDomainOperationHandlers();
    assert.equal(typeof handlers['goal.query'], 'function');
    assert.equal(typeof handlers['goal.clear'], 'function');
    const typed = {
      'goal.query': async () => ({ ok: true as const, result: { kind: 'none' as const } }),
      'goal.clear': async () => ({
        ok: true as const,
        result: { kind: 'unchanged' as const, goal: goalForStatus('cleared') },
      }),
    } satisfies GoalOperationHandlerMap;
    assert.deepEqual(Object.keys(typed), ['goal.query', 'goal.clear']);
  });

  test('roundtrips exact inputs and every producer-reachable Goal status', () => {
    assert.deepEqual(goalRequest('goal.query', { sessionId: 'session-1' }).input, {
      sessionId: 'session-1',
    });
    assert.deepEqual(
      goalRequest('goal.clear', { sessionId: 'session-1', goalId: 'goal-1' }).input,
      { sessionId: 'session-1', goalId: 'goal-1' },
    );
    assert.deepEqual(goalResponse('goal.query', { kind: 'none' }).result, { kind: 'none' });

    for (const status of GOAL_STATUSES) {
      const result = { kind: 'item' as const, goal: goalForStatus(status) };
      const encoded = encodeGoalQueryResult(result);
      assert.deepEqual(encoded, result);
      assert.deepEqual(goalResponse('goal.query', encoded).result, result);
    }

    const cleared = goalForStatus('cleared');
    const clearedResult = encodeGoalClearResult({ kind: 'cleared', goal: cleared });
    assert.deepEqual(goalResponse('goal.clear', clearedResult).result, {
      kind: 'cleared',
      goal: cleared,
    });
    const repeatedResult = encodeGoalClearResult({ kind: 'unchanged', goal: cleared });
    assert.deepEqual(goalResponse('goal.clear', repeatedResult).result, {
      kind: 'unchanged',
      goal: cleared,
    });
    const achieved = goalForStatus('achieved');
    const terminalResult = encodeGoalClearResult({ kind: 'unchanged', goal: achieved });
    assert.deepEqual(goalResponse('goal.clear', terminalResult).result, {
      kind: 'unchanged',
      goal: achieved,
    });
  });

  test('projects unbounded producer reasons with an explicit wire truncation marker', () => {
    const overBudgetPrefix = '\u0000'.repeat(Math.floor(GOAL_REASON_MAX_BYTES / 6) + 1);
    const longReason = `${overBudgetPrefix}tail-a`;
    const paused = goalForStatus('paused', { lastReason: longReason });
    const query = encodeGoalQueryResult({ kind: 'item', goal: paused });
    assert.equal(query.kind, 'item');
    assert.ok(query.kind === 'item');
    assert.equal(query.goal.lastReasonTruncated, true);
    assert.equal(longReason.startsWith(query.goal.lastReason ?? ''), true);
    assert.ok((query.goal.lastReason?.length ?? 0) < longReason.length);
    assert.ok(Buffer.byteLength(JSON.stringify(query), 'utf8') <= GOAL_RESULT_MAX_BYTES);
    assert.deepEqual(goalResponse('goal.query', query).result, query);

    const differentTail = encodeGoalQueryResult({
      kind: 'item',
      goal: goalForStatus('paused', { lastReason: `${overBudgetPrefix}tail-b` }),
    });
    assert.equal(differentTail.kind, 'item');
    assert.ok(differentTail.kind === 'item');
    assert.equal(differentTail.goal.lastReason, query.goal.lastReason);

    const cleared = { ...paused, status: 'cleared' as const, revision: paused.revision + 1 };
    const clear = encodeGoalClearResult({ kind: 'cleared', goal: cleared });
    assert.equal(clear.goal.lastReasonTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(clear), 'utf8') <= GOAL_RESULT_MAX_BYTES);
    assert.deepEqual(goalResponse('goal.clear', clear).result, clear);
  });

  test('rejects unknown fields and invalid scalar or optional fields', () => {
    for (const [operation, input] of [
      ['goal.query', { sessionId: 'session-1', goalId: 'unexpected' }],
      ['goal.clear', { sessionId: 'session-1', goalId: 'goal-1', revision: 1 }],
      ['goal.clear', { sessionId: '../outside', goalId: 'goal-1' }],
    ] as const) {
      assert.throws(() => goalRequest(operation, input), isInvalidFrame);
    }

    const goal = goalForStatus('active');
    for (const invalidGoal of [
      { ...goal, internalLease: {} },
      { ...goal, status: 'running' },
      { ...goal, revision: -1 },
      { ...goal, maxIterations: 0 },
      { ...goal, blockCap: 0 },
      { ...goal, tokensNow: goal.tokensAtStart - 1 },
      { ...goal, tokensBaselinePending: 0 },
      { ...goal, setAt: Number.NaN },
      { ...goal, condition: '' },
      { ...goal, condition: '界'.repeat(Math.floor(GOAL_CONDITION_MAX_BYTES / 3) + 1) },
      { ...goal, tokenBudget: 0 },
      { ...goal, tokenBudget: undefined },
      { ...goal, lastReason: '界'.repeat(Math.floor(GOAL_REASON_MAX_BYTES / 3) + 1) },
      { ...goal, lastReasonTruncated: false },
      { ...withoutField(goal, 'lastReason'), lastReasonTruncated: true },
      { ...goal, achievedAt: null },
      { ...goal, pausedAt: -1 },
    ]) {
      assert.throws(
        () => goalResponse('goal.query', { kind: 'item', goal: invalidGoal }),
        isInvalidFrame,
      );
    }

    assert.throws(() => goalResponse('goal.query', { kind: 'none', goal: null }), isInvalidFrame);
    assert.throws(() => goalResponse('goal.clear', { kind: 'removed', goal }), isInvalidFrame);
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'goal-error',
          operation: 'goal.query',
          ok: false,
          error: { code: 'not_found', message: 'none already expresses absence' },
        }),
      isInvalidFrame,
    );
  });

  test('rejects Goal state-machine shapes that GoalManager cannot produce', () => {
    const active = goalForStatus('active');
    const achieved = goalForStatus('achieved');
    const paused = goalForStatus('paused');
    const waiting = goalForStatus('waiting');
    const stalled = goalForStatus('stalled');
    const budgetLimited = goalForStatus('budget_limited');
    const maxIterations = goalForStatus('max_iterations');

    for (const invalidGoal of [
      { ...active, achievedAt: 300 },
      withoutField(achieved, 'achievedAt'),
      { ...active, pausedAt: 300 },
      withoutField(paused, 'pausedAt'),
      withoutField(waiting, 'lastReason'),
      withoutField(achieved, 'lastReason'),
      { ...active, iterations: active.maxIterations },
      { ...maxIterations, iterations: maxIterations.maxIterations - 1 },
      { ...maxIterations, iterations: maxIterations.maxIterations + 1 },
      { ...active, consecutiveNoProgress: active.blockCap },
      { ...stalled, consecutiveNoProgress: stalled.blockCap - 1 },
      { ...active, consecutiveNoProgress: active.iterations + 1 },
      { ...active, revision: active.iterations - 1 },
      withoutField(active, 'lastReason'),
      {
        ...active,
        revision: 1,
        iterations: 0,
        consecutiveNoProgress: 0,
        tokensNow: active.tokensAtStart,
      },
      {
        ...waiting,
        revision: 1,
        iterations: 0,
        consecutiveNoProgress: 0,
        tokensBaselinePending: true,
        tokensNow: waiting.tokensAtStart,
      },
      { ...budgetLimited, tokenBudget: undefined },
      {
        ...budgetLimited,
        tokensNow: budgetLimited.tokensAtStart + 999,
      },
      { ...active, tokenBudget: 1_000, tokensNow: active.tokensAtStart + 1_000 },
      { ...active, tokensBaselinePending: true, tokensNow: active.tokensAtStart + 1 },
      {
        ...active,
        revision: 0,
        iterations: 0,
        consecutiveNoProgress: 0,
        tokensBaselinePending: true,
        tokensNow: active.tokensAtStart,
      },
    ]) {
      assert.throws(
        () => goalResponse('goal.query', { kind: 'item', goal: invalidGoal }),
        isInvalidFrame,
      );
    }

    assert.doesNotThrow(() =>
      goalResponse('goal.query', {
        kind: 'item',
        goal: goalForStatus('paused', { lastReason: '' }),
      }),
    );
    assert.doesNotThrow(() =>
      goalResponse('goal.query', { kind: 'item', goal: goalForStatus('cleared') }),
    );
  });

  test('binds clear result discriminators to the actual idempotent handler outcomes', () => {
    for (const result of [
      { kind: 'cleared', goal: goalForStatus('active') },
      { kind: 'cleared', goal: goalForStatus('achieved') },
      { kind: 'unchanged', goal: goalForStatus('active') },
      { kind: 'unchanged', goal: goalForStatus('waiting') },
      { kind: 'unchanged', goal: goalForStatus('paused') },
    ]) {
      assert.throws(() => goalResponse('goal.clear', result), isInvalidFrame);
    }

    assert.doesNotThrow(() =>
      goalResponse('goal.clear', { kind: 'unchanged', goal: goalForStatus('cleared') }),
    );
    for (const status of [
      'achieved',
      'impossible',
      'stalled',
      'budget_limited',
      'max_iterations',
    ] as const) {
      assert.doesNotThrow(() =>
        goalResponse('goal.clear', { kind: 'unchanged', goal: goalForStatus(status) }),
      );
    }
  });
});

function goalForStatus(status: (typeof GOAL_STATUSES)[number], overrides = {}) {
  const initial = {
    goalId: 'goal-1',
    revision: 0,
    sessionId: 'session-1',
    condition: 'Ship the runtime host',
    status: 'active' as const,
    setAt: 100,
    iterations: 0,
    maxIterations: 50,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokensAtStart: 1_000,
    tokensNow: 1_000,
    tokensBaselinePending: true,
  };
  const continued = {
    ...initial,
    revision: 2,
    iterations: 2,
    consecutiveNoProgress: 1,
    tokensNow: 1_500,
    tokensBaselinePending: false,
    lastReason: 'Continue working',
  };
  const goal = (() => {
    switch (status) {
      case 'active':
        return continued;
      case 'waiting':
        return { ...continued, status };
      case 'achieved':
        return { ...initial, revision: 1, status, lastReason: 'Done', achievedAt: 200 };
      case 'impossible':
        return { ...initial, revision: 1, status, lastReason: 'Cannot complete' };
      case 'paused':
        return { ...continued, revision: 3, status, pausedAt: 200 };
      case 'cleared':
        return { ...continued, revision: 4, status, pausedAt: 200 };
      case 'stalled':
        return {
          ...continued,
          revision: 8,
          status,
          iterations: 8,
          consecutiveNoProgress: 8,
          lastReason: 'No progress for 8 consecutive turns',
        };
      case 'budget_limited':
        return {
          ...continued,
          revision: 3,
          status,
          tokenBudget: 1_000,
          tokensNow: 2_000,
          lastReason: 'Token budget exhausted (1000 tokens)',
        };
      case 'max_iterations':
        return {
          ...continued,
          revision: 50,
          status,
          iterations: 50,
          lastReason: 'Reached maximum iterations (50)',
        };
    }
  })();
  return { ...goal, ...overrides };
}

function withoutField(value: object, field: string): Record<string, unknown> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[field];
  return copy;
}

function goalRequest(operation: 'goal.query' | 'goal.clear', input: unknown) {
  const frame = decodeClientFrame({ requestId: 'goal-request', operation, input });
  assert.ok('operation' in frame);
  return frame;
}

function goalResponse(operation: 'goal.query' | 'goal.clear', result: unknown) {
  const frame = decodeHostFrame({ requestId: 'goal-response', operation, ok: true, result });
  assert.ok('ok' in frame && frame.ok);
  return frame;
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
