import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  HeavyTaskSelfCheckPlanState,
  HeavyTaskSemanticSelfCheckState,
  TaskEvent,
} from '../task-contracts.js';
import { taskAttemptExecutionEvidence } from '../task-execution-lineage.js';
import {
  createInMemoryTaskRunStore,
  createTaskRunStore,
  projectTaskRun,
} from '../task-run-store.js';

function eventIdFactory(): () => string {
  let i = 0;
  return () => `e-${++i}`;
}

function completedEvents(taskRunId = 'tr-1'): TaskEvent[] {
  const id = eventIdFactory();
  return [
    { type: 'task_run_created', id: id(), taskRunId, ts: 10, taskId: 'task-1', configId: 'cfg-1' },
    {
      type: 'task_run_started',
      id: id(),
      taskRunId,
      ts: 11,
      startedAt: 11,
      sessionId: 's-1',
      agentRunId: 'r-1',
    },
    {
      type: 'task_attempt_started',
      id: id(),
      taskRunId,
      ts: 12,
      attemptId: 'a-1',
      sessionId: 's-1',
      agentRunId: 'r-1',
    },
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
      observation: {
        id: 'fb-1',
        taskRunId,
        attemptId: 'a-1',
        ts: 14,
        source: 'verifier',
        summary: 'tests passed',
      },
    },
    {
      type: 'autonomous_decision_recorded',
      id: id(),
      taskRunId,
      ts: 15,
      decision: {
        id: 'd-1',
        taskRunId,
        attemptId: 'a-1',
        ts: 15,
        decision: 'stop',
        reason: 'verification passed',
      },
    },
    {
      type: 'verifier_result_recorded',
      id: id(),
      taskRunId,
      ts: 20,
      result: {
        id: 'v-1',
        taskRunId,
        attemptId: 'a-1',
        ts: 20,
        kind: 'command',
        passed: true,
        exitCode: 0,
      },
    },
    {
      type: 'score_result_recorded',
      id: id(),
      taskRunId,
      ts: 21,
      result: {
        id: 'score-1',
        taskRunId,
        attemptId: 'a-1',
        ts: 21,
        passed: true,
        taxonomy: 'passed',
      },
    },
    {
      type: 'task_attempt_completed',
      id: id(),
      taskRunId,
      ts: 22,
      attemptId: 'a-1',
      finishedAt: 22,
      status: 'completed',
    },
    { type: 'task_run_completed', id: id(), taskRunId, ts: 23, finishedAt: 23 },
  ];
}

function heavyTaskEvidenceEvent(
  taskRunId: string,
  id: string,
  evidenceId: string,
  name: 'Bash' | 'Read',
  ts: number,
): TaskEvent {
  return {
    type: 'heavy_task_evidence_recorded',
    id,
    taskRunId,
    ts,
    evidence: {
      schemaVersion: 1,
      evidenceId,
      taskRunId,
      ts,
      kind: 'tool',
      public: true,
      source: { kind: 'model_tool', toolCallId: `tool-${ts}`, toolName: name },
      tool: {
        name,
        inputSummary: name === 'Bash' ? { command: 'npm test' } : { path: 'README.md' },
        ...(name === 'Bash' ? { exitCode: 0 } : {}),
        ok: true,
        outputs: [
          {
            stream: name === 'Bash' ? 'stdout' : 'content',
            excerpt: 'bounded public summary',
            byteCount: 22,
            lineCount: 1,
            truncated: false,
            truncationRef: {
              truncated: false,
              originalBytes: 22,
              visibleBytes: 22,
              omittedBytes: 0,
            },
          },
        ],
        diff: { status: 'not_applicable' },
      },
    },
  };
}

describe('TaskRunStore', () => {
  test('appends and replays events in order', async () => {
    const store = createInMemoryTaskRunStore();
    const events = completedEvents();
    for (const event of events) await store.appendEvent(event.taskRunId, event);

    assert.deepEqual(await store.readEvents('tr-1'), events);
    assert.deepEqual(
      (await store.readEventRecords('tr-1')).slice(0, 2).map((record) => record.cursor),
      [
        { ledger: 'task_event', streamId: 'tr-1', sequence: 0, eventId: 'e-1' },
        { ledger: 'task_event', streamId: 'tr-1', sequence: 1, eventId: 'e-2' },
      ],
    );
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
    assert.deepEqual(projection.attempts[0]?.executionLineage, []);
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

  test('projects every AgentRun linked to one attempt without copying Runtime facts', () => {
    const taskRunId = 'tr-lineage';
    const attemptId = 'attempt-1';
    const events: TaskEvent[] = [
      {
        type: 'task_run_created',
        id: 'e-1',
        taskRunId,
        ts: 1,
        taskId: 'task-1',
        configId: 'cfg-1',
      },
      {
        type: 'task_run_started',
        id: 'e-2',
        taskRunId,
        ts: 2,
        sessionId: 'session-1',
        agentRunId: 'run-1',
      },
      {
        type: 'task_attempt_started',
        id: 'e-3',
        taskRunId,
        ts: 3,
        attemptId,
        sessionId: 'session-1',
        agentRunId: 'run-1',
      },
      {
        type: 'task_attempt_execution_linked',
        id: 'e-4',
        taskRunId,
        attemptId,
        ts: 4,
        evidence: taskAttemptExecutionEvidence({
          taskRunId,
          attemptId,
          sessionId: 'session-1',
          invocationId: 'invocation-1',
          agentRunId: 'run-1',
          turnId: 'turn-1',
          runtimeEvents: [],
        }),
      },
      {
        type: 'task_attempt_execution_linked',
        id: 'e-5',
        taskRunId,
        attemptId,
        ts: 5,
        evidence: taskAttemptExecutionEvidence({
          taskRunId,
          attemptId,
          sessionId: 'session-1',
          invocationId: 'invocation-2',
          agentRunId: 'run-2',
          turnId: 'turn-2',
          runtimeEvents: [],
        }),
      },
      {
        type: 'task_attempt_completed',
        id: 'e-6',
        taskRunId,
        ts: 6,
        attemptId,
        status: 'completed',
      },
    ];

    const projection = projectTaskRun(events, taskRunId);

    assert.equal(projection.agentRunId, 'run-1');
    assert.deepEqual(
      projection.executionLineage.map((ref) => ref.execution?.agentRunId),
      ['run-1', 'run-2'],
    );
    assert.deepEqual(
      projection.attempts[0]?.executionLineage.map((ref) => ref.execution?.agentRunId),
      ['run-1', 'run-2'],
    );
  });

  test('rejects lineage whose task identity does not match the owning event', () => {
    const taskRunId = 'tr-lineage-invalid';
    const projection = projectTaskRun(
      [
        { type: 'task_attempt_started', id: 'e-1', taskRunId, ts: 1, attemptId: 'attempt-1' },
        {
          type: 'task_attempt_execution_linked',
          id: 'e-2',
          taskRunId,
          attemptId: 'attempt-1',
          ts: 2,
          evidence: taskAttemptExecutionEvidence({
            taskRunId: 'another-task-run',
            attemptId: 'attempt-1',
            sessionId: 'session-1',
            agentRunId: 'run-1',
            runtimeEvents: [],
          }),
        },
      ],
      taskRunId,
    );

    assert.equal(projection.executionLineage.length, 0);
    assert.match(projection.warnings[0] ?? '', /task identity does not match/);
  });

  test('projects Runtime provenance onto compact evidence without copying Runtime facts', () => {
    const taskRunId = 'tr-evidence-provenance';
    const recorded = heavyTaskEvidenceEvent(taskRunId, 'e-1', 'evidence-1', 'Bash', 1);
    if (recorded.type !== 'heavy_task_evidence_recorded')
      throw new Error('expected evidence event');
    recorded.evidence.attemptId = 'attempt-1';
    recorded.evidence.source = {
      ...recorded.evidence.source,
      sessionId: 'session-1',
      agentRunId: 'run-1',
      turnId: 'turn-1',
    };
    const events: TaskEvent[] = [
      recorded,
      {
        type: 'heavy_task_evidence_provenance_linked',
        id: 'e-2',
        taskRunId,
        attemptId: 'attempt-1',
        ts: 2,
        evidenceId: 'evidence-1',
        provenance: {
          schemaVersion: 'maka.execution_evidence_ref.v1',
          execution: {
            sessionId: 'session-1',
            invocationId: 'invocation-1',
            agentRunId: 'run-1',
            turnId: 'turn-1',
          },
          task: { taskRunId, attemptId: 'attempt-1' },
          runtimeCoverage: {
            lowWater: {
              ledger: 'runtime_event',
              streamId: 'run-1',
              sequence: 4,
              eventId: 'call-1',
            },
            highWater: {
              ledger: 'runtime_event',
              streamId: 'run-1',
              sequence: 6,
              eventId: 'result-1',
            },
            eventCount: 3,
          },
        },
      },
    ];

    const projection = projectTaskRun(events, taskRunId);

    assert.equal(projection.heavyTaskEvidence[0]?.provenance?.execution?.agentRunId, 'run-1');
    assert.equal(
      projection.heavyTaskEvidence[0]?.provenance?.runtimeCoverage?.highWater.eventId,
      'result-1',
    );
    assert.equal(projection.events[1]?.type, 'heavy_task_evidence_provenance_linked');
  });

  test('rejects evidence provenance from a different Runtime source', () => {
    const taskRunId = 'tr-evidence-provenance-invalid';
    const recorded = heavyTaskEvidenceEvent(taskRunId, 'e-1', 'evidence-1', 'Bash', 1);
    if (recorded.type !== 'heavy_task_evidence_recorded')
      throw new Error('expected evidence event');
    recorded.evidence.source.agentRunId = 'run-1';
    const projection = projectTaskRun(
      [
        recorded,
        {
          type: 'heavy_task_evidence_provenance_linked',
          id: 'e-2',
          taskRunId,
          attemptId: 'attempt-1',
          ts: 2,
          evidenceId: 'evidence-1',
          provenance: {
            schemaVersion: 'maka.execution_evidence_ref.v1',
            execution: { sessionId: 'session-1', agentRunId: 'run-2' },
            task: { taskRunId, attemptId: 'attempt-1' },
            runtimeCoverage: {
              highWater: {
                ledger: 'runtime_event',
                streamId: 'run-2',
                sequence: 1,
                eventId: 'result-1',
              },
            },
          },
        },
      ],
      taskRunId,
    );

    assert.equal(projection.heavyTaskEvidence[0]?.provenance, undefined);
    assert.match(projection.warnings[0] ?? '', /Runtime identity does not match/);
  });

  test('does not trust provenance embedded in the compact evidence fact', () => {
    const taskRunId = 'tr-embedded-provenance';
    const recorded = heavyTaskEvidenceEvent(taskRunId, 'e-1', 'evidence-1', 'Bash', 1);
    if (recorded.type !== 'heavy_task_evidence_recorded')
      throw new Error('expected evidence event');
    recorded.evidence.provenance = {
      schemaVersion: 'maka.execution_evidence_ref.v1',
      execution: { sessionId: 'session-1', agentRunId: 'run-1' },
      task: { taskRunId, attemptId: 'attempt-1' },
      runtimeCoverage: {
        highWater: {
          ledger: 'runtime_event',
          streamId: 'run-1',
          sequence: 1,
          eventId: 'forged-result',
        },
      },
    };

    const projection = projectTaskRun([recorded], taskRunId);

    assert.equal(projection.heavyTaskEvidence[0]?.provenance, undefined);
    assert.match(projection.warnings[0] ?? '', /provenance link event is required/);
  });

  test('projects first-class task-run artifacts', () => {
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-artifact',
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'task_run_artifact_recorded',
          id: 'e-2',
          taskRunId: 'tr-artifact',
          ts: 2,
          artifact: {
            schemaVersion: 1,
            artifactId: 'artifact-workspace',
            taskRunId: 'tr-artifact',
            ts: 2,
            kind: 'container_workspace',
            workspacePath: '/app',
            authority: { source: 'container_capture', authoritative: true },
          },
        },
      ],
      'tr-artifact',
    );

    assert.equal(projection.artifacts.length, 1);
    assert.equal(projection.artifacts[0]?.workspacePath, '/app');
    assert.equal(projection.artifacts[0]?.authority.source, 'container_capture');
    assert.equal(projection.heavyTaskEvidence.length, 0);
  });

  test('projects compact evidence for heavy-task runtime artifacts and skips official artifacts', () => {
    const taskRunId = 'tr-artifact-evidence';
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId,
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'heavy_task_mode_recorded',
          id: 'e-2',
          taskRunId,
          ts: 2,
          facts: {
            schemaVersion: 1,
            enabled: true,
            triggerSource: 'config',
            triggerReason: 'long public task',
            policyVersion: 'maka-heavy-task-policy.v1',
          },
        },
        {
          type: 'task_run_artifact_recorded',
          id: 'e-3',
          taskRunId,
          ts: 3,
          artifact: {
            schemaVersion: 1,
            artifactId: 'artifact-runtime',
            taskRunId,
            ts: 3,
            kind: 'generated_output',
            path: 'build-output.log',
            authority: {
              source: 'runtime',
              authoritative: false,
              label: 'public runtime artifact',
            },
            metadata: { label: 'public label', body: 'raw artifact body' },
          },
        },
        {
          type: 'task_run_artifact_recorded',
          id: 'e-4',
          taskRunId,
          ts: 4,
          artifact: {
            schemaVersion: 1,
            artifactId: 'artifact-official',
            taskRunId,
            ts: 4,
            kind: 'benchmark_manifest',
            path: 'official-verifier-output.json',
            authority: { source: 'official_harbor_verifier', authoritative: true },
          },
        },
      ],
      taskRunId,
    );

    assert.equal(projection.artifacts.length, 2);
    assert.equal(projection.heavyTaskEvidence.length, 1);
    assert.equal(projection.latestHeavyTaskEvidence?.artifact?.artifactId, 'artifact-runtime');
    assert.equal(projection.latestHeavyTaskEvidence?.artifact?.authority?.source, 'runtime');
    assert.equal(projection.latestHeavyTaskEvidence?.artifact?.metadata?.label, 'public label');
    assert.doesNotMatch(
      JSON.stringify(projection.heavyTaskEvidence),
      /raw artifact body|official-verifier-output/,
    );
  });

  test('projects heavy-task mode facts', () => {
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-heavy',
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'heavy_task_mode_recorded',
          id: 'e-2',
          taskRunId: 'tr-heavy',
          ts: 2,
          facts: {
            schemaVersion: 1,
            enabled: true,
            triggerSource: 'task_metadata',
            triggerReason: 'task declared heavy',
            policyVersion: 'maka-heavy-task-policy.v1',
          },
        },
      ],
      'tr-heavy',
    );

    assert.deepEqual(projection.heavyTaskMode, {
      schemaVersion: 1,
      enabled: true,
      triggerSource: 'task_metadata',
      triggerReason: 'task declared heavy',
      policyVersion: 'maka-heavy-task-policy.v1',
    });
  });

  test('projects heavy-task inventory and todo snapshots from replay order', () => {
    const taskRunId = 'tr-progress';
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId,
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'heavy_task_inventory_recorded',
          id: 'e-2',
          taskRunId,
          ts: 2,
          inventory: {
            schemaVersion: 1,
            inventoryId: 'inventory-1',
            taskRunId,
            ts: 2,
            summary: 'Initial inventory',
            items: [{ path: 'README.md', kind: 'file', status: 'observed' }],
            source: { kind: 'model_tool', toolCallId: 'tool-1' },
          },
        },
        {
          type: 'heavy_task_todos_recorded',
          id: 'e-3',
          taskRunId,
          ts: 3,
          todos: {
            schemaVersion: 1,
            todoSetId: 'todos-1',
            taskRunId,
            ts: 3,
            items: [
              { id: 'inspect', content: 'Inspect files', status: 'in_progress', priority: 'high' },
            ],
            source: { kind: 'model_tool', toolCallId: 'tool-2' },
          },
        },
        {
          type: 'heavy_task_inventory_recorded',
          id: 'e-4',
          taskRunId,
          ts: 4,
          inventory: {
            schemaVersion: 1,
            inventoryId: 'inventory-2',
            taskRunId,
            ts: 4,
            summary: 'Updated inventory',
            items: [{ path: 'src/app.js', kind: 'file', status: 'planned' }],
            source: { kind: 'model_tool', toolCallId: 'tool-3' },
          },
        },
        {
          type: 'heavy_task_todos_recorded',
          id: 'e-5',
          taskRunId,
          ts: 5,
          todos: {
            schemaVersion: 1,
            todoSetId: 'todos-2',
            taskRunId,
            ts: 5,
            items: [
              {
                id: 'edit',
                content: 'Patch implementation',
                status: 'pending',
                priority: 'medium',
              },
            ],
            source: { kind: 'model_tool', toolCallId: 'tool-4' },
          },
        },
      ],
      taskRunId,
    );

    assert.equal(projection.heavyTaskInventory.length, 2);
    assert.equal(projection.latestHeavyTaskInventory?.inventoryId, 'inventory-2');
    assert.equal(projection.latestHeavyTaskInventory?.items[0]?.path, 'src/app.js');
    assert.equal(projection.heavyTaskTodoStates.length, 2);
    assert.equal(projection.latestHeavyTaskTodos?.todoSetId, 'todos-2');
    assert.equal(projection.latestHeavyTaskTodos?.items[0]?.id, 'edit');
  });

  test('projects heavy-task compact evidence from replay order', () => {
    const taskRunId = 'tr-evidence';
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId,
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        heavyTaskEvidenceEvent(taskRunId, 'e-2', 'evidence-1', 'Bash', 2),
        heavyTaskEvidenceEvent(taskRunId, 'e-3', 'evidence-2', 'Read', 3),
      ],
      taskRunId,
    );

    assert.equal(projection.heavyTaskEvidence.length, 2);
    assert.equal(projection.heavyTaskEvidence[0]?.evidenceId, 'evidence-1');
    assert.equal(projection.latestHeavyTaskEvidence?.evidenceId, 'evidence-2');
    assert.equal(projection.latestHeavyTaskEvidence?.tool?.name, 'Read');
  });

  test('projects only accepted public heavy-task self-checks from replay', () => {
    const taskRunId = 'tr-self-check';
    const accepted = acceptedSelfCheck(
      taskRunId,
      'self-check-1',
      'pass',
      'npm test passed on public files.',
    );
    const rejectedGuard = {
      ...acceptedSelfCheck(
        taskRunId,
        'self-check-2',
        'fail',
        'official-verifier-output.json says failed',
      ),
      guard: {
        status: 'rejected' as const,
        checkedAt: 11,
        categories: ['official_verifier_artifacts'],
        publicReason:
          'Rejected because submitted evidence referenced private, hidden, or evaluator-only material.',
      },
    };
    const privatePayload = acceptedSelfCheck(
      taskRunId,
      'self-check-3',
      'inconclusive',
      'hidden/tests/private_case.py revealed a failure.',
    );
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId,
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'heavy_task_self_check_recorded',
          id: 'e-2',
          taskRunId,
          ts: 10,
          selfCheck: accepted,
        },
        {
          type: 'heavy_task_self_check_recorded',
          id: 'e-3',
          taskRunId,
          ts: 11,
          selfCheck: rejectedGuard as unknown as HeavyTaskSemanticSelfCheckState,
        },
        {
          type: 'heavy_task_self_check_recorded',
          id: 'e-4',
          taskRunId,
          ts: 12,
          selfCheck: privatePayload,
        },
      ],
      taskRunId,
    );

    assert.equal(projection.heavyTaskSelfChecks.length, 1);
    assert.equal(projection.latestHeavyTaskSelfCheck?.selfCheckId, 'self-check-1');
    assert.deepEqual(
      projection.heavyTaskEvidence.map((item) => item.kind),
      ['check', 'tool', 'artifact'],
    );
    assert.equal(projection.heavyTaskEvidence[2]?.artifact?.path, 'build-output.log');
    assert.equal(projection.heavyTaskEvidence[2]?.artifact?.authority?.source, 'self_check');
    assert.equal(projection.warnings.length, 2);
    assert.match(projection.warnings.join('\n'), /source guard did not accept/);
  });

  test('replays Self-check source binding and invalidates freshness after later workspace mutations', () => {
    const taskRunId = 'tr-self-check-freshness';
    const attemptId = 'attempt-1';
    const selfCheck = {
      ...acceptedSelfCheck(taskRunId, 'self-check-1', 'pass', 'npm test passed.'),
      attemptId,
      source: {
        kind: 'model_tool' as const,
        toolCallId: 'self-check-call',
        sessionId: 'session-1',
        agentRunId: 'run-1',
        turnId: 'turn-1',
      },
    };
    const revision = { kind: 'manifest' as const, ref: 'sha256:workspace-1', dirty: false };
    const workspaceObservation: Extract<
      TaskEvent,
      { type: 'heavy_task_workspace_observation_recorded' }
    >['observation'] = {
      schemaVersion: 1,
      observationId: 'workspace-1',
      taskRunId,
      ts: 3,
      roots: ['/app/project'],
      entries: [{ path: '/app/project/result.txt', kind: 'file', sizeBytes: 2, sha256: 'aa' }],
      status: 'ok',
      command: 'observe',
      revision,
      source: { kind: 'system', label: 'isolated workspace observation' },
    };
    const prefix: TaskEvent[] = [
      {
        type: 'task_run_created',
        id: 'created',
        taskRunId,
        ts: 1,
        taskId: 'task-1',
        configId: 'cfg-1',
      },
      {
        type: 'heavy_task_self_check_recorded',
        id: 'self-check-event',
        taskRunId,
        ts: 2,
        selfCheck,
      },
      {
        type: 'heavy_task_workspace_observation_recorded',
        id: 'workspace-event-1',
        taskRunId,
        ts: 3,
        observation: workspaceObservation,
      },
      {
        type: 'heavy_task_self_check_evidence_linked',
        id: 'self-check-link',
        taskRunId,
        ts: 4,
        selfCheckId: selfCheck.selfCheckId,
        attemptId,
        workspaceObservationId: 'workspace-1',
        provenance: {
          schemaVersion: 'maka.execution_evidence_ref.v1',
          execution: {
            sessionId: 'session-1',
            invocationId: 'invocation-1',
            agentRunId: 'run-1',
            turnId: 'turn-1',
          },
          task: { taskRunId, attemptId },
          runtimeCoverage: {
            lowWater: {
              ledger: 'runtime_event',
              streamId: 'run-1',
              sequence: 2,
              eventId: 'runtime-call',
            },
            highWater: {
              ledger: 'runtime_event',
              streamId: 'run-1',
              sequence: 3,
              eventId: 'runtime-result',
            },
            eventCount: 2,
          },
          taskCoverage: {
            highWater: {
              ledger: 'task_event',
              streamId: taskRunId,
              sequence: 1,
              eventId: 'self-check-event',
            },
            eventCount: 2,
          },
          workspace: revision,
        },
      },
    ];

    const current = projectTaskRun(prefix, taskRunId);
    assert.equal(current.latestHeavyTaskSelfCheck?.freshness, 'current');
    assert.equal(
      current.latestHeavyTaskSelfCheck?.provenance?.taskCoverage?.highWater.eventId,
      'self-check-event',
    );

    const mutationBase = heavyTaskEvidenceEvent(
      taskRunId,
      'mutation',
      'write-evidence',
      'Bash',
      5,
    ) as Extract<TaskEvent, { type: 'heavy_task_evidence_recorded' }>;
    const mutation: Extract<TaskEvent, { type: 'heavy_task_evidence_recorded' }> = {
      ...mutationBase,
      evidence: { ...mutationBase.evidence, attemptId },
    };
    const mutated = projectTaskRun([...prefix, mutation], taskRunId);
    assert.equal(mutated.latestHeavyTaskSelfCheck?.freshness, 'stale');
    assert.deepEqual(mutated.latestHeavyTaskSelfCheck?.freshnessReasons, [
      'later_workspace_mutation',
    ]);

    const reobserved = projectTaskRun(
      [
        ...mutated.events,
        {
          type: 'heavy_task_workspace_observation_recorded',
          id: 'workspace-event-2',
          taskRunId,
          ts: 6,
          observation: {
            ...workspaceObservation,
            observationId: 'workspace-2',
            ts: 6,
          },
        } as TaskEvent,
      ],
      taskRunId,
    );
    assert.equal(reobserved.latestHeavyTaskSelfCheck?.freshness, 'current');

    const changed = projectTaskRun(
      [
        ...reobserved.events,
        {
          type: 'heavy_task_workspace_observation_recorded',
          id: 'workspace-event-3',
          taskRunId,
          ts: 7,
          observation: {
            ...workspaceObservation,
            observationId: 'workspace-3',
            ts: 7,
            revision: { kind: 'manifest', ref: 'sha256:workspace-2', dirty: false },
          },
        } as TaskEvent,
      ],
      taskRunId,
    );
    assert.equal(changed.latestHeavyTaskSelfCheck?.freshness, 'stale');
    assert.deepEqual(changed.latestHeavyTaskSelfCheck?.freshnessReasons, [
      'workspace_revision_changed',
    ]);
  });

  test('derives heavy-task completion from accepted self-checks and latest todos', () => {
    const taskRunId = 'tr-heavy-completion';
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId,
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'heavy_task_mode_recorded',
          id: 'e-2',
          taskRunId,
          ts: 2,
          facts: {
            schemaVersion: 1,
            enabled: true,
            triggerSource: 'config',
            triggerReason: 'long public task',
            policyVersion: 'maka-heavy-task-policy.v1',
          },
        },
        {
          type: 'heavy_task_todos_recorded',
          id: 'e-3',
          taskRunId,
          ts: 3,
          todos: {
            schemaVersion: 1,
            todoSetId: 'todos-1',
            taskRunId,
            ts: 3,
            items: [
              {
                id: 'edit',
                content: 'Patch implementation',
                status: 'completed',
                priority: 'high',
              },
              {
                id: 'artifact',
                kind: 'runnable_artifact',
                content: 'Create first runnable artifact',
                status: 'completed',
                priority: 'high',
                evidence: 'Runnable artifact exists.',
              },
              {
                id: 'check',
                kind: 'public_check',
                content: 'Run public check',
                status: 'completed',
                priority: 'high',
                evidence: 'Public check passed.',
              },
              {
                id: 'optional',
                content: 'Optional polish',
                status: 'cancelled',
                priority: 'low',
                evidence: 'Not required by public task.',
              },
            ],
            source: { kind: 'model_tool', toolCallId: 'tool-2' },
          },
        },
        {
          type: 'heavy_task_self_check_plan_recorded',
          id: 'e-3-plan',
          taskRunId,
          ts: 3.5,
          plan: acceptedSelfCheckPlan(taskRunId),
        },
        {
          type: 'heavy_task_self_check_recorded',
          id: 'e-4',
          taskRunId,
          ts: 4,
          selfCheck: acceptedSelfCheck(
            taskRunId,
            'self-check-1',
            'pass',
            'npm test passed against public files.',
          ),
        },
        {
          type: 'score_result_recorded',
          id: 'e-5',
          taskRunId,
          ts: 5,
          result: {
            id: 'score-1',
            taskRunId,
            ts: 5,
            passed: false,
            scored: true,
            eligible: true,
            taxonomy: 'verification_failed',
            authority: { source: 'official_harbor_verifier', authoritative: true },
          },
        },
        {
          type: 'task_run_budget_exhausted',
          id: 'e-6',
          taskRunId,
          ts: 6,
          error: { message: 'runtime step cap reached', class: 'max_steps' },
        },
      ],
      taskRunId,
    );

    assert.equal(projection.heavyTaskCompletion?.runtime.taskRunStatus, 'budget_exhausted');
    assert.equal(projection.heavyTaskSelfCheckPlans.length, 1);
    assert.equal(projection.latestHeavyTaskSelfCheckPlan?.planId, 'plan-1');
    assert.equal(projection.heavyTaskCompletion?.runtime.taxonomy, 'verification_failed');
    assert.equal(projection.heavyTaskCompletion?.runtime.capKind, 'runtime_step_cap');
    assert.equal(projection.heavyTaskCompletion?.semantic.status, 'complete');
    assert.deepEqual(projection.heavyTaskCompletion?.semantic.nonblockingTodoIds, ['optional']);
    assert.equal(projection.heavyTaskCompletion?.finalization.eligible, true);
    assert.equal(projection.result?.taxonomy, 'verification_failed');
    assert.equal(projection.result?.passed, false);
  });

  test('projects heavy-task self-check gate events while old traces remain ungated', () => {
    const taskRunId = 'tr-heavy-gate';
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId,
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'heavy_task_self_check_gate_recorded',
          id: 'e-2',
          taskRunId,
          ts: 2,
          gate: {
            schemaVersion: 1,
            action: 'repair_prompt',
            reason: 'missing accepted public self-check evidence',
            attempt: 1,
            maxAttempts: 1,
            checklist: [
              {
                id: 'check-1',
                kind: 'workspace_hygiene',
                source: 'generic_heavy_task',
                description:
                  'Pass self-check must include sandbox execution evidence and a public workspace hygiene guard',
                evidenceRequired: 'command_or_artifact',
              },
            ],
            prompt: 'run public checks and self_check_submit',
          },
        },
      ],
      taskRunId,
    );

    assert.equal(projection.heavyTaskSelfCheckGates.length, 1);
    assert.equal(projection.latestHeavyTaskSelfCheckGate?.action, 'repair_prompt');
    assert.equal(
      projection.latestHeavyTaskSelfCheckGate?.reason,
      'missing accepted public self-check evidence',
    );

    const oldTrace = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-old',
          ts: 1,
          taskId: 'task-old',
          configId: 'cfg-1',
        },
      ],
      'tr-old',
    );
    assert.deepEqual(oldTrace.heavyTaskSelfCheckPlans, []);
    assert.equal(oldTrace.latestHeavyTaskSelfCheckPlan, undefined);
    assert.deepEqual(oldTrace.heavyTaskSelfCheckGates, []);
    assert.equal(oldTrace.latestHeavyTaskSelfCheckGate, undefined);
  });

  test('projects isolation, permission, inbox, and needs_approval facts', () => {
    const taskRunId = 'tr-approval';
    const request = {
      schemaVersion: 1 as const,
      requestId: 'req-1',
      taskRunId,
      attemptId: 'a-1',
      toolCallId: 'tool-1',
      toolName: 'Bash',
      normalizedArgsHash: 'abc123',
      resourceScope: { kind: 'command' as const, value: 'rm file', mode: 'execute' as const },
      reason: 'dangerous command',
      preview: { argKeys: ['command'] },
      requestedAt: 3,
      expiresAt: 100,
    };
    const grant = {
      schemaVersion: 1 as const,
      grantId: 'grant-1',
      requestId: 'req-1',
      taskRunId,
      attemptId: 'a-1',
      toolCallId: 'tool-1',
      toolName: 'Bash',
      normalizedArgsHash: 'abc123',
      resourceScope: request.resourceScope,
      decision: 'allow' as const,
      actor: { kind: 'test' as const },
      source: 'test_fixture' as const,
      decidedAt: 4,
      expiresAt: 100,
    };
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId,
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'isolation_policy_recorded',
          id: 'e-2',
          taskRunId,
          ts: 2,
          facts: {
            schemaVersion: 1,
            backendKind: 'ai-sdk',
            required: true,
            mode: 'external',
            label: 'unit isolation',
            assertionSource: 'headless_deps',
            validatedAt: 2,
          },
        },
        {
          type: 'workspace_lease_recorded',
          id: 'e-3',
          taskRunId,
          ts: 2,
          lease: {
            schemaVersion: 1,
            leaseId: 'lease-1',
            taskRunId,
            attemptId: 'a-1',
            sourceWorkspaceDir: '/src',
            workspaceDir: '/tmp/work',
            leaseKind: 'throwaway_copy',
            writable: true,
            cleanupPolicy: 'cleanup_on_finally',
            createdAt: 2,
          },
        },
        {
          type: 'tool_executor_identity_recorded',
          id: 'e-4',
          taskRunId,
          ts: 2,
          identity: {
            schemaVersion: 1,
            executorId: 'exec-1',
            taskRunId,
            attemptId: 'a-1',
            toolNames: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
            isolationMode: 'external',
            label: 'unit isolation',
          },
        },
        { type: 'task_attempt_started', id: 'e-5', taskRunId, ts: 2, attemptId: 'a-1' },
        { type: 'permission_request_recorded', id: 'e-6', taskRunId, ts: 3, request },
        { type: 'permission_grant_recorded', id: 'e-7', taskRunId, ts: 4, grant },
        {
          type: 'task_inbox_item_recorded',
          id: 'e-8',
          taskRunId,
          ts: 5,
          item: {
            schemaVersion: 1,
            inboxItemId: 'inbox-1',
            taskRunId,
            attemptId: 'a-1',
            kind: 'approval_request',
            status: 'open',
            title: 'Approval required',
            reason: 'dangerous command',
            createdAt: 5,
            relatedRequestId: 'req-1',
          },
        },
        {
          type: 'task_run_needs_approval',
          id: 'e-9',
          taskRunId,
          ts: 6,
          attemptId: 'a-1',
          reason: 'approval',
          inboxItemId: 'inbox-1',
        },
      ],
      taskRunId,
    );

    assert.equal(projection.status, 'needs_approval');
    assert.equal(projection.attempts[0]?.status, 'needs_approval');
    assert.equal(projection.isolation?.label, 'unit isolation');
    assert.equal(projection.workspaceLease?.workspaceDir, '/tmp/work');
    assert.equal(projection.toolExecutors[0]?.executorId, 'exec-1');
    assert.equal(projection.permissionRequests[0]?.normalizedArgsHash, 'abc123');
    assert.equal(projection.permissionGrants[0]?.grantId, 'grant-1');
    assert.equal(projection.inboxItems[0]?.status, 'open');
    assert.deepEqual(projection.parked, { reason: 'approval', inboxItemId: 'inbox-1', since: 6 });
  });

  test('terminal events override open inbox parked state', () => {
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-terminal',
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'task_inbox_item_recorded',
          id: 'e-2',
          taskRunId: 'tr-terminal',
          ts: 2,
          item: {
            schemaVersion: 1,
            inboxItemId: 'inbox-1',
            taskRunId: 'tr-terminal',
            kind: 'approval_request',
            status: 'open',
            title: 'Approval required',
            reason: 'permission',
            createdAt: 2,
          },
        },
        {
          type: 'task_run_needs_approval',
          id: 'e-3',
          taskRunId: 'tr-terminal',
          ts: 3,
          reason: 'approval',
          inboxItemId: 'inbox-1',
        },
        { type: 'task_run_policy_denied', id: 'e-4', taskRunId: 'tr-terminal', ts: 4 },
      ],
      'tr-terminal',
    );

    assert.equal(projection.status, 'policy_denied');
    assert.equal(projection.parked, undefined);
  });

  test('projects failed and cancelled terminal events', () => {
    const failed = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-f',
          ts: 1,
          taskId: 'task-f',
          configId: 'cfg',
        },
        {
          type: 'task_run_failed',
          id: 'e-2',
          taskRunId: 'tr-f',
          ts: 2,
          error: { message: 'backend blew up', class: 'backend_failed' },
        },
      ],
      'tr-f',
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.message, 'backend blew up');

    const cancelled = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-c',
          ts: 1,
          taskId: 'task-c',
          configId: 'cfg',
        },
        { type: 'task_run_cancelled', id: 'e-2', taskRunId: 'tr-c', ts: 2 },
      ],
      'tr-c',
    );
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error?.class, 'cancelled');
  });

  test('projects queued, verifying, incomplete, blocked, policy, budget, and aborted states', () => {
    const queued = projectTaskRun(
      [
        {
          type: 'task_run_queued',
          id: 'e-1',
          taskRunId: 'tr-q',
          ts: 1,
          taskId: 'task-q',
          configId: 'cfg',
        },
      ],
      'tr-q',
    );
    assert.equal(queued.status, 'queued');
    assert.equal(queued.taskId, 'task-q');

    const verifying = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-v',
          ts: 1,
          taskId: 'task-v',
          configId: 'cfg',
        },
        { type: 'task_run_started', id: 'e-2', taskRunId: 'tr-v', ts: 2 },
        { type: 'task_run_verifying', id: 'e-3', taskRunId: 'tr-v', ts: 3 },
      ],
      'tr-v',
    );
    assert.equal(verifying.status, 'verifying');

    const terminalCases: Array<[TaskEvent, string, string]> = [
      [
        { type: 'task_run_incomplete', id: 'e-2', taskRunId: 'tr-x', ts: 2 },
        'incomplete',
        'agent_incomplete',
      ],
      [{ type: 'task_run_blocked', id: 'e-2', taskRunId: 'tr-x', ts: 2 }, 'blocked', 'blocked'],
      [
        { type: 'task_run_policy_denied', id: 'e-2', taskRunId: 'tr-x', ts: 2 },
        'policy_denied',
        'policy_denied',
      ],
      [
        { type: 'task_run_budget_exhausted', id: 'e-2', taskRunId: 'tr-x', ts: 2 },
        'budget_exhausted',
        'budget_exhausted',
      ],
      [{ type: 'task_run_aborted', id: 'e-2', taskRunId: 'tr-x', ts: 2 }, 'aborted', 'aborted'],
    ];

    for (const [terminalEvent, status, errorClass] of terminalCases) {
      const projection = projectTaskRun(
        [
          {
            type: 'task_run_created',
            id: 'e-1',
            taskRunId: 'tr-x',
            ts: 1,
            taskId: 'task-x',
            configId: 'cfg',
          },
          terminalEvent,
        ],
        'tr-x',
      );
      assert.equal(projection.status, status);
      assert.equal(projection.error?.class, errorClass);
    }
  });

  test('uses the last terminal event and records a warning', () => {
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-1',
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'task_run_failed',
          id: 'e-2',
          taskRunId: 'tr-1',
          ts: 2,
          error: { message: 'first terminal' },
        },
        { type: 'task_run_completed', id: 'e-3', taskRunId: 'tr-1', ts: 3 },
      ],
      'tr-1',
    );

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
    const projection = projectTaskRun(
      [
        {
          type: 'task_run_created',
          id: 'e-1',
          taskRunId: 'tr-1',
          ts: 1,
          taskId: 'task-1',
          configId: 'cfg-1',
        },
        {
          type: 'event_corrupt',
          id: 'e-corrupt',
          taskRunId: 'tr-1',
          ts: 2,
          raw: '{',
          error: 'invalid json',
        },
        { type: 'task_run_completed', id: 'e-3', taskRunId: 'tr-1', ts: 3 },
      ],
      'tr-1',
    );

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
      const records = await store.readEventRecords('tr-corrupt');
      assert.deepEqual(
        records.map((record) => record.cursor.sequence),
        [0, 1],
      );
      assert.equal(records[1]?.cursor.eventId, 'corrupt-2');
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});

function acceptedSelfCheck(
  taskRunId: string,
  selfCheckId: string,
  status: HeavyTaskSemanticSelfCheckState['status'],
  publicReason: string,
): HeavyTaskSemanticSelfCheckState {
  return {
    schemaVersion: 1,
    selfCheckId,
    taskRunId,
    ts: 10,
    status,
    publicReason,
    commandEvidence: [{ command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' }],
    artifactEvidence: [{ path: 'build-output.log', kind: 'log', exists: true }],
    executionHygiene: {
      sandbox: {
        root: '/tmp/maka-self-check/run-1',
        strategy: 'scratch_dir',
        commandCwd: '/tmp/maka-self-check/run-1',
        outputPolicy: 'scratch_only',
      },
      scratchUsed: true,
      scratchPath: '/tmp/maka-self-check/run-1',
      cleanupPerformed: true,
      workspaceSideEffects: 'none',
      workspaceGuard: {
        checked: true,
        checkedPaths: ['/app'],
        addedPaths: [],
        modifiedPaths: [],
        removedPaths: [],
      },
    },
    guard: {
      status: 'accepted',
      checkedAt: 10,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
    },
    source: { kind: 'model_tool', toolCallId: 'tool-1' },
  };
}

function acceptedSelfCheckPlan(taskRunId: string): HeavyTaskSelfCheckPlanState {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    taskRunId,
    ts: 3.5,
    finalArtifacts: [
      {
        path: 'build-output.log',
        purpose: 'public self-check artifact',
        publicReason: 'visible public check creates this artifact',
      },
    ],
    selfCheckScratch: {
      root: '/tmp/maka-self-check/run-1',
      expectedGeneratedPaths: ['/tmp/maka-self-check/run-1/check.log'],
      publicReason: 'public checks write temporary output under scratch',
    },
    workspaceGuardPlan: {
      checkedPaths: ['/app'],
      expectedAddedPaths: ['build-output.log'],
      expectedGeneratedPathsOutsideScratch: [],
      publicReason: 'public guard checks the deliverable workspace',
    },
    publicReason: 'plan is derived from visible public task evidence',
    guard: {
      status: 'accepted',
      checkedAt: 3.5,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check plan.',
    },
    source: { kind: 'model_tool', toolCallId: 'tool-plan' },
  };
}
