import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  HOST_OPERATION_SPECS,
  negotiateProtocol,
  ProtocolFrameDecoder,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RUNTIME_POLICY_OPERATION_SPECS,
  RuntimeHostProtocolError,
} from '../protocol/index.js';
import { HOST_STATUS_OPERATION_SPECS } from '../protocol/host-status.js';
import { composeOperationSpecMaps } from '../protocol/operation-spec.js';

describe('Runtime Host bootstrap protocol', () => {
  test('selects the highest mutually supported protocol and rejects a gap', () => {
    assert.equal(negotiateProtocol({ min: 0, max: 0 }, { min: 0, max: 0 }), 0);
    assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }), 3);
    assert.equal(negotiateProtocol({ min: 0, max: 0 }, { min: 1, max: 1 }), undefined);
  });

  test('declares exactly the ten Runtime Policy operations in the current framework', () => {
    const queries = [
      'runtime.policy.query',
      'connection.catalog.query',
      'credential.vault.query',
    ] as const;
    const mutations = [
      'runtime.policy.mutate',
      'connection.catalog.create',
      'connection.catalog.update',
      'connection.catalog.remove',
      'connection.catalog.set-default-target',
      'credential.vault.set',
      'credential.vault.delete',
    ] as const;
    assert.deepEqual(
      Object.keys(RUNTIME_POLICY_OPERATION_SPECS).sort(),
      [...queries, ...mutations].sort(),
    );
    for (const operation of queries) {
      assert.equal(RUNTIME_POLICY_OPERATION_SPECS[operation].mode, 'query');
      assert.equal(RUNTIME_POLICY_OPERATION_SPECS[operation].availability, 'ready');
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('persistence_failed'));
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('internal_failure'));
    }
    for (const operation of mutations) {
      assert.equal(RUNTIME_POLICY_OPERATION_SPECS[operation].mode, 'command');
      assert.equal(RUNTIME_POLICY_OPERATION_SPECS[operation].availability, 'ready');
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('invalid_request'));
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('persistence_failed'));
      assert.ok(
        RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('commit_outcome_unknown'),
      );
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('internal_failure'));
    }
  });

  test('keeps Runtime Policy request and response codecs exact', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'policy-query',
        operation: 'runtime.policy.query',
        input: {},
      }),
      {
        requestId: 'policy-query',
        operation: 'runtime.policy.query',
        input: {},
      },
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'policy-query-extra',
          operation: 'runtime.policy.query',
          input: { secret: 'must-not-cross-wire' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'credential-status-secret',
          operation: 'credential.vault.query',
          ok: true,
          result: {
            kind: 'status',
            status: {
              locator: { scope: 'network_proxy', kind: 'password' },
              configured: false,
              credentialId: null,
              revision: null,
              updatedAt: null,
              secret: 'must-not-cross-wire',
            },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'undeclared-error',
          operation: 'runtime.policy.query',
          ok: false,
          error: { code: 'commit_outcome_unknown', message: 'not declared for query' },
        }),
      isInvalidFrame,
    );
  });

  test('decodes split UTF-8 and multiple newline-delimited frames without an unbounded tail', () => {
    const decoder = new ProtocolFrameDecoder();
    const wire = Buffer.from(
      `${JSON.stringify({ kind: 'hello', clientInstanceId: '客户端', surface: 'tui', protocolMin: 0, protocolMax: 0 })}\n` +
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
      protocolMin: 0,
      protocolMax: 0,
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
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-unknown-field',
          operation: 'host.status',
          ok: false,
          error: { code: 'host_draining', message: 'draining' },
          trace: 'private',
        }),
      isInvalidFrame,
    );
  });

  test('rejects duplicate operation keys while composing domain registries', () => {
    const composeUnchecked = composeOperationSpecMaps as (
      left: typeof HOST_STATUS_OPERATION_SPECS,
      right: typeof HOST_STATUS_OPERATION_SPECS,
    ) => unknown;
    assert.throws(
      () => composeUnchecked(HOST_STATUS_OPERATION_SPECS, HOST_STATUS_OPERATION_SPECS),
      /Duplicate Runtime Host operation key: host\.status/,
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
