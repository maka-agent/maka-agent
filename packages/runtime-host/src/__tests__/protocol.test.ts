import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  negotiateProtocol,
  ProtocolFrameDecoder,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

describe('Runtime Host bootstrap protocol', () => {
  test('selects the highest mutually supported protocol and rejects a gap', () => {
    assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }), 3);
    assert.equal(negotiateProtocol({ min: 1, max: 1 }, { min: 2, max: 2 }), undefined);
  });

  test('decodes split UTF-8 and multiple newline-delimited frames without an unbounded tail', () => {
    const decoder = new ProtocolFrameDecoder();
    const wire = Buffer.from(
      `${JSON.stringify({ kind: 'hello', clientInstanceId: '客户端', surface: 'tui', protocolMin: 1, protocolMax: 1 })}\n` +
        `${JSON.stringify({ requestId: 'status-1', operation: 'host.status', input: {} })}\n`,
    );
    const split = wire.indexOf(Buffer.from('端')) + 1;
    assert.deepEqual(decoder.push(wire.subarray(0, split)), []);
    const frames = decoder.push(wire.subarray(split));
    assert.equal(frames.length, 2);
    assert.deepEqual(decodeClientFrame(frames[0]), {
      kind: 'hello',
      clientInstanceId: '客户端',
      surface: 'tui',
      protocolMin: 1,
      protocolMax: 1,
    });
    assert.deepEqual(decodeClientFrame(frames[1]), {
      requestId: 'status-1',
      operation: 'host.status',
      input: {},
    });
    decoder.end();
  });

  test('keeps the operation registry closed at request and response boundaries', () => {
    assert.throws(
      () => decodeClientFrame({ requestId: 'request-1', operation: 'store.read', input: {} }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-2',
          operation: 'turn.query',
          input: { sessionId: 'session-1', turnId: 'turn-1', path: '/tmp/private' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-3',
          operation: 'turn.query',
          ok: false,
          error: { code: 'session_busy', message: 'busy' },
        }),
      isInvalidFrame,
    );
  });

  test('rejects terminal snapshots with fields from another terminal variant', () => {
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-4',
          operation: 'turn.query',
          ok: true,
          result: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            runId: 'run-1',
            status: 'completed',
            terminalEventId: 'event-1',
            abortSource: 'user',
          },
        }),
      isInvalidFrame,
    );
  });

  test('rejects a frame before buffering more than the byte cap', () => {
    const decoder = new ProtocolFrameDecoder();
    assert.throws(
      () => decoder.push(Buffer.alloc(RUNTIME_HOST_MAX_FRAME_BYTES + 1, 0x61)),
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'frame_too_large',
    );
  });
});

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
