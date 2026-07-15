import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GoalManager, type GoalManagerDeps } from '../goal-state.js';
import {
  buildGoalTools,
  GOAL_CLEAR_TOOL_NAME,
  GOAL_PAUSE_TOOL_NAME,
  GOAL_RESUME_TOOL_NAME,
  GOAL_SET_TOOL_NAME,
} from '../goal-tools.js';
import {
  GoalContinuationCoordinator,
  type GoalContinuationDeps,
  type GoalContinuationOutcome,
  type GoalContinuationScheduler,
  type GoalTurnAdmission,
  type GoalTurnBinder,
  type GoalTurnOutcome,
} from '../goal-continuation.js';
import type { GoalEvaluation } from '../goal-evaluator.js';
import type { MakaToolContext } from '../tool-runtime.js';

const SESSION = 'sess-1';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controlledCall<T>() {
  const result = deferred<T>();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  return {
    invoke: () => {
      markStarted();
      return result.promise;
    },
    started,
    resolve: result.resolve,
    reject: result.reject,
  };
}

class ManualScheduler implements GoalContinuationScheduler {
  private nextId = 0;
  readonly entries: Array<{
    id: number;
    callback: () => void;
    delayMs: number;
    cleared: boolean;
  }> = [];

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.entries.push({ id, callback, delayMs, cleared: false });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const entry = this.entries.find((candidate) => candidate.id === handle);
    if (entry) entry.cleared = true;
  }

  pendingDelays(): number[] {
    return this.entries.filter((entry) => !entry.cleared).map((entry) => entry.delayMs);
  }

  fireNext(): void {
    const entry = this.entries.find((candidate) => !candidate.cleared);
    assert.ok(entry, 'expected a pending timer');
    entry.cleared = true;
    entry.callback();
  }

  fireEvenIfCleared(index: number): void {
    const entry = this.entries[index];
    assert.ok(entry, `expected timer at index ${index}`);
    entry.callback();
  }
}

interface AdmittedTurn {
  sessionId: string;
  prompt: string;
  turnId: string;
  completion: ReturnType<typeof deferred<GoalTurnOutcome>>;
}

function setup(opts?: {
  evaluations?: Partial<GoalEvaluation>[];
  tokenCount?: number;
  onChange?: GoalManagerDeps['onChange'];
  taskGate?: GoalContinuationDeps['taskGate'];
}) {
  let id = 0;
  const manager = new GoalManager({
    generateId: () => `g-${++id}`,
    now: () => 1000,
    onChange: opts?.onChange,
  });
  const scheduler = new ManualScheduler();
  const evaluationQueue = [...(opts?.evaluations ?? [])];
  const defaultEvaluation: GoalEvaluation = {
    met: false,
    impossible: false,
    progress: true,
    waiting: false,
    evaluatorFailed: false,
    reason: 'keep going',
  };
  const attemptedPrompts: string[] = [];
  const admitted: AdmittedTurn[] = [];
  let ownedTurnSequence = 0;
  let admissionImpl: (
    sessionId: string,
    prompt: string,
    bindTurn: GoalTurnBinder,
  ) => GoalTurnAdmission = (sessionId, prompt, bindTurn) => {
    const turnId = `turn-owned-${++ownedTurnSequence}`;
    assert.deepEqual(bindTurn(turnId), { kind: 'bound' });
    const completion = deferred<GoalTurnOutcome>();
    admitted.push({ sessionId, prompt, turnId, completion });
    return { kind: 'started', completion: completion.promise };
  };
  const deps: GoalContinuationDeps = {
    goalManager: manager,
    evaluator: {
      evaluate: async () => {
        const next = { ...defaultEvaluation, ...evaluationQueue.shift() };
        return JSON.stringify(next);
      },
    },
    getRecentContext: async () => 'recent context',
    getTokenCount: opts?.tokenCount !== undefined ? () => opts.tokenCount! : undefined,
    admitTurn: (sessionId, prompt, bindTurn) => {
      attemptedPrompts.push(prompt);
      return admissionImpl(sessionId, prompt, bindTurn);
    },
    scheduler,
    ...(opts?.taskGate ? { taskGate: opts.taskGate } : {}),
  };
  const coordinator = new GoalContinuationCoordinator(deps);
  return {
    manager,
    scheduler,
    deps,
    coordinator,
    attemptedPrompts,
    admitted,
    setAdmission: (next: typeof admissionImpl) => { admissionImpl = next; },
    queueEvaluations: (...next: Partial<GoalEvaluation>[]) => evaluationQueue.push(...next),
  };
}

async function waitFor(condition: () => boolean, message = 'condition was not met'): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function settleExternal(
  coordinator: GoalContinuationCoordinator,
  sessionId: string,
  outcome: GoalTurnOutcome,
): Promise<GoalContinuationOutcome> {
  assert.ok(outcome.turnId, 'an external turn must have a stable identity before it starts');
  const registration = coordinator.beginExternalTurn(sessionId, outcome.turnId);
  if (registration.kind === 'duplicate') return Promise.resolve({ kind: 'duplicate' });
  if (registration.kind === 'unavailable') return Promise.resolve({ kind: 'stale' });
  return registration.settle(outcome);
}

function registerExternalTurn(
  coordinator: GoalContinuationCoordinator,
  sessionId: string,
  turnId: string,
) {
  const registration = coordinator.beginExternalTurn(sessionId, turnId);
  assert.equal(registration.kind, 'registered');
  return registration.settle;
}

function goalToolContext(turnId: string): MakaToolContext {
  return {
    sessionId: SESSION,
    turnId,
    cwd: '/',
    toolCallId: `tool-${turnId}`,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function goalToolsFor(
  manager: GoalManager,
  coordinator: GoalContinuationCoordinator,
) {
  return buildGoalTools({
    goalManager: manager,
    goalContinuation: coordinator,
  });
}

describe('GoalContinuationCoordinator settlement', () => {
  test('returns no_goal without retaining an idle lane', async () => {
    const { coordinator } = setup();
    assert.deepEqual(await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    }), { kind: 'no_goal' });
  });

  test('binds a Goal created by the same external turn before it settles', async () => {
    const { manager, coordinator } = setup({
      evaluations: [{ met: true, reason: 'same-turn Goal verified' }],
    });
    const settle = registerExternalTurn(coordinator, SESSION, 'turn-owner');
    const tools = goalToolsFor(manager, coordinator);
    const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(set);

    await set.impl({ condition: 'ship' }, goalToolContext('turn-owner'));
    const result = await settle({ kind: 'completed', turnId: 'turn-owner' });

    assert.equal(result.kind, 'achieved');
    assert.equal(manager.get(SESSION)?.status, 'achieved');
  });

  test('an unbound turn cannot settle a Goal created by a concurrent turn', async () => {
    const { manager, coordinator, deps } = setup({
      evaluations: [{ met: true, reason: 'owner verified' }],
    });
    let evaluations = 0;
    const evaluate = deps.evaluator.evaluate;
    deps.evaluator.evaluate = (...args) => {
      evaluations++;
      return evaluate(...args);
    };
    const settleOther = registerExternalTurn(coordinator, SESSION, 'turn-other');
    const settleOwner = registerExternalTurn(coordinator, SESSION, 'turn-owner');
    const set = goalToolsFor(manager, coordinator)
      .find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(set);
    await set.impl({ condition: 'ship' }, goalToolContext('turn-owner'));

    assert.equal((await settleOther({
      kind: 'completed',
      turnId: 'turn-other',
    })).kind, 'stale');
    assert.equal(evaluations, 0);
    assert.equal((await settleOwner({
      kind: 'completed',
      turnId: 'turn-owner',
    })).kind, 'achieved');
    assert.equal(evaluations, 1);
  });

  test('an older unbound turn cannot activate a Goal after another turn activated and cleared one', async () => {
    const { manager, coordinator } = setup();
    registerExternalTurn(coordinator, SESSION, 'turn-old');
    registerExternalTurn(coordinator, SESSION, 'turn-owner');
    const tools = goalToolsFor(manager, coordinator);
    const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
    assert.ok(set);
    assert.ok(clear);

    await set.impl({ condition: 'first' }, goalToolContext('turn-owner'));
    await clear.impl({}, goalToolContext('turn-owner'));
    const output = String(await set.impl({ condition: 'replacement' }, goalToolContext('turn-old')));

    assert.match(output, /no longer owns Goal activation/);
    assert.equal(manager.get(SESSION)?.status, 'cleared');
    assert.equal(manager.get(SESSION)?.condition, 'first');
  });

  test('a turn registered against a paused Goal cannot activate after another turn clears it', async () => {
    const { manager, coordinator } = setup();
    manager.create(SESSION, 'paused goal');
    manager.pause(SESSION);
    registerExternalTurn(coordinator, SESSION, 'turn-old');
    registerExternalTurn(coordinator, SESSION, 'turn-clear');
    const tools = goalToolsFor(manager, coordinator);
    const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
    const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(clear);
    assert.ok(set);

    assert.match(
      String(await clear.impl({}, goalToolContext('turn-clear'))),
      /Goal cleared/,
    );
    const output = String(await set.impl(
      { condition: 'replacement' },
      goalToolContext('turn-old'),
    ));

    assert.match(output, /no longer owns Goal activation/);
    assert.equal(manager.get(SESSION)?.condition, 'paused goal');
    assert.equal(manager.get(SESSION)?.status, 'cleared');
  });

  test('an old Goal turn cannot pause or clear a replacement Goal', async () => {
    const { manager, coordinator } = setup();
    manager.create(SESSION, 'first');
    registerExternalTurn(coordinator, SESSION, 'turn-old');
    registerExternalTurn(coordinator, SESSION, 'turn-clear');
    const tools = goalToolsFor(manager, coordinator);
    const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
    const pause = tools.find((tool) => tool.name === GOAL_PAUSE_TOOL_NAME);
    const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(clear);
    assert.ok(pause);
    assert.ok(set);

    await clear.impl({}, goalToolContext('turn-clear'));
    registerExternalTurn(coordinator, SESSION, 'turn-replacement');
    await set.impl({ condition: 'replacement' }, goalToolContext('turn-replacement'));

    assert.match(
      String(await pause.impl({}, goalToolContext('turn-old'))),
      /no longer owns Goal control/,
    );
    assert.match(
      String(await clear.impl({}, goalToolContext('turn-old'))),
      /no longer owns Goal control/,
    );
    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.status, 'active');
  });

  test('a throwing state observer cannot strand Goal activation without its turn lease', async () => {
    const { manager, coordinator } = setup({
      evaluations: [{ met: true, reason: 'verified' }],
      onChange: () => { throw new Error('observer failed'); },
    });
    const settle = registerExternalTurn(coordinator, SESSION, 'turn-set');
    const set = goalToolsFor(manager, coordinator)
      .find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(set);

    const output = String(await set.impl({ condition: 'ship' }, goalToolContext('turn-set')));
    const outcome = await settle({ kind: 'completed', turnId: 'turn-set' });

    assert.match(output, /Goal set/);
    assert.equal(outcome.kind, 'achieved');
    assert.equal(manager.get(SESSION)?.status, 'achieved');
  });

  test('a removed external turn cannot create or resume a Goal through the real tools', async (t) => {
    await t.test('GoalSet after permanent removal', async () => {
      const { manager, coordinator } = setup();
      registerExternalTurn(coordinator, SESSION, 'turn-deleted');
      const set = goalToolsFor(manager, coordinator)
        .find((tool) => tool.name === GOAL_SET_TOOL_NAME);
      assert.ok(set);

      const removal = coordinator.beginSessionClose(SESSION, 'remove');
      manager.removeSession(SESSION);
      removal.commit();
      const output = String(await set.impl({ condition: 'must not exist' }, goalToolContext('turn-deleted')));

      assert.match(output, /no longer owns Goal activation/);
      assert.equal(manager.get(SESSION), undefined);
    });

    await t.test('GoalResume after archive and replacement', async () => {
      const { manager, coordinator } = setup();
      manager.create(SESSION, 'old');
      manager.pause(SESSION);
      registerExternalTurn(coordinator, SESSION, 'turn-archived');
      const resume = goalToolsFor(manager, coordinator)
        .find((tool) => tool.name === GOAL_RESUME_TOOL_NAME);
      assert.ok(resume);

      const archive = coordinator.beginSessionClose(SESSION, 'archive');
      manager.removeGoal(SESSION);
      archive.commit();
      coordinator.unarchiveSession(SESSION);
      manager.create(SESSION, 'replacement');
      manager.pause(SESSION);
      const output = String(await resume.impl({}, goalToolContext('turn-archived')));

      assert.match(output, /no longer owns Goal activation/);
      assert.equal(manager.get(SESSION)?.condition, 'replacement');
      assert.equal(manager.get(SESSION)?.status, 'paused');
    });
  });

  test('closed sessions reject fresh Goal authority until explicitly reopened', async (t) => {
    await t.test('archive fence', async () => {
      const { manager, coordinator } = setup();
      manager.create(SESSION, 'archived');
      const archive = coordinator.beginSessionClose(SESSION, 'archive');
      assert.equal(manager.removeGoal(SESSION), true);
      archive.commit();

      assert.deepEqual(coordinator.beginExternalTurn(SESSION, 'turn-closed'), {
        kind: 'unavailable',
        reason: 'Goal continuation session is closed.',
      });
      const set = goalToolsFor(manager, coordinator)
        .find((tool) => tool.name === GOAL_SET_TOOL_NAME);
      assert.ok(set);
      assert.match(
        String(await set.impl({ condition: 'must stay closed' }, goalToolContext('turn-closed'))),
        /no longer owns Goal activation/,
      );
      assert.equal(manager.get(SESSION), undefined);

      coordinator.unarchiveSession(SESSION);
      registerExternalTurn(coordinator, SESSION, 'turn-reopened');
      assert.match(
        String(await set.impl({ condition: 'reopened' }, goalToolContext('turn-reopened'))),
        /Goal set/,
      );
      assert.equal(manager.get(SESSION)?.condition, 'reopened');
    });

    await t.test('permanent removal fence', () => {
      const { manager, coordinator } = setup();
      manager.create(SESSION, 'deleted');
      const removal = coordinator.beginSessionClose(SESSION, 'remove');
      assert.equal(manager.removeSession(SESSION), true);
      removal.commit();

      assert.deepEqual(coordinator.beginExternalTurn(SESSION, 'turn-after-delete'), {
        kind: 'unavailable',
        reason: 'Goal continuation session is closed.',
      });
      assert.equal(manager.removeSession(SESSION), false);
    });
  });

  test('a rolled-back session close leaves revoked continuation visibly paused', async (t) => {
    await t.test('busy continuation intent', async () => {
      const { manager, coordinator, setAdmission, attemptedPrompts } = setup();
      const idle = deferred<void>();
      setAdmission(() => ({ kind: 'busy', whenIdle: idle.promise }));
      manager.create(SESSION, 'ship');

      assert.equal((await settleExternal(coordinator, SESSION, {
        kind: 'completed',
        turnId: 'turn-external',
      })).kind, 'continued');
      await waitFor(() => attemptedPrompts.length === 1, 'continuation did not reach the busy gate');

      const archive = coordinator.beginSessionClose(SESSION, 'archive');
      archive.rollback();
      idle.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(manager.get(SESSION)?.status, 'paused');
      assert.equal(
        manager.get(SESSION)?.lastReason,
        'Goal continuation paused because session archive did not complete.',
      );
      assert.equal(attemptedPrompts.length, 1);

      registerExternalTurn(coordinator, SESSION, 'turn-resume');
      const resume = goalToolsFor(manager, coordinator)
        .find((tool) => tool.name === GOAL_RESUME_TOOL_NAME);
      assert.ok(resume);
      assert.match(String(await resume.impl({}, goalToolContext('turn-resume'))), /Goal resumed/);
      assert.equal(manager.get(SESSION)?.status, 'active');
    });

    await t.test('in-flight evaluator', async () => {
      const { manager, coordinator, deps, admitted } = setup();
      const evaluation = controlledCall<string>();
      deps.evaluator.evaluate = evaluation.invoke;
      manager.create(SESSION, 'ship');
      const settlement = settleExternal(coordinator, SESSION, {
        kind: 'completed',
        turnId: 'turn-evaluating',
      });
      await evaluation.started;

      const removal = coordinator.beginSessionClose(SESSION, 'remove');
      removal.rollback();
      assert.equal((await settlement).kind, 'stale');
      evaluation.resolve('{"met":true,"reason":"late"}');
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(manager.get(SESSION)?.status, 'paused');
      assert.equal(
        manager.get(SESSION)?.lastReason,
        'Goal continuation paused because session removal did not complete.',
      );
      assert.equal(admitted.length, 0);
    });
  });

  test('duplicate external registration is rejected while the original is open or processing', async () => {
    const { manager, coordinator, deps } = setup();
    const evaluation = controlledCall<string>();
    deps.evaluator.evaluate = evaluation.invoke;
    manager.create(SESSION, 'ship');
    const settle = registerExternalTurn(coordinator, SESSION, 'turn-shared');

    assert.deepEqual(coordinator.beginExternalTurn(SESSION, 'turn-shared'), { kind: 'duplicate' });
    const pending = settle({ kind: 'completed', turnId: 'turn-shared' });
    await evaluation.started;
    assert.deepEqual(coordinator.beginExternalTurn(SESSION, 'turn-shared'), { kind: 'duplicate' });

    evaluation.resolve('{"met":true,"reason":"verified"}');
    assert.equal((await pending).kind, 'achieved');
  });

  test('a terminal turn-id mismatch pauses in FIFO order under the registered identity', async () => {
    const { manager, coordinator, deps } = setup();
    const firstEvaluation = controlledCall<string>();
    deps.evaluator.evaluate = firstEvaluation.invoke;
    manager.create(SESSION, 'ship');
    const settleFirst = registerExternalTurn(coordinator, SESSION, 'turn-first');
    const settleExpected = registerExternalTurn(coordinator, SESSION, 'turn-expected');

    const first = settleFirst({ kind: 'completed', turnId: 'turn-first' });
    await firstEvaluation.started;
    const mismatched = settleExpected({ kind: 'completed', turnId: 'turn-wrong' });
    assert.equal(manager.get(SESSION)?.status, 'active');

    firstEvaluation.resolve('{"met":false,"progress":true,"reason":"first evidence"}');
    assert.equal((await first).kind, 'continued');
    assert.equal((await mismatched).kind, 'stopped');

    assert.equal(manager.get(SESSION)?.status, 'paused');
    assert.match(manager.get(SESSION)?.lastReason ?? '', /identity mismatch/);
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-expected'), true);
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-wrong'), false);
    assert.deepEqual(coordinator.beginExternalTurn(SESSION, 'turn-expected'), { kind: 'duplicate' });
  });

  test('a host that binds twice fails closed without leaking the first turn identity', async () => {
    const { manager, coordinator, setAdmission } = setup();
    const completion = deferred<GoalTurnOutcome>();
    setAdmission((_sessionId, _prompt, bindTurn) => {
      assert.deepEqual(bindTurn('turn-owned-first'), { kind: 'bound' });
      assert.deepEqual(bindTurn('turn-owned-second'), {
        kind: 'unavailable',
        reason: 'Goal continuation turn ownership is stale.',
      });
      return {
        kind: 'started',
        completion: completion.promise,
      };
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => manager.get(SESSION)?.status === 'paused', 'double-bound host did not pause Goal');

    assert.equal(manager.hasSettledTurn(SESSION, 'turn-owned-first'), true);
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-owned-second'), false);
    assert.deepEqual(coordinator.beginExternalTurn(SESSION, 'turn-owned-first'), { kind: 'duplicate' });
    completion.reject(new Error('owned stream failed after protocol rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test('a turn cannot rebind after activating and pausing its Goal', async () => {
    const { manager, coordinator, deps } = setup();
    let evaluations = 0;
    deps.evaluator.evaluate = async () => {
      evaluations++;
      return '{"met":true,"reason":"must not evaluate"}';
    };
    const settle = registerExternalTurn(coordinator, SESSION, 'turn-control');
    const tools = goalToolsFor(manager, coordinator);
    const context = goalToolContext('turn-control');
    let resumeOutput = '';
    for (const name of [GOAL_SET_TOOL_NAME, GOAL_PAUSE_TOOL_NAME, GOAL_RESUME_TOOL_NAME]) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool);
      const output = await tool.impl(name === GOAL_SET_TOOL_NAME ? { condition: 'ship' } : {}, context);
      if (name === GOAL_RESUME_TOOL_NAME) resumeOutput = String(output);
    }

    assert.equal((await settle({
      kind: 'completed',
      turnId: 'turn-control',
    })).kind, 'stale');
    assert.match(resumeOutput, /no longer owns Goal activation/);
    assert.equal(manager.get(SESSION)?.status, 'paused');
    assert.equal(manager.get(SESSION)?.iterations, 0);
    assert.equal(evaluations, 0);
  });

  test('terminal evaluator verdict wins over hard caps and never admits another turn', async () => {
    const { manager, coordinator, admitted } = setup({
      evaluations: [{ met: true, reason: 'verified' }],
      tokenCount: 10_000,
    });
    manager.create(SESSION, 'ship', { maxIterations: 1, tokenBudget: 1 });

    const outcome = await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-final',
    });

    assert.equal(outcome.kind, 'achieved');
    assert.equal(manager.get(SESSION)?.status, 'achieved');
    assert.equal(manager.get(SESSION)?.iterations, 0);
    assert.equal(admitted.length, 0);
  });

  test('an impossible verdict terminates without admission', async () => {
    const { manager, coordinator, admitted } = setup({
      evaluations: [{ impossible: true, reason: 'required dependency does not exist' }],
    });
    manager.create(SESSION, 'ship');

    const outcome = await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-impossible',
    });

    assert.equal(outcome.kind, 'impossible');
    assert.equal(manager.get(SESSION)?.status, 'impossible');
    assert.equal(admitted.length, 0);
  });

  test('nonterminal settlement updates counters and admits one real continuation', async () => {
    const { manager, coordinator, admitted } = setup({
      evaluations: [{ progress: false, reason: 'one check remains' }],
    });
    manager.create(SESSION, 'ship', { blockCap: 3 });

    const outcome = await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await waitFor(() => admitted.length === 1, 'continuation was not admitted');

    assert.equal(outcome.kind, 'continued');
    assert.equal(manager.get(SESSION)?.iterations, 1);
    assert.equal(manager.get(SESSION)?.consecutiveNoProgress, 1);
    assert.equal(admitted.length, 1);
    assert.match(admitted[0]!.prompt, /one check remains/);
  });

  test('evaluator failure remains neutral and fail-open', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    deps.evaluator.evaluate = async () => { throw new Error('provider outage'); };
    manager.create(SESSION, 'ship', { blockCap: 1 });

    const outcome = await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await waitFor(() => admitted.length === 1, 'fail-open continuation was not admitted');

    assert.equal(outcome.kind, 'continued');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(manager.get(SESSION)?.consecutiveNoProgress, 0);
    assert.equal(admitted.length, 1);
  });

  test('context failure pauses the exact Goal with a visible reason', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    deps.getRecentContext = async () => { throw new Error('storage unavailable'); };
    manager.create(SESSION, 'ship');

    const outcome = await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });

    assert.equal(outcome.kind, 'stopped');
    assert.equal(manager.get(SESSION)?.status, 'paused');
    assert.match(manager.get(SESSION)?.lastReason ?? '', /storage unavailable/);
    assert.equal(admitted.length, 0);
  });

  test('queued completions are evaluated FIFO and collapse to the newest pending intent', async () => {
    const { manager, coordinator, deps, admitted, queueEvaluations } = setup();
    const firstEvaluation = controlledCall<string>();
    let calls = 0;
    deps.evaluator.evaluate = (async () => {
      calls++;
      if (calls === 1) return firstEvaluation.invoke();
      return JSON.stringify({
        met: false,
        impossible: false,
        progress: true,
        waiting: false,
        reason: 'second result',
      });
    });
    manager.create(SESSION, 'ship');

    const first = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await firstEvaluation.started;
    const second = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-2' });
    firstEvaluation.resolve(JSON.stringify({
      met: false,
      impossible: false,
      progress: true,
      waiting: false,
      reason: 'first result',
    }));
    await Promise.all([first, second]);
    await waitFor(() => admitted.length === 1, 'newest continuation was not admitted');

    assert.equal(manager.get(SESSION)?.iterations, 2);
    assert.equal(admitted.length, 1);
    assert.match(admitted[0]!.prompt, /second result/);
    assert.doesNotMatch(admitted[0]!.prompt, /first result/);
  });

  test('queues failures behind earlier evidence and consumes the remaining generation before resume', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    let evaluations = 0;
    deps.evaluator.evaluate = () => {
      evaluations++;
      return evaluation.invoke();
    };
    manager.create(SESSION, 'ship');

    const first = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-first' });
    await evaluation.started;
    const failure = settleExternal(coordinator, SESSION, {
      kind: 'errored',
      turnId: 'turn-failure',
      reason: 'provider failed',
    });
    const later = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-later' });

    assert.equal(manager.get(SESSION)?.status, 'active');
    evaluation.resolve(JSON.stringify({
      met: false,
      impossible: false,
      progress: true,
      waiting: false,
      reason: 'first result',
    }));
    const [firstResult, failureResult, laterResult] = await Promise.all([first, failure, later]);

    assert.equal(firstResult.kind, 'continued');
    assert.equal(failureResult.kind, 'stopped');
    assert.equal(laterResult.kind, 'stale');
    assert.equal(manager.get(SESSION)?.status, 'paused');
    assert.equal(evaluations, 1);
    assert.equal(admitted.length, 0);
    for (const turnId of ['turn-first', 'turn-failure', 'turn-later']) {
      assert.equal(manager.hasSettledTurn(SESSION, turnId), true);
    }

    manager.resume(SESSION);
    for (const outcome of [
      { kind: 'completed', turnId: 'turn-first' },
      { kind: 'errored', turnId: 'turn-failure', reason: 'provider failed' },
      { kind: 'completed', turnId: 'turn-later' },
    ] satisfies GoalTurnOutcome[]) {
      assert.equal((await settleExternal(coordinator, SESSION, outcome)).kind, 'duplicate');
    }
    assert.equal(evaluations, 1);
    assert.equal(manager.get(SESSION)?.status, 'active');
  });

  test('pause and resume invalidate every outcome queued under the previous control lease', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    let evaluations = 0;
    deps.evaluator.evaluate = () => {
      evaluations++;
      return evaluation.invoke();
    };
    manager.create(SESSION, 'ship');

    const first = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-first',
    });
    await evaluation.started;
    const failure = settleExternal(coordinator, SESSION, {
      kind: 'errored',
      turnId: 'turn-failure',
      reason: 'provider failed',
    });
    const later = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-later',
    });

    assert.ok(manager.pause(SESSION));
    assert.ok(manager.resume(SESSION));
    evaluation.resolve(JSON.stringify({
      met: true,
      impossible: false,
      progress: true,
      waiting: false,
      reason: 'old evidence must not apply',
    }));

    assert.deepEqual(
      (await Promise.all([first, failure, later])).map((result) => result.kind),
      ['stale', 'stale', 'stale'],
    );
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(manager.get(SESSION)?.iterations, 0);
    assert.equal(evaluations, 1);
    assert.equal(admitted.length, 0);
    for (const outcome of [
      { kind: 'completed', turnId: 'turn-first' },
      { kind: 'errored', turnId: 'turn-failure', reason: 'provider failed' },
      { kind: 'completed', turnId: 'turn-later' },
    ] satisfies GoalTurnOutcome[]) {
      assert.equal((await settleExternal(coordinator, SESSION, outcome)).kind, 'duplicate');
    }
  });

  test('a pre-pause external turn cannot settle the resumed Goal', async () => {
    const { manager, coordinator, deps } = setup();
    let evaluations = 0;
    deps.evaluator.evaluate = async () => {
      evaluations++;
      return '{"met":true,"reason":"must not evaluate"}';
    };
    manager.create(SESSION, 'ship');
    const settleLate = registerExternalTurn(coordinator, SESSION, 'turn-late');

    assert.equal((await settleExternal(coordinator, SESSION, {
      kind: 'errored',
      turnId: 'turn-failure',
      reason: 'provider failed',
    })).kind, 'stopped');
    assert.ok(manager.resume(SESSION));
    assert.equal((await settleLate({
      kind: 'completed',
      turnId: 'turn-late',
    })).kind, 'stale');
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-late'), true);

    assert.equal((await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-late',
    })).kind, 'duplicate');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(evaluations, 0);
  });

  test('archive retains queued and in-flight turn identities across Goal replacement', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    deps.evaluator.evaluate = evaluation.invoke;
    manager.create(SESSION, 'old');

    const inFlight = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-in-flight',
    });
    await evaluation.started;
    const queued = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-queued',
    });

    const archive = coordinator.beginSessionClose(SESSION, 'archive');
    assert.equal(manager.removeGoal(SESSION), true);
    archive.commit();
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-in-flight'), true);
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-queued'), true);
    coordinator.unarchiveSession(SESSION);
    assert.equal(manager.create(SESSION, 'replacement').kind, 'created');

    assert.equal((await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-in-flight',
    })).kind, 'duplicate');
    assert.equal((await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-queued',
    })).kind, 'duplicate');
    assert.equal((await inFlight).kind, 'stale');
    assert.equal((await queued).kind, 'stale');

    evaluation.resolve(JSON.stringify({
      met: true,
      impossible: false,
      progress: true,
      waiting: false,
      reason: 'old evaluator must not apply',
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 0);
  });

  test('archive consumes an external turn that has not reached the FIFO', async () => {
    const { manager, coordinator, deps } = setup();
    let evaluations = 0;
    deps.evaluator.evaluate = async () => {
      evaluations++;
      return '{"met":true,"reason":"old turn must not evaluate"}';
    };
    manager.create(SESSION, 'old');
    const settleOld = registerExternalTurn(coordinator, SESSION, 'turn-still-draining');

    const archive = coordinator.beginSessionClose(SESSION, 'archive');
    assert.equal(manager.removeGoal(SESSION), true);
    archive.commit();
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-still-draining'), true);
    coordinator.unarchiveSession(SESSION);
    assert.equal(manager.create(SESSION, 'replacement').kind, 'created');

    assert.equal((await settleOld({
      kind: 'completed',
      turnId: 'turn-still-draining',
    })).kind, 'duplicate');
    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(evaluations, 0);
  });

  test('permanent removal keeps a consumed external capability from recreating session state', async () => {
    const { manager, coordinator, deps } = setup();
    let evaluations = 0;
    deps.evaluator.evaluate = async () => {
      evaluations++;
      return '{"met":true,"reason":"deleted turn must not evaluate"}';
    };
    manager.create(SESSION, 'deleted');
    const settleDeleted = registerExternalTurn(coordinator, SESSION, 'turn-deleted');

    const removal = coordinator.beginSessionClose(SESSION, 'remove');
    assert.equal(manager.removeSession(SESSION), true);
    removal.commit();
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-deleted'), false);

    assert.equal((await settleDeleted({
      kind: 'completed',
      turnId: 'turn-deleted',
    })).kind, 'stale');
    assert.equal(manager.get(SESSION), undefined);
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-deleted'), false);
    assert.equal(evaluations, 0);
  });

  test('a late evaluator finally cannot recreate the ledger after permanent removal', async () => {
    const { manager, coordinator, deps } = setup();
    const evaluation = controlledCall<string>();
    deps.evaluator.evaluate = evaluation.invoke;
    manager.create(SESSION, 'deleted while evaluating');
    const settle = registerExternalTurn(coordinator, SESSION, 'turn-evaluating');
    const pending = settle({ kind: 'completed', turnId: 'turn-evaluating' });
    await evaluation.started;

    const removal = coordinator.beginSessionClose(SESSION, 'remove');
    manager.removeSession(SESSION);
    removal.commit();
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-evaluating'), false);

    evaluation.resolve('{"met":true,"reason":"too late"}');
    assert.equal((await pending).kind, 'stale');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.get(SESSION), undefined);
    assert.equal(manager.hasSettledTurn(SESSION, 'turn-evaluating'), false);
  });

  test('a replacement invalidates a late evaluator result and its side effects', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    deps.evaluator.evaluate = evaluation.invoke;
    manager.create(SESSION, 'old');

    const pending = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-old',
    });
    await evaluation.started;
    manager.clear(SESSION);
    const replacement = manager.create(SESSION, 'replacement');
    assert.equal(replacement.kind, 'created');
    evaluation.resolve('{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"old done"}');

    assert.equal((await pending).kind, 'stale');
    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 0);
  });

  test('a settled turn remains duplicate after a terminal Goal is replaced', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    let evaluations = 0;
    const evaluate = deps.evaluator.evaluate;
    deps.evaluator.evaluate = (...args) => {
      evaluations++;
      return evaluate(...args);
    };
    manager.create(SESSION, 'first', { maxIterations: 1 });

    const first = await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-shared',
    });
    assert.equal(first.kind, 'stopped');
    const replacement = manager.create(SESSION, 'replacement');
    assert.equal(replacement.kind, 'created');

    const replay = await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-shared',
    });

    assert.equal(replay.kind, 'duplicate');
    assert.equal(evaluations, 1);
    assert.equal(admitted.length, 0);
    assert.equal(manager.get(SESSION)?.iterations, 0);
  });

  test('late evaluator results cannot cross clear, pause/resume, or removal', async (t) => {
    for (const scenario of ['clear', 'pause-resume', 'remove'] as const) {
      await t.test(scenario, async () => {
        const { manager, coordinator, deps, admitted } = setup();
        const evaluation = controlledCall<string>();
        deps.evaluator.evaluate = evaluation.invoke;
        manager.create(SESSION, 'ship');
        const pending = settleExternal(coordinator, SESSION, {
          kind: 'completed',
          turnId: `turn-${scenario}`,
        });
        await evaluation.started;

        if (scenario === 'clear') {
          manager.clear(SESSION);
        } else if (scenario === 'pause-resume') {
          manager.pause(SESSION);
          manager.resume(SESSION);
        } else {
          const removal = coordinator.beginSessionClose(SESSION, 'remove');
          manager.removeSession(SESSION);
          removal.commit();
        }
        evaluation.resolve(JSON.stringify({
          met: false,
          impossible: false,
          progress: true,
          waiting: false,
          reason: 'late progress',
        }));

        assert.equal((await pending).kind, 'stale');
        if (scenario === 'remove') assert.equal(manager.get(SESSION), undefined);
        else assert.equal(manager.get(SESSION)?.iterations, 0);
        assert.equal(admitted.length, 0);
      });
    }
  });

  test('dispose revokes an evaluator and all later injection', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    deps.evaluator.evaluate = evaluation.invoke;
    manager.create(SESSION, 'ship');

    const pending = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await evaluation.started;
    coordinator.dispose();
    evaluation.resolve('{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"late"}');

    assert.equal((await pending).kind, 'stale');
    assert.equal(manager.get(SESSION)?.iterations, 0);
    assert.equal(admitted.length, 0);
  });
});

describe('GoalContinuationCoordinator admission and completion', () => {
  test('aborted, suspended, and errored external turns pause the current Goal without evaluation', async (t) => {
    const outcomes: GoalTurnOutcome[] = [
      { kind: 'aborted', turnId: 'turn-aborted' },
      {
        kind: 'suspended',
        turnId: 'turn-suspended',
        reason: 'Turn is waiting for user permission.',
      },
      { kind: 'errored', turnId: 'turn-errored', reason: 'provider failed' },
    ];
    for (const outcome of outcomes) {
      await t.test(outcome.kind, async () => {
        const { manager, coordinator, deps, admitted } = setup();
        let evaluations = 0;
        deps.evaluator.evaluate = async () => {
          evaluations++;
          throw new Error('must not evaluate');
        };
        manager.create(SESSION, 'ship');

        const result = await settleExternal(coordinator, SESSION, outcome);

        assert.equal(result.kind, 'stopped');
        assert.equal(manager.get(SESSION)?.status, 'paused');
        assert.match(manager.get(SESSION)?.lastReason ?? '', /aborted|waiting for user permission|provider failed/);
        assert.equal(evaluations, 0);
        assert.equal(admitted.length, 0);
        assert.equal(manager.hasSettledTurn(SESSION, outcome.turnId!), true);

        manager.resume(SESSION);
        const replay = await settleExternal(coordinator, SESSION, outcome);
        assert.equal(replay.kind, 'duplicate');
        assert.equal(manager.get(SESSION)?.status, 'active');
      });
    }
  });

  test('busy preserves the intent and retries only after the host becomes idle', async () => {
    const { manager, coordinator, admitted, setAdmission, attemptedPrompts } = setup({
      evaluations: [{ reason: 'ready to continue' }],
    });
    const idle = deferred<void>();
    let attempts = 0;
    setAdmission((sessionId, prompt, bindTurn) => {
      attempts++;
      if (attempts === 1) return { kind: 'busy', whenIdle: idle.promise };
      const turnId = `turn-owned-${attempts}`;
      assert.deepEqual(bindTurn(turnId), { kind: 'bound' });
      const completion = deferred<GoalTurnOutcome>();
      admitted.push({ sessionId, prompt, turnId, completion });
      return { kind: 'started', completion: completion.promise };
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => attempts === 1, 'busy admission was not attempted');
    assert.equal(attempts, 1);
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 0);

    idle.resolve();
    await waitFor(() => attempts === 2, 'idle wake did not retry admission');
    assert.equal(attempts, 2);
    assert.equal(admitted.length, 1);
    assert.equal(attemptedPrompts.length, 2);
  });

  test('new completion evidence outranks an intent waiting on busy', async () => {
    const { manager, coordinator, admitted, setAdmission } = setup({
      evaluations: [
        { reason: 'old intent' },
        { reason: 'new intent' },
      ],
    });
    const idle = deferred<void>();
    let attempts = 0;
    setAdmission((sessionId, prompt, bindTurn) => {
      attempts++;
      if (attempts === 1) return { kind: 'busy', whenIdle: idle.promise };
      const turnId = `turn-owned-${attempts}`;
      assert.deepEqual(bindTurn(turnId), { kind: 'bound' });
      const completion = deferred<GoalTurnOutcome>();
      admitted.push({ sessionId, prompt, turnId, completion });
      return { kind: 'started', completion: completion.promise };
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => attempts === 1, 'first admission was not attempted');
    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-2' });
    idle.resolve();
    await waitFor(() => admitted.length === 1, 'new evidence was not admitted after idle');

    assert.equal(manager.get(SESSION)?.iterations, 2);
    assert.equal(admitted.length, 1);
    assert.match(admitted[0]!.prompt, /new intent/);
    assert.doesNotMatch(admitted[0]!.prompt, /old intent/);
  });

  test('a stale owned-turn failure cannot erase a newer intent waiting on busy', async () => {
    const { manager, coordinator, admitted, setAdmission } = setup({
      evaluations: [
        { reason: 'owned turn' },
        { reason: 'new external evidence' },
      ],
    });
    const idle = deferred<void>();
    let attempts = 0;
    setAdmission((sessionId, prompt, bindTurn) => {
      attempts++;
      if (attempts === 2) return { kind: 'busy', whenIdle: idle.promise };
      const turnId = `turn-owned-${attempts}`;
      assert.deepEqual(bindTurn(turnId), { kind: 'bound' });
      const completion = deferred<GoalTurnOutcome>();
      admitted.push({ sessionId, prompt, turnId, completion });
      return { kind: 'started', completion: completion.promise };
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'owned turn was not admitted');
    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-2' });
    await waitFor(() => attempts === 2, 'newer intent did not reach the busy host');

    admitted[0]!.completion.resolve({ kind: 'aborted', turnId: admitted[0]!.turnId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.get(SESSION)?.status, 'active');

    idle.resolve();
    await waitFor(() => attempts === 3, 'stale failure erased the newer busy intent');
    assert.equal(admitted.length, 2);
    assert.match(admitted[1]!.prompt, /new external evidence/);
  });

  test('unavailable admission pauses instead of leaving a false active Goal', async () => {
    const { manager, coordinator, setAdmission } = setup();
    setAdmission(() => ({ kind: 'unavailable', reason: 'TUI switched sessions' }));
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => manager.get(SESSION)?.status === 'paused', 'unavailable host did not pause Goal');

    assert.equal(manager.get(SESSION)?.status, 'paused');
    assert.equal(manager.get(SESSION)?.lastReason, 'TUI switched sessions');
  });

  test('a checkpoint change during task inspection discards the stale intent', async () => {
    const taskRead = controlledCall<string[]>();
    let taskReads = 0;
    const { manager, coordinator, admitted } = setup({
      taskGate: {
        listActionableTaskKeys: () => {
          taskReads++;
          return taskRead.invoke();
        },
      },
    });
    manager.create(SESSION, 'ship');

    const settlement = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await taskRead.started;
    manager.pause(SESSION);
    manager.resume(SESSION);
    taskRead.resolve([]);

    assert.equal((await settlement).kind, 'continued');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(taskReads, 1);
    assert.equal(admitted.length, 0);
  });

  test('an advisory task read fails open without permanently owning the session lane', async () => {
    const taskRead = controlledCall<string[]>();
    let readSignal: AbortSignal | undefined;
    const { manager, coordinator, admitted } = setup({
      taskGate: {
        listActionableTimeoutMs: 10,
        listActionableTaskKeys: (_sessionId, signal) => {
          readSignal = signal;
          return taskRead.invoke();
        },
      },
    });
    manager.create(SESSION, 'ship');

    const settlement = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await taskRead.started;
    await waitFor(() => admitted.length === 1, 'task read timeout did not release the lane');

    assert.equal((await settlement).kind, 'continued');
    assert.equal(readSignal?.aborted, true);
    assert.doesNotMatch(admitted[0]!.prompt, /\[Task reminder\]/);
  });

  test('a completed Goal-owned turn re-enters the FIFO with its real turn id', async () => {
    const { manager, coordinator, admitted, queueEvaluations } = setup({
      evaluations: [{ reason: 'first' }],
    });
    queueEvaluations({ met: true, reason: 'verified by second turn' });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'continuation was not admitted');
    assert.equal(admitted.length, 1);
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await waitFor(() => manager.get(SESSION)?.status === 'achieved', 'owned turn was not settled');

    assert.equal(manager.get(SESSION)?.status, 'achieved');
    assert.equal(manager.hasSettledTurn(SESSION, admitted[0]!.turnId), true);
    assert.equal(admitted.length, 1);
  });

  test('an admitted Goal-owned turn can use the same Goal control capability', async () => {
    const { manager, coordinator, admitted } = setup();
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'continuation was not admitted');
    const pause = goalToolsFor(manager, coordinator)
      .find((tool) => tool.name === GOAL_PAUSE_TOOL_NAME);
    assert.ok(pause);

    const output = String(await pause.impl({}, goalToolContext(admitted[0]!.turnId)));

    assert.match(output, /Goal paused/);
    assert.equal(manager.get(SESSION)?.status, 'paused');
  });

  test('archive consumes an admitted Goal-owned turn before its completion arrives', async () => {
    const { manager, coordinator, admitted } = setup();
    manager.create(SESSION, 'first');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'continuation was not admitted');
    const ownedTurnId = admitted[0]!.turnId;

    const archive = coordinator.beginSessionClose(SESSION, 'archive');
    manager.removeGoal(SESSION);
    archive.commit();
    coordinator.unarchiveSession(SESSION);
    manager.create(SESSION, 'replacement');
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: ownedTurnId });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(manager.hasSettledTurn(SESSION, ownedTurnId), true);
    assert.deepEqual(coordinator.beginExternalTurn(SESSION, ownedTurnId), { kind: 'duplicate' });
    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.iterations, 0);
  });

  test('a completed Goal-owned turn is consumed without crossing pause and resume', async () => {
    const { manager, coordinator, admitted, deps } = setup({
      evaluations: [
        { reason: 'first' },
        { met: true, reason: 'stale owned completion must not evaluate' },
      ],
    });
    let evaluations = 0;
    const evaluate = deps.evaluator.evaluate;
    deps.evaluator.evaluate = (...args) => {
      evaluations++;
      return evaluate(...args);
    };
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'owned turn was not admitted');
    manager.pause(SESSION);
    manager.resume(SESSION);
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(evaluations, 1);
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(manager.get(SESSION)?.iterations, 1);
    assert.equal(manager.hasSettledTurn(SESSION, admitted[0]!.turnId), true);
    assert.equal((await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: admitted[0]!.turnId,
    })).kind, 'duplicate');
    assert.equal(evaluations, 1);
    assert.equal(admitted.length, 1);
  });

  test('aborted, errored, and rejected Goal-owned turns pause without retrying', async (t) => {
    for (const scenario of ['aborted', 'errored', 'rejected'] as const) {
      await t.test(scenario, async () => {
        const { manager, coordinator, admitted } = setup();
        manager.create(SESSION, 'ship');
        await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
        await waitFor(() => admitted.length === 1, 'continuation was not admitted');

        if (scenario === 'aborted') {
          admitted[0]!.completion.resolve({ kind: 'aborted', turnId: admitted[0]!.turnId });
        } else if (scenario === 'errored') {
          admitted[0]!.completion.resolve({
            kind: 'errored',
            turnId: admitted[0]!.turnId,
            reason: 'provider failed',
          });
        } else {
          admitted[0]!.completion.reject(new Error('stream rejected'));
        }
        await waitFor(() => manager.get(SESSION)?.status === 'paused', `${scenario} did not pause Goal`);

        assert.equal(manager.get(SESSION)?.status, 'paused');
        assert.equal(admitted.length, 1);
        assert.match(manager.get(SESSION)?.lastReason ?? '', /aborted|provider failed|stream rejected/);
      });
    }
  });
});

describe('GoalContinuationCoordinator waiting and task gate', () => {
  test('waiting is visible and uses 5s → 10s backoff instead of immediate turns', async () => {
    const { manager, coordinator, scheduler, admitted, queueEvaluations } = setup({
      evaluations: [{ waiting: true, progress: false, reason: 'CI running' }],
    });
    queueEvaluations({ waiting: true, progress: false, reason: 'CI still running' });
    manager.create(SESSION, 'CI passes');

    const first = await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => scheduler.pendingDelays().length === 1, 'waiting retry was not scheduled');
    assert.equal(first.kind, 'waiting');
    assert.equal(manager.get(SESSION)?.status, 'waiting');
    assert.deepEqual(scheduler.pendingDelays(), [5_000]);
    assert.equal(admitted.length, 0);

    scheduler.fireNext();
    await waitFor(() => admitted.length === 1, 'waiting retry did not admit a turn');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 1);
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await waitFor(() => scheduler.pendingDelays()[0] === 10_000, 'second wait did not back off');

    assert.equal(manager.get(SESSION)?.status, 'waiting');
    assert.deepEqual(scheduler.pendingDelays(), [10_000]);
    assert.equal(manager.get(SESSION)?.consecutiveNoProgress, 0);
  });

  test('a real user turn preempts waiting and makes the stale timer harmless', async () => {
    const { manager, coordinator, scheduler, admitted, queueEvaluations } = setup({
      evaluations: [{ waiting: true, progress: false, reason: 'CI running' }],
    });
    queueEvaluations({ waiting: false, progress: true, reason: 'CI passed' });
    manager.create(SESSION, 'CI passes');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => scheduler.pendingDelays().length === 1, 'waiting retry was not scheduled');
    assert.deepEqual(scheduler.pendingDelays(), [5_000]);

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-user' });
    await waitFor(() => admitted.length === 1, 'user evidence did not preempt waiting');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 1);
    assert.match(admitted[0]!.prompt, /CI passed/);

    scheduler.fireEvenIfCleared(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(admitted.length, 1);
  });

  test('waiting timer cannot wake a cleared and replaced Goal', async () => {
    const { manager, coordinator, scheduler, admitted } = setup({
      evaluations: [{ waiting: true, reason: 'pending' }],
    });
    manager.create(SESSION, 'old');
    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => scheduler.pendingDelays().length === 1, 'waiting retry was not scheduled');

    const settleOldControlTurn = registerExternalTurn(coordinator, SESSION, 'turn-old-control');
    manager.clear(SESSION);
    const replacement = manager.create(SESSION, 'new');
    assert.equal(replacement.kind, 'created');
    assert.equal((await settleOldControlTurn({
      kind: 'completed',
      turnId: 'turn-old-control',
    })).kind, 'stale');
    assert.deepEqual(scheduler.pendingDelays(), []);
    scheduler.fireEvenIfCleared(0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(manager.get(SESSION)?.condition, 'new');
    assert.equal(manager.get(SESSION)?.revision, 0);
    assert.equal(admitted.length, 0);
  });

  test('task reminder is consumed and traced only after admission starts', async () => {
    const idle = deferred<void>();
    const remindedGoalIds = new Set<string>();
    const decisions: string[] = [];
    const { manager, coordinator, admitted, setAdmission } = setup({
      taskGate: {
        listActionableTaskKeys: async () => ['T1', 'T1'],
        remindedGoalIds,
        recordDecision: (trace) => { decisions.push(trace.decision); },
      },
    });
    let attempts = 0;
    setAdmission((sessionId, prompt, bindTurn) => {
      attempts++;
      if (attempts === 1) return { kind: 'busy', whenIdle: idle.promise };
      const turnId = `turn-owned-${attempts}`;
      assert.deepEqual(bindTurn(turnId), { kind: 'bound' });
      const completion = deferred<GoalTurnOutcome>();
      admitted.push({ sessionId, prompt, turnId, completion });
      return { kind: 'started', completion: completion.promise };
    });
    const created = manager.create(SESSION, 'ship');
    assert.equal(created.kind, 'created');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => attempts === 1, 'busy admission was not attempted');
    assert.deepEqual([...remindedGoalIds], []);
    assert.deepEqual(decisions, []);

    idle.resolve();
    await waitFor(() => decisions.length === 1, 'started admission was not traced');
    assert.deepEqual([...remindedGoalIds], [created.goal.id]);
    assert.deepEqual(decisions, ['reminder_injected']);
    assert.match(admitted[0]!.prompt, /Actionable task keys: T1/);
  });

  test('task reminder is injected once per Goal across chained turns', async () => {
    const decisions: string[] = [];
    const { manager, coordinator, admitted } = setup({
      taskGate: {
        listActionableTaskKeys: async () => ['T1'],
        recordDecision: (trace) => { decisions.push(trace.decision); },
      },
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'first continuation was not admitted');
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await waitFor(() => admitted.length === 2, 'chained continuation was not admitted');

    assert.match(admitted[0]!.prompt, /\[Task reminder\]/);
    assert.doesNotMatch(admitted[1]!.prompt, /\[Task reminder\]/);
    assert.deepEqual(decisions, ['reminder_injected', 'reminder_limit_reached']);
  });

  test('a pending diagnostic trace cannot block a completed owned turn behind it', async () => {
    const trace = controlledCall<void>();
    const { manager, coordinator, admitted } = setup({
      taskGate: {
        listActionableTaskKeys: async () => [],
        recordDecision: () => trace.invoke(),
      },
    });
    manager.create(SESSION, 'ship');

    const settlement = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await trace.started;
    await waitFor(() => admitted.length === 1, 'first continuation was not admitted');
    admitted[0]!.completion.resolve({
      kind: 'completed',
      turnId: admitted[0]!.turnId,
    });
    await waitFor(() => admitted.length === 2, 'pending trace retained the session lane');

    assert.equal((await settlement).kind, 'continued');
  });
});
