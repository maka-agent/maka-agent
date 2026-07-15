import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoalManager,
  goalCheckpoint,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_BLOCK_CAP,
  type GoalState,
} from '../goal-state.js';

const SESSION = 'sess-1';

function createManager(startTime = 1_700_000_000_000) {
  let id = 0;
  let time = startTime;
  const events: Array<{ goal: GoalState; previous?: string }> = [];
  const mgr = new GoalManager({
    generateId: () => `goal-${++id}`,
    now: () => time,
    onChange: (goal, previous) => { events.push({ goal, previous }); },
  });
  return { mgr, events, advance: (ms: number) => { time += ms; } };
}

function createGoal(
  mgr: GoalManager,
  condition = 'all tests pass',
  opts?: Parameters<GoalManager['create']>[2],
): GoalState {
  const result = mgr.create(SESSION, condition, opts);
  assert.equal(result.kind, 'created');
  return result.goal;
}

function settle(
  mgr: GoalManager,
  turnId: string,
  input: (
    | { waiting: true; madeProgress?: never; tokensNow?: number; reason?: string }
    | { waiting?: false; madeProgress?: boolean; tokensNow?: number; reason?: string }
  ) = {},
) {
  const goal = mgr.getActive(SESSION);
  assert.ok(goal);
  if (input.waiting === true) {
    return mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(goal),
      turnId,
      verdict: 'continue',
      waiting: true,
      reason: input.reason ?? 'keep going',
      ...(input.tokensNow !== undefined ? { tokensNow: input.tokensNow } : {}),
    });
  }
  return mgr.settleTurn(SESSION, {
    checkpoint: goalCheckpoint(goal),
    turnId,
    verdict: 'continue',
    reason: input.reason ?? 'keep going',
    madeProgress: input.madeProgress ?? true,
    ...(input.tokensNow !== undefined ? { tokensNow: input.tokensNow } : {}),
  });
}

describe('GoalManager creation and lifecycle', () => {
  test('isolates asynchronous observer rejection after committing state', async () => {
    let notifications = 0;
    const mgr = new GoalManager({
      generateId: () => 'goal-1',
      now: () => 1,
      onChange: async () => {
        notifications++;
        throw new Error('observer failed');
      },
    });

    const created = createGoal(mgr);
    const result = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(created),
      turnId: 'turn-1',
      verdict: 'continue',
      reason: 'keep going',
      madeProgress: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(result.kind, 'applied');
    assert.equal(mgr.get(SESSION)?.iterations, 1);
    assert.equal(notifications, 2);
  });

  test('creates an immutable active goal with defaults and custom limits', () => {
    const { mgr } = createManager();
    const goal = createGoal(mgr, 'ship it', {
      maxIterations: 10,
      blockCap: 3,
      tokenBudget: 5000,
      tokensAtStart: 100,
    });

    assert.equal(goal.revision, 0);
    assert.equal(goal.status, 'active');
    assert.equal(goal.maxIterations, 10);
    assert.equal(goal.blockCap, 3);
    assert.equal(goal.tokenBudget, 5000);
    assert.equal(goal.tokensAtStart, 100);
    assert.ok(Object.isFrozen(goal));

    const { mgr: defaults } = createManager();
    const defaultGoal = createGoal(defaults);
    assert.equal(defaultGoal.maxIterations, DEFAULT_MAX_ITERATIONS);
    assert.equal(defaultGoal.blockCap, DEFAULT_BLOCK_CAP);
  });

  test('rejects active and paused Goal replacement without mutating either snapshot', () => {
    const { mgr, events } = createManager();
    const original = createGoal(mgr, 'first');

    const activeConflict = mgr.create(SESSION, 'second');
    assert.equal(activeConflict.kind, 'unfinished');
    assert.strictEqual(activeConflict.goal, original);

    const paused = mgr.pause(SESSION);
    assert.equal(paused?.revision, 1);
    const pausedConflict = mgr.create(SESSION, 'third');
    assert.equal(pausedConflict.kind, 'unfinished');
    assert.strictEqual(pausedConflict.goal, paused);
    assert.equal(events.length, 2);
  });

  test('a terminal Goal may be followed by a new Goal without rewriting its snapshot', () => {
    const { mgr } = createManager();
    const first = createGoal(mgr, 'first');
    const cleared = mgr.clear(SESSION);
    assert.equal(cleared?.status, 'cleared');
    const second = mgr.create(SESSION, 'second');

    assert.equal(second.kind, 'created');
    assert.notEqual(second.goal.id, first.id);
    assert.equal(first.status, 'active');
    assert.equal(first.revision, 0);
  });

  test('pause, resume, waiting wake, and clear each produce a new revision', () => {
    const { mgr, advance } = createManager();
    const original = createGoal(mgr);
    advance(10);
    const paused = mgr.pause(SESSION);
    const resumed = mgr.resume(SESSION);
    const waiting = settle(mgr, 'turn-wait', { waiting: true });
    assert.equal(waiting.kind, 'applied');
    const woken = mgr.wakeWaiting(SESSION, goalCheckpoint(waiting.goal));
    const cleared = mgr.clear(SESSION);

    assert.equal(original.revision, 0);
    assert.equal(paused?.revision, 1);
    assert.equal(paused?.status, 'paused');
    assert.equal(resumed?.revision, 2);
    assert.equal(resumed?.status, 'active');
    assert.equal(resumed?.pausedAt, undefined);
    assert.equal(waiting.goal.revision, 3);
    assert.equal(waiting.goal.status, 'waiting');
    assert.equal(woken?.revision, 4);
    assert.equal(woken?.status, 'active');
    assert.equal(cleared?.revision, 5);
    assert.equal(cleared?.status, 'cleared');
    assert.equal(mgr.clear(SESSION), undefined);
  });

  test('waiting blocks replacement, can be paused with a reason, and rejects stale wake', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'wait for CI');
    const waiting = settle(mgr, 'turn-wait', {
      waiting: true,
      reason: 'CI is still running',
    });
    assert.equal(waiting.kind, 'applied');

    assert.equal(mgr.create(SESSION, 'replacement').kind, 'unfinished');
    const stale = { goalId: waiting.goal.id, revision: waiting.goal.revision - 1 };
    assert.equal(mgr.wakeWaiting(SESSION, stale), undefined);
    assert.equal(mgr.get(SESSION)?.status, 'waiting');

    const paused = mgr.pause(SESSION, {
      checkpoint: goalCheckpoint(waiting.goal),
      reason: 'Continuation host is unavailable',
    });
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.lastReason, 'Continuation host is unavailable');
  });
});

describe('GoalManager atomic turn settlement', () => {
  test('commits token, iteration, progress, reason, revision, and one event atomically', () => {
    const { mgr, events } = createManager();
    const before = createGoal(mgr, 'x', { tokensAtStart: 0 });
    const result = settle(mgr, 'turn-1', {
      madeProgress: false,
      tokensNow: 50_000,
      reason: 'one check remains',
    });

    assert.equal(result.kind, 'applied');
    assert.equal(result.goal.revision, 1);
    assert.equal(result.goal.iterations, 1);
    assert.equal(result.goal.consecutiveNoProgress, 1);
    assert.equal(result.goal.tokensAtStart, 50_000);
    assert.equal(result.goal.tokensNow, 50_000);
    assert.equal(result.goal.lastReason, 'one check remains');
    assert.equal(before.iterations, 0);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.previous, 'active');
  });

  test('terminal evaluator verdict settles without advancing turn counters', () => {
    const { mgr } = createManager();
    const goal = createGoal(mgr, 'x', { maxIterations: 1, tokenBudget: 1000 });
    const result = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(goal),
      turnId: 'turn-final',
      verdict: 'achieved',
      reason: 'verified',
    });

    assert.equal(result.kind, 'applied');
    assert.equal(result.goal.status, 'achieved');
    assert.equal(result.goal.iterations, 0);
    assert.equal(result.goal.lastReason, 'verified');
  });

  test('token budget stops settlement before iteration and stall updates', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'x', { tokenBudget: 1000, maxIterations: 2, blockCap: 1 });
    settle(mgr, 'turn-1', { tokensNow: 500, madeProgress: true });
    const budget = settle(mgr, 'turn-2', { tokensNow: 1500, madeProgress: false });

    assert.equal(budget.kind, 'applied');
    assert.equal(budget.goal.status, 'budget_limited');
    assert.equal(budget.goal.iterations, 1);
    assert.equal(budget.goal.consecutiveNoProgress, 0);
  });

  test('iteration cap stops settlement before the stall update', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'x', { maxIterations: 1, blockCap: 1 });

    const result = settle(mgr, 'turn-1', { madeProgress: false });

    assert.equal(result.kind, 'applied');
    assert.equal(result.goal.status, 'max_iterations');
    assert.equal(result.goal.consecutiveNoProgress, 0);
  });

  test('progress resets the streak and no progress eventually stalls', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'x', { blockCap: 2 });
    settle(mgr, 'turn-1', { madeProgress: false });
    settle(mgr, 'turn-2', { madeProgress: true });
    settle(mgr, 'turn-3', { madeProgress: false });
    const stopped = settle(mgr, 'turn-4', { madeProgress: false });

    assert.equal(stopped.kind, 'applied');
    assert.equal(stopped.goal.status, 'stalled');
    assert.equal(stopped.goal.consecutiveNoProgress, 2);
  });

  test('waiting consumes a real iteration but is neutral to progress and still obeys hard caps', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'wait', { maxIterations: 2, blockCap: 1 });
    const first = settle(mgr, 'turn-1', {
      waiting: true,
      reason: 'external check pending',
    });

    assert.equal(first.kind, 'applied');
    assert.equal(first.goal.status, 'waiting');
    assert.equal(first.goal.iterations, 1);
    assert.equal(first.goal.consecutiveNoProgress, 0);

    const active = mgr.wakeWaiting(SESSION, goalCheckpoint(first.goal));
    assert.ok(active);
    const capped = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(active),
      turnId: 'turn-2',
      verdict: 'continue',
      waiting: true,
      reason: 'still pending',
    });
    assert.equal(capped.kind, 'applied');
    assert.equal(capped.goal.status, 'max_iterations');
    assert.equal(capped.goal.consecutiveNoProgress, 0);
  });

  test('token observations remain monotonic after the initial baseline', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'x');
    settle(mgr, 'turn-1', { tokensNow: 1000 });
    settle(mgr, 'turn-2', { tokensNow: 1800 });
    settle(mgr, 'turn-3', { tokensNow: 1200 });

    assert.equal(mgr.get(SESSION)?.tokensNow, 1800);
    assert.equal(mgr.tokensSpent(SESSION), 800);
  });
});

describe('GoalManager stale and duplicate rejection', () => {
  test('rejects an evaluator checkpoint invalidated by pause and resume', () => {
    const { mgr, events } = createManager();
    const goal = createGoal(mgr);
    const checkpoint = goalCheckpoint(goal);
    mgr.pause(SESSION);
    const resumed = mgr.resume(SESSION);
    const eventCount = events.length;

    const result = mgr.settleTurn(SESSION, {
      checkpoint,
      turnId: 'turn-old',
      verdict: 'achieved',
      reason: 'stale verdict',
    });

    assert.equal(result.kind, 'stale');
    assert.strictEqual(mgr.get(SESSION), resumed);
    assert.equal(events.length, eventCount);
  });

  test('rejects an evaluator checkpoint after clear and replacement (ABA)', () => {
    const { mgr } = createManager();
    const first = createGoal(mgr, 'first');
    const checkpoint = goalCheckpoint(first);
    mgr.clear(SESSION);
    const replacement = mgr.create(SESSION, 'replacement');
    assert.equal(replacement.kind, 'created');

    const result = mgr.settleTurn(SESSION, {
      checkpoint,
      turnId: 'turn-old',
      verdict: 'impossible',
      reason: 'stale verdict',
    });

    assert.equal(result.kind, 'stale');
    assert.equal(mgr.get(SESSION)?.condition, 'replacement');
    assert.equal(mgr.get(SESSION)?.status, 'active');
  });

  test('rejects sequential replay of any already-settled turn', () => {
    const { mgr } = createManager();
    const first = createGoal(mgr);
    const turnOne = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(first),
      turnId: 'turn-1',
      verdict: 'continue',
      reason: 'continue',
      madeProgress: true,
    });
    assert.equal(turnOne.kind, 'applied');
    const turnTwo = settle(mgr, 'turn-2');
    assert.equal(turnTwo.kind, 'applied');

    const replay = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(turnTwo.goal),
      turnId: 'turn-1',
      verdict: 'achieved',
      reason: 'must not apply',
    });

    assert.equal(replay.kind, 'duplicate');
    assert.equal(mgr.get(SESSION)?.iterations, 2);
    assert.equal(mgr.get(SESSION)?.status, 'active');
  });

  test('retains turn idempotency when a terminal Goal is replaced', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'first', { maxIterations: 1 });
    const terminal = settle(mgr, 'turn-shared');
    assert.equal(terminal.kind, 'applied');
    assert.equal(terminal.goal.status, 'max_iterations');

    const replacement = mgr.create(SESSION, 'replacement');
    assert.equal(replacement.kind, 'created');
    const replay = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(replacement.goal),
      turnId: 'turn-shared',
      verdict: 'continue',
      reason: 'must not apply',
      madeProgress: true,
    });

    assert.equal(replay.kind, 'duplicate');
    assert.strictEqual(replay.goal, replacement.goal);
    assert.equal(replacement.goal.revision, 0);
    assert.equal(replacement.goal.iterations, 0);
  });
});

describe('GoalManager ownership cleanup', () => {
  test('archive retains turn identity while permanent removal releases the session record', () => {
    const { mgr } = createManager();
    assert.equal(mgr.create('a', 'goal A').kind, 'created');
    assert.equal(mgr.create('b', 'goal B').kind, 'created');
    assert.equal(mgr.markTurnSettled('a', 'turn-a'), true);
    assert.equal(mgr.removeGoal('a'), true);
    assert.equal(mgr.get('a'), undefined);
    assert.equal(mgr.hasSettledTurn('a', 'turn-a'), true);
    assert.equal(mgr.get('b')?.condition, 'goal B');

    assert.equal(mgr.create('a', 'replacement').kind, 'created');
    assert.equal(mgr.hasSettledTurn('a', 'turn-a'), true);
    assert.equal(mgr.removeSession('a'), true);
    assert.equal(mgr.hasSettledTurn('a', 'turn-a'), false);
    mgr.dispose();
    assert.equal(mgr.get('b'), undefined);
  });
});
