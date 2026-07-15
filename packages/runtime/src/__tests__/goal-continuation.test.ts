import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GoalManager } from '../goal-state.js';
import { handleGoalContinuation, type GoalContinuationDeps } from '../goal-continuation.js';
import type { GoalEvaluation } from '../goal-evaluator.js';

const SESSION = 'sess-1';

function setup(opts?: {
  evaluation?: Partial<GoalEvaluation>;
  canContinue?: boolean;
  tokenCount?: number;
}) {
  let id = 0;
  const mgr = new GoalManager({
    generateId: () => `g-${++id}`,
    now: () => 1000,
  });
  const injected: string[] = [];
  const evaluation: GoalEvaluation = {
    met: false, impossible: false, progress: true, waiting: false, evaluatorFailed: false, reason: 'keep going',
    ...opts?.evaluation,
  };
  const deps: GoalContinuationDeps = {
    goalManager: mgr,
    evaluator: { evaluate: async () => JSON.stringify({
      met: evaluation.met, impossible: evaluation.impossible,
      progress: evaluation.progress, waiting: evaluation.waiting,
      reason: evaluation.reason,
    }) },
    getRecentContext: async () => 'recent context',
    getTokenCount: opts?.tokenCount !== undefined ? () => opts.tokenCount! : undefined,
    injectTurn: (_s, text) => { injected.push(text); },
    canContinue: async () => opts?.canContinue ?? true,
  };
  return { mgr, deps, injected };
}

function controlledCall<T>() {
  let markStarted!: () => void;
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const result = new Promise<T>((resolve) => { resolveResult = resolve; });
  return {
    invoke: () => {
      markStarted();
      return result;
    },
    started,
    resolve: resolveResult,
  };
}

describe('handleGoalContinuation', () => {
  test('no active goal → no_goal', async () => {
    const { deps } = setup();
    const out = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(out.kind, 'no_goal');
  });

  test('session busy → cannot_continue', async () => {
    const { mgr, deps } = setup({ canContinue: false });
    mgr.create(SESSION, 'x');
    const out = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(out.kind, 'cannot_continue');
  });

  test('met → achieved, no injection', async () => {
    const { mgr, deps, injected } = setup({ evaluation: { met: true, reason: 'all pass' } });
    mgr.create(SESSION, 'x');
    const out = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(out.kind, 'achieved');
    assert.equal(mgr.get(SESSION)?.status, 'achieved');
    assert.equal(injected.length, 0);
  });

  test('impossible → impossible, no injection', async () => {
    const { mgr, deps, injected } = setup({ evaluation: { impossible: true, reason: 'cannot' } });
    mgr.create(SESSION, 'x');
    const out = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(out.kind, 'impossible');
    assert.equal(mgr.get(SESSION)?.status, 'impossible');
    assert.equal(injected.length, 0);
  });

  test('not met + progress → continued, injects steering turn', async () => {
    const { mgr, deps, injected } = setup({ evaluation: { progress: true, reason: '1 of 3 done' } });
    mgr.create(SESSION, 'x');
    const out = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(out.kind, 'continued');
    assert.equal(injected.length, 1);
    assert.ok(injected[0].includes('1 of 3 done'));
    assert.equal(mgr.get(SESSION)?.iterations, 1);
    assert.equal(mgr.get(SESSION)?.consecutiveNoProgress, 0);
  });

  test('no progress accumulates and trips stalled at block cap', async () => {
    const { mgr, deps, injected } = setup({ evaluation: { progress: false, reason: 'stuck' } });
    mgr.create(SESSION, 'x', { blockCap: 2 });
    const first = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(first.kind, 'continued');
    assert.equal(mgr.get(SESSION)?.consecutiveNoProgress, 1);
    const second = await handleGoalContinuation(deps, SESSION, 'turn-2');
    assert.equal(second.kind, 'stopped');
    assert.equal(mgr.get(SESSION)?.status, 'stalled');
    // Second call must not inject (goal stalled).
    assert.equal(injected.length, 1);
  });

  test('evaluate-first: a goal MET on its final permitted turn is achieved, not max_iterations', async () => {
    const { mgr, deps } = setup({ evaluation: { met: true, reason: 'all pass' } });
    mgr.create(SESSION, 'x', { maxIterations: 1 });
    const out = await handleGoalContinuation(deps, SESSION, 'turn-final');
    assert.equal(out.kind, 'achieved');
    assert.equal(mgr.get(SESSION)?.status, 'achieved');
  });

  test('not-met on the final permitted turn stops with max_iterations', async () => {
    const { mgr, deps } = setup({ evaluation: { met: false, progress: true } });
    mgr.create(SESSION, 'x', { maxIterations: 1 });
    const out = await handleGoalContinuation(deps, SESSION, 'turn-final');
    assert.equal(out.kind, 'stopped');
    assert.equal(mgr.get(SESSION)?.status, 'max_iterations');
  });

  test('evaluate-first: a goal MET on the budget-crossing turn is achieved, not budget_limited', async () => {
    const { mgr, deps } = setup({ tokenCount: 2000, evaluation: { met: true, reason: 'done' } });
    mgr.create(SESSION, 'x', { tokenBudget: 1000, tokensAtStart: 500 });
    const out = await handleGoalContinuation(deps, SESSION, 'turn-final');
    assert.equal(out.kind, 'achieved');
    assert.equal(mgr.get(SESSION)?.status, 'achieved');
  });

  test('not-met budget crossing stops with budget_limited', async () => {
    const { mgr, deps } = setup({ tokenCount: 2000, evaluation: { met: false, progress: true } });
    const created = mgr.create(SESSION, 'x', { tokenBudget: 1000, tokensAtStart: 500 });
    assert.equal(created.kind, 'created');
    mgr.settleTurn(SESSION, {
      checkpoint: { goalId: created.goal.id, revision: created.goal.revision },
      turnId: 'turn-baseline',
      verdict: 'continue',
      reason: 'baseline',
      madeProgress: true,
      tokensNow: 500,
    });
    const out = await handleGoalContinuation(deps, SESSION, 'turn-final');
    assert.equal(out.kind, 'stopped');
    assert.equal(mgr.get(SESSION)?.status, 'budget_limited');
  });

  test('evaluatorFailed leaves the no-progress streak unchanged (neutral)', async () => {
    let id = 0;
    const mgr = new GoalManager({ generateId: () => `g-${++id}`, now: () => 1000 });
    // A throwing evaluator yields evaluatorFailed=true from evaluateGoal.
    const deps: GoalContinuationDeps = {
      goalManager: mgr,
      evaluator: { evaluate: async () => { throw new Error('outage'); } },
      getRecentContext: async () => 'ctx',
      injectTurn: () => {},
      canContinue: async () => true,
    };
    mgr.create(SESSION, 'x', { blockCap: 2 });
    await handleGoalContinuation(deps, SESSION, 'turn-1');
    // Neutral: streak neither advanced nor reset; goal still active (fail-open).
    assert.equal(mgr.get(SESSION)?.consecutiveNoProgress, 0);
    assert.equal(mgr.get(SESSION)?.status, 'active');
  });

  test('waiting is neutral: does not count against the stall cap, still injects', async () => {
    const { mgr, deps, injected } = setup({
      evaluation: { waiting: true, progress: false, reason: 'CI still running' },
    });
    mgr.create(SESSION, 'deploy done', { blockCap: 2 });
    const out = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(out.kind, 'continued');
    // Waiting must NOT accumulate toward stall (a wait is not being stuck).
    assert.equal(mgr.get(SESSION)?.consecutiveNoProgress, 0);
    assert.equal(injected.length, 1);
    assert.ok(injected[0].includes('waiting on an external event'));
  });

  test('a long wait is bounded by maxIterations (visible terminal, no zombie)', async () => {
    const { mgr, deps } = setup({
      evaluation: { waiting: true, progress: false, reason: 'CI running' },
    });
    mgr.create(SESSION, 'x', { maxIterations: 3 });
    await handleGoalContinuation(deps, SESSION, 'turn-1');
    await handleGoalContinuation(deps, SESSION, 'turn-2');
    const third = await handleGoalContinuation(deps, SESSION, 'turn-3');
    assert.equal(third.kind, 'stopped');
    assert.equal(mgr.get(SESSION)?.status, 'max_iterations');
  });

  test('re-entrancy guard: overlapping continuation returns busy', async () => {
    let id = 0;
    const mgr = new GoalManager({ generateId: () => `g-${++id}`, now: () => 1000 });
    const inFlight = new Set<string>();
    const evaluation = controlledCall<string>();
    const deps: GoalContinuationDeps = {
      goalManager: mgr,
      inFlight,
      evaluator: { evaluate: evaluation.invoke },
      getRecentContext: async () => 'ctx',
      injectTurn: () => {},
      canContinue: async () => true,
    };
    mgr.create(SESSION, 'x');
    const first = handleGoalContinuation(deps, SESSION, 'turn-1'); // hangs on evaluate
    await evaluation.started;
    const second = await handleGoalContinuation(deps, SESSION, 'turn-2'); // should see inFlight
    assert.equal(second.kind, 'busy');
    evaluation.resolve('{"met": false, "progress": true, "reason": "x"}');
    await first;
  });

  test('a completed turn is settled once without re-running the evaluator', async () => {
    const { mgr, deps, injected } = setup();
    let evaluations = 0;
    const evaluate = deps.evaluator.evaluate;
    deps.evaluator.evaluate = (...args) => {
      evaluations++;
      return evaluate(...args);
    };
    mgr.create(SESSION, 'x');

    const first = await handleGoalContinuation(deps, SESSION, 'turn-1');
    const replay = await handleGoalContinuation(deps, SESSION, 'turn-1');

    assert.equal(first.kind, 'continued');
    assert.equal(replay.kind, 'duplicate');
    assert.equal(evaluations, 1);
    assert.equal(injected.length, 1);
    assert.equal(mgr.get(SESSION)?.iterations, 1);
  });

  test('a settled turn remains duplicate after its terminal Goal is replaced', async () => {
    const { mgr, deps, injected } = setup();
    let evaluations = 0;
    const evaluate = deps.evaluator.evaluate;
    deps.evaluator.evaluate = (...args) => {
      evaluations++;
      return evaluate(...args);
    };
    mgr.create(SESSION, 'first', { maxIterations: 1 });

    const first = await handleGoalContinuation(deps, SESSION, 'turn-shared');
    assert.equal(first.kind, 'stopped');
    const replacement = mgr.create(SESSION, 'replacement');
    assert.equal(replacement.kind, 'created');
    const replay = await handleGoalContinuation(deps, SESSION, 'turn-shared');

    assert.equal(replay.kind, 'duplicate');
    assert.equal(evaluations, 1);
    assert.deepEqual(injected, []);
    assert.equal(replacement.goal.iterations, 0);
    assert.equal(replacement.goal.revision, 0);
  });

  test('an evaluator result cannot settle a replacement Goal', async () => {
    const { mgr, deps, injected } = setup();
    const evaluation = controlledCall<string>();
    deps.evaluator.evaluate = evaluation.invoke;
    const decisions: string[] = [];
    deps.taskGate = {
      listActionableTaskKeys: async () => [],
      recordDecision: (trace) => { decisions.push(trace.decision); },
    };
    mgr.create(SESSION, 'old');
    const pending = handleGoalContinuation(deps, SESSION, 'turn-old');
    await evaluation.started;

    mgr.clear(SESSION);
    const replacement = mgr.create(SESSION, 'replacement');
    assert.equal(replacement.kind, 'created');
    evaluation.resolve('{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"old done"}');
    const result = await pending;

    assert.equal(result.kind, 'stale');
    assert.equal(mgr.get(SESSION)?.condition, 'replacement');
    assert.equal(mgr.get(SESSION)?.status, 'active');
    assert.deepEqual(injected, []);
    assert.deepEqual(decisions, []);
  });

  test('an evaluator result cannot cross clear, pause/resume, or removal', async (t) => {
    for (const scenario of ['clear', 'pause-resume', 'remove'] as const) {
      await t.test(scenario, async () => {
        const { mgr, deps, injected } = setup();
        const evaluation = controlledCall<string>();
        deps.evaluator.evaluate = evaluation.invoke;
        mgr.create(SESSION, 'x');
        const pending = handleGoalContinuation(deps, SESSION, `turn-${scenario}`);
        await evaluation.started;

        if (scenario === 'clear') {
          mgr.clear(SESSION);
        } else if (scenario === 'pause-resume') {
          mgr.pause(SESSION);
          mgr.resume(SESSION);
        } else {
          mgr.remove(SESSION);
        }
        evaluation.resolve('{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"old progress"}');
        const result = await pending;

        assert.equal(result.kind, 'stale');
        if (scenario === 'remove') assert.equal(mgr.get(SESSION), undefined);
        else assert.equal(mgr.get(SESSION)?.iterations, 0);
        assert.deepEqual(injected, []);
      });
    }
  });

  test('a post-settlement pause prevents stale continuation injection', async () => {
    const { mgr, deps, injected } = setup();
    const taskRead = controlledCall<string[]>();
    deps.taskGate = {
      listActionableTaskKeys: taskRead.invoke,
    };
    mgr.create(SESSION, 'x');
    const pending = handleGoalContinuation(deps, SESSION, 'turn-1');
    await taskRead.started;

    mgr.pause(SESSION);
    taskRead.resolve([]);
    const result = await pending;

    assert.equal(result.kind, 'stale');
    assert.equal(mgr.get(SESSION)?.status, 'paused');
    assert.deepEqual(injected, []);
  });

  test('paused goal is not continued', async () => {
    const { mgr, deps } = setup();
    mgr.create(SESSION, 'x');
    mgr.pause(SESSION);
    const out = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(out.kind, 'no_goal');
  });

  test('task gate injects one reminder per goal and traces the reminder limit', async () => {
    const { mgr, deps, injected } = setup();
    const traces: Array<{ decision: string; taskKeys: string[]; turnId: string }> = [];
    deps.taskGate = {
      listActionableTaskKeys: async () => ['T1', 'T1.1'],
      recordDecision: (trace) => { traces.push(trace); },
    };
    mgr.create(SESSION, 'finish implementation');
    await handleGoalContinuation(deps, SESSION, 'turn-1');
    await handleGoalContinuation(deps, SESSION, 'turn-2');
    assert.equal(injected.length, 2);
    assert.match(injected[0]!, /Actionable task keys: T1, T1\.1/);
    assert.doesNotMatch(injected[1]!, /\[Task reminder\]/);
    assert.deepEqual(traces.map((trace) => trace.decision), ['reminder_injected', 'reminder_limit_reached']);
    assert.equal(traces[0]?.turnId, 'turn-1');
  });

  test('task gate excludes blocked/empty ledgers through its actionable read model', async () => {
    const { mgr, deps, injected } = setup();
    const decisions: string[] = [];
    deps.taskGate = {
      listActionableTaskKeys: async () => [],
      recordDecision: (trace) => { decisions.push(trace.decision); },
    };
    mgr.create(SESSION, 'wait for dependency');
    await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.doesNotMatch(injected[0]!, /\[Task reminder\]/);
    assert.deepEqual(decisions, ['no_actionable_tasks']);
  });

  test('evaluator terminal decisions win over actionable tasks', async () => {
    const { mgr, deps, injected } = setup({ evaluation: { met: true, reason: 'verified' } });
    const decisions: string[] = [];
    let listCalls = 0;
    deps.taskGate = {
      listActionableTaskKeys: async () => { listCalls += 1; return ['T1']; },
      recordDecision: (trace) => { decisions.push(trace.decision); },
    };
    mgr.create(SESSION, 'done');
    await handleGoalContinuation(deps, SESSION, 'turn-final');
    assert.equal(listCalls, 0);
    assert.equal(injected.length, 0);
    assert.deepEqual(decisions, ['evaluator_terminal']);
  });

  test('task reminder is not consumed when the post-evaluation idle check loses the race', async () => {
    const { mgr, deps, injected } = setup();
    const traces: string[] = [];
    let canContinueCalls = 0;
    deps.canContinue = async () => {
      canContinueCalls += 1;
      return canContinueCalls !== 2;
    };
    deps.taskGate = {
      listActionableTaskKeys: async () => ['T1'],
      recordDecision: (trace) => { traces.push(trace.decision); },
    };
    mgr.create(SESSION, 'finish implementation');

    const preempted = await handleGoalContinuation(deps, SESSION, 'turn-1');
    assert.equal(preempted.kind, 'cannot_continue');
    assert.deepEqual(injected, []);
    assert.deepEqual(traces, []);

    const retried = await handleGoalContinuation(deps, SESSION, 'turn-2');
    assert.equal(retried.kind, 'continued');
    assert.match(injected[0]!, /\[Task reminder\]/);
    assert.deepEqual(traces, ['reminder_injected']);
  });

  test('goal caps trace the actionable task keys that remain at stop', async () => {
    const { mgr, deps } = setup({ evaluation: { met: false, progress: true } });
    const traces: Array<{ decision: string; taskKeys: string[] }> = [];
    deps.taskGate = {
      listActionableTaskKeys: async () => ['T1', 'T2.1'],
      recordDecision: (trace) => { traces.push(trace); },
    };
    mgr.create(SESSION, 'finish implementation', { maxIterations: 1 });
    const result = await handleGoalContinuation(deps, SESSION, 'turn-final');
    assert.equal(result.kind, 'stopped');
    assert.deepEqual(traces, [{
      sessionId: SESSION,
      turnId: 'turn-final',
      goalId: mgr.get(SESSION)!.id,
      decision: 'goal_stopped',
      taskKeys: ['T1', 'T2.1'],
    }]);
  });
});
