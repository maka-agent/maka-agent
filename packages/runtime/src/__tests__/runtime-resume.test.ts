import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RuntimeEvent } from '@maka/core/runtime-event';

import {
  RUNTIME_RESUME_FAILPOINTS,
  RuntimeContinuationPlanner,
  buildSafeBoundaryContinuationPlan,
  buildResumePlanFromRuntimeEvents,
  buildResumeReplayRuntimeEvents,
  projectToolOperationsFromRuntimeEvents,
} from '../runtime-resume.js';
import { ToolRecoveryContractRegistry } from '../tool-recovery-contract.js';

describe('runtime resume phase 0 projection', () => {
  test('publishes the stable P0-P11 crash failpoint catalog', () => {
    assert.deepEqual(
      RUNTIME_RESUME_FAILPOINTS.map((failpoint) => failpoint.id),
      ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'],
    );
    assert.deepEqual(
      [...new Set(RUNTIME_RESUME_FAILPOINTS.map((failpoint) => failpoint.committedPrefix))],
      [
        'before_function_call',
        'after_function_call',
        'after_function_response',
        'after_terminal_event',
      ],
    );
  });

  test('projects deterministic tool operations from legal RuntimeEvent prefixes', () => {
    const events = [
      callEvent('call-1', 'tool-1', 'Bash', { command: 'npm test' }),
      responseEvent('result-1', 'tool-1', 'Bash', { ok: false }, true),
      callEvent('call-2', 'tool-2', 'Read', { file_path: 'README.md' }),
    ];

    const first = projectToolOperationsFromRuntimeEvents(events);
    const second = projectToolOperationsFromRuntimeEvents(events);

    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((operation) => ({
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
        status: operation.status,
        callRuntimeEventId: operation.callRuntimeEventId,
        responseRuntimeEventId: operation.responseRuntimeEventId,
      })),
      [
        {
          toolCallId: 'tool-1',
          toolName: 'Bash',
          status: 'failed',
          callRuntimeEventId: 'call-1',
          responseRuntimeEventId: 'result-1',
        },
        {
          toolCallId: 'tool-2',
          toolName: 'Read',
          status: 'parked',
          callRuntimeEventId: 'call-2',
          responseRuntimeEventId: undefined,
        },
      ],
    );
  });

  test('distinguishes committed failed results from fail-closed missing results', () => {
    const failed = buildResumePlanFromRuntimeEvents([
      callEvent('call-1', 'tool-1', 'Bash', { command: 'exit 1' }),
      responseEvent('result-1', 'tool-1', 'Bash', { exitCode: 1 }, true),
    ]);
    const indeterminate = buildResumePlanFromRuntimeEvents([
      callEvent('call-2', 'tool-2', 'Bash', { command: 'touch marker' }),
    ]);

    assert.equal(failed.disposition, 'safe_replay');
    assert.equal(failed.operations[0]?.status, 'failed');
    assert.equal(indeterminate.disposition, 'blocked');
    assert.equal(indeterminate.operations[0]?.status, 'parked');
    assert.equal(indeterminate.requiresVerification, true);
    assert.deepEqual(indeterminate.rejectionReasons, ['dangling_tool_state']);
    assert.equal(indeterminate.diagnostics[0]?.code, 'tool_outcome_indeterminate');
    assert.equal(indeterminate.sourceRuntimeEventHighWater, 1);
    assert.ok(indeterminate.directive);
    assert.match(indeterminate.directive, /Do not retry/i);
    assert.match(indeterminate.directive, /read-only/i);
  });

  test('excludes unresolved tool calls from provider replay history', () => {
    const events = [
      textEvent('user-1', 'user', 'hello'),
      callEvent('call-1', 'tool-1', 'Bash', { command: 'touch marker' }),
      textEvent('system-1', 'system', 'diagnostic'),
    ];

    const replayEvents = buildResumeReplayRuntimeEvents(events);

    assert.deepEqual(
      replayEvents.map((event) => event.id),
      ['user-1', 'system-1'],
    );
  });

  test('blocks replay on unmatched tool results rather than inventing provider history', () => {
    const plan = buildResumePlanFromRuntimeEvents([
      responseEvent('result-1', 'tool-1', 'Bash', { ok: true }, false),
    ]);

    assert.equal(plan.disposition, 'blocked');
    assert.equal(plan.requiresVerification, false);
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
    assert.deepEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.code),
      ['unmatched_tool_result'],
    );
    assert.deepEqual(
      buildResumeReplayRuntimeEvents(plan.runtimeEvents).map((event) => event.id),
      [],
    );
  });

  test('rejects runtime high-water mismatches with a stable fallback reason', () => {
    const plan = buildResumePlanFromRuntimeEvents([textEvent('user-1', 'user', 'hello')], {
      expectedRuntimeEventHighWater: 2,
    });

    assert.equal(plan.disposition, 'blocked');
    assert.deepEqual(plan.rejectionReasons, ['runtime_offset_mismatch']);
    assert.deepEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.code),
      ['runtime_offset_mismatch'],
    );
  });

  test('parks recovery at an unknown runtime fact kind and version', () => {
    const fact = base({
      id: 'future-runtime-fact',
      actions: {
        runtimeFact: {
          kind: 'maka.test.future_fact',
          version: 7,
          legacyProjection: 'invisible',
          payload: { checkpointId: 'checkpoint-1' },
        },
      },
    });
    const plan = buildResumePlanFromRuntimeEvents([
      textEvent('user-1', 'user', 'continue the task'),
      fact,
    ]);

    assert.equal(plan.disposition, 'blocked');
    assert.deepEqual(plan.rejectionReasons, ['runtime_fact_unsupported']);
    assert.deepEqual(plan.diagnostics, [
      {
        code: 'runtime_fact_unsupported',
        message: 'runtime fact maka.test.future_fact@7 is not supported by this recovery runtime',
        eventId: 'future-runtime-fact',
        detail: { kind: 'maka.test.future_fact', version: 7 },
      },
    ]);
  });
});

describe('runtime resume phase 1 safe-boundary continuation', () => {
  test('parks a continuation plan when its source contains an unknown runtime fact', async () => {
    const sourceEvents = [
      textEvent('source-user', 'user', 'continue safely'),
      base({
        id: 'source-future-runtime-fact',
        actions: {
          runtimeFact: {
            kind: 'maka.test.future_fact',
            version: 1,
            legacyProjection: 'invisible',
            payload: {},
          },
        },
      }),
      base({ id: 'source-terminal', status: 'failed', actions: { endInvocation: true } }),
    ];
    const planner = new RuntimeContinuationPlanner({
      readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'failed' }),
      readRuntimeEvents: async () => sourceEvents,
      newId: () => 'unused',
    });

    const plan = await planner.plan({
      sessionId: 'session-1',
      sourceRunId: 'run-1',
      currentCwd: '/workspace/repo',
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['runtime_fact_unsupported']);
  });

  test('replays the user-anchored ancestor prefix when continuing a continuation run', async () => {
    const rootEvents = [
      textEvent('root-user', 'user', 'finish the task'),
      base({ id: 'root-terminal', status: 'failed', actions: { endInvocation: true } }),
    ];
    const continuationIdentity = {
      sessionId: 'session-1',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
    };
    const childEvents = [
      {
        ...base({
          id: 'continuation-start',
          role: 'system',
          author: 'system',
          actions: { stateDelta: { continuationStart: true } },
        }),
        ...continuationIdentity,
      },
      {
        ...callEvent('child-call', 'tool-2', 'Bash', { command: 'npm test' }),
        ...continuationIdentity,
      },
      {
        ...responseEvent('child-result', 'tool-2', 'Bash', { exitCode: 0 }, false),
        ...continuationIdentity,
      },
      {
        ...base({ id: 'child-terminal', status: 'failed', actions: { endInvocation: true } }),
        ...continuationIdentity,
      },
    ];
    const planner = new RuntimeContinuationPlanner({
      readSourceRun: async (_sessionId, runId) =>
        runId === 'run-2'
          ? {
              cwd: '/workspace/repo',
              status: 'failed',
              continuationSource: {
                sourceInvocationId: 'invocation-1',
                sourceRunId: 'run-1',
                sourceTurnId: 'turn-1',
                sourceRuntimeEventHighWater: rootEvents.length,
              },
            }
          : { cwd: '/workspace/repo', status: 'failed' },
      readRuntimeEvents: async (_sessionId, runId) =>
        runId === 'run-2' ? childEvents : rootEvents,
      newId: (() => {
        let next = 2;
        return () => `generated-${++next}`;
      })(),
    });

    const plan = await planner.plan({
      sessionId: 'session-1',
      sourceRunId: 'run-2',
      currentCwd: '/workspace/repo',
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: ['Bash'],
    });

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      [
        'root-user',
        'root-terminal',
        'continuation-start',
        'child-call',
        'child-result',
        'child-terminal',
      ],
    );
    assert.deepEqual(
      plan.continuation?.sourceRuntimeContext?.map((event) => event.id),
      ['continuation-start', 'child-call', 'child-result', 'child-terminal'],
    );
  });

  test('does not reintroduce an interrupted ancestor model suffix in a chained continuation', async () => {
    const rootEvents = [
      textEvent('root-user', 'user', 'finish the task'),
      base({
        id: 'root-thinking',
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'unfinished reasoning', signature: 'signed-root-step' },
      }),
      base({
        id: 'root-text',
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'unfinished answer' },
      }),
      base({ id: 'root-terminal', status: 'failed', actions: { endInvocation: true } }),
    ];
    const childIdentity = {
      sessionId: 'session-1',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
    };
    const childEvents = [
      {
        ...base({
          id: 'continuation-start',
          role: 'system',
          author: 'system',
          actions: { stateDelta: { continuationStart: true } },
        }),
        ...childIdentity,
      },
      {
        ...callEvent('child-call', 'tool-2', 'Bash', { command: 'npm test' }),
        ...childIdentity,
      },
      {
        ...responseEvent('child-result', 'tool-2', 'Bash', { exitCode: 0 }, false),
        ...childIdentity,
      },
      {
        ...base({ id: 'child-terminal', status: 'failed', actions: { endInvocation: true } }),
        ...childIdentity,
      },
    ];
    const planner = new RuntimeContinuationPlanner({
      readSourceRun: async (_sessionId, runId) =>
        runId === 'run-2'
          ? {
              cwd: '/workspace/repo',
              status: 'failed',
              continuationSource: {
                sourceInvocationId: 'invocation-1',
                sourceRunId: 'run-1',
                sourceTurnId: 'turn-1',
                sourceRuntimeEventHighWater: rootEvents.length,
              },
            }
          : { cwd: '/workspace/repo', status: 'failed' },
      readRuntimeEvents: async (_sessionId, runId) =>
        runId === 'run-2' ? childEvents : rootEvents,
      newId: (() => {
        let next = 2;
        return () => `generated-${++next}`;
      })(),
    });

    const plan = await planner.plan({
      sessionId: 'session-1',
      sourceRunId: 'run-2',
      currentCwd: '/workspace/repo',
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: ['Bash'],
    });

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      [
        'root-user',
        'root-terminal',
        'continuation-start',
        'child-call',
        'child-result',
        'child-terminal',
      ],
    );
  });

  test('uses RecoveryResolver to distinguish a new-protocol call that never crossed T1', () => {
    const initial = textEvent('user-1', 'user', 'run it');
    initial.actions = {
      runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
    };
    const plan = buildResumePlanFromRuntimeEvents([
      initial,
      callEvent('call-1', 'tool-1', 'Bash', { command: 'touch marker' }),
    ]);

    assert.equal(plan.disposition, 'blocked');
    assert.equal(plan.operations[0]?.status, 'not_dispatched');
    assert.equal(plan.requiresVerification, false);
    assert.deepEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.code),
      ['tool_not_dispatched'],
    );
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
  });

  test('uses its configured recovery contracts when planning from stored events', async () => {
    const initial = textEvent('source-user', 'user', 'write safely');
    initial.actions = { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } };
    const sourceEvents = [
      initial,
      callEvent('source-call', 'tool-1', 'Write', { path: 'a.txt' }),
      toolDispatchEvent(),
      base({ id: 'source-terminal', status: 'failed', actions: { endInvocation: true } }),
    ];
    const recoveryContracts = writeRecoveryContracts();
    const planner = new RuntimeContinuationPlanner({
      readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'failed' }),
      readRuntimeEvents: async () => sourceEvents,
      recoveryContracts,
      newId: () => 'unused',
    });

    const plan = await planner.plan({
      sessionId: 'session-1',
      sourceRunId: 'run-1',
      currentCwd: '/workspace/repo',
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: ['Write'],
    });

    assert.equal(plan.disposition, 'park');
    assert.equal(plan.diagnostics[0]?.code, 'tool_recovery_required');
  });

  test('passes the recovery contract registry through safe-boundary planning', () => {
    const initial = textEvent('user-1', 'user', 'write it');
    initial.actions = { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } };
    const dispatch = toolDispatchEvent();
    const recoveryContracts = writeRecoveryContracts();

    const plan = buildSafeBoundaryContinuationPlan(
      [initial, callEvent('call-1', 'tool-1', 'Write', { path: 'a.txt' }), dispatch],
      { ...safeBoundaryFacts(), recoveryContracts },
    );

    assert.equal(plan.disposition, 'park');
    assert.equal(plan.diagnostics[0]?.code, 'tool_recovery_required');
    assert.equal(plan.diagnostics[0]?.detail?.reasonCode, 'recovery_contract_available');
  });

  test('creates a new execution identity from a fully committed safe boundary', () => {
    const events = [
      textEvent('user-1', 'user', 'run the tests'),
      callEvent('call-1', 'tool-1', 'Bash', { command: 'npm test' }),
      responseEvent('result-1', 'tool-1', 'Bash', { exitCode: 0 }, false),
    ];

    const plan = buildSafeBoundaryContinuationPlan(events, {
      ledgerReadable: true,
      terminalRepairSucceeded: true,
      sourceCwd: '/workspace/repo',
      currentCwd: '/workspace/repo',
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: ['Bash'],
      continuationIdentity: {
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
      },
    });

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(plan.rejectionReasons, []);
    assert.equal(plan.recoveryProjection?.disposition, 'safe_replay');
    assert.equal(plan.recoveryProjection?.sourceRuntimeEventHighWater, events.length);
    assert.deepEqual(plan.continuation, {
      sessionId: 'session-1',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
      sourceInvocationId: 'invocation-1',
      sourceRunId: 'run-1',
      sourceTurnId: 'turn-1',
      sourceRuntimeEventHighWater: 3,
      sourceRuntimeContext: events,
      runtimeContext: events,
      safetySnapshot: {
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames: ['Bash'],
      },
    });
  });

  test('parks when a permission request has no committed decision', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'edit the file'),
        permissionRequestEvent('permission-1', 'tool-1'),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['pending_permission']);
    assert.equal(plan.continuation, undefined);
  });

  test('parks when the current workspace identity differs from the source boundary', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [textEvent('user-1', 'user', 'inspect the repository')],
      {
        ...safeBoundaryFacts(),
        currentWorkspaceIdentity: 'workspace-2',
      },
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['workspace_identity_mismatch']);
  });

  test('continues after a workspace path change when the UUID marker is unchanged', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [textEvent('user-1', 'user', 'inspect the repository')],
      {
        ...safeBoundaryFacts(),
        currentCwd: '/fresh-sandbox/repo',
      },
    );

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(plan.rejectionReasons, []);
    assert.deepEqual(plan.diagnostics, [
      {
        code: 'workspace_location_changed',
        message: 'workspace location differs from the source resume boundary',
        detail: {
          sourceCwd: '/workspace/repo',
          currentCwd: '/fresh-sandbox/repo',
        },
      },
    ]);
  });

  test('migrates a legacy filesystem anchor through a marker alias', () => {
    const workspaceIdentity = 'workspace:v1:123e4567-e89b-42d3-a456-426614174000';
    const legacyIdentity = 'fs:7:42:/workspace/repo';
    const plan = buildSafeBoundaryContinuationPlan(
      [textEvent('user-1', 'user', 'inspect the repository')],
      {
        ...safeBoundaryFacts(),
        sourceWorkspaceIdentity: legacyIdentity,
        currentWorkspaceIdentity: workspaceIdentity,
        currentWorkspaceIdentityAliases: [legacyIdentity],
      },
    );

    assert.equal(plan.disposition, 'continue');
    assert.equal(plan.continuation?.safetySnapshot.workspaceIdentity, workspaceIdentity);
  });

  test('parks while a background operation is still unsettled', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'start the service'),
        callEvent('call-1', 'tool-1', 'Bash', { command: 'npm start', background: true }),
        responseEvent(
          'result-1',
          'tool-1',
          'Bash',
          {
            kind: 'shell_run',
            ref: 'maka://runtime/background-tasks/run-1',
            status: 'running',
          },
          false,
        ),
      ],
      {
        ...safeBoundaryFacts(),
        backgroundOperationsSettled: false,
      },
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['background_operation_pending']);
  });

  test('parks when a historical tool is unavailable in the current catalog', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'fetch the page'),
        callEvent('call-1', 'tool-1', 'Fetch', { url: 'https://example.test' }),
        responseEvent('result-1', 'tool-1', 'Fetch', { status: 200 }, false),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['tool_catalog_mismatch']);
    assert.deepEqual(plan.diagnostics[0]?.detail, { unavailableToolNames: ['Fetch'] });
  });

  test('parks when any required external safety fact is absent', () => {
    const events = [textEvent('user-1', 'user', 'continue the task')];
    const cases = [
      {
        facts: { ...safeBoundaryFacts(), ledgerReadable: false },
        reason: 'runtime_ledger_unreadable',
      },
      {
        facts: { ...safeBoundaryFacts(), terminalRepairSucceeded: false },
        reason: 'terminal_repair_failed',
      },
    ] as const;

    for (const candidate of cases) {
      const plan = buildSafeBoundaryContinuationPlan(events, candidate.facts);
      assert.equal(plan.disposition, 'park');
      assert.deepEqual(plan.rejectionReasons, [candidate.reason]);
    }
  });

  test('requires a non-empty single-source ledger and fresh continuation identity', () => {
    const empty = buildSafeBoundaryContinuationPlan([], safeBoundaryFacts());
    assert.deepEqual(empty.rejectionReasons, ['runtime_ledger_empty']);

    const mixed = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'continue'),
        base({ id: 'other-run', runId: 'run-other', content: { kind: 'text', text: 'other' } }),
      ],
      safeBoundaryFacts(),
    );
    assert.deepEqual(mixed.rejectionReasons, ['runtime_identity_mismatch']);

    const reused = buildSafeBoundaryContinuationPlan([textEvent('user-1', 'user', 'continue')], {
      ...safeBoundaryFacts(),
      continuationIdentity: {
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
      },
    });
    assert.deepEqual(reused.rejectionReasons, ['continuation_identity_reused']);
  });

  test('omits an interrupted model-only suffix from continuation replay', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'write a summary'),
        base({
          id: 'assistant-1',
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'partial but committed answer' },
          refs: { providerEventId: 'interrupted-step-1' },
        }),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(plan.rejectionReasons, []);
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      ['user-1'],
    );
    assert.equal(plan.continuation?.sourceRuntimeEventHighWater, 2);
    assert.equal(plan.diagnostics[0]?.code, 'interrupted_model_suffix_omitted');
    assert.deepEqual(plan.diagnostics[0]?.detail?.eventIds, ['assistant-1']);
    assert.deepEqual(
      plan.recoveryProjection?.replayRuntimeEvents.map((event) => event.id),
      ['user-1', 'assistant-1'],
    );
  });

  test('omits delayed text and signed thinking after a completed tool boundary as one suffix', () => {
    const call = callEvent('call-1', 'tool-1', 'Write', {
      path: 'hello.txt',
      content: 'hello',
    });
    call.refs = { ...call.refs, stepId: 'step-1' };
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'write hello.txt'),
        call,
        responseEvent('response-1', 'tool-1', 'Write', { ok: true }, false),
        base({
          id: 'thinking-1',
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'write complete', signature: 'signed-step-1' },
          refs: { providerEventId: 'step-1' },
        }),
        base({
          id: 'assistant-1',
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'The first write is complete.' },
          refs: { providerEventId: 'step-1' },
        }),
      ],
      { ...safeBoundaryFacts(), availableToolNames: ['Write'] },
    );

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      ['user-1', 'call-1', 'response-1'],
    );
    assert.equal(plan.continuation?.sourceRuntimeEventHighWater, 5);
    assert.deepEqual(plan.diagnostics[0]?.detail?.eventIds, ['thinking-1', 'assistant-1']);
  });

  test('does not treat empty model text or a runtime error fact as a replay suffix', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'continue'),
        base({
          id: 'empty-model-text',
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: '' },
          refs: { providerEventId: 'step-1' },
        }),
        base({
          id: 'runtime-error',
          role: 'system',
          author: 'system',
          content: { kind: 'error', message: 'app restarted' },
        }),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'continue');
    assert.equal(
      plan.diagnostics.some(({ code }) => code === 'interrupted_model_suffix_omitted'),
      false,
    );
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      ['user-1', 'empty-model-text', 'runtime-error'],
    );
  });

  test('parks when committed provider history does not start at a user boundary', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        base({
          id: 'continuation-start',
          role: 'system',
          author: 'system',
          actions: { stateDelta: { continuationStart: true } },
        }),
        callEvent('call-1', 'tool-1', 'Bash', { command: 'npm test' }),
        responseEvent('result-1', 'tool-1', 'Bash', { exitCode: 0 }, false),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['provider_resume_head_unsupported']);
    assert.equal(plan.diagnostics[0]?.code, 'provider_resume_head_unsupported');
  });

  test('requires a restored workspace checkpoint with the same runtime high-water when supplied', () => {
    const events = [textEvent('user-1', 'user', 'continue')];
    const missingRef = buildSafeBoundaryContinuationPlan(events, {
      ...safeBoundaryFacts(),
      workspaceCheckpoint: { restored: true, runtimeEventHighWater: 1 },
    });
    assert.deepEqual(missingRef.rejectionReasons, ['workspace_ref_missing']);

    const restoreFailed = buildSafeBoundaryContinuationPlan(events, {
      ...safeBoundaryFacts(),
      workspaceCheckpoint: { ref: 'checkpoint-1', restored: false, runtimeEventHighWater: 1 },
    });
    assert.deepEqual(restoreFailed.rejectionReasons, ['checkpoint_restore_failed']);

    const offsetMismatch = buildSafeBoundaryContinuationPlan(events, {
      ...safeBoundaryFacts(),
      workspaceCheckpoint: { ref: 'checkpoint-1', restored: true, runtimeEventHighWater: 2 },
    });
    assert.deepEqual(offsetMismatch.rejectionReasons, ['runtime_offset_mismatch']);
  });

  test('keeps the durable high-water even when partial events are excluded from replay context', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'continue'),
        base({
          id: 'partial-1',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'streaming' },
        }),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'continue');
    assert.equal(plan.continuation?.sourceRuntimeEventHighWater, 2);
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      ['user-1'],
    );
  });
});

function safeBoundaryFacts() {
  return {
    ledgerReadable: true,
    terminalRepairSucceeded: true,
    sourceCwd: '/workspace/repo',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: ['Bash', 'Write'],
    continuationIdentity: {
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
    },
  };
}

function base(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    author: 'agent',
    role: 'system',
    ...overrides,
  };
}

function callEvent(id: string, toolCallId: string, name: string, args: unknown): RuntimeEvent {
  return base({
    id,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: toolCallId, name, args },
    refs: { toolCallId },
  });
}

function responseEvent(
  id: string,
  toolCallId: string,
  name: string,
  result: unknown,
  isError: boolean,
): RuntimeEvent {
  return base({
    id,
    role: 'tool',
    content: { kind: 'function_response', id: toolCallId, name, result, isError },
    author: 'tool',
    refs: { toolCallId },
  });
}

function toolDispatchEvent(): RuntimeEvent {
  return base({
    id: 'dispatch-1',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'tool-1',
        toolName: 'Write',
        canonicalArgsHash: 'hash-1',
        recoveryMode: 'reconcile',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'tool-1' },
  });
}

function writeRecoveryContracts(): ToolRecoveryContractRegistry {
  return new ToolRecoveryContractRegistry([
    {
      toolName: 'Write',
      contract: {
        id: 'maka.tool.write.reconcile',
        version: 1,
        mode: 'reconcile_then_decide',
      },
    },
  ]);
}

function textEvent(id: string, role: 'user' | 'system', text: string): RuntimeEvent {
  return base({
    id,
    role,
    author: role === 'user' ? 'user' : 'system',
    content: { kind: 'text', text },
  });
}

function permissionRequestEvent(id: string, toolCallId: string): RuntimeEvent {
  return base({
    id,
    role: 'system',
    author: 'system',
    actions: {
      permissionRequest: {
        kind: 'tool_permission',
        requestId: id,
        toolUseId: toolCallId,
        toolName: 'Write',
        category: 'file_write',
        reason: 'file_write',
        args: { path: 'README.md' },
        rememberForTurnAllowed: true,
      },
    },
  });
}
