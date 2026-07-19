import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
  compareExecutionLogCursors,
  executionLogCursorsShareStream,
  isExecutionEvidenceRef,
  validateExecutionEvidenceRef,
  type ExecutionEvidenceRef,
  type ExecutionLogCursor,
} from '../execution-evidence.js';

describe('execution evidence spine contract', () => {
  it('accepts a complete cross-ledger reference', () => {
    const ref: ExecutionEvidenceRef = {
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      execution: {
        sessionId: 'session-1',
        invocationId: 'invocation-1',
        agentRunId: 'run-1',
        turnId: 'turn-1',
      },
      task: {
        taskRunId: 'task-run-1',
        attemptId: 'attempt-2',
      },
      runtimeCoverage: {
        lowWater: runtimeCursor(4, 'event-4'),
        highWater: runtimeCursor(12, 'event-12'),
        eventCount: 9,
      },
      taskCoverage: {
        highWater: taskCursor(7, 'task-event-7'),
        eventCount: 8,
      },
      workspace: {
        kind: 'workspace_snapshot',
        ref: 'workspace-snapshot-12',
      },
      target: {
        snapshotId: 'maka-ahe-snapshot-1',
        sourceLabel: 'git:abc123',
      },
    };

    assert.deepEqual(validateExecutionEvidenceRef(ref), { ok: true, value: ref });
    assert.equal(isExecutionEvidenceRef(ref), true);
  });

  it('represents honest partial knowledge without inventing child identities', () => {
    const executionOnly = {
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      execution: { sessionId: 'session-1' },
    };
    const taskOnly = {
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      task: { taskRunId: 'task-run-1' },
    };

    assert.equal(validateExecutionEvidenceRef(executionOnly).ok, true);
    assert.equal(validateExecutionEvidenceRef(taskOnly).ok, true);
  });

  it('requires an execution or task identity lane', () => {
    const result = validateExecutionEvidenceRef({
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      target: { snapshotId: 'snapshot-1' },
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert(result.errors.some((error) => error.path === 'ref'));
  });

  it('rejects malformed ids, schema versions, cursors, and revision refs', () => {
    const result = validateExecutionEvidenceRef({
      schemaVersion: 'maka.execution_evidence_ref.v2',
      execution: { sessionId: ' ', invocationId: '' },
      runtimeCoverage: {
        highWater: {
          ledger: 'task_event',
          streamId: '',
          sequence: 1.5,
          eventId: '',
        },
        eventCount: 0,
      },
      workspace: { kind: 'unknown', ref: '', dirty: 'yes' },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      const paths = new Set(result.errors.map((error) => error.path));
      assert(paths.has('schemaVersion'));
      assert(paths.has('execution.sessionId'));
      assert(paths.has('execution.invocationId'));
      assert(paths.has('runtimeCoverage.highWater.ledger'));
      assert(paths.has('runtimeCoverage.highWater.streamId'));
      assert(paths.has('runtimeCoverage.highWater.sequence'));
      assert(paths.has('runtimeCoverage.highWater.eventId'));
      assert(paths.has('runtimeCoverage.eventCount'));
      assert(paths.has('workspace.kind'));
      assert(paths.has('workspace.ref'));
      assert(paths.has('workspace.dirty'));
    }
  });

  it('rejects inverted, mixed-stream, and conflicting coverage', () => {
    const inverted = validateExecutionEvidenceRef({
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      execution: { sessionId: 'session-1', agentRunId: 'run-1' },
      runtimeCoverage: {
        lowWater: runtimeCursor(5, 'event-5'),
        highWater: runtimeCursor(4, 'event-4'),
      },
    });
    const mixed = validateExecutionEvidenceRef({
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      execution: { sessionId: 'session-1' },
      runtimeCoverage: {
        lowWater: runtimeCursor(1, 'event-1'),
        highWater: { ...runtimeCursor(2, 'event-2'), streamId: 'run-2' },
      },
    });
    const conflict = validateExecutionEvidenceRef({
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      execution: { sessionId: 'session-1' },
      runtimeCoverage: {
        lowWater: runtimeCursor(2, 'event-a'),
        highWater: runtimeCursor(2, 'event-b'),
      },
    });

    assert.equal(inverted.ok, false);
    assert.equal(mixed.ok, false);
    assert.equal(conflict.ok, false);
  });

  it('binds Runtime and Task coverage streams to known run identities', () => {
    const result = validateExecutionEvidenceRef({
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      execution: { sessionId: 'session-1', agentRunId: 'run-expected' },
      task: { taskRunId: 'task-run-expected' },
      runtimeCoverage: { highWater: runtimeCursor(1, 'event-1') },
      taskCoverage: { highWater: taskCursor(1, 'task-event-1') },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert(result.errors.some((error) => error.path === 'runtimeCoverage.highWater.streamId'));
      assert(result.errors.some((error) => error.path === 'taskCoverage.highWater.streamId'));
    }
  });

  it('orders only cursors in the same stream and never orders by event id', () => {
    const first = runtimeCursor(1, 'z-event');
    const second = runtimeCursor(2, 'a-event');

    assert.equal(executionLogCursorsShareStream(first, second), true);
    assert.equal(compareExecutionLogCursors(first, second), 'before');
    assert.equal(compareExecutionLogCursors(second, first), 'after');
    assert.equal(compareExecutionLogCursors(first, { ...first, eventId: undefined }), 'equal');
    assert.equal(
      compareExecutionLogCursors(first, { ...first, eventId: 'other-event' }),
      'conflict',
    );
    assert.equal(
      compareExecutionLogCursors(first, { ...first, streamId: 'run-2' }),
      'incomparable',
    );
    assert.equal(compareExecutionLogCursors(first, taskCursor(1, 'task-event-1')), 'incomparable');
    assert.equal(
      compareExecutionLogCursors(first, {
        ...first,
        ledger: 'runtime_event_projection',
      }),
      'incomparable',
    );
  });
});

function runtimeCursor(sequence: number, eventId?: string): ExecutionLogCursor {
  return {
    ledger: 'runtime_event',
    streamId: 'run-1',
    sequence,
    ...(eventId ? { eventId } : {}),
  };
}

function taskCursor(sequence: number, eventId?: string): ExecutionLogCursor {
  return {
    ledger: 'task_event',
    streamId: 'task-run-1',
    sequence,
    ...(eventId ? { eventId } : {}),
  };
}
