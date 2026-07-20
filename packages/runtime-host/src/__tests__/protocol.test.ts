import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  HOST_OPERATION_SPECS,
  negotiateProtocol,
  ProtocolFrameDecoder,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_LIVE_DELTA_MAX_BYTES,
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

  test('declares subscription open non-retryable and decodes its domain input', () => {
    assert.equal(HOST_OPERATION_SPECS['subscription.open'].retry, 'none');
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'subscription-open-1',
        operation: 'subscription.open',
        input: { sessionId: 'session-1' },
      }),
      {
        requestId: 'subscription-open-1',
        operation: 'subscription.open',
        input: { sessionId: 'session-1' },
      },
    );
  });

  test('routes Interaction answers only by stable Interaction identity', () => {
    const frame = {
      requestId: 'interaction-answer-1',
      operation: 'interaction.answer' as const,
      input: {
        interactionId: 'interaction-1',
        answer: { kind: 'question' as const, answers: ['yes'] },
      },
    };
    assert.deepEqual(decodeClientFrame(frame), frame);
    assert.throws(
      () =>
        decodeClientFrame({
          ...frame,
          input: { ...frame.input, sessionId: 'session-1' },
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

  test('keeps Session continuity snapshots closed to canonical identity and root Turn', () => {
    const frame = sessionProjectionFrame();
    assert.doesNotThrow(() => decodeHostFrame(frame));
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            transcript: [{ role: 'assistant', text: 'private' }],
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          snapshot: {
            ...frame.snapshot,
            interaction: { kind: 'permission', args: { path: '/private' } },
          },
        }),
      isInvalidFrame,
    );
  });

  test('rejects Session continuity root Turns from another Session', () => {
    const projection = sessionProjectionFrame();
    assert.doesNotThrow(() => decodeHostFrame(projection));
    const snapshot = {
      ...projection.snapshot,
      rootTurn: {
        ...projection.snapshot.rootTurn,
        sessionId: 'session-2',
      },
    };
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'subscription-open-2',
          operation: 'subscription.open',
          ok: true,
          result: {
            hostEpoch: 'epoch-1',
            subscriptionId: 'subscription-1',
            nextSequence: 1,
            snapshot,
          },
        }),
      isInvalidFrame,
    );
    assert.throws(() => decodeHostFrame({ ...projection, snapshot }), isInvalidFrame);
  });

  test('rejects private delta fields and enforces the text limit in UTF-8 bytes', () => {
    const frame = sessionDeltaFrame('visible');
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          delta: { ...frame.delta, signature: 'private-signature' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          delta: { ...frame.delta, toolArgs: { path: '/private' } },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame(
          sessionDeltaFrame('界'.repeat(Math.floor(SESSION_LIVE_DELTA_MAX_BYTES / 3) + 1)),
        ),
      isInvalidFrame,
    );
    const decoded = decodeHostFrame(sessionDeltaFrame('a'.repeat(SESSION_LIVE_DELTA_MAX_BYTES)));
    assert.equal('kind' in decoded && decoded.kind, 'subscription.session_delta');
  });
});

function sessionProjectionFrame() {
  return {
    kind: 'subscription.session_projection' as const,
    hostEpoch: 'epoch-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: {
        sessionId: 'session-1',
        status: 'running' as const,
        createdAt: 1,
        lastUsedAt: 2,
        isArchived: false,
      },
      projectionRevision: 1,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running' as const,
      },
      interactions: { pending: [] },
    },
  };
}

function sessionDeltaFrame(text: string) {
  return {
    kind: 'subscription.session_delta' as const,
    hostEpoch: 'epoch-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    sessionId: 'session-1',
    delta: {
      kind: 'text' as const,
      turnId: 'turn-1',
      runId: 'run-1',
      messageId: 'message-1',
      text,
    },
  };
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
