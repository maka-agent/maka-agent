import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { taskRunExportFromProjection, writeTaskRunExport } from '../result-export.js';
import type { TaskEvent } from '../task-contracts.js';
import { projectTaskRun } from '../task-run-store.js';

describe('task run export', () => {
  test('projects runtime, verifier, score, budget, isolation, inbox, and taxonomy', async () => {
    const events: TaskEvent[] = [
      { type: 'task_run_created', id: 'e1', taskRunId: 'run-1', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
      { type: 'task_run_started', id: 'e2', taskRunId: 'run-1', ts: 2, startedAt: 2, sessionId: 'session-1', agentRunId: 'agent-1' },
      {
        type: 'isolation_policy_recorded',
        id: 'e3',
        taskRunId: 'run-1',
        ts: 2,
        facts: {
          schemaVersion: 1,
          backendKind: 'fake',
          required: false,
          mode: 'inert_fake_backend',
          assertionSource: 'test_fixture',
          validatedAt: 2,
        },
      },
      {
        type: 'feedback_observed',
        id: 'e4',
        taskRunId: 'run-1',
        ts: 3,
        observation: {
          id: 'feedback-1',
          taskRunId: 'run-1',
          ts: 3,
          source: 'runtime',
          summary: 'runtime invocation completed',
          details: { runtimeRefs: { runtimeEventIds: ['runtime-1'] }, budget: { totals: { total: 3 } } },
        },
      },
      {
        type: 'verifier_result_recorded',
        id: 'e5',
        taskRunId: 'run-1',
        ts: 4,
        result: {
          id: 'verifier-1',
          taskRunId: 'run-1',
          ts: 4,
          kind: 'terminal_bench',
          passed: true,
          exitCode: 0,
          score: 1,
          maxScore: 1,
          submittedSnapshotId: 'snapshot-1',
          details: { adapter: 'terminal-bench', instanceId: 'tb-1' },
        },
      },
      {
        type: 'score_result_recorded',
        id: 'e6',
        taskRunId: 'run-1',
        ts: 5,
        result: {
          id: 'score-1',
          taskRunId: 'run-1',
          ts: 5,
          passed: true,
          scored: true,
          eligible: true,
          score: 1,
          maxScore: 1,
          taxonomy: 'passed',
          details: {
            runtimeRefs: { runtimeEventIds: ['runtime-1'] },
            budget: { totals: { total: 3 } },
            submittedSnapshot: { id: 'snapshot-1', manifestHash: 'sha256:abc' },
          },
        },
      },
      { type: 'task_run_completed', id: 'e7', taskRunId: 'run-1', ts: 6, finishedAt: 6 },
    ];
    const projection = projectTaskRun(events, 'run-1');
    const exported = taskRunExportFromProjection(projection, { exportedAt: '2026-06-19T00:00:00.000Z' });

    assert.equal(exported.schemaVersion, 'maka.task_run_export.v1');
    assert.equal(exported.taskRun.taskRunId, 'run-1');
    assert.deepEqual(exported.runtime.trajectoryRefs.runtimeEventIds, ['runtime-1']);
    assert.deepEqual(exported.workspace.submittedSnapshot, { id: 'snapshot-1', manifestHash: 'sha256:abc' });
    assert.equal(exported.workspace.diff.status, 'not_captured');
    assert.equal(exported.verifier?.benchmark?.instanceId, 'tb-1');
    assert.deepEqual(exported.budget, { totals: { total: 3 } });
    assert.equal(exported.isolation.policy?.mode, 'inert_fake_backend');
    assert.equal(exported.taxonomy.value, 'passed');
    assert.equal(exported.legacyResultRecord.passed, true);
  });

  test('writes deterministic export files and optional events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-task-export-'));
    try {
      const projection = projectTaskRun([
        { type: 'task_run_created', id: 'e1', taskRunId: 'run-1', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
      ], 'run-1');
      const result = await writeTaskRunExport(dir, projection, {
        includeEvents: true,
        exportedAt: '2026-06-19T00:00:00.000Z',
      });

      assert.match(await readFile(result.files.taskRunJson, 'utf8'), /maka.task_run_export.v1/);
      assert.match(await readFile(result.files.resultMd, 'utf8'), /# Task Run run-1/);
      assert.equal(await readFile(result.files.eventsJsonl!, 'utf8'), '{"type":"task_run_created","id":"e1","taskRunId":"run-1","ts":1,"taskId":"task-1","configId":"cfg-1"}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
