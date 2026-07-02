import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateHeavyTaskSelfCheckGate } from '../heavy-task-self-check-gate.js';
import type { Task } from '../contracts.js';
import type { HeavyTaskModeFacts, HeavyTaskSemanticSelfCheckState, HeavyTaskTodoItem, TaskEvent } from '../task-contracts.js';
import { projectTaskRun } from '../task-run-store.js';

const heavyTaskMode: HeavyTaskModeFacts = {
  schemaVersion: 1,
  enabled: true,
  triggerSource: 'config',
  triggerReason: 'long public task',
  policyVersion: 'maka-heavy-task-policy.v1',
};

const task: Task = {
  id: 'gate-task',
  instruction: 'Create /app/move.txt and /app/report.jsonl.',
  workspaceDir: '/tmp/workspace',
  verification: { command: 'test -f /app/move.txt', protectedPaths: [] },
};

describe('heavy-task self-check gate', () => {
  test('missing self-check returns a bounded repair prompt', () => {
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(),
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /missing accepted public self-check/);
    assert.match(decision.action === 'repair_prompt' ? decision.prompt : '', /not accepted for heavy-task finalization/);
    assert.ok(decision.checklist.some((check) => check.path === '/app/move.txt'));
    assert.ok(decision.checklist.some((check) => check.path === '/app/report.jsonl' && check.kind === 'artifact_parse'));
  });

  test('fail and inconclusive self-checks return repair prompts', () => {
    for (const status of ['fail', 'inconclusive'] as const) {
      const decision = evaluateHeavyTaskSelfCheckGate({
        task,
        heavyTaskMode,
        projection: projection(selfCheck(status, { command: 'test -f /app/move.txt', refs: ['/app/move.txt'] })),
      });

      assert.equal(decision.action, 'repair_prompt');
      assert.match(decision.reason, new RegExp(`latest self-check status is ${status}`));
    }
  });

  test('pass without sandbox or workspace guard stays blocked', () => {
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(selfCheck('pass', {
        command: 'test -f /app/move.txt',
        refs: ['/app/move.txt'],
        omitExecutionHygiene: true,
      })),
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /missing sandbox execution evidence/);
  });

  test('pass with sandbox, workspace guard, command evidence, and visible artifact evidence can finalize', () => {
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(selfCheck('pass', {
        command: 'test -f /app/move.txt && python - <<PY\nimport json\nPY',
        refs: ['/app/move.txt', '/app/report.jsonl'],
      })),
    });

    assert.equal(decision.action, 'allow_finalize');
    assert.equal(decision.action === 'allow_finalize' ? decision.selfCheckId : undefined, 'self-check-1');
  });

  test('weak pass without command or artifact evidence stays blocked', () => {
    const weak = {
      ...selfCheck('pass', { command: 'test -f /app/move.txt', refs: ['/app/move.txt'] }),
      commandEvidence: [],
      artifactEvidence: [],
    };
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(weak),
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /lacks concrete command or artifact evidence/);
  });

  test('visible required artifact with unrelated evidence stays blocked', () => {
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(selfCheck('pass', {
        command: 'npm test',
        refs: ['README.md'],
        artifactPath: 'README.md',
      })),
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /does not address visible required artifact contract/);
  });

  test('after the bounded repair attempt, the gate allows official verifier to proceed', () => {
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(),
      repairAttemptsUsed: 1,
      maxRepairAttempts: 1,
    });

    assert.equal(decision.action, 'allow_official_verifier_after_bounded_attempt');
    assert.match(decision.reason, /missing accepted public self-check/);
  });
});

function projection(selfCheckState?: HeavyTaskSemanticSelfCheckState) {
  const taskRunId = 'run-gate';
  const events: TaskEvent[] = [
    { type: 'task_run_created', id: 'e1', taskRunId, ts: 1, taskId: task.id, configId: 'cfg' },
    { type: 'heavy_task_mode_recorded', id: 'e2', taskRunId, ts: 2, facts: heavyTaskMode },
    {
      type: 'heavy_task_todos_recorded',
      id: 'e3',
      taskRunId,
      ts: 3,
      todos: {
        schemaVersion: 1,
        todoSetId: 'todos-1',
        taskRunId,
        ts: 3,
        items: phaseGateTodos(),
        source: { kind: 'model_tool', toolCallId: 'tool-todos' },
      },
    },
  ];
  if (selfCheckState) {
    events.push({ type: 'heavy_task_self_check_recorded', id: 'e4', taskRunId, ts: 4, selfCheck: selfCheckState });
  }
  return projectTaskRun(events, taskRunId);
}

function phaseGateTodos(): HeavyTaskTodoItem[] {
  return [
    { id: 'artifact', kind: 'runnable_artifact', content: 'Create /app/move.txt', status: 'completed', priority: 'high' },
    { id: 'check', kind: 'public_check', content: 'Run public check', status: 'completed', priority: 'high' },
  ];
}

function selfCheck(
  status: HeavyTaskSemanticSelfCheckState['status'],
  options: {
    command: string;
    refs: string[];
    artifactPath?: string;
    executionHygiene?: HeavyTaskSemanticSelfCheckState['executionHygiene'];
    omitExecutionHygiene?: boolean;
  },
): HeavyTaskSemanticSelfCheckState {
  return {
    schemaVersion: 1,
    selfCheckId: 'self-check-1',
    taskRunId: 'run-gate',
    ts: 4,
    status,
    publicReason: `${options.command} used public task evidence.`,
    commandEvidence: [{ command: options.command, exitCode: status === 'pass' ? 0 : 1, outputExcerpt: 'public check output', artifactRefs: options.refs }],
    artifactEvidence: [{ path: options.artifactPath ?? options.refs[0] ?? '/app/move.txt', kind: 'file', exists: true }],
    ...(options.omitExecutionHygiene ? {} : { executionHygiene: options.executionHygiene ?? {
      sandbox: {
        root: '/tmp/maka-self-check/run-gate',
        strategy: 'scratch_dir',
        commandCwd: '/tmp/maka-self-check/run-gate',
        outputPolicy: 'scratch_only',
      },
      scratchUsed: true,
      scratchPath: '/tmp/maka-self-check/run-gate',
      cleanupPerformed: true,
      workspaceSideEffects: 'none',
      workspaceGuard: {
        checked: true,
        checkedPaths: ['/app'],
        addedPaths: [],
        modifiedPaths: [],
        removedPaths: [],
      },
    } }),
    guard: {
      status: 'accepted',
      checkedAt: 4,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
    },
    source: { kind: 'model_tool', toolCallId: 'tool-self-check' },
  };
}
