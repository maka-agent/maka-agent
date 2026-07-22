import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ResultRecord, Task } from '../contracts.js';
import { taxonomyFromResultRecord } from '../task-contracts.js';
import {
  resultRecordFromTaskRunProjection,
  taskDefinitionFromTask,
  taskEventsFromResultRecord,
} from '../task-run-adapter.js';
import { projectTaskRun } from '../task-run-projection.js';

const task: Task = {
  id: 'task-1',
  instruction: 'fix it',
  workspaceDir: '/tmp/fixture',
  verification: { command: 'npm test', timeoutMs: 5000, protectedPaths: ['test.mjs'] },
};
const legacyVerification = task.verification!;

function record(extra: Partial<ResultRecord> = {}): ResultRecord {
  return {
    taskId: 'task-1',
    configId: 'cfg-1',
    sessionId: 'session-1',
    runId: 'run-1',
    status: 'completed',
    passed: true,
    exitCode: 0,
    steps: 4,
    durationMs: 30,
    startedAt: 10,
    finishedAt: 40,
    ...extra,
  };
}

function eventIdFactory(): () => string {
  let i = 0;
  return () => `e-${++i}`;
}

describe('taskDefinitionFromTask', () => {
  test('maps the existing Task contract one-to-one', () => {
    const definition = taskDefinitionFromTask(task);
    assert.deepEqual(definition, {
      id: 'task-1',
      instruction: 'fix it',
      workspaceDir: '/tmp/fixture',
      verification: { command: 'npm test', timeoutMs: 5000, protectedPaths: ['test.mjs'] },
    });
    assert.notEqual(definition.verification.protectedPaths, legacyVerification.protectedPaths);
  });
});

describe('taskEventsFromResultRecord', () => {
  test('maps completed passing results through passed taxonomy and back to ResultRecord', () => {
    const original = record();
    const events = taskEventsFromResultRecord(original, { task, eventId: eventIdFactory() });
    const projection = projectTaskRun(events, 'run-1');

    assert.equal(taxonomyFromResultRecord(original), 'passed');
    assert.equal(projection.latestScoreResult?.taxonomy, 'passed');
    assert.equal(projection.executionLineage[0]?.execution?.sessionId, original.sessionId);
    assert.equal(projection.executionLineage[0]?.execution?.agentRunId, original.runId);
    assert.equal(projection.executionLineage[0]?.runtimeCoverage, undefined);
    assert.deepEqual(resultRecordFromTaskRunProjection(projection), original);
  });

  test('maps completed verification failures as completed but not passed', () => {
    const original = record({ passed: false, exitCode: 1 });
    const events = taskEventsFromResultRecord(original, { eventId: eventIdFactory() });
    const projection = projectTaskRun(events, 'run-1');
    const compatible = resultRecordFromTaskRunProjection(projection);

    assert.equal(taxonomyFromResultRecord(original), 'verification_failed');
    assert.equal(projection.latestScoreResult?.taxonomy, 'verification_failed');
    assert.equal(compatible.status, 'completed');
    assert.equal(compatible.passed, false);
    assert.equal(compatible.exitCode, 1);
  });

  test('keeps completed verifier errors compatible with ResultRecord status semantics', () => {
    const original = record({ passed: false, exitCode: null });
    const events = taskEventsFromResultRecord(original, { eventId: eventIdFactory() });
    const projection = projectTaskRun(events, 'run-1');
    const compatible = resultRecordFromTaskRunProjection(projection);

    assert.equal(taxonomyFromResultRecord(original), 'verification_error');
    assert.equal(projection.latestScoreResult?.taxonomy, 'verification_error');
    assert.equal(projection.verifierResults.length, 1);
    assert.deepEqual(compatible, original);
  });

  test('maps backend failures as agent_failed and preserves old error fields', () => {
    const original = record({
      status: 'failed',
      passed: false,
      exitCode: null,
      error: 'backend blew up',
      errorClass: 'backend_failed',
    });
    const events = taskEventsFromResultRecord(original, { eventId: eventIdFactory() });
    const projection = projectTaskRun(events, 'run-1');

    assert.equal(taxonomyFromResultRecord(original), 'agent_failed');
    assert.equal(projection.latestScoreResult?.taxonomy, 'agent_failed');
    assert.equal(projection.verifierResults.length, 0);
    assert.deepEqual(resultRecordFromTaskRunProjection(projection), original);
  });

  test('maps matrix-level thrown failures as setup_failed', () => {
    const original = record({
      sessionId: '',
      runId: '',
      status: 'failed',
      passed: false,
      exitCode: null,
      steps: 0,
      error: 'fixture missing',
    });
    const events = taskEventsFromResultRecord(original, {
      eventId: eventIdFactory(),
      taskRunId: 'matrix-failure',
    });
    const projection = projectTaskRun(events, 'matrix-failure');

    assert.equal(taxonomyFromResultRecord(original), 'setup_failed');
    assert.equal(projection.latestScoreResult?.taxonomy, 'setup_failed');
    assert.equal(projection.verifierResults.length, 0);
    assert.deepEqual(resultRecordFromTaskRunProjection(projection), original);
  });

  test('maps incomplete, policy, budget, aborted, blocked, and infra failures explicitly', () => {
    const cases = [
      ['incomplete_tool_calls', 'agent_incomplete', 'incomplete'],
      ['tool_step_cap_reached', 'agent_incomplete', 'incomplete'],
      ['permission_denied', 'policy_denied', 'policy_denied'],
      ['max_steps_exceeded', 'budget_exhausted', 'budget_exhausted'],
      ['user_aborted', 'aborted', 'aborted'],
      ['blocked_waiting_permission', 'blocked', 'blocked'],
      ['infra_failure', 'infra_failed', 'failed'],
    ] as const;

    for (const [errorClass, taxonomy, status] of cases) {
      const original = record({
        status: 'failed',
        passed: false,
        exitCode: null,
        error: errorClass,
        errorClass,
      });
      const projection = projectTaskRun(
        taskEventsFromResultRecord(original, { eventId: eventIdFactory() }),
        'run-1',
      );
      assert.equal(taxonomyFromResultRecord(original), taxonomy);
      assert.equal(projection.latestScoreResult?.taxonomy, taxonomy);
      assert.equal(projection.status, status);
      assert.deepEqual(resultRecordFromTaskRunProjection(projection), original);
    }
  });

  test('maps cancelled projections into failed ResultRecord compatibility', () => {
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-c',
          ts: 10,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'task_run_started',
          id: 'e-2',
          taskRunId: 'tr-c',
          ts: 11,
          sessionId: 's-1',
          agentRunId: 'r-1',
        },
        { type: 'task_run_cancelled', id: 'e-3', taskRunId: 'tr-c', ts: 20 },
      ],
      'tr-c',
    );

    assert.deepEqual(resultRecordFromTaskRunProjection(projection), {
      taskId: 'task-1',
      configId: 'cfg-1',
      sessionId: 's-1',
      runId: 'r-1',
      status: 'failed',
      passed: false,
      exitCode: null,
      steps: 3,
      durationMs: 9,
      startedAt: 11,
      finishedAt: 20,
      error: 'task run cancelled',
      errorClass: 'cancelled',
    });
  });
});
