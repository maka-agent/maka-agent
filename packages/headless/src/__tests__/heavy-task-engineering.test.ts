import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createHeavyTaskEngineeringRecorder,
  renderHeavyTaskEngineeringForPrompt,
} from '../heavy-task-engineering.js';
import type {
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskEngineeringRecord,
  TaskEvent,
} from '../task-contracts.js';
import { createInMemoryTaskRunStore, projectTaskRun } from '../task-run-store.js';

describe('heavy-task engineering records', () => {
  test('records valid hypothesis, targeted check, repair, and patch submissions', async () => {
    const store = createInMemoryTaskRunStore(seedEvents('run-engineering'));
    let id = 0;
    const recorder = createHeavyTaskEngineeringRecorder({
      taskRunId: 'run-engineering',
      attemptId: 'attempt-1',
      store,
      now: () => 100 + id,
      newId: () => `gen-${++id}`,
    });

    const hypothesis = await recorder.recordEngineering({
      kind: 'hypothesis',
      title: 'Build check should reveal missing import',
      summary: 'The current todo likely fails because the public build cannot resolve a local import.',
      status: 'proposed',
      links: { todoIds: ['todo-build'] },
      hypothesis: {
        expectedSignal: 'npm test reports a missing local import',
        rationaleEvidenceIds: ['evidence-bash-1'],
      },
    }, toolCtx('tool-record-1'));

    assert.equal(hypothesis.accepted, true);
    assert.equal(hypothesis.record.kind, 'hypothesis');
    assert.equal(hypothesis.record.completeness, 'complete');
    assert.deepEqual(hypothesis.missingLinks, []);

    const check = await recorder.recordCheck({
      title: 'Run unit tests',
      summary: 'The public test command exercises the build path.',
      status: 'failed',
      links: {
        todoIds: ['todo-build'],
        toolCallIds: ['tool-bash-1'],
        evidenceIds: ['evidence-bash-1'],
      },
      command: 'npm test',
      expectedSignal: 'test command completes successfully',
      observedSignal: 'test command failed before the repair',
      result: 'fail',
    }, toolCtx('tool-record-2'));

    assert.equal(check.accepted, true);
    assert.equal(check.checkId, check.record.targetedCheck?.checkId);

    const repair = await recorder.recordEngineering({
      kind: 'repair',
      title: 'Repair import path',
      summary: 'Update the local import path used by the public build.',
      status: 'repaired',
      links: { todoIds: ['todo-build'], changedFiles: ['src/app.js'] },
      repair: {
        failedCheckIds: [check.checkId],
        hypothesisId: hypothesis.record.recordId,
        repairStrategy: 'Adjust the local import to match the public source tree.',
        outcome: 'check_passed',
      },
    }, toolCtx('tool-record-3'));

    assert.equal(repair.accepted, true);
    assert.equal(repair.record.repair?.failedCheckIds[0], check.checkId);

    const patch = await recorder.recordEngineering({
      kind: 'patch',
      title: 'Patch app import',
      summary: 'The implementation change is limited to one public source file.',
      status: 'passed',
      links: { todoIds: ['todo-build'] },
      patch: {
        changedFiles: ['src/app.js'],
        changeSummary: 'Updated the import path and reran public tests.',
        mutationEvidenceIds: ['evidence-edit-1'],
      },
    }, toolCtx('tool-record-4'));

    assert.equal(patch.accepted, true);
    assert.equal(patch.record.patch?.changedFiles[0], 'src/app.js');

    const projection = await store.project('run-engineering');
    assert.equal(projection.heavyTaskEngineeringRecords.length, 4);
    assert.equal(projection.latestHeavyTaskEngineeringRecord?.kind, 'patch');
  });

  test('rejects complete check records that miss required links', async () => {
    const recorder = createHeavyTaskEngineeringRecorder({
      taskRunId: 'run-reject',
      store: createInMemoryTaskRunStore(seedEvents('run-reject')),
      now: () => 1,
      newId: () => 'id',
    });

    await assert.rejects(
      recorder.recordCheck({
        title: 'Run tests',
        summary: 'Missing evidence links should not be accepted as complete.',
        status: 'failed',
        links: { todoIds: ['todo-build'] },
        command: 'npm test',
        expectedSignal: 'tests pass',
        observedSignal: 'tests fail',
        result: 'fail',
      }, toolCtx('tool-record')),
      /complete targeted_check record requires toolCallIds/,
    );
  });

  test('accepts explicitly incomplete records with incompleteReason', async () => {
    const recorder = createHeavyTaskEngineeringRecorder({
      taskRunId: 'run-incomplete',
      store: createInMemoryTaskRunStore(seedEvents('run-incomplete')),
      now: () => 1,
      newId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });

    const result = await recorder.recordEngineering({
      kind: 'hypothesis',
      title: 'Need more evidence',
      summary: 'The hypothesis is recorded before a public check exists.',
      status: 'proposed',
      completeness: 'incomplete',
      incompleteReason: 'No compact public evidence envelope exists for this hypothesis yet.',
      links: { todoIds: ['todo-build'] },
      hypothesis: {
        expectedSignal: 'a later public check identifies the failing area',
      },
    }, toolCtx('tool-record'));

    assert.equal(result.accepted, true);
    assert.equal(result.record.completeness, 'incomplete');
    assert.match(result.record.incompleteReason ?? '', /No compact public evidence/);
  });

  test('rejects private or evaluator-only material through the source guard', async () => {
    const recorder = createHeavyTaskEngineeringRecorder({
      taskRunId: 'run-private',
      store: createInMemoryTaskRunStore(seedEvents('run-private')),
      now: () => 1,
      newId: () => 'id',
    });

    const result = await recorder.recordEngineering({
      kind: 'hypothesis',
      title: 'Avoid official verifier artifacts',
      summary: 'This mentions official verifier artifacts and must be rejected.',
      status: 'proposed',
      links: { todoIds: ['todo-build'] },
      hypothesis: {
        expectedSignal: 'public tests show the issue',
        rationaleEvidenceIds: ['evidence-bash-1'],
      },
    }, toolCtx('tool-record'));

    assert.equal(result.accepted, false);
    assert.ok(result.guard.categories.includes('official_verifier_artifacts'));
  });

  test('replay downgrades dangling links and prompt rendering stays compact', () => {
    const dangling = engineeringRecord('run-dangling', {
      links: {
        todoIds: ['todo-missing'],
        evidenceIds: ['evidence-missing'],
        toolCallIds: [],
        checkIds: ['check-missing'],
        artifactIds: ['artifact-missing'],
        changedFiles: [],
        patchIds: [],
        hypothesisIds: [],
        repairIds: [],
      },
    });
    const projection = projectTaskRun([
      { type: 'task_run_created', id: 'e1', taskRunId: 'run-dangling', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
      { type: 'heavy_task_engineering_recorded', id: 'e2', taskRunId: 'run-dangling', ts: 2, record: dangling },
    ], 'run-dangling');

    assert.equal(projection.heavyTaskEngineeringRecords[0]?.completeness, 'incomplete');
    assert.deepEqual(projection.heavyTaskEngineeringRecords[0]?.projection?.missingTodoIds, ['todo-missing']);
    assert.deepEqual(projection.heavyTaskEngineeringRecords[0]?.projection?.missingEvidenceIds, ['evidence-missing']);
    assert.deepEqual(projection.heavyTaskEngineeringRecords[0]?.projection?.missingArtifactIds, ['artifact-missing']);
    assert.deepEqual(projection.heavyTaskEngineeringRecords[0]?.projection?.missingCheckIds, ['check-missing']);
    assert.match(renderHeavyTaskEngineeringForPrompt(projection) ?? '', /missingTodos=todo-missing/);
  });

  test('replay downgrades complete records that omit required links', () => {
    const projection = projectTaskRun([
      { type: 'task_run_created', id: 'e1', taskRunId: 'run-missing-required', ts: 1, taskId: 'task-1', configId: 'cfg-1' },
      {
        type: 'heavy_task_engineering_recorded',
        id: 'e2',
        taskRunId: 'run-missing-required',
        ts: 2,
        record: engineeringRecord('run-missing-required', {
          kind: 'patch',
          patch: {
            patchId: 'patch-without-required-links',
            changedFiles: ['src/app.js'],
            changeSummary: 'Missing todo and mutation evidence links should downgrade this replayed event.',
            mutationEvidenceIds: [],
          },
          links: {
            todoIds: [],
            evidenceIds: [],
            toolCallIds: [],
            checkIds: [],
            artifactIds: [],
            changedFiles: ['src/app.js'],
            patchIds: ['patch-without-required-links'],
            hypothesisIds: [],
            repairIds: [],
          },
        }),
      },
    ], 'run-missing-required');

    const record = projection.heavyTaskEngineeringRecords[0];
    assert.equal(record?.completeness, 'incomplete');
    assert.match(record?.incompleteReason ?? '', /Required links are missing/);
    assert.match(record?.incompleteReason ?? '', /todoIds/);
    assert.match(record?.incompleteReason ?? '', /mutationEvidenceIds/);
  });
});

function seedEvents(taskRunId: string): TaskEvent[] {
  return [
    { type: 'task_run_created', id: 'e-create', taskRunId, ts: 1, taskId: 'task-1', configId: 'cfg-1' },
    {
      type: 'heavy_task_todos_recorded',
      id: 'e-todos',
      taskRunId,
      ts: 2,
      todos: {
        schemaVersion: 1,
        todoSetId: 'todos-1',
        taskRunId,
        ts: 2,
        items: [{ id: 'todo-build', content: 'Fix the public build', status: 'in_progress', priority: 'high' }],
        source: { kind: 'model_tool', toolCallId: 'tool-todos' },
      },
    },
    evidenceEvent(taskRunId, 'evidence-bash-1', 'Bash'),
    evidenceEvent(taskRunId, 'evidence-edit-1', 'Edit'),
    {
      type: 'task_run_artifact_recorded',
      id: 'e-artifact',
      taskRunId,
      ts: 4,
      artifact: {
        schemaVersion: 1,
        artifactId: 'artifact-build-output',
        taskRunId,
        ts: 4,
        kind: 'generated_output',
        path: 'build-output.log',
        authority: { source: 'runtime', authoritative: false },
      },
    },
  ];
}

function evidenceEvent(taskRunId: string, evidenceId: string, toolName: string): TaskEvent {
  const evidence: HeavyTaskCompactEvidenceEnvelope = {
    schemaVersion: 1,
    evidenceId,
    taskRunId,
    ts: 3,
    kind: 'tool',
    public: true,
    source: { kind: 'model_tool', toolCallId: `tool-${toolName.toLowerCase()}`, toolName },
    tool: {
      name: toolName,
      inputSummary: toolName === 'Bash' ? { command: 'npm test' } : { path: 'src/app.js' },
      ok: toolName !== 'Bash',
      ...(toolName === 'Bash' ? { exitCode: 1 } : {}),
      outputs: [{
        stream: toolName === 'Bash' ? 'stdout' : 'diff',
        excerpt: 'bounded public output summary',
        truncated: false,
      }],
      diff: toolName === 'Edit' ? { status: 'not_captured', files: [{ path: 'src/app.js' }] } : { status: 'not_applicable' },
    },
  };
  return { type: 'heavy_task_evidence_recorded', id: `event-${evidenceId}`, taskRunId, ts: 3, evidence };
}

function engineeringRecord(taskRunId: string, partial: Partial<HeavyTaskEngineeringRecord>): HeavyTaskEngineeringRecord {
  return {
    schemaVersion: 1,
    recordId: 'record-1',
    taskRunId,
    ts: 2,
    kind: 'targeted_check',
    title: 'Dangling public check',
    summary: 'A hand-written event references missing public ids.',
    status: 'failed',
    completeness: 'complete',
    source: { kind: 'model_tool', toolCallId: 'tool-record', toolName: 'check_record' },
    links: {
      todoIds: ['todo-build'],
      evidenceIds: [],
      toolCallIds: ['tool-bash'],
      checkIds: ['check-unit-1'],
      artifactIds: [],
      changedFiles: [],
      patchIds: [],
      hypothesisIds: [],
      repairIds: [],
    },
    targetedCheck: {
      checkId: 'check-unit-1',
      command: 'npm test',
      expectedSignal: 'tests pass',
      observedSignal: 'tests fail',
      result: 'fail',
    },
    ...partial,
  };
}

function toolCtx(toolCallId: string) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/workspace',
    toolCallId,
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
}
