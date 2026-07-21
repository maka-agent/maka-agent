import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_PTY_COLS as RUNTIME_MAX_PTY_COLS,
  MAX_PTY_ROWS as RUNTIME_MAX_PTY_ROWS,
  MIN_PTY_COLS as RUNTIME_MIN_PTY_COLS,
  MIN_PTY_ROWS as RUNTIME_MIN_PTY_ROWS,
  shellRunResourceRef as runtimeShellRunResourceRef,
} from '@maka/runtime';
import {
  decodeClientFrame,
  decodeHostFrame,
  encodeProtocolFrame,
  HOST_OPERATION_SPECS,
  MAX_PTY_COLS,
  MAX_PTY_ROWS,
  MIN_PTY_COLS,
  MIN_PTY_ROWS,
  ProtocolFrameDecoder,
  PTY_CURSOR_MAX_BYTES,
  PTY_INPUT_MAX_BYTES,
  RUNTIME_RESOURCE_RESULT_MAX_BYTES,
  RuntimeHostProtocolError,
  runtimeResourceRef,
  type PtyControlInput,
  type PtyControlResult,
  type RuntimeResourceStopResult,
} from '../protocol/index.js';

const ref = runtimeResourceRef('shell-run-1');

describe('Runtime Resource protocol', () => {
  test('registers the closed operation family with its retry and admission contract', () => {
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter(
        (key) => key.startsWith('resource.') || key.startsWith('pty.'),
      ),
      [
        'resource.query',
        'resource.read',
        'resource.stop',
        'pty.acquire',
        'pty.release',
        'pty.control',
        'pty.read',
      ],
    );
    assert.deepEqual(metadata('resource.query'), ['query', 'safe', 'session']);
    assert.deepEqual(metadata('resource.read'), ['query', 'safe', 'session']);
    assert.deepEqual(metadata('resource.stop'), ['command', 'safe', 'session']);
    assert.deepEqual(metadata('pty.acquire'), ['control', 'none', 'session']);
    assert.deepEqual(metadata('pty.release'), ['control', 'none', 'session']);
    assert.deepEqual(metadata('pty.control'), ['control', 'none', 'session']);
    assert.deepEqual(metadata('pty.read'), ['query', 'safe', 'session']);

    assert.ok(HOST_OPERATION_SPECS['pty.acquire'].errors.includes('controller_held'));
    assert.ok(HOST_OPERATION_SPECS['pty.acquire'].errors.includes('resource_terminal'));
    assert.ok(HOST_OPERATION_SPECS['pty.control'].errors.includes('controller_invalid'));
  });

  test('round-trips canonical resource refs and rejects bare or malformed refs everywhere', () => {
    const requestFrame = {
      requestId: 'resource-query',
      operation: 'resource.query' as const,
      input: { sessionId: 'session-1', ref },
    };
    assert.deepEqual(decodeClientFrame(roundTrip(requestFrame)), requestFrame);

    const responseFrame = {
      requestId: 'pty-snapshot',
      operation: 'pty.read' as const,
      ok: true as const,
      result: { kind: 'snapshot' as const, resource: ptySnapshot(), cursor: 'cursor-1' },
    };
    assert.deepEqual(decodeHostFrame(roundTrip(responseFrame)), responseFrame);

    for (const invalidRef of ['shell-run-1', 'maka://runtime/background-tasks/', `${ref}/extra`]) {
      assert.throws(
        () => request('resource.query', { sessionId: 'session-1', ref: invalidRef }),
        isInvalidFrame,
      );
      assert.throws(
        () => response('resource.query', { ...ptyMetadata(), ref: invalidRef }),
        isInvalidFrame,
      );
      assert.throws(
        () =>
          response('pty.read', {
            kind: 'snapshot',
            resource: { ...ptySnapshot(), ref: invalidRef },
            cursor: 'cursor-1',
          }),
        isInvalidFrame,
      );
    }

    assert.throws(
      () =>
        request('resource.query', {
          sessionId: 'session-1',
          ref,
          argv: ['bash'],
        }),
      isInvalidFrame,
    );

    assert.doesNotThrow(() => runtimeResourceRef('x'.repeat(128)));
    for (const invalidId of ['', 'x'.repeat(129), 'shell.run']) {
      assert.throws(() => runtimeResourceRef(invalidId), /Invalid shell run id/);
    }
    assert.throws(
      () => request('resource.query', { sessionId: 'session-1', ref: `${ref}%2D` }),
      isInvalidFrame,
    );
  });

  test('uses the runtime PTY column and row boundaries for control and snapshots', () => {
    assert.deepEqual(
      [MIN_PTY_COLS, MAX_PTY_COLS, MIN_PTY_ROWS, MAX_PTY_ROWS, ref],
      [
        RUNTIME_MIN_PTY_COLS,
        RUNTIME_MAX_PTY_COLS,
        RUNTIME_MIN_PTY_ROWS,
        RUNTIME_MAX_PTY_ROWS,
        runtimeShellRunResourceRef('shell-run-1'),
      ],
    );
    const controllerId = 'controller-1';
    for (const resize of [
      { cols: MIN_PTY_COLS, rows: 24 },
      { cols: MAX_PTY_COLS, rows: 24 },
      { cols: 80, rows: MIN_PTY_ROWS },
      { cols: 80, rows: MAX_PTY_ROWS },
    ]) {
      assert.doesNotThrow(() =>
        request('pty.control', { sessionId: 'session-1', ref, controllerId, resize }),
      );
      assert.doesNotThrow(() =>
        response('resource.read', {
          ...ptySnapshot(),
          output: {
            ...ptyOutput(),
            ...resize,
            cursor: { x: 0, y: 0, visible: true },
          },
        }),
      );
    }

    for (const resize of [
      { cols: MIN_PTY_COLS - 1, rows: 24 },
      { cols: MAX_PTY_COLS + 1, rows: 24 },
      { cols: 80, rows: MIN_PTY_ROWS - 1 },
      { cols: 80, rows: MAX_PTY_ROWS + 1 },
    ]) {
      assert.throws(
        () => request('pty.control', { sessionId: 'session-1', ref, controllerId, resize }),
        isInvalidFrame,
      );
      assert.throws(
        () =>
          response('resource.read', {
            ...ptySnapshot(),
            output: {
              ...ptyOutput(),
              ...resize,
              cursor: { x: 0, y: 0, visible: true },
            },
          }),
        isInvalidFrame,
      );
    }
  });

  test('requires input or resize, and enforces the exact multibyte PTY input byte limit', () => {
    const base = { sessionId: 'session-1', ref, controllerId: 'controller-1' };
    const maximumInput = '😀'.repeat(PTY_INPUT_MAX_BYTES / 4);
    const inputOnly = { ...base, input: maximumInput } satisfies PtyControlInput;
    const resizeOnly = {
      ...base,
      resize: { cols: MIN_PTY_COLS, rows: MIN_PTY_ROWS },
    } satisfies PtyControlInput;
    const both = { ...inputOnly, resize: resizeOnly.resize } satisfies PtyControlInput;
    for (const input of [inputOnly, resizeOnly, both]) {
      const frame = { requestId: 'pty-input', operation: 'pty.control' as const, input };
      assert.deepEqual(decodeClientFrame(roundTrip(frame)), frame);
    }
    assert.equal(Buffer.byteLength(maximumInput, 'utf8'), PTY_INPUT_MAX_BYTES);

    const oversizedFrame = {
      requestId: 'pty-input-oversized',
      operation: 'pty.control' as const,
      input: { ...base, input: `${maximumInput}x` },
    };
    assert.equal(Buffer.byteLength(oversizedFrame.input.input, 'utf8'), PTY_INPUT_MAX_BYTES + 1);
    assert.throws(() => decodeClientFrame(roundTrip(oversizedFrame)), isInvalidFrame);
    assert.throws(() => request('pty.control', base), isInvalidFrame);

    const inputResult = {
      input: { accepted: true, bytes: PTY_INPUT_MAX_BYTES },
    } satisfies PtyControlResult;
    const resizeResult = {
      resize: { applied: true, changed: true },
    } satisfies PtyControlResult;
    const bothResult = { ...inputResult, ...resizeResult } satisfies PtyControlResult;
    for (const result of [inputResult, resizeResult, bothResult]) {
      assert.doesNotThrow(() => response('pty.control', result));
    }
  });

  test('accepts astral PTY input and rejects malformed surrogate input', () => {
    const base = { sessionId: 'session-1', ref, controllerId: 'controller-1' };
    assert.doesNotThrow(() => request('pty.control', { ...base, input: 'A😀B' }));

    for (const input of ['\ud800', '\udc00', 'A\ud800B', 'A\udc00B']) {
      assert.throws(() => request('pty.control', { ...base, input }), isInvalidFrame);
    }
  });

  test('accepts only terminal stop snapshots and rejects unknown output fields', () => {
    const terminal = {
      ...ptySnapshot(),
      status: 'cancelled',
      completedAt: 3,
      exitCode: 130,
      updatedAt: 3,
      revision: 2,
      operation: { kind: 'stop', applied: false },
    } as const satisfies RuntimeResourceStopResult;
    assert.doesNotThrow(() => response('resource.stop', terminal));
    assert.throws(
      () =>
        response('resource.stop', {
          ...ptySnapshot(),
          operation: { kind: 'stop', applied: true },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        response('resource.read', {
          ...ptySnapshot(),
          output: { ...ptyOutput(), nativeHandle: 7 },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () => response('resource.query', { ...ptyMetadata(), status: 'stopped' }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        response('resource.query', {
          ...ptyMetadata(),
          status: 'completed',
          completedAt: 3,
          exitCode: 1,
        }),
      isInvalidFrame,
    );
  });

  test('accepts only canonical snapshot and unchanged PTY reads with bounded cursors', () => {
    const maximumCursor = 'x'.repeat(PTY_CURSOR_MAX_BYTES);
    assert.doesNotThrow(() => request('pty.read', { sessionId: 'session-1', ref, cursor: null }));
    assert.doesNotThrow(() =>
      request('pty.read', { sessionId: 'session-1', ref, cursor: maximumCursor }),
    );
    assert.doesNotThrow(() =>
      response('pty.read', { kind: 'snapshot', resource: ptySnapshot(), cursor: maximumCursor }),
    );
    assert.doesNotThrow(() =>
      response('pty.read', { kind: 'unchanged', resource: ptyMetadata(), cursor: maximumCursor }),
    );

    assert.throws(
      () => request('pty.read', { sessionId: 'session-1', ref, cursor: `${maximumCursor}x` }),
      isInvalidFrame,
    );
    for (const removedResult of [
      {
        kind: 'delta',
        resource: ptyMetadata(),
        data: 'output',
        redacted: false,
        cursor: 'cursor-2',
      },
      { kind: 'reload_required', reason: 'gap' },
    ]) {
      assert.throws(() => response('pty.read', removedResult), isInvalidFrame);
    }

    const input = '😀'.repeat(PTY_INPUT_MAX_BYTES / 4);
    const control = decodeHostFrame(
      roundTrip({
        requestId: 'pty-control',
        operation: 'pty.control',
        ok: true,
        result: { input: { accepted: true, bytes: Buffer.byteLength(input, 'utf8') } },
      }),
    );
    assert.deepEqual(control, {
      requestId: 'pty-control',
      operation: 'pty.control',
      ok: true,
      result: { input: { accepted: true, bytes: Buffer.byteLength(input, 'utf8') } },
    });
    assert.equal(JSON.stringify(control).includes(input), false);
  });

  test('rejects canonical snapshots whose validated fields exceed the total result budget', () => {
    const oversized = {
      ...ptySnapshot(),
      output: {
        ...ptyOutput(),
        screen: 's'.repeat(24 * 1024),
        scrollback: 'b'.repeat(24 * 1024),
      },
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversized), 'utf8') > RUNTIME_RESOURCE_RESULT_MAX_BYTES,
    );
    assert.throws(() => response('resource.read', oversized), isInvalidFrame);
    assert.throws(
      () => response('pty.read', { kind: 'snapshot', resource: oversized, cursor: 'cursor-1' }),
      isInvalidFrame,
    );
  });
});

type ResourceOperation =
  | 'resource.query'
  | 'resource.read'
  | 'resource.stop'
  | 'pty.acquire'
  | 'pty.release'
  | 'pty.control'
  | 'pty.read';

function metadata(operation: ResourceOperation) {
  const { mode, retry, admission } = HOST_OPERATION_SPECS[operation];
  return [mode, retry, admission];
}

function request(operation: ResourceOperation, input: unknown): void {
  decodeClientFrame({ requestId: 'resource-request', operation, input });
}

function response(operation: ResourceOperation, result: unknown): void {
  decodeHostFrame({ requestId: 'resource-response', operation, ok: true, result });
}

function roundTrip(frame: Parameters<typeof encodeProtocolFrame>[0]): unknown {
  const decoder = new ProtocolFrameDecoder();
  const [decoded] = decoder.push(encodeProtocolFrame(frame));
  decoder.end();
  return decoded;
}

function ptyMetadata() {
  return {
    kind: 'shell_run' as const,
    ref,
    mode: 'pty' as const,
    status: 'running' as const,
    cwd: '/workspace',
    cmd: 'bash',
    startedAt: 1,
    updatedAt: 2,
    revision: 1,
  };
}

function ptySnapshot() {
  return { ...ptyMetadata(), output: ptyOutput() };
}

function ptyOutput() {
  return {
    mode: 'pty' as const,
    screen: '$ ',
    scrollback: '',
    cols: 80,
    rows: 24,
    cursor: { x: 2, y: 0, visible: true },
    alternateScreen: false,
    truncated: false,
    redacted: false,
  };
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
