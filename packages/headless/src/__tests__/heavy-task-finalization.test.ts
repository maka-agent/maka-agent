import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateHeavyTaskCompletionStatus } from '../heavy-task-finalization.js';
import type {
  HeavyTaskModeFacts,
  HeavyTaskSelfCheckPlanState,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskSelfCheckStatus,
  HeavyTaskTodoItem,
  HeavyTaskTodoState,
  TaskRunStatus,
} from '../task-contracts.js';

const heavyTaskMode: HeavyTaskModeFacts = {
  schemaVersion: 1,
  enabled: true,
  triggerSource: 'config',
  triggerReason: 'long public task',
  policyVersion: 'maka-heavy-task-policy.v1',
};

describe('heavy-task finalization status', () => {
  test('marks semantic complete with accepted pass self-check and completed todos', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheckPlan: selfCheckPlan(),
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: phaseGateTodos([{ id: 'edit', status: 'completed' }]),
    });

    assert.equal(status.runtime.capLike, true);
    assert.equal(status.runtime.capKind, 'budget_exhausted');
    assert.equal(status.semantic.status, 'complete');
    assert.equal(status.semantic.advisory, true);
    assert.deepEqual(status.semantic.unresolvedTodoIds, []);
    assert.equal(status.finalization.eligible, true);
    assert.equal(status.finalization.boundedTurnImplemented, false);
  });

  test('treats cancelled todos with evidence as nonblocking', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'incomplete',
      taxonomy: 'agent_incomplete',
      heavyTaskMode,
      latestHeavyTaskSelfCheckPlan: selfCheckPlan(),
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: phaseGateTodos([
        { id: 'implemented', status: 'completed' },
        {
          id: 'optional-polish',
          status: 'cancelled',
          evidence: 'Out of scope after public README review.',
        },
      ]),
    });

    assert.equal(status.semantic.status, 'complete');
    assert.deepEqual(status.semantic.nonblockingTodoIds, ['optional-polish']);
    assert.deepEqual(status.semantic.unresolvedTodoIds, []);
    assert.equal(status.finalization.eligible, true);
  });

  test('requires accepted public pass self-check evidence', () => {
    const cases = [
      { name: 'missing self-check', selfCheck: undefined },
      {
        name: 'rejected self-check',
        selfCheck: selfCheck('pass', {
          guardStatus: 'rejected',
        }) as unknown as HeavyTaskSemanticSelfCheckState,
      },
      {
        name: 'private payload replay',
        selfCheck: selfCheck('pass', { publicReason: 'hidden/tests/private_case.py passed.' }),
      },
      { name: 'failed self-check', selfCheck: selfCheck('fail') },
      { name: 'inconclusive self-check', selfCheck: selfCheck('inconclusive') },
    ];

    for (const item of cases) {
      const status = evaluateHeavyTaskCompletionStatus({
        status: 'budget_exhausted',
        taxonomy: 'budget_exhausted',
        heavyTaskMode,
        latestHeavyTaskSelfCheck: item.selfCheck,
        latestHeavyTaskTodos: phaseGateTodos([{ id: 'edit', status: 'completed' }]),
      });

      assert.equal(status.semantic.status, 'incomplete', item.name);
      assert.equal(status.finalization.eligible, false, item.name);
    }
  });

  test('does not treat a pass self-check with uncleaned workspace delta as semantic complete', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass', {
        executionHygiene: {
          sandbox: {
            root: '/tmp/maka-self-check/run-1',
            strategy: 'scratch_dir',
            commandCwd: '/tmp/maka-self-check/run-1',
            outputPolicy: 'scratch_only',
          },
          scratchUsed: false,
          cleanupPerformed: false,
          workspaceSideEffects: 'present',
          remainingSideEffectPaths: ['/app/polyglot/cmain'],
          workspaceGuard: {
            checked: true,
            checkedPaths: ['/app/polyglot'],
            addedPaths: ['/app/polyglot/cmain'],
            modifiedPaths: [],
            removedPaths: [],
          },
        },
      }),
      latestHeavyTaskTodos: phaseGateTodos([{ id: 'edit', status: 'completed' }]),
    });

    assert.equal(status.semantic.status, 'incomplete');
    assert.match(status.semantic.reason ?? '', /uncleaned workspace side effects/);
    assert.equal(status.finalization.eligible, false);
  });

  test('requires sandbox execution evidence for pass self-check semantic completion', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass', {
        executionHygiene: {
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
      }),
      latestHeavyTaskTodos: phaseGateTodos([{ id: 'edit', status: 'completed' }]),
    });

    assert.equal(status.semantic.status, 'incomplete');
    assert.match(status.semantic.reason ?? '', /missing sandbox execution evidence/);
    assert.equal(status.finalization.eligible, false);
  });

  test('requires non-empty latest todos with no unresolved work', () => {
    const cases = [
      { name: 'missing todos', todos: undefined, unresolved: [] },
      { name: 'empty todos', todos: todos([]), unresolved: [] },
      {
        name: 'pending todo',
        todos: phaseGateTodos([{ id: 'inspect', status: 'pending' }]),
        unresolved: ['inspect'],
      },
      {
        name: 'in-progress todo',
        todos: phaseGateTodos([{ id: 'edit', status: 'in_progress' }]),
        unresolved: ['edit'],
      },
      {
        name: 'cancelled without evidence',
        todos: phaseGateTodos([{ id: 'optional', status: 'cancelled' }]),
        unresolved: ['optional'],
      },
      {
        name: 'unknown future status',
        todos: phaseGateTodos([{ id: 'future', status: 'blocked' as HeavyTaskTodoItem['status'] }]),
        unresolved: ['future'],
      },
    ];

    for (const item of cases) {
      const status = evaluateHeavyTaskCompletionStatus({
        status: 'budget_exhausted',
        taxonomy: 'budget_exhausted',
        heavyTaskMode,
        latestHeavyTaskSelfCheckPlan: selfCheckPlan(),
        latestHeavyTaskSelfCheck: selfCheck('pass'),
        latestHeavyTaskTodos: item.todos,
      });

      assert.equal(status.semantic.status, 'incomplete', item.name);
      assert.deepEqual(status.semantic.unresolvedTodoIds, item.unresolved, item.name);
      assert.equal(status.finalization.eligible, false, item.name);
    }
  });

  test('requires completed early runnable and public check phase-gate todos', () => {
    const cases = [
      {
        name: 'missing both gate kinds',
        todos: todos([
          { id: 'edit', content: 'Patch implementation', status: 'completed', priority: 'high' },
        ]),
        reason: /runnable_artifact, public_check/,
      },
      {
        name: 'missing public check',
        todos: todos([
          {
            id: 'artifact',
            kind: 'runnable_artifact',
            content: 'Create runnable artifact',
            status: 'completed',
            priority: 'high',
          },
        ]),
        reason: /public_check/,
      },
      {
        name: 'public check still pending',
        todos: todos([
          {
            id: 'artifact',
            kind: 'runnable_artifact',
            content: 'Create runnable artifact',
            status: 'completed',
            priority: 'high',
          },
          {
            id: 'check',
            kind: 'public_check',
            content: 'Run public check',
            status: 'pending',
            priority: 'high',
          },
        ]),
        reason: /unresolved work/,
      },
    ];

    for (const item of cases) {
      const status = evaluateHeavyTaskCompletionStatus({
        status: 'budget_exhausted',
        taxonomy: 'budget_exhausted',
        heavyTaskMode,
        latestHeavyTaskSelfCheckPlan: selfCheckPlan(),
        latestHeavyTaskSelfCheck: selfCheck('pass'),
        latestHeavyTaskTodos: item.todos,
      });

      assert.equal(status.semantic.status, 'incomplete', item.name);
      assert.match(status.semantic.reason, item.reason, item.name);
      assert.equal(status.finalization.eligible, false, item.name);
    }
  });

  test('classifies cap-like runtime outcomes without treating verifier failures as caps', () => {
    const capCases: Array<{
      name: string;
      status: TaskRunStatus;
      taxonomy?: string;
      errorClass?: string;
      message?: string;
      reason?: string;
      capKind: string;
    }> = [
      {
        name: 'budget exhausted',
        status: 'budget_exhausted',
        taxonomy: 'budget_exhausted',
        capKind: 'budget_exhausted',
      },
      {
        name: 'runtime step cap',
        status: 'failed',
        errorClass: 'max_steps',
        message: 'runtime step cap reached',
        capKind: 'runtime_step_cap',
      },
      {
        name: 'wall time cap',
        status: 'failed',
        message: 'wall time cap reached',
        capKind: 'wall_time_cap',
      },
      {
        name: 'max attempts',
        status: 'failed',
        reason: 'max attempts exhausted',
        capKind: 'max_attempts',
      },
      {
        name: 'legacy tool calls',
        status: 'incomplete',
        errorClass: 'incomplete_tool_calls',
        capKind: 'tool_call_step_cap',
      },
      {
        name: 'tool step cap',
        status: 'incomplete',
        errorClass: 'tool_step_cap_reached',
        capKind: 'tool_call_step_cap',
      },
      { name: 'max tokens', status: 'incomplete', errorClass: 'max_tokens', capKind: 'token_cap' },
      { name: 'timeout', status: 'failed', errorClass: 'timeout', capKind: 'timeout' },
    ];

    for (const item of capCases) {
      const status = evaluateHeavyTaskCompletionStatus({
        status: item.status,
        taxonomy: item.taxonomy,
        error:
          item.errorClass || item.message
            ? { class: item.errorClass, message: item.message ?? item.errorClass ?? '' }
            : undefined,
        decisions: item.reason
          ? [
              {
                id: `decision-${item.name}`,
                taskRunId: 'run-1',
                ts: 1,
                decision: 'stop',
                reason: item.reason,
              },
            ]
          : undefined,
        heavyTaskMode,
        latestHeavyTaskSelfCheckPlan: selfCheckPlan(),
        latestHeavyTaskSelfCheck: selfCheck('pass'),
        latestHeavyTaskTodos: phaseGateTodos([{ id: 'edit', status: 'completed' }]),
      });

      assert.equal(status.runtime.capLike, true, item.name);
      assert.equal(status.runtime.capKind, item.capKind, item.name);
      assert.equal(status.finalization.eligible, true, item.name);
    }

    const verifierFailure = evaluateHeavyTaskCompletionStatus({
      status: 'completed',
      taxonomy: 'verification_failed',
      heavyTaskMode,
      latestHeavyTaskSelfCheckPlan: selfCheckPlan(),
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: phaseGateTodos([{ id: 'edit', status: 'completed' }]),
    });
    assert.equal(verifierFailure.runtime.capLike, false);
    assert.equal(verifierFailure.runtime.capKind, 'none');
    assert.equal(verifierFailure.semantic.status, 'complete');
    assert.equal(verifierFailure.finalization.eligible, false);
  });
});

function selfCheck(
  status: HeavyTaskSelfCheckStatus,
  options: {
    guardStatus?: 'accepted' | 'rejected';
    publicReason?: string;
    executionHygiene?: HeavyTaskSemanticSelfCheckState['executionHygiene'];
  } = {},
): HeavyTaskSemanticSelfCheckState {
  return {
    schemaVersion: 1,
    selfCheckId: `self-check-${status}-${options.guardStatus ?? 'accepted'}`,
    taskRunId: 'run-1',
    ts: 2,
    status,
    publicReason: options.publicReason ?? 'npm test passed against public files.',
    commandEvidence: [{ command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' }],
    artifactEvidence: [{ path: 'build-output.log', kind: 'log', exists: true }],
    executionHygiene: options.executionHygiene ?? {
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
      status: options.guardStatus ?? 'accepted',
      checkedAt: 2,
      categories: options.guardStatus === 'rejected' ? ['official_verifier_artifacts'] : [],
      publicReason:
        options.guardStatus === 'rejected'
          ? 'Rejected because submitted evidence referenced private, hidden, or evaluator-only material.'
          : 'Accepted as public, task-derived advisory self-check evidence.',
    } as unknown as HeavyTaskSemanticSelfCheckState['guard'],
    source: { kind: 'model_tool', toolCallId: 'tool-self-check' },
  };
}

function selfCheckPlan(): HeavyTaskSelfCheckPlanState {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    taskRunId: 'run-1',
    ts: 1,
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
      publicReason: 'public guard checks visible workspace paths',
    },
    publicReason: 'plan is derived from visible public task evidence',
    guard: {
      status: 'accepted',
      checkedAt: 1,
      categories: [],
      publicReason: 'Accepted as public, task-derived advisory self-check plan.',
    },
    source: { kind: 'model_tool', toolCallId: 'tool-plan' },
  };
}

function phaseGateTodos(
  items: Array<{ id: string; status: HeavyTaskTodoItem['status']; evidence?: string }>,
): HeavyTaskTodoState {
  return todos([
    ...items.map((item) => ({
      id: item.id,
      content: `Work item ${item.id}`,
      status: item.status,
      priority: 'high' as const,
      ...(item.evidence ? { evidence: item.evidence } : {}),
    })),
    {
      id: 'artifact',
      kind: 'runnable_artifact' as const,
      content: 'Create first runnable artifact',
      status: 'completed' as const,
      priority: 'high' as const,
      evidence: 'Runnable artifact exists in public workspace.',
    },
    {
      id: 'check',
      kind: 'public_check' as const,
      content: 'Run public check',
      status: 'completed' as const,
      priority: 'high' as const,
      evidence: 'Public check command passed.',
    },
  ]);
}

function todos(items: HeavyTaskTodoItem[]): HeavyTaskTodoState {
  return {
    schemaVersion: 1,
    todoSetId: 'todos-1',
    taskRunId: 'run-1',
    ts: 3,
    items,
    source: { kind: 'model_tool', toolCallId: 'tool-todos' },
  };
}
