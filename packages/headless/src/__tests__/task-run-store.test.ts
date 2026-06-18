import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TaskEvent } from '../task-contracts.js';
import { createInMemoryTaskRunStore, createTaskRunStore, projectTaskRun } from '../task-run-store.js';

function eventIdFactory(): () => string {
  let i = 0;
  return () => `e-${++i}`;
}

function completedEvents(taskRunId = 'tr-1'): TaskEvent[] {
  const id = eventIdFactory();
  return [
    { type: 'task_run_created', id: id(), taskRunId, ts: 10, taskId: 'task-1', configId: 'cfg-1' },
    { type: 'task_run_started', id: id(), taskRunId, ts: 11, startedAt: 11, sessionId: 's-1', agentRunId: 'r-1' },
    { type: 'task_attempt_started', id: id(), taskRunId, ts: 12, attemptId: 'a-1', sessionId: 's-1', agentRunId: 'r-1' },
    {
      type: 'self_check_observed',
      id: id(),
      taskRunId,
      ts: 13,
      observation: { id: 'self-1', taskRunId, attemptId: 'a-1', ts: 13, summary: 'looks solved' },
    },
    {
      type: 'feedback_observed',
      id: id(),
      taskRunId,
      ts: 14,
      observation: { id: 'fb-1', taskRunId, attemptId: 'a-1', ts: 14, source: 'verifier', summary: 'tests passed' },
    },
    {
      type: 'autonomous_decision_recorded',
      id: id(),
      taskRunId,
      ts: 15,
      decision: { id: 'd-1', taskRunId, attemptId: 'a-1', ts: 15, decision: 'stop', reason: 'verification passed' },
    },
    {
      type: 'verifier_result_recorded',
      id: id(),
      taskRunId,
      ts: 20,
      result: { id: 'v-1', taskRunId, attemptId: 'a-1', ts: 20, kind: 'command', passed: true, exitCode: 0 },
    },
    {
      type: 'score_result_recorded',
      id: id(),
      taskRunId,
      ts: 21,
      result: { id: 'score-1', taskRunId, attemptId: 'a-1', ts: 21, passed: true, taxonomy: 'passed' },
    },
    { type: 'task_attempt_completed', id: id(), taskRunId, ts: 22, attemptId: 'a-1', finishedAt: 22, status: 'completed' },
    { type: 'task_run_completed', id: id(), taskRunId, ts: 23, finishedAt: 23 },
  ];
}

describe('TaskRunStore', () => {
  test('appends and replays events in order', async () => {
    const store = createInMemoryTaskRunStore();
    const events = completedEvents();
    for (const event of events) await store.appendEvent(event.taskRunId, event);

    assert.deepEqual(await store.readEvents('tr-1'), events);
  });

  test('projects status, attempts, observations, verifier, and score from replay', async () => {
    const store = createInMemoryTaskRunStore();
    for (const event of completedEvents()) await store.appendEvent(event.taskRunId, event);

    const projection = await store.project('tr-1');
    assert.equal(projection.status, 'completed');
    assert.equal(projection.taskId, 'task-1');
    assert.equal(projection.configId, 'cfg-1');
    assert.equal(projection.sessionId, 's-1');
    assert.equal(projection.agentRunId, 'r-1');
    assert.equal(projection.attempts[0]?.status, 'completed');
    assert.equal(projection.selfChecks[0]?.summary, 'looks solved');
    assert.equal(projection.feedback[0]?.summary, 'tests passed');
    assert.equal(projection.decisions[0]?.decision, 'stop');
    assert.equal(projection.latestVerifierResult?.exitCode, 0);
    assert.equal(projection.latestScoreResult?.taxonomy, 'passed');
    assert.deepEqual(projection.result, {
      passed: true,
      taxonomy: 'passed',
      verifierResultId: 'v-1',
      scoreResultId: 'score-1',
    });
  });

  test('projects failed and cancelled terminal events', () => {
    const failed = projectTaskRun([
      { type: 'task_run_created', id: 'e-1', taskRunId: 'tr-f', ts: 1, taskId: 'task-f', configId: 'cfg' },
      { type: 'task_run_failed', id: 'e-2', taskRunId: 'tr-f', ts: 2, error: { message: 'backend blew up', class: 'backend_failed' } },
    ], 'tr-f');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.message, 'backend blew up');

    const cancelled = projectTaskRun([
      { type: 'task_run_created', id: 'e-1', taskRunId: 'tr-c', ts: 1, taskId: 'task-c', configId: 'cfg' },
      { type: 'task_run_cancelled', id: 'e-2', taskRunId: 'tr-c', ts: 2 },
    ], 'tr-c');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error?.class, 'cancelled');
  });

  test('projects queued, verifying, incomplete, blocked, policy, budget, and aborted states', () => {
    const queued = projectTaskRun([
      { type: 'task_run_queued', id: 'e-1', taskRunId: 'tr-q', ts: 1, taskId: 'task-q', configId: 'cfg' },
    ], 'tr-q');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.taskId, 'task-q');

    const verifying = projectTaskRun([
      { type: 'task_run_created', id: 'e-1', taskRunId: 'tr-v', ts: 1, taskId: 'task-v', configId: 'cfg' },
      { type: 'task_run_started', id: 'e-2', taskRunId: 'tr-v', ts: 2 },
      { type: 'task_run_verifying', id: 'e-3', taskRunId: 'tr-v', ts: 3 },
    ], 'tr-v');
    assert.equal(verifying.status, 'verifying');

    const terminalCases: Array<[TaskEvent, string, string]> = [
      [{ type: 'task_run_incomplete', id: 'e-2', taskRunId: 'tr-x', ts: 2 }, 'incomplete', 'agent_incomplete'],
      [{ type: 'task_run_blocked', id: 'e-2', taskRunId: 'tr-x', ts: 2 }, 'blocked', 'blocked'],
      [{ type: 'task_run_policy_denied', id: 'e-2', taskRunId: 'tr-x', ts: 2 }, 'policy_denied', 'policy_denied'],
      [{ type: 'task_run_budget_exhausted', id: 'e-2', taskRunId: 'tr-x', ts: 2 }, 'budget_exhausted', 'budget_exhausted'],
      [{ type: 'task_run_aborted', id: 'e-2', taskRunId: 'tr-x', ts: 2 }, 'aborted', 'aborted'],
    ];

    for (const [terminalEvent, status, errorClass] of terminalCases) {
      const projection = projectTaskRun([
        { type: 'task_run_created', id: 'e-1', taskRunId: 'tr-x', ts: 1, taskId: 'task-x', configId: 'cfg' },
        terminalEvent,
      ], 'tr-x');
      assert.equal(projection.status, status);
      assert.equal(projection.error?.class, errorClass);
    }
  });

  test('uses the last terminal event and records a warning', () => {
    const projection = projectTaskRun([
      { type: 'task_run_created', id: 'e-1', taskRunId: 'tr-1', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
      { type: 'task_run_failed', id: 'e-2', taskRunId: 'tr-1', ts: 2, error: { message: 'first terminal' } },
      { type: 'task_run_completed', id: 'e-3', taskRunId: 'tr-1', ts: 3 },
    ], 'tr-1');

    assert.equal(projection.status, 'completed');
    assert.match(projection.warnings[0] ?? '', /multiple terminal/);
  });

  test('serializes concurrent appends for one task run', async () => {
    const store = createInMemoryTaskRunStore();
    const events = completedEvents('tr-concurrent');

    await Promise.all(events.map((event) => store.appendEvent('tr-concurrent', event)));

    assert.deepEqual(await store.readEvents('tr-concurrent'), events);
  });

  test('event_corrupt stays in replay and surfaces as a projection warning', () => {
    const projection = projectTaskRun([
      { type: 'task_run_created', id: 'e-1', taskRunId: 'tr-1', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
      { type: 'event_corrupt', id: 'e-corrupt', taskRunId: 'tr-1', ts: 2, raw: '{', error: 'invalid json' },
      { type: 'task_run_completed', id: 'e-3', taskRunId: 'tr-1', ts: 3 },
    ], 'tr-1');

    assert.equal(projection.events.length, 3);
    assert.match(projection.warnings[0] ?? '', /corrupt event/);
    assert.equal(projection.status, 'completed');
  });

  test('file-backed store appends and replays events after restart', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-run-store-'));
    try {
      const store = createTaskRunStore(storageRoot);
      const events = completedEvents('tr-file');
      for (const event of events) await store.appendEvent(event.taskRunId, event);

      const restarted = createTaskRunStore(storageRoot);
      assert.deepEqual(await restarted.readEvents('tr-file'), events);
      assert.equal((await restarted.project('tr-file')).status, 'completed');
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  test('file-backed store surfaces corrupt durable lines and ignores partial tail', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-run-store-'));
    try {
      const store = createTaskRunStore(storageRoot);
      const events = completedEvents('tr-corrupt');
      await store.appendEvent('tr-corrupt', events[0] as TaskEvent);

      await appendFile(
        join(storageRoot, 'task-runs', 'tr-corrupt.jsonl'),
        'not-json\n{"type":"task_run_completed","id":"partial"',
        'utf8',
      );

      const replayed = await store.readEvents('tr-corrupt');
      assert.equal(replayed.length, 2);
      assert.equal(replayed[1]?.type, 'event_corrupt');
      assert.match((replayed[1] as { error?: string }).error ?? '', /Unexpected/);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
