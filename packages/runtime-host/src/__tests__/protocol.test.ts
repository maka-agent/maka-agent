import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
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
      `${JSON.stringify({ kind: 'hello', clientInstanceId: '客户端', surface: 'tui', protocolMin: 1, protocolMax: 1 })}\n`
      + `${JSON.stringify({ kind: 'status', requestId: 'status-1' })}\n`,
    );
    const split = wire.indexOf(Buffer.from('端')) + 1;
    assert.deepEqual(decoder.push(wire.subarray(0, split)), []);
    const frames = decoder.push(wire.subarray(split));
    assert.equal(frames.length, 2);
    assert.equal(decodeClientFrame(frames[0]).kind, 'hello');
    assert.deepEqual(decodeClientFrame(frames[1]), { kind: 'status', requestId: 'status-1' });
    decoder.end();
  });

  test('rejects a frame before buffering more than the byte cap', () => {
    const decoder = new ProtocolFrameDecoder();
    assert.throws(
      () => decoder.push(Buffer.alloc(RUNTIME_HOST_MAX_FRAME_BYTES + 1, 0x61)),
      (error: unknown) => error instanceof RuntimeHostProtocolError && error.code === 'frame_too_large',
    );
  });
});
