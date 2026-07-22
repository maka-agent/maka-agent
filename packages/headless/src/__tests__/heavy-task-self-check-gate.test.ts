import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateHeavyTaskSelfCheckGate } from '../heavy-task-self-check-gate.js';
import type { Task } from '../contracts.js';
import type {
  HeavyTaskModeFacts,
  HeavyTaskSelfCheckPlanState,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskTodoItem,
  HeavyTaskWorkspaceObservationState,
  TaskEvent,
} from '../task-contracts.js';
import { projectTaskRun } from '../task-run-projection.js';

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
      projection: projection(undefined, plan(['/app/move.txt', '/app/report.jsonl'])),
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /missing accepted public self-check/);
    assert.match(
      decision.action === 'repair_prompt' ? decision.prompt : '',
      /not accepted for heavy-task finalization/,
    );
    assert.ok(decision.checklist.some((check) => check.path === '/app/move.txt'));
    assert.ok(
      decision.checklist.some(
        (check) => check.path === '/app/report.jsonl' && check.kind === 'artifact_parse',
      ),
    );
  });

  test('does not derive required artifacts by parsing raw instruction text', () => {
    const polyglotTask: Task = {
      id: 'polyglot-task',
      instruction: 'Write me a single file in /app/polyglot/main.py.c which is a polyglot.',
      workspaceDir: '/tmp/workspace',
      verification: { command: 'true', protectedPaths: [] },
    };
    const decision = evaluateHeavyTaskSelfCheckGate({
      task: polyglotTask,
      heavyTaskMode,
      projection: projection(),
    });

    assert.ok(!decision.checklist.some((check) => check.kind === 'required_artifact'));
    assert.ok(!decision.checklist.some((check) => check.path === '/app/polyglot/main.py'));
  });

  test('fail and inconclusive self-checks return repair prompts', () => {
    for (const status of ['fail', 'inconclusive'] as const) {
      const decision = evaluateHeavyTaskSelfCheckGate({
        task,
        heavyTaskMode,
        projection: projection(
          selfCheck(status, { command: 'test -f /app/move.txt', refs: ['/app/move.txt'] }),
        ),
      });

      assert.equal(decision.action, 'repair_prompt');
      assert.match(decision.reason, new RegExp(`latest self-check status is ${status}`));
    }
  });

  test('pass without sandbox or workspace guard stays blocked', () => {
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(
        selfCheck('pass', {
          command: 'test -f /app/move.txt',
          refs: ['/app/move.txt'],
          omitExecutionHygiene: true,
        }),
      ),
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /missing sandbox execution evidence/);
  });

  test('pass with sandbox, workspace guard, command evidence, and visible artifact evidence can finalize', () => {
    const selfCheckState = selfCheck('pass', {
      command: 'test -f /app/move.txt && python - <<PY\nimport json\nPY',
      refs: ['/app/move.txt', '/app/report.jsonl'],
    });
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(selfCheckState, plan(['/app/move.txt', '/app/report.jsonl'])),
    });

    assert.equal(decision.action, 'allow_finalize');
    assert.equal(
      decision.action === 'allow_finalize' ? decision.selfCheckId : undefined,
      'self-check-1',
    );
  });

  test('pass self-check without a plan returns a plan diagnostic', () => {
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(
        selfCheck('pass', {
          command: 'test -f /app/move.txt && test -f /app/report.jsonl',
          refs: ['/app/move.txt', '/app/report.jsonl'],
        }),
      ),
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /missing_self_check_plan/);
    assert.match(decision.reason, /no accepted self_check_plan_submit/);
  });

  test('planned /app/move.txt addition is not a dirty workspace blocker', () => {
    const selfCheckState = selfCheck('pass', {
      command: 'test -f /app/move.txt && test -f /app/report.jsonl',
      refs: ['/app/move.txt', '/app/report.jsonl'],
      executionHygiene: {
        sandbox: {
          root: '/tmp/maka-self-check/run-gate',
          strategy: 'scratch_dir',
          commandCwd: '/tmp/maka-self-check/run-gate',
          outputPolicy: 'scratch_only',
        },
        scratchUsed: true,
        scratchPath: '/tmp/maka-self-check/run-gate',
        cleanupPerformed: true,
        workspaceSideEffects: 'present',
        workspaceGuard: {
          checked: true,
          checkedPaths: ['/app'],
          addedPaths: ['/app/move.txt'],
          modifiedPaths: [],
          removedPaths: [],
        },
      },
    });
    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(selfCheckState, plan(['/app/move.txt', '/app/report.jsonl'])),
    });

    assert.equal(decision.action, 'allow_finalize');
  });

  test('unplanned /app/polyglot/cmain yields scratch and unplanned risk diagnostics without repair instructions', () => {
    const selfCheckState = selfCheck('pass', {
      command: 'cc /app/polyglot/main.py.c -o /app/polyglot/cmain && test -f /app/move.txt',
      refs: ['/app/move.txt', '/app/report.jsonl'],
      artifactPath: '/app/polyglot/cmain',
      executionHygiene: {
        sandbox: {
          root: '/tmp/maka-self-check/run-gate',
          strategy: 'scratch_dir',
          commandCwd: '/tmp/maka-self-check/run-gate',
          outputPolicy: 'scratch_only',
        },
        scratchUsed: true,
        scratchPath: '/tmp/maka-self-check/run-gate',
        cleanupPerformed: true,
        workspaceSideEffects: 'present',
        workspaceGuard: {
          checked: true,
          checkedPaths: ['/app/polyglot'],
          addedPaths: ['/app/polyglot/cmain'],
          modifiedPaths: [],
          removedPaths: [],
        },
      },
    });

    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: projection(selfCheckState, plan(['/app/move.txt', '/app/report.jsonl'])),
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /unplanned_added_path/);
    assert.match(decision.reason, /scratch_escape/);
    assert.match(decision.reason, /\/app\/polyglot\/cmain/);
    assert.doesNotMatch(decision.reason, /fix|repair|rerun|submit a revised plan/i);
  });

  test('machine workspace observation facts do not block an otherwise passing self-check', () => {
    const polyglotTask: Task = {
      id: 'polyglot-task',
      instruction: 'Write me a single file in /app/polyglot/main.py.c which is a polyglot.',
      workspaceDir: '/tmp/workspace',
      verification: { command: 'true', protectedPaths: [] },
    };
    const selfCheckState = selfCheck('pass', {
      command: 'python3 /app/polyglot/main.py.c 10 && python3 /app/polyglot/main.py 10',
      refs: ['/app/polyglot/main.py.c', '/app/polyglot/main.py'],
      artifactPath: '/app/polyglot/main.py.c',
    });
    const decision = evaluateHeavyTaskSelfCheckGate({
      task: polyglotTask,
      heavyTaskMode,
      projection: projection(
        selfCheckState,
        plan(['/app/polyglot/main.py.c']),
        workspaceObservation([
          { path: '/app/polyglot/main.py.c', kind: 'file' },
          { path: '/app/polyglot/main.py', kind: 'symlink', symlinkTarget: 'main.py.c' },
        ]),
      ),
      repairAttemptsUsed: 0,
      maxRepairAttempts: 1,
    });

    assert.equal(decision.action, 'allow_finalize');
  });

  test('gate prompt includes neutral machine observation facts when blocked for a separate reason', () => {
    const polyglotTask: Task = {
      id: 'polyglot-task',
      instruction: 'Write me a single file in /app/polyglot/main.py.c which is a polyglot.',
      workspaceDir: '/tmp/workspace',
      verification: { command: 'true', protectedPaths: [] },
    };
    const revisedPlan = plan(['/app/polyglot/main.py.c']);
    revisedPlan.workspaceGuardPlan.expectedGeneratedPathsOutsideScratch = ['/app/polyglot/cmain'];
    const selfCheckState = selfCheck('pass', {
      command:
        'gcc /app/polyglot/main.py.c -o /tmp/maka-self-check/run-gate/cmain && /tmp/maka-self-check/run-gate/cmain 10',
      refs: ['/app/polyglot/main.py.c'],
      artifactPath: '/app/polyglot/main.py.c',
    });
    selfCheckState.commandEvidence = [];
    selfCheckState.artifactEvidence = [];

    const decision = evaluateHeavyTaskSelfCheckGate({
      task: polyglotTask,
      heavyTaskMode,
      projection: projection(
        selfCheckState,
        revisedPlan,
        workspaceObservation([
          { path: '/app/polyglot/main.py.c', kind: 'file' },
          { path: '/app/polyglot/cmain', kind: 'file' },
        ]),
      ),
      repairAttemptsUsed: 0,
      maxRepairAttempts: 1,
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /lacks concrete command or artifact evidence/);
    assert.match(decision.prompt, /Machine workspace observation facts/);
    assert.match(decision.prompt, /file \/app\/polyglot\/main\.py\.c/);
    assert.match(decision.prompt, /file \/app\/polyglot\/cmain/);
    assert.doesNotMatch(decision.reason, /expected only|observed extras|single-file deliverable/);
    assert.doesNotMatch(decision.prompt, /expected only|observed extras|single-file deliverable/);
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
      projection: projection(
        selfCheck('pass', {
          command: 'npm test',
          refs: ['README.md'],
          artifactPath: 'README.md',
        }),
        plan(['/app/move.txt', '/app/report.jsonl']),
      ),
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

  test('stale Self-check evidence requires bounded revalidation', () => {
    const gateProjection = projection(
      selfCheck('pass', {
        command: 'npm test',
        refs: ['/app/move.txt'],
      }),
      plan(['/app/move.txt']),
    );
    assert.ok(gateProjection.latestHeavyTaskSelfCheck);
    gateProjection.latestHeavyTaskSelfCheck.freshness = 'stale';
    gateProjection.latestHeavyTaskSelfCheck.freshnessReasons = ['workspace_revision_changed'];

    const decision = evaluateHeavyTaskSelfCheckGate({
      task,
      heavyTaskMode,
      projection: gateProjection,
    });

    assert.equal(decision.action, 'repair_prompt');
    assert.match(decision.reason, /self-check is stale: workspace_revision_changed/);
  });
});

function projection(
  selfCheckState?: HeavyTaskSemanticSelfCheckState,
  planState?: HeavyTaskSelfCheckPlanState,
  observation?: HeavyTaskWorkspaceObservationState,
) {
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
  if (planState) {
    events.push({
      type: 'heavy_task_self_check_plan_recorded',
      id: 'e4-plan',
      taskRunId,
      ts: 4,
      plan: planState,
    });
  }
  if (selfCheckState) {
    events.push({
      type: 'heavy_task_self_check_recorded',
      id: 'e4',
      taskRunId,
      ts: 4,
      selfCheck: selfCheckState,
    });
  }
  if (observation) {
    events.push({
      type: 'heavy_task_workspace_observation_recorded',
      id: 'e5-observation',
      taskRunId,
      ts: 5,
      observation,
    });
  }
  return projectTaskRun(events, taskRunId);
}

function workspaceObservation(
  entries: HeavyTaskWorkspaceObservationState['entries'],
): HeavyTaskWorkspaceObservationState {
  return {
    schemaVersion: 1,
    observationId: 'workspace-observation-1',
    taskRunId: 'run-gate',
    ts: 5,
    roots: ['/app/polyglot'],
    entries,
    status: 'ok',
    command: 'find /app/polyglot -mindepth 1 -maxdepth 1',
    source: { kind: 'system', label: 'unit test' },
  };
}

function plan(finalArtifacts: string[]): HeavyTaskSelfCheckPlanState {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    taskRunId: 'run-gate',
    ts: 3.5,
    finalArtifacts: finalArtifacts.map((path) => ({
      path,
      purpose: `visible deliverable ${path}`,
      publicReason: 'visible task instruction requires this artifact',
    })),
    selfCheckScratch: {
      root: '/tmp/maka-self-check/run-gate',
      expectedGeneratedPaths: ['/tmp/maka-self-check/run-gate/check.log'],
      publicReason: 'public check output stays under scratch',
    },
    workspaceGuardPlan: {
      checkedPaths: ['/app'],
      expectedAddedPaths: finalArtifacts,
      expectedGeneratedPathsOutsideScratch: [],
      publicReason: 'public guard checks visible deliverables',
    },
    publicReason: 'plan is derived from visible task artifacts and public checks',
    guard: {
      status: 'accepted',
      checkedAt: 3.5,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check plan.',
    },
    source: { kind: 'model_tool', toolCallId: 'tool-plan' },
  };
}

function phaseGateTodos(): HeavyTaskTodoItem[] {
  return [
    {
      id: 'artifact',
      kind: 'runnable_artifact',
      content: 'Create /app/move.txt',
      status: 'completed',
      priority: 'high',
    },
    {
      id: 'check',
      kind: 'public_check',
      content: 'Run public check',
      status: 'completed',
      priority: 'high',
    },
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
    commandEvidence: [
      {
        command: options.command,
        exitCode: status === 'pass' ? 0 : 1,
        outputExcerpt: 'public check output',
        artifactRefs: options.refs,
      },
    ],
    artifactEvidence: [
      {
        path: options.artifactPath ?? options.refs[0] ?? '/app/move.txt',
        kind: 'file',
        exists: true,
      },
    ],
    ...(options.omitExecutionHygiene
      ? {}
      : {
          executionHygiene: options.executionHygiene ?? {
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
          },
        }),
    guard: {
      status: 'accepted',
      checkedAt: 4,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
    },
    source: { kind: 'model_tool', toolCallId: 'tool-self-check' },
  };
}
