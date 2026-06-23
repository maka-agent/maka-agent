import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateHeavyTaskCompletionStatus } from '../heavy-task-finalization.js';
import type {
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskEngineeringRecord,
  HeavyTaskModeFacts,
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
  test('marks semantic complete only when the advisory evidence chain is complete', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [
        toolEvidence('e-check-pass', { todoIds: ['edit'], checkIds: ['check-pass'] }),
        toolEvidence('e-write', { todoIds: ['edit'], toolName: 'Write', diff: true }),
      ],
      heavyTaskEngineeringRecords: [
        checkRecord('record-check-pass', 'check-pass', 'pass', { todoIds: ['edit'], evidenceIds: ['e-check-pass'] }),
        patchRecord('record-patch', 'patch-1', { todoIds: ['edit'], evidenceIds: ['e-write'], changedFiles: ['src/app.js'] }),
      ],
    });

    assert.equal(status.runtime.capLike, true);
    assert.equal(status.runtime.capKind, 'budget_exhausted');
    assert.equal(status.semantic.status, 'complete');
    assert.equal(status.semantic.evidenceChain.outcome, 'complete');
    assert.deepEqual(status.semantic.unresolvedTodoIds, []);
    assert.equal(status.finalization.eligible, true);
    assert.equal(status.finalization.boundedTurnImplemented, false);

    const nonCapStatus = evaluateHeavyTaskCompletionStatus({
      status: 'completed',
      taxonomy: 'passed',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [toolEvidence('e-check-pass', { todoIds: ['edit'], checkIds: ['check-pass'] })],
      heavyTaskEngineeringRecords: [
        checkRecord('record-check-pass', 'check-pass', 'pass', { todoIds: ['edit'], evidenceIds: ['e-check-pass'] }),
      ],
    });
    assert.equal(nonCapStatus.semantic.evidenceChain.outcome, 'complete');
    assert.equal(nonCapStatus.finalization.eligible, false);
  });

  test('requires completed todos to have linked P1-a or P1-b support beyond self-check alone', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
    });

    assert.equal(status.semantic.status, 'incomplete');
    assert.equal(status.semantic.evidenceChain.outcome, 'missing');
    assert.deepEqual(status.semantic.evidenceChain.missingItemIds, ['todo:edit']);
    assert.equal(status.finalization.eligible, false);
  });

  test('standalone artifact compact evidence does not satisfy required completed todos', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [artifactEvidence('e-artifact-only', { todoIds: ['edit'], artifactId: 'artifact-frame' })],
    });

    assert.equal(status.semantic.status, 'incomplete');
    assert.equal(status.semantic.evidenceChain.outcome, 'missing');
    assert.deepEqual(status.semantic.evidenceChain.missingItemIds, ['todo:edit']);
    assert.equal(status.finalization.eligible, false);
  });

  test('official verifier artifact compact evidence is ignored for advisory finalization support', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [artifactEvidence('e-official-artifact', {
        todoIds: ['edit'],
        artifactId: 'artifact-official',
        authority: { source: 'official_harbor_verifier', authoritative: true },
      })],
    });

    assert.equal(status.semantic.status, 'incomplete');
    assert.equal(status.semantic.evidenceChain.outcome, 'missing');
    assert.deepEqual(status.semantic.evidenceChain.missingItemIds, ['todo:edit']);
    assert.equal(status.finalization.eligible, false);
  });

  test('failed targeted check linked to a required todo blocks eligibility', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [toolEvidence('e-check-fail', { todoIds: ['edit'], checkIds: ['check-fail'], ok: false })],
      heavyTaskEngineeringRecords: [
        checkRecord('record-check-fail', 'check-fail', 'fail', {
          todoIds: ['edit'],
          evidenceIds: ['e-check-fail'],
          status: 'failed',
        }),
      ],
    });

    assert.equal(status.semantic.evidenceChain.outcome, 'failed');
    assert.deepEqual(status.semantic.evidenceChain.failedItemIds, ['targeted_check:check-fail']);
    assert.equal(status.finalization.eligible, false);
  });

  test('failed targeted check repaired by later repair and passing check becomes complete', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass', { ts: 8 }),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [
        toolEvidence('e-check-fail', { todoIds: ['edit'], checkIds: ['check-fail'], ok: false }),
        toolEvidence('e-repair', { todoIds: ['edit'], checkIds: ['check-pass'] }),
      ],
      heavyTaskEngineeringRecords: [
        checkRecord('record-check-fail', 'check-fail', 'fail', {
          todoIds: ['edit'],
          evidenceIds: ['e-check-fail'],
          status: 'failed',
          ts: 3,
        }),
        repairRecord('record-repair', ['check-fail'], {
          todoIds: ['edit'],
          evidenceIds: ['e-repair'],
          changedFiles: ['src/app.js'],
          ts: 4,
        }),
        checkRecord('record-check-pass', 'check-pass', 'pass', {
          todoIds: ['edit'],
          evidenceIds: ['e-repair'],
          ts: 5,
        }),
      ],
    });

    assert.equal(status.semantic.evidenceChain.outcome, 'complete');
    assert.equal(status.semantic.status, 'complete');
    assert.equal(status.finalization.eligible, true);
  });

  test('inconclusive targeted checks and self-checks block required completion', () => {
    const targeted = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [toolEvidence('e-check', { todoIds: ['edit'], checkIds: ['check-inconclusive'] })],
      heavyTaskEngineeringRecords: [
        checkRecord('record-check', 'check-inconclusive', 'inconclusive', { todoIds: ['edit'], evidenceIds: ['e-check'] }),
      ],
    });
    assert.equal(targeted.semantic.evidenceChain.outcome, 'inconclusive');
    assert.deepEqual(targeted.semantic.evidenceChain.inconclusiveItemIds, ['targeted_check:check-inconclusive']);
    assert.equal(targeted.finalization.eligible, false);

    const selfCheckOnly = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('inconclusive'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [toolEvidence('e-check-pass', { todoIds: ['edit'], checkIds: ['check-pass'] })],
      heavyTaskEngineeringRecords: [
        checkRecord('record-check-pass', 'check-pass', 'pass', { todoIds: ['edit'], evidenceIds: ['e-check-pass'] }),
      ],
    });
    assert.equal(selfCheckOnly.semantic.evidenceChain.outcome, 'inconclusive');
    assert.equal(selfCheckOnly.finalization.eligible, false);
  });

  test('cancelled todo requires public rationale plus durable nonblocking support', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'incomplete',
      taxonomy: 'agent_incomplete',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([
        { id: 'implemented', status: 'completed' },
        { id: 'optional-polish', status: 'cancelled', evidence: 'Not required by public task.' },
      ]),
      heavyTaskEvidence: [
        toolEvidence('e-check-pass', { todoIds: ['implemented'], checkIds: ['check-pass'] }),
        toolEvidence('e-optional', { todoIds: ['optional-polish'] }),
      ],
      heavyTaskEngineeringRecords: [
        checkRecord('record-check-pass', 'check-pass', 'pass', { todoIds: ['implemented'], evidenceIds: ['e-check-pass'] }),
        engineeringRecord('record-optional', 'patch', {
          todoIds: ['optional-polish'],
          evidenceIds: ['e-optional'],
          status: 'abandoned',
        }),
      ],
    });

    assert.equal(status.semantic.status, 'complete');
    assert.equal(status.semantic.evidenceChain.outcome, 'complete');
    assert.deepEqual(status.semantic.nonblockingTodoIds, ['optional-polish']);
    assert.deepEqual(status.semantic.evidenceChain.nonblockingItemIds, ['todo:optional-polish']);
    assert.equal(status.finalization.eligible, true);

    const missing = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'optional-polish', status: 'cancelled', evidence: 'Not required by public task.' }]),
    });
    assert.equal(missing.semantic.evidenceChain.outcome, 'missing');
    assert.equal(missing.finalization.eligible, false);
  });

  test('dangling engineering record links are missing evidence-chain items', () => {
    const status = evaluateHeavyTaskCompletionStatus({
      status: 'budget_exhausted',
      taxonomy: 'budget_exhausted',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEngineeringRecords: [
        checkRecord('record-dangling', 'check-dangling', 'pass', {
          todoIds: ['edit'],
          evidenceIds: ['e-missing'],
          completeness: 'incomplete',
          incompleteReason: 'referenced links were not found',
        }),
      ],
    });

    assert.equal(status.semantic.evidenceChain.outcome, 'missing');
    assert.ok(status.semantic.evidenceChain.missingItemIds.includes('targeted_check:check-dangling'));
    assert.ok(status.semantic.evidenceChain.missingItemIds.includes('compact_evidence:record-dangling:e-missing'));
    assert.equal(status.finalization.eligible, false);
  });

  test('requires accepted public pass self-check evidence', () => {
    const cases = [
      { name: 'missing self-check', selfCheck: undefined },
      {
        name: 'rejected self-check',
        selfCheck: selfCheck('pass', { guardStatus: 'rejected' }) as unknown as HeavyTaskSemanticSelfCheckState,
      },
      { name: 'private payload replay', selfCheck: selfCheck('pass', { publicReason: 'hidden/tests/private_case.py passed.' }) },
      { name: 'failed self-check', selfCheck: selfCheck('fail') },
      { name: 'inconclusive self-check', selfCheck: selfCheck('inconclusive') },
    ];

    for (const item of cases) {
      const status = evaluateHeavyTaskCompletionStatus({
        status: 'budget_exhausted',
        taxonomy: 'budget_exhausted',
        heavyTaskMode,
        latestHeavyTaskSelfCheck: item.selfCheck,
        latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
        heavyTaskEvidence: [toolEvidence('e-check-pass', { todoIds: ['edit'], checkIds: ['check-pass'] })],
        heavyTaskEngineeringRecords: [
          checkRecord('record-check-pass', 'check-pass', 'pass', { todoIds: ['edit'], evidenceIds: ['e-check-pass'] }),
        ],
      });

      assert.equal(status.semantic.status, 'incomplete', item.name);
      assert.equal(status.finalization.eligible, false, item.name);
    }
  });

  test('requires non-empty latest todos with no unresolved work', () => {
    const cases = [
      { name: 'missing todos', todos: undefined, unresolved: [] },
      { name: 'empty todos', todos: todos([]), unresolved: [] },
      { name: 'pending todo', todos: todos([{ id: 'inspect', status: 'pending' }]), unresolved: ['inspect'] },
      { name: 'in-progress todo', todos: todos([{ id: 'edit', status: 'in_progress' }]), unresolved: ['edit'] },
      { name: 'cancelled without evidence', todos: todos([{ id: 'optional', status: 'cancelled' }]), unresolved: ['optional'] },
      {
        name: 'unknown future status',
        todos: todos([{ id: 'future', status: 'blocked' as HeavyTaskTodoItem['status'] }]),
        unresolved: ['future'],
      },
    ];

    for (const item of cases) {
      const status = evaluateHeavyTaskCompletionStatus({
        status: 'budget_exhausted',
        taxonomy: 'budget_exhausted',
        heavyTaskMode,
        latestHeavyTaskSelfCheck: selfCheck('pass'),
        latestHeavyTaskTodos: item.todos,
      });

      assert.equal(status.semantic.status, 'incomplete', item.name);
      assert.deepEqual(status.semantic.unresolvedTodoIds, item.unresolved, item.name);
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
      { name: 'budget exhausted', status: 'budget_exhausted', taxonomy: 'budget_exhausted', capKind: 'budget_exhausted' },
      { name: 'runtime step cap', status: 'failed', errorClass: 'max_steps', message: 'runtime step cap reached', capKind: 'runtime_step_cap' },
      { name: 'wall time cap', status: 'failed', message: 'wall time cap reached', capKind: 'wall_time_cap' },
      { name: 'max attempts', status: 'failed', reason: 'max attempts exhausted', capKind: 'max_attempts' },
      { name: 'tool calls', status: 'incomplete', errorClass: 'incomplete_tool_calls', capKind: 'tool_call_step_cap' },
      { name: 'max tokens', status: 'incomplete', errorClass: 'max_tokens', capKind: 'token_cap' },
      { name: 'timeout', status: 'failed', errorClass: 'timeout', capKind: 'timeout' },
    ];

    for (const item of capCases) {
      const status = evaluateHeavyTaskCompletionStatus({
        status: item.status,
        taxonomy: item.taxonomy,
        error: item.errorClass || item.message ? { class: item.errorClass, message: item.message ?? item.errorClass ?? '' } : undefined,
        decisions: item.reason ? [{ id: `decision-${item.name}`, taskRunId: 'run-1', ts: 1, decision: 'stop', reason: item.reason }] : undefined,
        heavyTaskMode,
        latestHeavyTaskSelfCheck: selfCheck('pass'),
        latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
        heavyTaskEvidence: [toolEvidence('e-check-pass', { todoIds: ['edit'], checkIds: ['check-pass'] })],
        heavyTaskEngineeringRecords: [
          checkRecord('record-check-pass', 'check-pass', 'pass', { todoIds: ['edit'], evidenceIds: ['e-check-pass'] }),
        ],
      });

      assert.equal(status.runtime.capLike, true, item.name);
      assert.equal(status.runtime.capKind, item.capKind, item.name);
      assert.equal(status.finalization.eligible, true, item.name);
    }

    const verifierFailure = evaluateHeavyTaskCompletionStatus({
      status: 'completed',
      taxonomy: 'verification_failed',
      heavyTaskMode,
      latestHeavyTaskSelfCheck: selfCheck('pass'),
      latestHeavyTaskTodos: todos([{ id: 'edit', status: 'completed' }]),
      heavyTaskEvidence: [toolEvidence('e-check-pass', { todoIds: ['edit'], checkIds: ['check-pass'] })],
      heavyTaskEngineeringRecords: [
        checkRecord('record-check-pass', 'check-pass', 'pass', { todoIds: ['edit'], evidenceIds: ['e-check-pass'] }),
      ],
    });
    assert.equal(verifierFailure.runtime.capLike, false);
    assert.equal(verifierFailure.runtime.capKind, 'none');
    assert.equal(verifierFailure.semantic.status, 'complete');
    assert.equal(verifierFailure.finalization.eligible, false);
  });
});

function selfCheck(
  status: HeavyTaskSelfCheckStatus,
  options: { guardStatus?: 'accepted' | 'rejected'; publicReason?: string; ts?: number } = {},
): HeavyTaskSemanticSelfCheckState {
  return {
    schemaVersion: 1,
    selfCheckId: `self-check-${status}-${options.guardStatus ?? 'accepted'}`,
    taskRunId: 'run-1',
    ts: options.ts ?? 2,
    status,
    publicReason: options.publicReason ?? 'npm test passed against public files.',
    commandEvidence: [{ command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' }],
    artifactEvidence: [{ path: 'build-output.log', kind: 'log', exists: true }],
    guard: {
      status: options.guardStatus ?? 'accepted',
      checkedAt: options.ts ?? 2,
      categories: options.guardStatus === 'rejected' ? ['official_verifier_artifacts'] : [],
      publicReason: options.guardStatus === 'rejected'
        ? 'Rejected because submitted evidence referenced private, hidden, or evaluator-only material.'
        : 'Accepted as public, task-derived advisory self-check evidence.',
    } as unknown as HeavyTaskSemanticSelfCheckState['guard'],
    source: { kind: 'model_tool', toolCallId: 'tool-self-check' },
  };
}

function todos(items: Array<{ id: string; status: HeavyTaskTodoItem['status']; evidence?: string }>): HeavyTaskTodoState {
  return {
    schemaVersion: 1,
    todoSetId: 'todos-1',
    taskRunId: 'run-1',
    ts: 3,
    items: items.map((item) => ({
      id: item.id,
      content: `Work item ${item.id}`,
      status: item.status,
      priority: 'high',
      ...(item.evidence ? { evidence: item.evidence } : {}),
    })),
    source: { kind: 'model_tool', toolCallId: 'tool-todos' },
  };
}

function toolEvidence(
  evidenceId: string,
  options: {
    todoIds?: string[];
    checkIds?: string[];
    artifactIds?: string[];
    toolName?: string;
    ok?: boolean;
    diff?: boolean;
  } = {},
): HeavyTaskCompactEvidenceEnvelope {
  return {
    schemaVersion: 1,
    evidenceId,
    taskRunId: 'run-1',
    ts: 4,
    kind: 'tool',
    public: true,
    source: { kind: 'model_tool', toolCallId: `tool-${evidenceId}`, toolName: options.toolName ?? 'Bash' },
    tool: {
      name: options.toolName ?? 'Bash',
      inputSummary: options.toolName === 'Write' ? { filePath: 'src/app.js' } : { command: 'npm test' },
      exitCode: options.ok === false ? 1 : 0,
      ok: options.ok !== false,
      outputs: [{
        stream: options.diff ? 'diff' : 'stdout',
        excerpt: options.diff ? 'src/app.js changed' : 'public check output',
        lineCount: 1,
        byteCount: 19,
        truncated: false,
      }],
      diff: options.diff ? { status: 'present', files: [{ path: 'src/app.js', additions: 1, deletions: 0 }] } : { status: 'not_applicable' },
    },
    links: {
      ...(options.todoIds ? { todoIds: options.todoIds } : {}),
      ...(options.checkIds ? { checkIds: options.checkIds } : {}),
      ...(options.artifactIds ? { artifactIds: options.artifactIds } : {}),
    },
  };
}

function artifactEvidence(
  evidenceId: string,
  options: {
    todoIds?: string[];
    artifactId: string;
    authority?: NonNullable<NonNullable<HeavyTaskCompactEvidenceEnvelope['artifact']>['authority']>;
  },
): HeavyTaskCompactEvidenceEnvelope {
  return {
    schemaVersion: 1,
    evidenceId,
    taskRunId: 'run-1',
    ts: 4,
    kind: 'artifact',
    public: true,
    source: { kind: 'model_tool', toolCallId: `tool-${evidenceId}`, toolName: 'artifact' },
    artifact: {
      artifactId: options.artifactId,
      path: `${options.artifactId}.log`,
      kind: 'generated_output',
      exists: true,
      ...(options.authority ? { authority: options.authority } : {}),
    },
    links: {
      ...(options.todoIds ? { todoIds: options.todoIds } : {}),
      artifactIds: [options.artifactId],
    },
  };
}

function checkRecord(
  recordId: string,
  checkId: string,
  result: NonNullable<HeavyTaskEngineeringRecord['targetedCheck']>['result'],
  options: {
    todoIds: string[];
    evidenceIds?: string[];
    status?: HeavyTaskEngineeringRecord['status'];
    completeness?: HeavyTaskEngineeringRecord['completeness'];
    incompleteReason?: string;
    ts?: number;
  },
): HeavyTaskEngineeringRecord {
  return engineeringRecord(recordId, 'targeted_check', {
    todoIds: options.todoIds,
    evidenceIds: options.evidenceIds ?? [],
    checkIds: [checkId],
    status: options.status ?? (result === 'pass' ? 'passed' : result === 'fail' ? 'failed' : 'running'),
    completeness: options.completeness,
    incompleteReason: options.incompleteReason,
    ts: options.ts,
    targetedCheck: {
      checkId,
      command: 'npm test',
      expectedSignal: 'public tests pass',
      observedSignal: result === 'pass' ? 'public tests passed' : 'public tests did not pass',
      result,
    },
  });
}

function patchRecord(
  recordId: string,
  patchId: string,
  options: {
    todoIds: string[];
    evidenceIds?: string[];
    artifactIds?: string[];
    changedFiles?: string[];
    status?: HeavyTaskEngineeringRecord['status'];
    ts?: number;
  },
): HeavyTaskEngineeringRecord {
  return engineeringRecord(recordId, 'patch', {
    todoIds: options.todoIds,
    evidenceIds: options.evidenceIds ?? [],
    artifactIds: options.artifactIds ?? [],
    changedFiles: options.changedFiles ?? [],
    status: options.status ?? 'passed',
    ts: options.ts,
    patch: {
      patchId,
      changedFiles: options.changedFiles ?? [],
      changeSummary: 'Changed public source file.',
      mutationEvidenceIds: options.evidenceIds ?? [],
    },
  });
}

function repairRecord(
  recordId: string,
  failedCheckIds: string[],
  options: {
    todoIds: string[];
    evidenceIds?: string[];
    changedFiles?: string[];
    ts?: number;
  },
): HeavyTaskEngineeringRecord {
  return engineeringRecord(recordId, 'repair', {
    todoIds: options.todoIds,
    evidenceIds: options.evidenceIds ?? [],
    checkIds: failedCheckIds,
    changedFiles: options.changedFiles ?? [],
    status: 'repaired',
    ts: options.ts,
    repair: {
      failedCheckIds,
      repairStrategy: 'Adjust public source and rerun check.',
      outcome: 'check_passed',
    },
  });
}

function engineeringRecord(
  recordId: string,
  kind: HeavyTaskEngineeringRecord['kind'],
  options: {
    todoIds: string[];
    evidenceIds?: string[];
    checkIds?: string[];
    artifactIds?: string[];
    changedFiles?: string[];
    status?: HeavyTaskEngineeringRecord['status'];
    completeness?: HeavyTaskEngineeringRecord['completeness'];
    incompleteReason?: string;
    ts?: number;
    targetedCheck?: HeavyTaskEngineeringRecord['targetedCheck'];
    repair?: HeavyTaskEngineeringRecord['repair'];
    patch?: HeavyTaskEngineeringRecord['patch'];
  },
): HeavyTaskEngineeringRecord {
  return {
    schemaVersion: 1,
    recordId,
    taskRunId: 'run-1',
    ts: options.ts ?? 4,
    kind,
    title: `${kind} record`,
    summary: `${kind} public summary`,
    status: options.status ?? 'passed',
    completeness: options.completeness ?? 'complete',
    ...(options.incompleteReason ? { incompleteReason: options.incompleteReason } : {}),
    source: { kind: 'model_tool', toolCallId: `tool-${recordId}`, toolName: kind === 'targeted_check' ? 'check_record' : 'engineering_record' },
    links: {
      todoIds: options.todoIds,
      evidenceIds: options.evidenceIds ?? [],
      toolCallIds: [`tool-${recordId}`],
      checkIds: options.checkIds ?? [],
      artifactIds: options.artifactIds ?? [],
      changedFiles: options.changedFiles ?? [],
      patchIds: options.patch?.patchId ? [options.patch.patchId] : [],
      hypothesisIds: [],
      repairIds: [],
    },
    ...(options.targetedCheck ? { targetedCheck: options.targetedCheck } : {}),
    ...(options.repair ? { repair: options.repair } : {}),
    ...(options.patch ? { patch: options.patch } : {}),
  };
}
