import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { taskRunExportFromProjection, writeTaskRunExport } from '../result-export.js';
import type {
  HeavyTaskEngineeringRecord,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskSelfCheckStatus,
  HeavyTaskTodoItem,
  TaskEvent,
} from '../task-contracts.js';
import { createTaskRunStore } from '../task-run-store.js';

const TASK_RUN_ID = 'run-sqlite-gcov-p1d';
const ATTEMPT_ID = 'attempt-sqlite-gcov-p1d';

describe('heavy-task public synthetic trace harness', () => {
  test('replays a full public repair chain through store, projection, and compact export', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-p1d-trace-store-'));
    const exportRoot = await mkdtemp(join(tmpdir(), 'maka-p1d-trace-export-'));
    try {
      const store = createTaskRunStore(storageRoot);
      for (const event of sqliteGcovPublicTrace()) {
        await store.appendEvent(TASK_RUN_ID, event);
      }

      const firstProjection = await store.project(TASK_RUN_ID);
      const replayedProjection = await createTaskRunStore(storageRoot).project(TASK_RUN_ID);
      assert.deepEqual(replayedProjection.heavyTaskInventory, firstProjection.heavyTaskInventory);
      assert.deepEqual(replayedProjection.heavyTaskTodoStates, firstProjection.heavyTaskTodoStates);
      assert.deepEqual(replayedProjection.heavyTaskEngineeringRecords, firstProjection.heavyTaskEngineeringRecords);
      assert.deepEqual(replayedProjection.heavyTaskCompletion, firstProjection.heavyTaskCompletion);

      assert.equal(replayedProjection.latestHeavyTaskInventory?.inventoryId, 'inventory-sqlite-gcov-1');
      assert.equal(replayedProjection.heavyTaskTodoStates.length, 4);
      assert.equal(replayedProjection.latestHeavyTaskTodos?.todoSetId, 'todos-sqlite-gcov-4');
      assert.deepEqual(replayedProjection.latestHeavyTaskTodos?.items.map((item) => item.status), [
        'completed',
        'completed',
        'completed',
      ]);
      assert.equal(replayedProjection.heavyTaskEngineeringRecords.map((record) => record.kind).join(','), [
        'hypothesis',
        'targeted_check',
        'repair',
        'patch',
        'targeted_check',
      ].join(','));
      assert.equal(replayedProjection.latestHeavyTaskSelfCheck?.selfCheckId, 'self-check-public-pass');
      assert.equal(replayedProjection.heavyTaskSelfChecks.length, 1);
      assert.equal(replayedProjection.heavyTaskCompletion?.runtime.capLike, true);
      assert.equal(replayedProjection.heavyTaskCompletion?.runtime.capKind, 'runtime_step_cap');
      assert.equal(replayedProjection.heavyTaskCompletion?.semantic.status, 'complete');
      assert.equal(replayedProjection.heavyTaskCompletion?.semantic.evidenceChain.outcome, 'complete');
      assertPublicChecksPrecedeFinalSelfCheck(replayedProjection.events);
      assert.ok(replayedProjection.heavyTaskCompletion?.semantic.evidenceChain.completeItemIds.includes('targeted_check:check-gcov-initial'));
      assert.ok(replayedProjection.heavyTaskCompletion?.semantic.evidenceChain.completeItemIds.includes('repair:record-repair-gcov-flags'));
      assert.ok(replayedProjection.heavyTaskCompletion?.semantic.evidenceChain.completeItemIds.includes('patch:patch-gcov-flags'));
      assert.ok(replayedProjection.heavyTaskCompletion?.semantic.evidenceChain.completeItemIds.includes('targeted_check:check-gcov-final'));
      assert.equal(replayedProjection.heavyTaskCompletion?.finalization.eligible, true);
      assert.equal(replayedProjection.result?.taxonomy, 'verification_failed');
      assert.equal(replayedProjection.result?.passed, false);
      assert.match(replayedProjection.warnings.join('\n'), /source guard did not accept/);

      const exported = taskRunExportFromProjection(replayedProjection, { exportedAt: '2026-06-23T00:00:00.000Z' });
      assert.equal(exported.schemaVersion, 'maka.task_run_export.v1');
      assert.equal(exported.taskRun.taskRunId, TASK_RUN_ID);
      assert.equal(exported.taskRun.status, 'budget_exhausted');
      assert.equal(exported.runtime.attempts[0]?.attemptId, ATTEMPT_ID);
      assert.deepEqual(exported.runtime.trajectoryRefs.runtimeEventIds, ['runtime-sqlite-gcov-1']);
      assert.equal(exported.workspace.diff.status, 'present');
      assert.equal(exported.artifacts.byKind.workspace_diff?.[0]?.path, '/logs/submission.diff');
      assert.equal(exported.policy?.heavyTask?.enabled, true);
      assert.equal(exported.progress?.inventory?.historyCount, 1);
      assert.equal(exported.progress?.todos?.historyCount, 4);
      assert.equal(exported.progress?.engineering?.historyCount, 5);
      assert.equal(exported.progress?.evidence?.historyCount, 7);
      assert.equal(exported.progress?.selfChecks?.historyCount, 1);
      assert.equal(exported.heavyTask?.completion.semantic.evidenceChain.outcome, 'complete');
      assert.equal(exported.heavyTask?.completion.finalization.eligible, true);
      assert.equal(exported.taxonomy.value, 'verification_failed');
      assert.equal(exported.taxonomy.passed, false);
      assert.equal(exported.legacyResultRecord.passed, false);

      const written = await writeTaskRunExport(exportRoot, replayedProjection, {
        exportedAt: '2026-06-23T00:00:00.000Z',
        includeEvents: true,
      });
      const fullJson = await readFile(written.files.taskRunJson, 'utf8');
      const compactJson = await readFile(written.files.resultJson, 'utf8');
      const eventsJsonl = await readFile(written.files.eventsJsonl!, 'utf8');
      const compact = JSON.parse(compactJson);

      assert.deepEqual(compact.heavyTask, exported.heavyTask);
      assert.deepEqual(compact.progress, exported.progress);
      assert.equal(compact.schemaVersion, 'maka.task_run_export.v1');
      assert.equal(compact.taskRun.taskRunId, TASK_RUN_ID);
      assert.equal(compact.taxonomy.value, 'verification_failed');
      assert.equal(compact.legacyResultRecord.errorClass, 'max_steps');
      assert.match(eventsJsonl, /self-check-public-pass/);
      assert.doesNotMatch(eventsJsonl, /self-check-rejected/);
      assertNoPrivateLeak(fullJson);
      assertNoPrivateLeak(compactJson);
      assertNoPrivateLeak(eventsJsonl);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
      await rm(exportRoot, { recursive: true, force: true });
    }
  });
});

function sqliteGcovPublicTrace(): TaskEvent[] {
  const taskRunId = TASK_RUN_ID;
  const attemptId = ATTEMPT_ID;
  return [
    { type: 'task_run_created', id: 'p1d-001', taskRunId, ts: 1, taskId: 'terminal-bench-sample@2.0/sqlite-with-gcov', configId: 'deepseek-v4-pro-heavy-task' },
    { type: 'task_run_started', id: 'p1d-002', taskRunId, ts: 2, startedAt: 2, sessionId: 'session-sqlite-gcov', agentRunId: 'agent-run-sqlite-gcov' },
    { type: 'task_attempt_started', id: 'p1d-003', taskRunId, ts: 3, attemptId, startedAt: 3, sessionId: 'session-sqlite-gcov', agentRunId: 'agent-run-sqlite-gcov' },
    {
      type: 'isolation_policy_recorded',
      id: 'p1d-004',
      taskRunId,
      ts: 4,
      facts: {
        schemaVersion: 1,
        backendKind: 'harbor',
        required: true,
        mode: 'external',
        label: 'Terminal-Bench Harbor container',
        assertionSource: 'ci',
        validatedAt: 4,
      },
    },
    {
      type: 'heavy_task_mode_recorded',
      id: 'p1d-005',
      taskRunId,
      ts: 5,
      facts: {
        schemaVersion: 1,
        enabled: true,
        triggerSource: 'config',
        triggerReason: 'P1-d public synthetic trace over sqlite-with-gcov',
        policyVersion: 'maka-heavy-task-policy.v1',
      },
    },
    {
      type: 'feedback_observed',
      id: 'p1d-006',
      taskRunId,
      ts: 6,
      observation: {
        id: 'feedback-runtime-sqlite-gcov',
        taskRunId,
        attemptId,
        ts: 6,
        source: 'runtime',
        summary: 'Harbor task-run bridge started the public sqlite-with-gcov task.',
        details: { runtimeRefs: { runtimeEventIds: ['runtime-sqlite-gcov-1'] }, budget: { maxSteps: 100 } },
      },
    },
    inventoryEvent(),
    todosEvent('p1d-008', 8, 'todos-sqlite-gcov-1', [
      { id: 'inspect-public-files', content: 'Inspect public task files and build scripts', status: 'in_progress', priority: 'high' },
      { id: 'configure-gcov', content: 'Enable gcov instrumentation in the public SQLite build', status: 'pending', priority: 'high' },
      { id: 'verify-gcov', content: 'Run public gcov-targeted checks', status: 'pending', priority: 'high' },
    ]),
    evidenceEvent('p1d-009', 9, 'e-read-public-task', 'Read', {
      inputSummary: { path: 'task.yaml' },
      stream: 'content',
      excerpt: 'Public task requires SQLite to build with gcov coverage files available after tests.',
      links: { todoIds: ['inspect-public-files'] },
    }),
    engineeringEvent(hypothesisRecord()),
    todosEvent('p1d-011', 11, 'todos-sqlite-gcov-2', [
      { id: 'inspect-public-files', content: 'Inspect public task files and build scripts', status: 'completed', priority: 'high', evidence: 'task.yaml and build scripts inspected.' },
      { id: 'configure-gcov', content: 'Enable gcov instrumentation in the public SQLite build', status: 'in_progress', priority: 'high' },
      { id: 'verify-gcov', content: 'Run public gcov-targeted checks', status: 'pending', priority: 'high' },
    ]),
    evidenceEvent('p1d-012', 12, 'e-check-gcov-initial', 'Bash', {
      inputSummary: { command: 'make test && gcov sqlite3.c' },
      exitCode: 1,
      ok: false,
      stream: 'stdout',
      excerpt: 'gcov reported that sqlite3.gcda was not created by the public build.',
      links: { todoIds: ['verify-gcov'], checkIds: ['check-gcov-initial'] },
    }),
    engineeringEvent(targetedCheckRecord({
      recordId: 'record-check-gcov-initial',
      checkId: 'check-gcov-initial',
      ts: 13,
      status: 'failed',
      result: 'fail',
      evidenceIds: ['e-check-gcov-initial'],
      observedSignal: 'sqlite3.gcda was missing after the public test run.',
    })),
    todosEvent('p1d-014', 14, 'todos-sqlite-gcov-3', [
      { id: 'inspect-public-files', content: 'Inspect public task files and build scripts', status: 'completed', priority: 'high', evidence: 'task.yaml and build scripts inspected.' },
      { id: 'configure-gcov', content: 'Enable gcov instrumentation in the public SQLite build', status: 'completed', priority: 'high', evidence: 'Public build flags were patched for coverage.' },
      { id: 'verify-gcov', content: 'Run public gcov-targeted checks', status: 'in_progress', priority: 'high' },
    ]),
    evidenceEvent('p1d-015', 15, 'e-edit-gcov-flags', 'Edit', {
      inputSummary: { path: 'Makefile.in' },
      stream: 'diff',
      excerpt: 'Added coverage flags to the public SQLite build configuration.',
      diffFiles: [{ path: 'Makefile.in', additions: 2, deletions: 0 }],
      links: { todoIds: ['configure-gcov'], artifactIds: ['patch-gcov-flags'] },
    }),
    engineeringEvent(repairRecord()),
    engineeringEvent(patchRecord()),
    evidenceEvent('p1d-018', 18, 'e-check-gcov-final', 'Bash', {
      inputSummary: { command: 'make test && gcov sqlite3.c' },
      exitCode: 0,
      ok: true,
      stream: 'stdout',
      excerpt: 'Public check generated sqlite3.c.gcov and exited successfully.',
      links: { todoIds: ['verify-gcov'], checkIds: ['check-gcov-final'] },
    }),
    engineeringEvent(targetedCheckRecord({
      recordId: 'record-check-gcov-final',
      checkId: 'check-gcov-final',
      ts: 19,
      status: 'passed',
      result: 'pass',
      evidenceIds: ['e-check-gcov-final'],
      observedSignal: 'sqlite3.c.gcov was generated and the public check exited zero.',
    })),
    todosEvent('p1d-020', 20, 'todos-sqlite-gcov-4', [
      { id: 'inspect-public-files', content: 'Inspect public task files and build scripts', status: 'completed', priority: 'high', evidence: 'task.yaml and build scripts inspected.' },
      { id: 'configure-gcov', content: 'Enable gcov instrumentation in the public SQLite build', status: 'completed', priority: 'high', evidence: 'record-patch-gcov-flags linked the public source mutation.' },
      { id: 'verify-gcov', content: 'Run public gcov-targeted checks', status: 'completed', priority: 'high', evidence: 'check-gcov-final passed with public command evidence.' },
    ]),
    selfCheckEvent('p1d-021', 21, 'self-check-public-pass', 'pass', 'Public build and gcov checks passed after the repair.'),
    selfCheckEvent('p1d-022', 22, 'self-check-rejected', 'fail', 'hidden private evaluator-only output should not be exported.', false),
    {
      type: 'task_run_artifact_recorded',
      id: 'p1d-023',
      taskRunId,
      ts: 23,
      artifact: {
        schemaVersion: 1,
        artifactId: 'artifact-workspace',
        taskRunId,
        attemptId,
        ts: 23,
        kind: 'container_workspace',
        workspacePath: '/workspace/sqlite-with-gcov',
        authority: { source: 'container_capture', authoritative: true },
      },
    },
    {
      type: 'task_run_artifact_recorded',
      id: 'p1d-024',
      taskRunId,
      ts: 24,
      artifact: {
        schemaVersion: 1,
        artifactId: 'artifact-diff',
        taskRunId,
        attemptId,
        ts: 24,
        kind: 'workspace_diff',
        path: '/logs/submission.diff',
        workspacePath: '/workspace/sqlite-with-gcov',
        authority: { source: 'container_capture', authoritative: true },
      },
    },
    {
      type: 'verifier_result_recorded',
      id: 'p1d-025',
      taskRunId,
      ts: 25,
      result: {
        id: 'verifier-sqlite-gcov',
        taskRunId,
        attemptId,
        ts: 25,
        kind: 'terminal_bench',
        passed: false,
        exitCode: 1,
        errorClass: 'verification_failed',
        authority: { source: 'official_harbor_verifier', authoritative: true },
        details: { dataset: 'terminal-bench-sample@2.0', taskName: 'sqlite-with-gcov' },
      },
    },
    {
      type: 'score_result_recorded',
      id: 'p1d-026',
      taskRunId,
      ts: 26,
      result: {
        id: 'score-sqlite-gcov',
        taskRunId,
        attemptId,
        ts: 26,
        passed: false,
        scored: true,
        eligible: true,
        score: 0,
        maxScore: 1,
        taxonomy: 'verification_failed',
        errorClass: 'verification_failed',
        authority: { source: 'official_harbor_verifier', authoritative: true },
        details: { runtimeRefs: { runtimeEventIds: ['runtime-sqlite-gcov-1'] } },
      },
    },
    { type: 'task_attempt_completed', id: 'p1d-027', taskRunId, ts: 27, attemptId, finishedAt: 27, status: 'budget_exhausted', error: { message: 'runtime step cap reached after public repair evidence was recorded', class: 'max_steps' } },
    { type: 'task_run_budget_exhausted', id: 'p1d-028', taskRunId, ts: 28, finishedAt: 28, error: { message: 'runtime step cap reached after public repair evidence was recorded', class: 'max_steps' } },
  ];
}

function inventoryEvent(): TaskEvent {
  return {
    type: 'heavy_task_inventory_recorded',
    id: 'p1d-007',
    taskRunId: TASK_RUN_ID,
    ts: 7,
    inventory: {
      schemaVersion: 1,
      inventoryId: 'inventory-sqlite-gcov-1',
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      ts: 7,
      summary: 'Inspected the public sqlite-with-gcov task surface before planning edits.',
      items: [
        { path: 'task.yaml', kind: 'file', status: 'observed', purpose: 'Public benchmark instruction.' },
        { path: 'Makefile.in', kind: 'file', status: 'planned', purpose: 'Candidate public build configuration.' },
        { path: 'test/', kind: 'directory', status: 'observed', purpose: 'Public SQLite test directory.' },
      ],
      source: source('tool-inventory'),
    },
  };
}

function todosEvent(id: string, ts: number, todoSetId: string, items: HeavyTaskTodoItem[]): TaskEvent {
  return {
    type: 'heavy_task_todos_recorded',
    id,
    taskRunId: TASK_RUN_ID,
    ts,
    todos: {
      schemaVersion: 1,
      todoSetId,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      ts,
      items,
      source: source(`tool-${todoSetId}`),
    },
  };
}

function evidenceEvent(
  id: string,
  ts: number,
  evidenceId: string,
  toolName: 'Bash' | 'Read' | 'Edit',
  options: {
    inputSummary: Record<string, unknown>;
    stream: 'stdout' | 'content' | 'diff';
    excerpt: string;
    exitCode?: number;
    ok?: boolean;
    diffFiles?: Array<{ path: string; additions?: number; deletions?: number }>;
    links: { todoIds?: string[]; checkIds?: string[]; artifactIds?: string[] };
  },
): TaskEvent {
  return {
    type: 'heavy_task_evidence_recorded',
    id,
    taskRunId: TASK_RUN_ID,
    ts,
    evidence: {
      schemaVersion: 1,
      evidenceId,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      ts,
      kind: 'tool',
      public: true,
      source: { ...source(`tool-${evidenceId}`), toolName },
      tool: {
        name: toolName,
        inputSummary: options.inputSummary,
        ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
        ...(options.ok !== undefined ? { ok: options.ok } : {}),
        outputs: [{
          stream: options.stream,
          excerpt: options.excerpt,
          lineCount: 1,
          byteCount: options.excerpt.length,
          truncated: false,
          truncationRef: { truncated: false, originalBytes: options.excerpt.length, visibleBytes: options.excerpt.length, omittedBytes: 0 },
        }],
        diff: options.stream === 'diff'
          ? { status: 'present', files: options.diffFiles ?? [], excerpt: options.excerpt }
          : { status: 'not_applicable' },
      },
      links: options.links,
    },
  };
}

function engineeringEvent(record: HeavyTaskEngineeringRecord): TaskEvent {
  return {
    type: 'heavy_task_engineering_recorded',
    id: `event-${record.recordId}`,
    taskRunId: TASK_RUN_ID,
    ts: record.ts,
    record,
  };
}

function hypothesisRecord(): HeavyTaskEngineeringRecord {
  return baseEngineeringRecord({
    recordId: 'record-hypothesis-gcov-flags',
    ts: 10,
    kind: 'hypothesis',
    title: 'Coverage flags are missing from the public build',
    summary: 'The public build likely omits coverage flags, so gcov has no data files to read.',
    status: 'proposed',
    evidenceIds: ['e-read-public-task'],
    todoIds: ['configure-gcov'],
    hypothesisIds: ['hypothesis-gcov-flags'],
    hypothesis: {
      expectedSignal: 'A public gcov command should fail before coverage flags are added.',
      rationaleEvidenceIds: ['e-read-public-task'],
    },
  });
}

function targetedCheckRecord(input: {
  recordId: string;
  checkId: string;
  ts: number;
  status: HeavyTaskEngineeringRecord['status'];
  result: 'pass' | 'fail';
  evidenceIds: string[];
  observedSignal: string;
}): HeavyTaskEngineeringRecord {
  return baseEngineeringRecord({
    recordId: input.recordId,
    ts: input.ts,
    kind: 'targeted_check',
    title: 'Run public gcov targeted check',
    summary: input.observedSignal,
    status: input.status,
    evidenceIds: input.evidenceIds,
    todoIds: ['verify-gcov'],
    checkIds: [input.checkId],
    targetedCheck: {
      checkId: input.checkId,
      command: 'make test && gcov sqlite3.c',
      expectedSignal: 'The public command should produce gcov output.',
      observedSignal: input.observedSignal,
      result: input.result,
    },
  });
}

function repairRecord(): HeavyTaskEngineeringRecord {
  return baseEngineeringRecord({
    recordId: 'record-repair-gcov-flags',
    ts: 16,
    kind: 'repair',
    title: 'Repair public build coverage flags',
    summary: 'Added coverage flags and linked the repair to the failed public gcov check.',
    status: 'repaired',
    evidenceIds: ['e-edit-gcov-flags'],
    todoIds: ['configure-gcov', 'verify-gcov'],
    checkIds: ['check-gcov-initial'],
    changedFiles: ['Makefile.in'],
    repairIds: ['repair-gcov-flags'],
    repair: {
      failedCheckIds: ['check-gcov-initial'],
      hypothesisId: 'hypothesis-gcov-flags',
      repairStrategy: 'Enable coverage instrumentation in the public SQLite build configuration.',
      outcome: 'check_passed',
    },
  });
}

function patchRecord(): HeavyTaskEngineeringRecord {
  return baseEngineeringRecord({
    recordId: 'record-patch-gcov-flags',
    ts: 17,
    kind: 'patch',
    title: 'Record public coverage patch',
    summary: 'Recorded the public source mutation that enabled gcov data generation.',
    status: 'passed',
    evidenceIds: ['e-edit-gcov-flags'],
    todoIds: ['configure-gcov'],
    changedFiles: ['Makefile.in'],
    patchIds: ['patch-gcov-flags'],
    patch: {
      patchId: 'patch-gcov-flags',
      changedFiles: ['Makefile.in'],
      changeSummary: 'Added coverage flags to the public SQLite build.',
      mutationEvidenceIds: ['e-edit-gcov-flags'],
    },
  });
}

function baseEngineeringRecord(input: {
  recordId: string;
  ts: number;
  kind: HeavyTaskEngineeringRecord['kind'];
  title: string;
  summary: string;
  status: HeavyTaskEngineeringRecord['status'];
  todoIds?: string[];
  evidenceIds?: string[];
  checkIds?: string[];
  changedFiles?: string[];
  patchIds?: string[];
  hypothesisIds?: string[];
  repairIds?: string[];
  hypothesis?: HeavyTaskEngineeringRecord['hypothesis'];
  targetedCheck?: HeavyTaskEngineeringRecord['targetedCheck'];
  repair?: HeavyTaskEngineeringRecord['repair'];
  patch?: HeavyTaskEngineeringRecord['patch'];
}): HeavyTaskEngineeringRecord {
  return {
    schemaVersion: 1,
    recordId: input.recordId,
    taskRunId: TASK_RUN_ID,
    attemptId: ATTEMPT_ID,
    ts: input.ts,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    status: input.status,
    completeness: 'complete',
    source: {
      ...source(`tool-${input.recordId}`),
      toolName: input.kind === 'targeted_check' ? 'check_record' : 'engineering_record',
    },
    links: {
      todoIds: input.todoIds ?? [],
      evidenceIds: input.evidenceIds ?? [],
      toolCallIds: [`tool-${input.recordId}`],
      checkIds: input.checkIds ?? [],
      artifactIds: [],
      changedFiles: input.changedFiles ?? [],
      patchIds: input.patchIds ?? [],
      hypothesisIds: input.hypothesisIds ?? [],
      repairIds: input.repairIds ?? [],
    },
    ...(input.hypothesis ? { hypothesis: input.hypothesis } : {}),
    ...(input.targetedCheck ? { targetedCheck: input.targetedCheck } : {}),
    ...(input.repair ? { repair: input.repair } : {}),
    ...(input.patch ? { patch: input.patch } : {}),
  };
}

function selfCheckEvent(
  id: string,
  ts: number,
  selfCheckId: string,
  status: HeavyTaskSelfCheckStatus,
  publicReason: string,
  accepted = true,
): TaskEvent {
  return {
    type: 'heavy_task_self_check_recorded',
    id,
    taskRunId: TASK_RUN_ID,
    ts,
    selfCheck: {
      schemaVersion: 1,
      selfCheckId,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      ts,
      status,
      publicReason,
      commandEvidence: [{ command: 'make test && gcov sqlite3.c', exitCode: status === 'pass' ? 0 : 1, outputExcerpt: publicReason }],
      artifactEvidence: [{ path: accepted ? 'sqlite3.c.gcov' : 'hidden/private/evaluator-only.txt', kind: 'log', exists: true }],
      guard: accepted
        ? {
            status: 'accepted',
            checkedAt: ts,
            categories: [],
            publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
          }
        : {
            status: 'rejected',
            checkedAt: ts,
            categories: ['forbidden_source'],
            publicReason: 'Rejected because the submitted evidence referenced non-public material.',
          },
      source: source(`tool-${selfCheckId}`),
    } as unknown as HeavyTaskSemanticSelfCheckState,
  };
}

function source(toolCallId: string): { kind: 'model_tool'; toolCallId: string; sessionId: string; turnId: string } {
  return { kind: 'model_tool', toolCallId, sessionId: 'session-sqlite-gcov', turnId: 'turn-sqlite-gcov' };
}

function assertNoPrivateLeak(content: string): void {
  assert.doesNotMatch(content, /hidden|private|evaluator-only|forbidden-source|official-verifier-output/);
}

function assertPublicChecksPrecedeFinalSelfCheck(events: TaskEvent[]): void {
  const finalSelfCheckIndex = events.findIndex(
    (event) => event.type === 'heavy_task_self_check_recorded'
      && event.selfCheck.selfCheckId === 'self-check-public-pass',
  );
  assert.ok(finalSelfCheckIndex > 0, 'expected final accepted public self-check event');

  const priorCheckRecords = events.slice(0, finalSelfCheckIndex).filter(
    (event) => event.type === 'heavy_task_engineering_recorded'
      && event.record.kind === 'targeted_check'
      && event.record.source.toolName === 'check_record',
  );

  assert.equal(priorCheckRecords.length, 2);
}
