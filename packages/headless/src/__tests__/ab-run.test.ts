import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runAbComparison } from '../ab-run.js';
import { completed } from './helpers/ab-run-fixtures.js';
import { sha256 } from './helpers/hash-fixture.js';
import type { FixedPromptTaskBudgetExhaustedEvent, FixedPromptTaskInfraFailedEvent } from '../fixed-prompt-controller.js';

describe('runAbComparison', () => {
  test('rejects arm ids that collapse to the same round id suffix', async () => {
    await assert.rejects(
      runAbComparison({
        runId: 'ab-run',
        arms: [
          { id: 'tools.off', kind: 'tools', fingerprint: sha256('tools-off') },
          { id: 'tools/off', kind: 'tools', fingerprint: sha256('tools-on') },
        ],
        evaluationTasks: [
          { id: 't1', path: '/tasks/t1' },
        ],
        reps: 1,
        runArm: async ({ task }) => completed(task.id, true),
      }),
      /A\/B arm ids must produce unique round id suffixes/,
    );
  });

  test('runs generic arms adjacent for each task-rep pair', async () => {
    const calls: string[] = [];
    const result = await runAbComparison({
      runId: 'ab-run',
      arms: [
        { id: 'tools-off', kind: 'tools', fingerprint: sha256('tools-off') },
        { id: 'tools-on', kind: 'tools', fingerprint: sha256('tools-on') },
      ],
      evaluationTasks: [
        { id: 't1', path: '/tasks/t1' },
        { id: 't2', path: '/tasks/t2' },
      ],
      reps: 2,
      maxConcurrency: 1,
      runArm: async ({ roundId, task, arm }) => {
        calls.push(`${roundId}:${arm.id}:${task.id}`);
        return arm.id === 'tools-on'
          ? completed(task.id, true)
          : completed(task.id, false);
      },
    });

    assert.equal(result.baselineArmId, 'tools-off');
    assert.equal(result.candidateArmId, 'tools-on');
    assert.equal(result.taskLevel.wins, 2);
    assert.deepEqual(calls, [
      'ab-tools-off-r0-t1:tools-off:t1',
      'ab-tools-on-r0-t1:tools-on:t1',
      'ab-tools-on-r0-t2:tools-on:t2',
      'ab-tools-off-r0-t2:tools-off:t2',
      'ab-tools-on-r1-t1:tools-on:t1',
      'ab-tools-off-r1-t1:tools-off:t1',
      'ab-tools-off-r1-t2:tools-off:t2',
      'ab-tools-on-r1-t2:tools-on:t2',
    ]);
  });

  test('can alternate arms sequentially without overlapping provider calls', async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    await runAbComparison({
      runId: 'ab-run',
      arms: [
        { id: 'maka', kind: 'harness', fingerprint: sha256('maka') },
        { id: 'opencode', kind: 'harness', fingerprint: sha256('opencode') },
      ],
      evaluationTasks: [
        { id: 't1', path: '/tasks/t1' },
        { id: 't2', path: '/tasks/t2' },
      ],
      reps: 1,
      maxConcurrency: 1,
      armExecution: 'sequential',
      runArm: async ({ arm, task }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(`${task.id}:${arm.id}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return completed(task.id, true);
      },
    });

    assert.equal(maxActive, 1);
    assert.deepEqual(calls, [
      't1:maka',
      't1:opencode',
      't2:opencode',
      't2:maka',
    ]);
  });

  test('starts both arms for the same task-rep pair before waiting for either arm to finish', async () => {
    const calls: string[] = [];
    const waiters: Array<() => void> = [];
    let released = false;
    const releaseAll = () => {
      released = true;
      for (const resolve of waiters.splice(0)) resolve();
    };

    const runPromise = runAbComparison({
      runId: 'ab-run',
      arms: [
        { id: 'tools-off', kind: 'tools', fingerprint: sha256('tools-off') },
        { id: 'tools-on', kind: 'tools', fingerprint: sha256('tools-on') },
      ],
      evaluationTasks: [{ id: 't1', path: '/tasks/t1' }],
      reps: 1,
      maxConcurrency: 1,
      runArm: async ({ roundId, task }) => {
        calls.push(roundId);
        if (!released) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        return completed(task.id, true);
      },
    });

    while (calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsStartedBeforeFirstFinish = calls.length;
    releaseAll();
    await runPromise;

    assert.equal(callsStartedBeforeFirstFinish, 2);
    assert.deepEqual(calls, [
      'ab-tools-off-r0-t1',
      'ab-tools-on-r0-t1',
    ]);
  });

  test('stops scheduling new pairs after the observed cost threshold is reached', async () => {
    const calls: string[] = [];
    const result = await runAbComparison({
      runId: 'ab-run',
      arms: [
        { id: 'tools-off', kind: 'tools', fingerprint: sha256('tools-off') },
        { id: 'tools-on', kind: 'tools', fingerprint: sha256('tools-on') },
      ],
      evaluationTasks: [
        { id: 't1', path: '/tasks/t1' },
        { id: 't2', path: '/tasks/t2' },
      ],
      reps: 1,
      maxConcurrency: 1,
      observedCostStopUsd: 0.02,
      runArm: async ({ roundId, task }) => {
        calls.push(roundId);
        return completed(task.id, true);
      },
    });

    assert.deepEqual(calls, ['ab-tools-off-r0-t1', 'ab-tools-on-r0-t1']);
    assert.equal(result.stopReason, 'observed_cost_stop_reached');
  });

  test('stops scheduling new pairs after a systemic provider failure', async () => {
    const calls: string[] = [];
    const result = await runAbComparison({
      runId: 'ab-run',
      arms: [
        { id: 'off', kind: 'runtime', fingerprint: sha256('off') },
        { id: 'on', kind: 'runtime', fingerprint: sha256('on') },
      ],
      evaluationTasks: [
        { id: 't1', path: '/tasks/t1' },
        { id: 't2', path: '/tasks/t2' },
        { id: 't3', path: '/tasks/t3' },
      ],
      reps: 1,
      maxConcurrency: 1,
      runArm: async ({ roundId, task }) => {
        calls.push(roundId);
        return providerBilling(task.id);
      },
    });

    assert.deepEqual(calls, ['ab-off-r0-t1', 'ab-on-r0-t1']);
    assert.equal(result.stopReason, 'systemic_provider_failure');
  });

  test('stops scheduling new pairs after a timeout carries systemic provider evidence', async () => {
    const calls: string[] = [];
    const result = await runAbComparison({
      runId: 'ab-run',
      arms: [
        { id: 'off', kind: 'runtime', fingerprint: sha256('off') },
        { id: 'on', kind: 'runtime', fingerprint: sha256('on') },
      ],
      evaluationTasks: [
        { id: 't1', path: '/tasks/t1' },
        { id: 't2', path: '/tasks/t2' },
        { id: 't3', path: '/tasks/t3' },
      ],
      reps: 1,
      maxConcurrency: 1,
      runArm: async ({ roundId, task }) => {
        calls.push(roundId);
        return providerAuthTimeout(task.id);
      },
    });

    assert.deepEqual(calls, ['ab-off-r0-t1', 'ab-on-r0-t1']);
    assert.equal(result.stopReason, 'systemic_provider_failure');
  });
});

function providerAuthTimeout(taskId: string): FixedPromptTaskBudgetExhaustedEvent {
  return {
    schemaVersion: 1,
    type: 'task_budget_exhausted',
    id: `event-${taskId}`,
    ts: 0,
    runId: 'ab-run',
    roundId: 'round',
    taskId,
    status: 'budget_exhausted',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'budget_exhausted',
    error: 'agent timed out',
    evidenceErrorClass: 'auth',
    evidenceError: 'provider auth failed',
    expectedPromptHash: 'sha256:prompt',
  };
}

function providerBilling(taskId: string): FixedPromptTaskInfraFailedEvent {
  return {
    schemaVersion: 1,
    type: 'task_infra_failed',
    id: `event-${taskId}`,
    ts: 0,
    runId: 'ab-run',
    roundId: 'round',
    taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'provider_billing',
    error: 'provider billing failure',
  };
}
