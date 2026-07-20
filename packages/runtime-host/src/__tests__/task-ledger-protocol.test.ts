import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  encodeTaskLedgerQueryResult,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
  TASK_LEDGER_CURSOR_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_ITEMS,
} from '../protocol/index.js';
import {
  createUnavailableDomainOperationHandlers,
  type TaskLedgerOperationHandlerMap,
} from '../server/operation-dispatcher.js';

const revision = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
const nextRevision = `sha256:${'b'.repeat(64)}` as `sha256:${string}`;

describe('Task Ledger protocol', () => {
  test('registers only the retry-safe session query with its closed errors and handler key', () => {
    const spec = HOST_OPERATION_SPECS['task.ledger.query'];
    assert.equal(spec.mode, 'query');
    assert.equal(spec.retry, 'safe');
    assert.equal(spec.admission, 'session');
    assert.deepEqual(spec.errors, [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'internal_failure',
      'invalid_request',
      'persistence_failed',
    ]);
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter((key) => key.startsWith('task.ledger.')),
      ['task.ledger.query'],
    );

    const handlers = createUnavailableDomainOperationHandlers();
    assert.equal(typeof handlers['task.ledger.query'], 'function');
    const typed = {
      'task.ledger.query': async () => ({
        ok: true as const,
        result: { kind: 'task' as const, sessionId: 'session-1', revision, task: null },
      }),
    } satisfies TaskLedgerOperationHandlerMap;
    assert.deepEqual(Object.keys(typed), ['task.ledger.query']);
  });

  test('accepts exactly list start, list continuation, and get inputs', () => {
    for (const input of [
      { kind: 'list_start', sessionId: 'session-1' },
      { kind: 'list_continue', sessionId: 'session-1', revision, cursor: 'opaque:2' },
      { kind: 'get', sessionId: 'session-1', taskRef: 'T1.2' },
    ]) {
      assert.doesNotThrow(() => taskLedgerRequest(input));
    }
    for (const input of [
      { kind: 'list', sessionId: 'session-1' },
      { kind: 'list_start', sessionId: 'session-1', cursor: '0' },
      { kind: 'list_continue', sessionId: 'session-1', revision, cursor: 'x', limit: 10 },
      { kind: 'list_continue', sessionId: 'session-1', revision: 'a'.repeat(64), cursor: 'x' },
      {
        kind: 'list_continue',
        sessionId: 'session-1',
        revision,
        cursor: '界'.repeat(Math.floor(TASK_LEDGER_CURSOR_MAX_BYTES / 3) + 1),
      },
      { kind: 'get', sessionId: 'session-1', taskRef: '../events.jsonl' },
      { kind: 'list_start', sessionId: '../outside' },
      { kind: 'create', sessionId: 'session-1', subject: 'No mutations' },
    ]) {
      assert.throws(() => taskLedgerRequest(input), isInvalidFrame);
    }
  });

  test('decodes only exact safe task DTOs and closed result variants', () => {
    const task = validTask();
    assert.doesNotThrow(() =>
      taskLedgerResponse({
        kind: 'page',
        sessionId: 'session-1',
        revision,
        tasks: [task],
        nextCursor: null,
      }),
    );
    assert.doesNotThrow(() =>
      taskLedgerResponse({
        kind: 'revision_changed',
        expected: revision,
        actual: nextRevision,
      }),
    );
    assert.doesNotThrow(() =>
      taskLedgerResponse({
        kind: 'task',
        sessionId: 'session-1',
        revision,
        task: null,
      }),
    );

    for (const invalidTask of [
      { ...task, rawEventPath: '/private/task-events.jsonl' },
      { ...task, subject: 'x'.repeat(201) },
      { ...task, status: 'done' },
      { ...task, status: 'blocked' },
      { ...task, owner: { actor: 'child_agent', agentId: 'child-1', socketPath: '/tmp/a' } },
      { ...task, resumeTrust: 'probably_ok' },
    ]) {
      assert.throws(
        () =>
          taskLedgerResponse({
            kind: 'task',
            sessionId: 'session-1',
            revision,
            task: invalidTask,
          }),
        isInvalidFrame,
      );
    }
    assert.throws(
      () =>
        taskLedgerResponse({
          kind: 'revision_changed',
          expected: revision,
          actual: nextRevision,
          cursor: 'x',
        }),
      isInvalidFrame,
    );
    assert.throws(
      () => taskLedgerResponse({ kind: 'subscription', sessionId: 'session-1', revision }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'task-ledger-error',
          operation: 'task.ledger.query',
          ok: false,
          error: { code: 'not_found', message: 'not declared' },
        }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'task-ledger-error',
        operation: 'task.ledger.query',
        ok: false,
        error: { code: 'persistence_failed', message: 'read failed' },
      }),
    );
  });

  test('sanitizes producer DTOs while the decoder rejects unsanitized wire tasks', () => {
    const unsafe = {
      ...validTask(),
      subject:
        'Inspect <task-ledger hidden>data</task-ledger> ghp_abcdefghijklmnopqrstuvwxyz123456',
    };
    const encoded = encodeTaskLedgerQueryResult({
      kind: 'task',
      sessionId: 'session-1',
      revision,
      task: unsafe,
    });
    assert.equal(encoded.kind, 'task');
    assert.ok(encoded.kind === 'task' && encoded.task);
    assert.equal(encoded.task.subject.includes('<task-ledger'), false);
    assert.equal(encoded.task.subject.includes('ghp_'), false);
    assert.throws(
      () => taskLedgerResponse({ kind: 'task', sessionId: 'session-1', revision, task: unsafe }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() => taskLedgerResponse(encoded));
  });

  test('enforces item and JSON-byte page caps in both producer and wire codecs', () => {
    const tooMany = Array.from({ length: TASK_LEDGER_PAGE_MAX_ITEMS + 1 }, (_, index) =>
      validTask(index),
    );
    const byteHeavy = Array.from({ length: 48 }, (_, index) => ({
      ...validTask(index),
      status: 'completed' as const,
      subject: 'subject '.repeat(25).trim(),
      completionEvidence: 'evidence '.repeat(125).trim(),
      endedAt: 3,
    }));
    const oversizedPage = {
      kind: 'page',
      sessionId: 'session-1',
      revision,
      tasks: byteHeavy,
      nextCursor: null,
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversizedPage), 'utf8') > TASK_LEDGER_PAGE_MAX_BYTES,
    );

    for (const result of [{ ...oversizedPage, tasks: tooMany }, oversizedPage]) {
      assert.throws(() => encodeTaskLedgerQueryResult(result), isInvalidFrame);
      assert.throws(() => taskLedgerResponse(result), isInvalidFrame);
    }
  });
});

function validTask(index = 0) {
  return {
    id: `task-${index}`,
    key: `T${index + 1}`,
    subject: `Task ${index}`,
    status: 'in_progress' as const,
    createdAt: 1,
    updatedAt: 2,
    owner: { actor: 'main_agent' as const, runId: 'run-1' },
  };
}

function taskLedgerRequest(input: unknown): void {
  decodeClientFrame({ requestId: 'task-ledger-request', operation: 'task.ledger.query', input });
}

function taskLedgerResponse(result: unknown): void {
  decodeHostFrame({
    requestId: 'task-ledger-response',
    operation: 'task.ledger.query',
    ok: true,
    result,
  });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
