import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core';
import {
  AutomationManager,
  AutomationScheduler,
  GoalManager,
  type GoalTurnOutcome,
} from '@maka/runtime';
import { CliGoalContinuation } from '../cli-goal-continuation.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('CLI Goal continuation host', () => {
  test('routes a scheduled heartbeat through the shared activity gate and Goal FIFO', async () => {
    const sessionId = 'session-1';
    let now = 1_000;
    let goalId = 0;
    let evaluations = 0;
    let admissions = 0;
    const goalManager = new GoalManager({
      generateId: () => `goal-${++goalId}`,
      now: () => now,
    });
    goalManager.create(sessionId, 'ship');
    const lifecycle = new CliGoalContinuation({
      goalManager,
      evaluator: {
        evaluate: async () => {
          evaluations++;
          return JSON.stringify({
            met: false,
            impossible: false,
            progress: true,
            waiting: false,
            reason: `evidence-${evaluations}`,
          });
        },
      },
      getRecentContext: async () => 'recent context',
    });
    const ownedCompletion = deferred<GoalTurnOutcome>();
    lifecycle.bindHost({
      admitTurn: (_sessionId, _text, bindTurn) => {
        admissions++;
        assert.deepEqual(bindTurn('owned-turn'), { kind: 'bound' });
        return { kind: 'started', completion: ownedCompletion.promise };
      },
    });

    const automationManager = new AutomationManager({
      generateId: () => 'automation-1',
      now: () => now,
      random: () => 0,
    });
    const automation = automationManager.create({
      kind: 'heartbeat',
      name: 'check',
      prompt: 'check status',
      sessionId,
      schedule: { type: 'interval', seconds: 10 },
    });
    assert.ok(!('error' in automation));
    now += 11_000;

    const timers: Array<() => void> = [];
    const streamStarted = deferred<void>();
    const releaseStream = deferred<void>();
    const scheduler = new AutomationScheduler({
      automationManager,
      canFire: async () => true,
      injectTurn: async () => {
        const { outcome } = await lifecycle.runAutomationTurn({
          sessionId,
          turnId: 'heartbeat-turn',
          start: async function* (): AsyncIterable<SessionEvent> {
            streamStarted.resolve();
            await releaseStream.promise;
            yield {
              type: 'complete', id: 'heartbeat-complete', turnId: 'heartbeat-turn',
              ts: now, stopReason: 'end_turn',
            };
          },
        });
        return { runId: 'heartbeat-turn', ok: outcome.kind === 'completed' };
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => {},
      now: () => now,
    });

    scheduler.start();
    timers.shift()?.();
    await streamStarted.promise;
    assert.ok(lifecycle.activities.whenIdle(sessionId));

    const registration = lifecycle.beginExternalTurn(sessionId, 'external-turn');
    assert.equal(registration.kind, 'registered');
    const external = await registration.settle({
      kind: 'completed',
      turnId: 'external-turn',
    });
    assert.equal(external.kind, 'continued');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(admissions, 0, 'Goal admission must wait for the hidden heartbeat');

    releaseStream.resolve();
    await waitFor(() => evaluations === 2, 'heartbeat completion did not enter the Goal FIFO');
    await waitFor(() => admissions === 1, 'Goal admission did not resume after heartbeat drain');
    await waitFor(
      () => automationManager.get(automation.id)?.lastRunId === 'heartbeat-turn',
      'scheduler did not observe the drained heartbeat result',
    );

    assert.equal(goalManager.get(sessionId)?.iterations, 2);
    assert.equal(goalManager.hasSettledTurn(sessionId, 'heartbeat-turn'), true);
    scheduler.dispose();
    lifecycle.dispose();
    goalManager.dispose();
  });

  test('records a heartbeat stream with the wrong turn identity as failed', async () => {
    const sessionId = 'session-1';
    let now = 1_000;
    const goalManager = new GoalManager({
      generateId: () => 'goal-1',
      now: () => now,
    });
    const lifecycle = new CliGoalContinuation({
      goalManager,
      evaluator: { evaluate: async () => '{"met":false}' },
      getRecentContext: async () => '',
    });
    const automationManager = new AutomationManager({
      generateId: () => 'automation-1',
      now: () => now,
      random: () => 0,
    });
    const automation = automationManager.create({
      kind: 'heartbeat',
      name: 'check',
      prompt: 'check status',
      sessionId,
      schedule: { type: 'interval', seconds: 10 },
    });
    assert.ok(!('error' in automation));
    now += 11_000;

    const timers: Array<() => void> = [];
    const scheduler = new AutomationScheduler({
      automationManager,
      canFire: async () => true,
      injectTurn: async () => {
        const turnId = 'heartbeat-turn';
        const { outcome } = await lifecycle.runAutomationTurn({
          sessionId,
          turnId,
          start: async function* (): AsyncIterable<SessionEvent> {
            yield {
              type: 'complete',
              id: 'wrong-complete',
              turnId: 'another-turn',
              ts: now,
              stopReason: 'end_turn',
            };
          },
        });
        const error = outcome.kind === 'errored' || outcome.kind === 'suspended'
          ? outcome.reason
          : outcome.kind === 'aborted'
            ? 'Automation turn was aborted.'
            : undefined;
        return {
          runId: turnId,
          ok: outcome.kind === 'completed',
          ...(error ? { error } : {}),
        };
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => {},
      now: () => now,
    });

    scheduler.start();
    timers.shift()?.();
    await waitFor(
      () => automationManager.get(automation.id)?.lastError !== null,
      'scheduler did not record the identity mismatch',
    );

    const recorded = automationManager.get(automation.id);
    assert.equal(recorded?.lastError,
      'Session turn identity mismatch: expected heartbeat-turn, received another-turn.');
    scheduler.dispose();
    lifecycle.dispose();
    goalManager.dispose();
  });
});
