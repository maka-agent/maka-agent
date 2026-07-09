import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoalManager,
  TERMINAL_GOAL_STATUSES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_BLOCK_CAP,
} from '../goal-state.js';

const SESSION = 'sess-1';

function createManager(startTime = 1_700_000_000_000) {
  let id = 0;
  let time = startTime;
  const mgr = new GoalManager({ generateId: () => `goal-${++id}`, now: () => time });
  return { mgr, advance: (ms: number) => { time += ms; }, at: () => time };
}

describe('GoalManager — set / lifecycle', () => {
  test('set creates an active goal with defaults', () => {
    const { mgr } = createManager();
    const g = mgr.set(SESSION, 'all tests pass');
    assert.equal(g.status, 'active');
    assert.equal(g.iterations, 0);
    assert.equal(g.maxIterations, DEFAULT_MAX_ITERATIONS);
    assert.equal(g.blockCap, DEFAULT_BLOCK_CAP);
    assert.equal(g.consecutiveNoProgress, 0);
    assert.equal(g.tokenBudget, undefined);
  });

  test('set accepts custom limits', () => {
    const { mgr } = createManager();
    const g = mgr.set(SESSION, 'x', { maxIterations: 10, blockCap: 3, tokenBudget: 5000, tokensAtStart: 100 });
    assert.equal(g.maxIterations, 10);
    assert.equal(g.blockCap, 3);
    assert.equal(g.tokenBudget, 5000);
    assert.equal(g.tokensAtStart, 100);
    assert.equal(g.tokensNow, 100);
  });

  test('set replaces an active goal (old marked cleared)', () => {
    const { mgr } = createManager();
    const first = mgr.set(SESSION, 'first');
    mgr.set(SESSION, 'second');
    assert.equal(first.status, 'cleared');
    assert.equal(mgr.get(SESSION)?.condition, 'second');
  });

  test('set after a terminal goal does not mutate the settled one', () => {
    const { mgr } = createManager();
    const first = mgr.set(SESSION, 'first');
    mgr.markAchieved(SESSION, 'done');
    assert.equal(first.status, 'achieved');
    mgr.set(SESSION, 'second');
    // The achieved goal object keeps its status; a new goal replaces the map entry.
    assert.equal(first.status, 'achieved');
    assert.equal(mgr.get(SESSION)?.condition, 'second');
  });

  test('getActive only returns active goals', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    assert.ok(mgr.getActive(SESSION));
    mgr.pause(SESSION);
    assert.equal(mgr.getActive(SESSION), undefined);
  });
});

describe('GoalManager — iteration ceiling', () => {
  test('incrementIteration trips max_iterations', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x', { maxIterations: 2 });
    mgr.incrementIteration(SESSION);
    const g = mgr.incrementIteration(SESSION);
    assert.equal(g?.status, 'max_iterations');
  });

  test('incrementIteration on non-active returns undefined', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    mgr.pause(SESSION);
    assert.equal(mgr.incrementIteration(SESSION), undefined);
  });
});

describe('GoalManager — block cap (stall detection)', () => {
  test('progress resets the no-progress streak', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x', { blockCap: 3 });
    mgr.recordProgress(SESSION, false);
    mgr.recordProgress(SESSION, false);
    assert.equal(mgr.get(SESSION)?.consecutiveNoProgress, 2);
    mgr.recordProgress(SESSION, true);
    assert.equal(mgr.get(SESSION)?.consecutiveNoProgress, 0);
    assert.equal(mgr.get(SESSION)?.status, 'active');
  });

  test('block cap trips stalled', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x', { blockCap: 3 });
    mgr.recordProgress(SESSION, false);
    mgr.recordProgress(SESSION, false);
    const g = mgr.recordProgress(SESSION, false);
    assert.equal(g?.status, 'stalled');
    assert.ok(g?.lastReason?.includes('No progress'));
  });

  test('recordProgress on non-active is a no-op', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    mgr.markAchieved(SESSION, 'done');
    assert.equal(mgr.recordProgress(SESSION, false), undefined);
  });
});

describe('GoalManager — token budget', () => {
  test('recordTokens trips budget_limited (after baseline established)', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x', { tokenBudget: 1000, tokensAtStart: 500 });
    mgr.recordTokens(SESSION, 500);  // establishes baseline at 500
    mgr.recordTokens(SESSION, 1200); // spent 700, under budget
    assert.equal(mgr.get(SESSION)?.status, 'active');
    mgr.recordTokens(SESSION, 1600); // spent 1100, over budget
    assert.equal(mgr.get(SESSION)?.status, 'budget_limited');
  });

  test('tokensSpent computes delta from established baseline', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x', { tokensAtStart: 500 });
    mgr.recordTokens(SESSION, 500); // baseline
    mgr.recordTokens(SESSION, 800);
    assert.equal(mgr.tokensSpent(SESSION), 300);
  });

  test('token count is monotonic (stale smaller read ignored)', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x', { tokensAtStart: 0 });
    mgr.recordTokens(SESSION, 0);    // baseline
    mgr.recordTokens(SESSION, 1000);
    mgr.recordTokens(SESSION, 500);  // stale
    assert.equal(mgr.get(SESSION)?.tokensNow, 1000);
  });

  test('no budget → recordTokens never trips budget_limited', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    mgr.recordTokens(SESSION, 0);
    mgr.recordTokens(SESSION, 1_000_000);
    assert.equal(mgr.get(SESSION)?.status, 'active');
  });
});

describe('GoalManager — pause / resume', () => {
  test('pause then resume', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    const paused = mgr.pause(SESSION);
    assert.equal(paused?.status, 'paused');
    assert.ok(paused?.pausedAt);
    const resumed = mgr.resume(SESSION);
    assert.equal(resumed?.status, 'active');
    assert.equal(resumed?.pausedAt, undefined);
  });

  test('cannot pause a non-active goal', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    mgr.markAchieved(SESSION, 'done');
    assert.equal(mgr.pause(SESSION), undefined);
  });

  test('cannot resume a non-paused goal', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    assert.equal(mgr.resume(SESSION), undefined);
  });
});

describe('GoalManager — terminal transitions', () => {
  test('markAchieved / markImpossible only from active', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    assert.equal(mgr.markAchieved(SESSION, 'done')?.status, 'achieved');
    assert.equal(mgr.markImpossible(SESSION, 'no'), undefined);
  });

  test('clear from active → cleared; clear from terminal keeps outcome', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    assert.equal(mgr.clear(SESSION)?.status, 'cleared');

    mgr.set(SESSION, 'y');
    mgr.markAchieved(SESSION, 'done');
    assert.equal(mgr.clear(SESSION)?.status, 'achieved');
  });

  test('TERMINAL_GOAL_STATUSES covers all stop states', () => {
    for (const s of ['achieved', 'impossible', 'cleared', 'stalled', 'budget_limited', 'max_iterations'] as const) {
      assert.ok(TERMINAL_GOAL_STATUSES.has(s), `${s} should be terminal`);
    }
    assert.ok(!TERMINAL_GOAL_STATUSES.has('active'));
    assert.ok(!TERMINAL_GOAL_STATUSES.has('paused'));
  });

  test('remove and dispose', () => {
    const { mgr } = createManager();
    mgr.set(SESSION, 'x');
    assert.equal(mgr.remove(SESSION), true);
    assert.equal(mgr.get(SESSION), undefined);
    mgr.set('a', '1');
    mgr.set('b', '2');
    mgr.dispose();
    assert.equal(mgr.get('a'), undefined);
    assert.equal(mgr.get('b'), undefined);
  });

  test('different sessions are independent', () => {
    const { mgr } = createManager();
    mgr.set('a', 'goal A');
    mgr.set('b', 'goal B');
    assert.equal(mgr.get('a')?.condition, 'goal A');
    assert.equal(mgr.get('b')?.condition, 'goal B');
  });
});

describe('GoalManager — token baseline', () => {
  test('first recordTokens establishes the baseline (spend starts at 0)', () => {
    const { mgr } = createManager();
    // GoalSet captured a stale/0 baseline; the goal actually starts at 50k.
    mgr.set(SESSION, 'x', { tokenBudget: 20000, tokensAtStart: 0 });
    mgr.recordTokens(SESSION, 50000); // first real observation → re-baseline
    assert.equal(mgr.tokensSpent(SESSION), 0);
    assert.equal(mgr.get(SESSION)?.status, 'active'); // NOT budget_limited
    mgr.recordTokens(SESSION, 71000); // spent 21000 > 20000
    assert.equal(mgr.get(SESSION)?.status, 'budget_limited');
  });
});

describe('GoalManager — onChange (kill-switch events)', () => {
  function managerWithSpy() {
    let id = 0;
    const events: Array<{ status: string; previous?: string }> = [];
    const mgr = new GoalManager({
      generateId: () => `goal-${++id}`,
      now: () => 1_700_000_000_000,
      onChange: (goal, previous) => events.push({ status: goal.status, previous }),
    });
    return { mgr, events };
  }

  test('fires on set (goal armed)', () => {
    const { mgr, events } = managerWithSpy();
    mgr.set(SESSION, 'x');
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'active');
    assert.equal(events[0].previous, undefined);
  });

  test('fires on each continuation and carries the previous status', () => {
    const { mgr, events } = managerWithSpy();
    mgr.set(SESSION, 'x');
    mgr.incrementIteration(SESSION);
    assert.equal(events.length, 2);
    assert.equal(events[1].status, 'active');
    assert.equal(events[1].previous, 'active');
  });

  test('fires on terminal transitions (achieved / cleared)', () => {
    const { mgr, events } = managerWithSpy();
    mgr.set(SESSION, 'x');
    mgr.markAchieved(SESSION, 'done');
    assert.equal(events.at(-1)?.status, 'achieved');
    mgr.set('sess-2', 'y');
    mgr.clear('sess-2');
    assert.equal(events.at(-1)?.status, 'cleared');
  });

  test('fires on remove so a badge can clear', () => {
    const { mgr, events } = managerWithSpy();
    mgr.set(SESSION, 'x');
    const before = events.length;
    mgr.remove(SESSION);
    assert.equal(events.length, before + 1);
  });

  test('is optional — a manager without onChange still mutates', () => {
    const mgr = new GoalManager({ generateId: () => 'g', now: () => 0 });
    assert.doesNotThrow(() => { mgr.set(SESSION, 'x'); mgr.clear(SESSION); });
  });
});
