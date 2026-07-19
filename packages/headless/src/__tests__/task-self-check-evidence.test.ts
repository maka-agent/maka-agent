import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  HeavyTaskSelfCheckRecordedEvent,
  HeavyTaskWorkspaceObservationRecordedEvent,
} from '../task-contracts.js';
import { bindSelfCheckEvidence } from '../task-self-check-evidence.js';

describe('bindSelfCheckEvidence', () => {
  test('binds Self-check to exact Runtime facts, Task high water, and workspace revision', () => {
    const result = bindSelfCheckEvidence(bindingInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.link.provenance.runtimeCoverage, {
      lowWater: {
        ledger: 'runtime_event',
        streamId: 'run-1',
        sequence: 0,
        eventId: 'runtime-call',
      },
      highWater: {
        ledger: 'runtime_event',
        streamId: 'run-1',
        sequence: 1,
        eventId: 'runtime-result',
      },
      eventCount: 2,
    });
    assert.deepEqual(result.link.provenance.taskCoverage, {
      highWater: {
        ledger: 'task_event',
        streamId: 'task-run-1',
        sequence: 7,
        eventId: 'self-check-event',
      },
      eventCount: 8,
    });
    assert.equal(result.link.provenance.workspace?.ref, 'sha256:workspace-1');
  });

  test('does not bind without an executor-owned response or a workspace revision', () => {
    const noResponse = bindingInput();
    noResponse.runtimeEvents = noResponse.runtimeEvents.slice(0, 1);
    assert.deepEqual(bindSelfCheckEvidence(noResponse), {
      ok: false,
      reason: 'Matching Self-check function call and response are required',
    });

    const noRevision = bindingInput();
    delete noRevision.workspaceObservation.observation.revision;
    assert.deepEqual(bindSelfCheckEvidence(noRevision), {
      ok: false,
      reason: 'A successful workspace manifest revision is required',
    });
  });

  test('does not bind a Self-check from another AgentRun', () => {
    const input = bindingInput();
    input.selfCheckRecord.event.selfCheck.source.agentRunId = 'run-2';
    assert.deepEqual(bindSelfCheckEvidence(input), {
      ok: false,
      reason: 'Self-check source does not match the Runtime invocation',
    });
  });
});

function bindingInput() {
  const selfCheckEvent: HeavyTaskSelfCheckRecordedEvent = {
    type: 'heavy_task_self_check_recorded',
    id: 'self-check-event',
    taskRunId: 'task-run-1',
    ts: 2,
    selfCheck: {
      schemaVersion: 1,
      selfCheckId: 'self-check-1',
      taskRunId: 'task-run-1',
      attemptId: 'attempt-1',
      ts: 2,
      status: 'pass',
      publicReason: 'public tests passed',
      commandEvidence: [{ command: 'npm test', exitCode: 0 }],
      artifactEvidence: [],
      guard: {
        status: 'accepted',
        checkedAt: 2,
        categories: [],
        publicReason: 'public evidence',
      },
      source: {
        kind: 'model_tool',
        toolCallId: 'self-check-call',
        sessionId: 'session-1',
        agentRunId: 'run-1',
        turnId: 'turn-1',
      },
    },
  };
  const workspaceObservation: HeavyTaskWorkspaceObservationRecordedEvent = {
    type: 'heavy_task_workspace_observation_recorded',
    id: 'workspace-event',
    taskRunId: 'task-run-1',
    ts: 3,
    observation: {
      schemaVersion: 1,
      observationId: 'workspace-1',
      taskRunId: 'task-run-1',
      ts: 3,
      roots: ['/app/project'],
      entries: [{ path: '/app/project/result.txt', kind: 'file', sizeBytes: 2, sha256: 'aa' }],
      status: 'ok',
      command: 'observe',
      revision: { kind: 'manifest', ref: 'sha256:workspace-1', dirty: false },
      source: { kind: 'system', label: 'isolated workspace observation' },
    },
  };
  return {
    taskRunId: 'task-run-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    agentRunId: 'run-1',
    turnId: 'turn-1',
    runtimeEvents: [
      runtimeEvent('runtime-call', {
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'self-check-call',
          name: 'self_check_submit',
          args: {},
        },
        refs: { toolCallId: 'self-check-call' },
      }),
      runtimeEvent('runtime-result', {
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'self-check-call',
          name: 'self_check_submit',
          result: { accepted: true },
        },
        refs: { toolCallId: 'self-check-call' },
      }),
    ],
    selfCheckRecord: {
      event: selfCheckEvent,
      cursor: {
        ledger: 'task_event' as const,
        streamId: 'task-run-1',
        sequence: 7,
        eventId: 'self-check-event',
      },
    },
    workspaceObservation,
  };
}

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}
