import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GoalExternalTurnStart, GoalTurnAdmission, MakaToolContext } from '@maka/runtime';
import type { ConnectionContext, OperationResidency } from '../server/operation-dispatcher.js';
import {
  HostGoalCoordinator,
  type HostGoalCoordinatorOptions,
} from '../server/goal-coordinator.js';

const SESSION_ID = 'goal-session';
const context: ConnectionContext = {
  hostEpoch: 'goal-test-epoch',
  connectionId: 'goal-test-connection',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

test('clear keeps residency while the real evaluator lane is pending', async () => {
  const evaluation = deferred<string>();
  const evaluatorEntered = deferred<void>();
  const fixture = createFixture({
    evaluate: async () => {
      evaluatorEntered.resolve();
      return evaluation.promise;
    },
  });
  const { goalId, registration } = await activateGoal(fixture, 'turn-evaluator');
  const settling = registration.settle({ kind: 'completed', turnId: 'turn-evaluator' });
  await evaluatorEntered.promise;

  const result = await clear(fixture.coordinator, goalId);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.result.kind, 'cleared');
  assert.equal(fixture.liveResidencies(), 1);

  evaluation.resolve(evaluationResult({ met: true }));
  await settling;
  await waitFor(() => fixture.liveResidencies() === 0);
  assert.equal(fixture.releases(), 1);
});

test('terminal transition retains residency through remaining generation settlement', async () => {
  const recordEntered = deferred<void>();
  const releaseRecord = deferred<void>();
  const fixture = createFixture({
    evaluate: async () => evaluationResult({ met: true }),
    taskGate: {
      listActionableTaskKeys: async () => [],
      recordDecision: async () => {
        recordEntered.resolve();
        await releaseRecord.promise;
      },
    },
  });
  const { registration } = await activateGoal(fixture, 'turn-terminal');
  const settling = registration.settle({ kind: 'completed', turnId: 'turn-terminal' });
  await recordEntered.promise;

  assert.equal(fixture.coordinator.manager.get(SESSION_ID)?.status, 'achieved');
  assert.equal(fixture.liveResidencies(), 1);
  releaseRecord.resolve();
  await settling;
  await waitFor(() => fixture.liveResidencies() === 0);
});

test('clear during async prepared admission waits for abandon settlement', async () => {
  const admission = deferred<GoalTurnAdmission>();
  const admissionEntered = deferred<void>();
  const abandonEntered = deferred<void>();
  const abandonReleased = deferred<void>();
  let admittedGoalId: string | undefined;
  let startCalls = 0;
  const fixture = createFixture({
    evaluate: async () => evaluationResult(),
    root: {
      admitGoalTurn: async (_sessionId, _text, identity) => {
        admittedGoalId = identity.goalId;
        admissionEntered.resolve();
        return admission.promise;
      },
    },
  });
  const { goalId, registration } = await activateGoal(fixture, 'turn-admission');
  void registration.settle({ kind: 'completed', turnId: 'turn-admission' });
  await admissionEntered.promise;
  assert.equal(admittedGoalId, goalId);

  await clear(fixture.coordinator, goalId);
  assert.equal(fixture.liveResidencies(), 1);
  admission.resolve({
    kind: 'prepared',
    turnId: 'prepared-turn',
    start: async () => {
      startCalls++;
      return { kind: 'completed', turnId: 'prepared-turn' };
    },
    abandon: async () => {
      abandonEntered.resolve();
      await abandonReleased.promise;
    },
  });
  await abandonEntered.promise;
  assert.equal(fixture.liveResidencies(), 1);

  abandonReleased.resolve();
  await waitFor(() => fixture.liveResidencies() === 0);
  assert.equal(startCalls, 0);
});

test('post-cut effect fence rechecks Host admission after waiting', async () => {
  const fence = deferred<void>();
  const fenceEntered = deferred<void>();
  let rootAdmissions = 0;
  const fixture = createFixture({
    evaluate: async () => evaluationResult(),
    waitForEvaluatorPostCutEffects: () => {
      fenceEntered.resolve();
      return fence.promise;
    },
    root: {
      admitGoalTurn: async () => {
        rootAdmissions++;
        return { kind: 'unavailable', reason: 'test root stopped' };
      },
    },
  });
  const { registration } = await activateGoal(fixture, 'turn-effect-fence');
  const settling = registration.settle({ kind: 'completed', turnId: 'turn-effect-fence' });
  await fenceEntered.promise;
  assert.equal(rootAdmissions, 0);

  fixture.coordinator.beginDrain();
  fence.resolve();
  await settling;
  assert.equal(rootAdmissions, 0);
  await fixture.coordinator.close();
});

test('old generation idle does not wait for or release its replacement', async () => {
  const evaluation = deferred<string>();
  const evaluatorEntered = deferred<void>();
  const ids = ['goal-old', 'goal-new'];
  const fixture = createFixture({
    newId: () => ids.shift()!,
    evaluate: async () => {
      evaluatorEntered.resolve();
      return evaluation.promise;
    },
  });
  const { goalId, registration } = await activateGoal(fixture, 'turn-old');
  void registration.settle({ kind: 'completed', turnId: 'turn-old' });
  await evaluatorEntered.promise;
  await clear(fixture.coordinator, goalId);

  const replacement = fixture.coordinator.manager.create(SESSION_ID, 'replacement').goal;
  assert.equal(replacement.id, 'goal-new');
  assert.equal(fixture.liveResidencies(), 2);
  evaluation.resolve(evaluationResult({ met: true }));
  await waitFor(() => fixture.liveResidencies() === 1);
  assert.equal(fixture.coordinator.manager.get(SESSION_ID)?.id, replacement.id);
  assert.equal(fixture.coordinator.manager.get(SESSION_ID)?.status, 'active');

  await clear(fixture.coordinator, replacement.id);
  await waitFor(() => fixture.liveResidencies() === 0);
});

test('normal drain waits for pending generation work before closing', async () => {
  const evaluation = deferred<string>();
  const evaluatorEntered = deferred<void>();
  const fixture = createFixture({
    evaluate: async () => {
      evaluatorEntered.resolve();
      return evaluation.promise;
    },
  });
  const { registration } = await activateGoal(fixture, 'turn-drain');
  void registration.settle({ kind: 'completed', turnId: 'turn-drain' });
  await evaluatorEntered.promise;

  fixture.coordinator.beginDrain();
  let closed = false;
  const closing = fixture.coordinator.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(fixture.liveResidencies(), 1);
  assert.equal(fixture.coordinator.manager.get(SESSION_ID), undefined);

  evaluation.resolve(evaluationResult());
  await closing;
  assert.equal(fixture.liveResidencies(), 0);
  await fixture.coordinator.close();
});

test('session close clears immediately and settles only when its generation is idle', async () => {
  const evaluation = deferred<string>();
  const evaluatorEntered = deferred<void>();
  const fixture = createFixture({
    evaluate: async () => {
      evaluatorEntered.resolve();
      return evaluation.promise;
    },
  });
  const { goalId, registration } = await activateGoal(fixture, 'turn-session-close');
  void registration.settle({ kind: 'completed', turnId: 'turn-session-close' });
  await evaluatorEntered.promise;

  const close = fixture.coordinator.beginSessionClose(SESSION_ID, 'archive');
  assert.equal(fixture.coordinator.manager.get(SESSION_ID)?.status, 'cleared');
  assert.equal(fixture.coordinator.beginExternalTurn(SESSION_ID, 'fenced').kind, 'unavailable');
  let settled = false;
  void close.settled.then(() => {
    settled = true;
  });
  await waitForTurns(2);
  assert.equal(settled, false);

  evaluation.resolve(evaluationResult({ met: true }));
  await close.settled;
  assert.equal(fixture.coordinator.manager.get(SESSION_ID)?.id, goalId);
  assert.equal(fixture.coordinator.manager.get(SESSION_ID)?.status, 'cleared');
  close.rollback();
  close.rollback();
  assert.equal(fixture.coordinator.beginExternalTurn(SESSION_ID, 'reopened').kind, 'registered');
  assert.equal(fixture.coordinator.manager.get(SESSION_ID)?.status, 'cleared');
});

test('commit removes only the captured Goal and unarchive releases only committed archive fence', async () => {
  const fixture = createFixture();
  fixture.coordinator.manager.create(SESSION_ID, 'archive me');
  const first = fixture.coordinator.beginSessionClose(SESSION_ID, 'archive');
  const concurrent = fixture.coordinator.beginSessionClose(SESSION_ID, 'archive');
  await first.settled;
  first.commit();
  first.commit();
  assert.equal(fixture.coordinator.manager.get(SESSION_ID), undefined);

  fixture.coordinator.unarchiveSession(SESSION_ID);
  assert.equal(
    fixture.coordinator.beginExternalTurn(SESSION_ID, 'still-pending').kind,
    'unavailable',
  );
  concurrent.rollback();
  assert.equal(fixture.coordinator.beginExternalTurn(SESSION_ID, 'unarchived').kind, 'registered');
  assert.equal(fixture.coordinator.manager.get(SESSION_ID), undefined);
});

test('fail-stop prevents queued normal release until its reclaimer runs', async () => {
  const evaluation = deferred<string>();
  const evaluatorEntered = deferred<void>();
  const fixture = createFixture({
    evaluate: async () => {
      evaluatorEntered.resolve();
      return evaluation.promise;
    },
  });
  const { goalId, registration } = await activateGoal(fixture, 'turn-fail-stop');
  const settling = registration.settle({ kind: 'completed', turnId: 'turn-fail-stop' });
  await evaluatorEntered.promise;
  await clear(fixture.coordinator, goalId);

  const reclaim = fixture.coordinator.prepareFailStopReclaim();
  assert.equal(fixture.coordinator.manager.get(SESSION_ID), undefined);
  evaluation.resolve(evaluationResult({ met: true }));
  await settling;
  await waitForTurns(2);
  assert.equal(fixture.liveResidencies(), 1);

  reclaim();
  assert.equal(fixture.liveResidencies(), 0);
  assert.equal(fixture.releases(), 1);
  reclaim();
  fixture.coordinator.prepareFailStopReclaim()();
  assert.equal(fixture.releases(), 1);
  await fixture.coordinator.close();
});

test('generation idle rejection drains non-cleanly but still releases residency', async () => {
  const failure = new Error('Goal admission settlement failed');
  let drainRequests = 0;
  const fixture = createFixture({
    evaluate: async () => evaluationResult(),
    root: {
      admitGoalTurn: async () => {
        throw failure;
      },
    },
    requestDrain: () => {
      drainRequests++;
    },
  });
  const { goalId, registration } = await activateGoal(fixture, 'turn-rejection');
  await registration.settle({ kind: 'completed', turnId: 'turn-rejection' });
  await waitFor(() => fixture.coordinator.manager.get(SESSION_ID)?.status === 'paused');

  await clear(fixture.coordinator, goalId);
  await waitFor(() => fixture.liveResidencies() === 0);
  assert.equal(drainRequests, 1);
  await assert.rejects(fixture.coordinator.close(), failure);
  await assert.rejects(fixture.coordinator.close(), failure);
});

test('wire clear remains identity-safe and idempotent', async () => {
  const ids = ['goal-1', 'goal-2'];
  const fixture = createFixture({ newId: () => ids.shift()! });
  const first = fixture.coordinator.manager.create(SESSION_ID, 'first generation').goal;
  const cleared = await clear(fixture.coordinator, first.id);
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.result.kind, 'cleared');
  await waitFor(() => fixture.liveResidencies() === 0);

  const unchanged = await clear(fixture.coordinator, first.id);
  assert.equal(unchanged.ok, true);
  if (unchanged.ok) assert.equal(unchanged.result.kind, 'unchanged');
  const replacement = fixture.coordinator.manager.create(SESSION_ID, 'replacement').goal;
  const stale = await clear(fixture.coordinator, first.id);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, 'operation_conflict');

  const query = await fixture.coordinator.handlers['goal.query'](
    { sessionId: SESSION_ID },
    context,
  );
  assert.equal(query.ok, true);
  if (query.ok && query.result.kind === 'item') {
    assert.equal(query.result.goal.goalId, replacement.id);
    assert.equal(Object.hasOwn(query.result.goal, 'id'), false);
  }
});

test('residency acquisition failure requests drain and remains a close error', async () => {
  const acquisitionFailure = new Error('residency acquisition failed');
  let drainRequests = 0;
  const coordinator = new HostGoalCoordinator({
    ...baseOptions(),
    acquireResidency: () => {
      throw acquisitionFailure;
    },
    requestDrain: () => {
      drainRequests++;
    },
  });
  coordinator.manager.create(SESSION_ID, 'cannot run without residency');

  assert.equal(coordinator.beginExternalTurn(SESSION_ID, 'late-turn').kind, 'unavailable');
  assert.equal(drainRequests, 1);
  await assert.rejects(coordinator.close(), acquisitionFailure);
});

type Fixture = ReturnType<typeof createFixture>;
type RegisteredTurn = Extract<GoalExternalTurnStart, { kind: 'registered' }>;

function createFixture(overrides: Partial<HostGoalCoordinatorOptions> = {}) {
  let live = 0;
  let releases = 0;
  const ids = ['goal-1', 'goal-2', 'goal-3'];
  const coordinator = new HostGoalCoordinator({
    ...baseOptions(),
    newId: () => ids.shift()!,
    acquireResidency: () => {
      live++;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          live--;
          releases++;
        },
      } satisfies OperationResidency;
    },
    ...overrides,
  });
  return {
    coordinator,
    liveResidencies: () => live,
    releases: () => releases,
  };
}

function baseOptions(): HostGoalCoordinatorOptions {
  return {
    root: {
      admitGoalTurn: async () => ({
        kind: 'unavailable',
        reason: 'test admission stopped',
      }),
    },
    evaluate: async () => evaluationResult(),
    waitForEvaluatorPostCutEffects: async () => undefined,
    readEvaluationContext: async () => ({ recentContext: '', tokenCount: 73 }),
    acquireResidency: () => ({ release() {} }),
    requestDrain: () => undefined,
    now: () => 1_000,
  };
}

async function activateGoal(
  fixture: Fixture,
  turnId: string,
): Promise<{ goalId: string; registration: RegisteredTurn }> {
  const registration = fixture.coordinator.beginExternalTurn(SESSION_ID, turnId);
  assert.equal(registration.kind, 'registered');
  if (registration.kind !== 'registered') throw new Error('Goal turn registration failed');
  const set = fixture.coordinator.tools.find((tool) => tool.name === 'GoalSet');
  assert.ok(set);
  await set.impl({ condition: `finish ${turnId}` }, toolContext(turnId));
  const goal = fixture.coordinator.manager.get(SESSION_ID);
  assert.ok(goal);
  return { goalId: goal.id, registration };
}

function clear(coordinator: Fixture['coordinator'], goalId: string) {
  return coordinator.handlers['goal.clear']({ sessionId: SESSION_ID, goalId }, context);
}

function toolContext(turnId: string): MakaToolContext {
  return {
    sessionId: SESSION_ID,
    turnId,
    cwd: '/',
    toolCallId: 'goal-tool-call',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}

function evaluationResult(overrides: Partial<{ met: boolean }> = {}): string {
  return JSON.stringify({
    met: overrides.met ?? false,
    impossible: false,
    progress: true,
    waiting: false,
    reason: 'continue',
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for Goal coordinator state');
}

async function waitForTurns(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
