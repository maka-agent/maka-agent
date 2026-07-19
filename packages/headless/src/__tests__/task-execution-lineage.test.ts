import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { taskAttemptExecutionEvidence } from '../task-execution-lineage.js';

describe('taskAttemptExecutionEvidence', () => {
  test('builds inclusive stable coverage from every immutable Runtime log row', () => {
    const evidence = taskAttemptExecutionEvidence({
      taskRunId: 'task-run-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      agentRunId: 'run-1',
      turnId: 'turn-1',
      runtimeEvents: [
        runtimeEvent('event-1'),
        runtimeEvent('partial-lifecycle-event', {
          partial: true,
          role: 'system',
          author: 'system',
          actions: { stateDelta: { progress: 1 } },
        }),
        runtimeEvent('event-2'),
        runtimeEvent('event-3'),
      ],
    });

    assert.deepEqual(evidence.runtimeCoverage, {
      lowWater: {
        ledger: 'runtime_event',
        streamId: 'run-1',
        sequence: 0,
        eventId: 'event-1',
      },
      highWater: {
        ledger: 'runtime_event',
        streamId: 'run-1',
        sequence: 3,
        eventId: 'event-3',
      },
      eventCount: 4,
    });
  });

  test('keeps an honest identity-only link when legacy data has no event coverage', () => {
    const evidence = taskAttemptExecutionEvidence({
      taskRunId: 'task-run-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      agentRunId: 'run-1',
      runtimeEvents: [],
    });

    assert.deepEqual(evidence.execution, {
      sessionId: 'session-1',
      agentRunId: 'run-1',
    });
    assert.deepEqual(evidence.task, {
      taskRunId: 'task-run-1',
      attemptId: 'attempt-1',
    });
    assert.equal(evidence.runtimeCoverage, undefined);
  });

  test('refuses to claim coverage over events from another Runtime stream', () => {
    assert.throws(
      () =>
        taskAttemptExecutionEvidence({
          taskRunId: 'task-run-1',
          attemptId: 'attempt-1',
          sessionId: 'session-1',
          invocationId: 'invocation-1',
          agentRunId: 'run-1',
          turnId: 'turn-1',
          runtimeEvents: [runtimeEvent('event-1', { runId: 'run-2' })],
        }),
      /runId does not match lineage agentRunId/,
    );
  });
});

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    ...overrides,
  };
}
