import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LOCAL_MEMORY_MAX_BYTES } from '@maka/core/local-memory';
import {
  decodeClientFrame,
  decodeHostFrame,
  encodeMemoryQueryResult,
  encodeProtocolFrame,
  HOST_OPERATION_SPECS,
  MEMORY_ENTRY_CONTENT_MAX_BYTES,
  MEMORY_TITLE_MAX_BYTES,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

const revision = `sha256:${'a'.repeat(64)}` as const;

describe('Memory protocol', () => {
  test('registers only ready-scoped query and non-retryable mutate operations', () => {
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter((key) => key.startsWith('memory.')),
      ['memory.query', 'memory.mutate'],
    );
    assert.deepEqual(metadata('memory.query'), {
      mode: 'query',
      retry: 'safe',
      admission: 'ready',
    });
    assert.deepEqual(metadata('memory.mutate'), {
      mode: 'command',
      retry: 'none',
      admission: 'ready',
    });

    assert.doesNotThrow(() => request('memory.query', {}));
    assert.throws(() => request('memory.query', { kind: 'get' }), isInvalidFrame);
  });

  test('accepts exactly the six bounded mutation shapes with nullable absence CAS', () => {
    for (const input of [
      { expectedRevision: null, mutation: { kind: 'save', contentBase64: '' } },
      {
        expectedRevision: revision,
        mutation: {
          kind: 'propose',
          title: 'Color preference',
          content: 'Prefer dark mode.',
          scope: 'session',
          sourceTurnId: 'turn-1',
        },
      },
      {
        expectedRevision: revision,
        mutation: {
          kind: 'remember',
          title: 'Response style',
          content: 'Keep answers concise.',
          scope: 'workspace',
        },
      },
      {
        expectedRevision: revision,
        mutation: { kind: 'approve', entryId: '自定义提案' },
      },
      {
        expectedRevision: revision,
        mutation: { kind: 'reject', entryId: '手写提案' },
      },
      {
        expectedRevision: revision,
        mutation: { kind: 'set_status', entryId: 'proposal-abc', target: 'archived' },
      },
      {
        expectedRevision: revision,
        mutation: { kind: 'set_status', entryId: '我的偏好', target: 'active' },
      },
    ]) {
      assert.doesNotThrow(() => request('memory.mutate', input));
    }

    for (const input of [
      { expectedRevision: revision, mutation: { kind: 'reset' } },
      {
        expectedRevision: revision,
        mutation: { kind: 'save', contentBase64: '', force: true },
      },
      {
        expectedRevision: revision,
        mutation: { kind: 'approve', entryId: '' },
      },
      {
        expectedRevision: revision,
        mutation: { kind: 'set_status', entryId: 'mem-abc', target: 'proposal' },
      },
      {
        expectedRevision: revision,
        mutation: {
          kind: 'remember',
          title: 'x'.repeat(MEMORY_TITLE_MAX_BYTES + 1),
          content: 'bounded',
          scope: 'workspace',
        },
      },
      {
        expectedRevision: revision,
        mutation: {
          kind: 'propose',
          title: 'bounded',
          content: 'x'.repeat(MEMORY_ENTRY_CONTENT_MAX_BYTES + 1),
          scope: 'workspace',
        },
      },
      {
        expectedRevision: revision,
        mutation: {
          kind: 'save',
          contentBase64: Buffer.alloc(LOCAL_MEMORY_MAX_BYTES + 1).toString('base64'),
        },
      },
      {
        expectedRevision: `sha256:${'A'.repeat(64)}`,
        mutation: { kind: 'reject', entryId: 'proposal-abc' },
      },
    ]) {
      assert.throws(() => request('memory.mutate', input), isInvalidFrame);
    }
  });

  test('closes query and mutation outcomes while preserving exact document bytes in one frame', () => {
    const content = Buffer.alloc(LOCAL_MEMORY_MAX_BYTES, 0x78);
    const contentBase64 = content.toString('base64');
    for (const result of [
      { kind: 'blocked', reason: 'incognito_active' },
      { kind: 'missing', revision: null },
      { kind: 'safe_mode', revision, reason: 'oversize' },
      { kind: 'safe_mode', revision, reason: 'invalid_utf8' },
      { kind: 'document', revision, contentBase64 },
    ]) {
      assert.doesNotThrow(() => response('memory.query', result));
    }
    for (const result of [
      { kind: 'committed', revision },
      { kind: 'unchanged', revision },
      { kind: 'revision_conflict', expectedRevision: null, actualRevision: revision },
      { kind: 'rejected', reason: 'invalid_transition' },
      { kind: 'rejected', reason: 'invalid_id' },
      { kind: 'rejected', reason: 'invalid_content' },
      { kind: 'rejected', reason: 'not_pending' },
    ]) {
      assert.doesNotThrow(() => response('memory.mutate', result));
    }

    const encoded = encodeMemoryQueryResult({ kind: 'document', revision, contentBase64 });
    assert.equal(encoded.kind, 'document');
    if (encoded.kind !== 'document') assert.fail('Encoded Memory document changed kind');
    assert.deepEqual(Buffer.from(encoded.contentBase64, 'base64'), content);
    assert.ok(
      encodeProtocolFrame({
        requestId: 'memory-query',
        operation: 'memory.query',
        ok: true,
        result: encoded,
      }).byteLength <= RUNTIME_HOST_MAX_FRAME_BYTES,
    );

    for (const result of [
      { kind: 'missing' },
      { kind: 'safe_mode', revision, reason: 'oversize', contentBase64: '' },
      { kind: 'document', revision, contentBase64: 'YR==' },
      { kind: 'document', revision, contentBase64: Buffer.from([0xff]).toString('base64') },
      { kind: 'revision_conflict', expectedRevision: 'missing', actualRevision: revision },
      { kind: 'rejected', reason: 'unknown' },
      { kind: 'rejected', reason: 'empty_content' },
      { kind: 'rejected', reason: 'not_proposal' },
    ]) {
      const operation =
        result.kind === 'revision_conflict' || result.kind === 'rejected'
          ? 'memory.mutate'
          : 'memory.query';
      assert.throws(() => response(operation, result), isInvalidFrame);
    }
  });
});

function metadata(key: 'memory.query' | 'memory.mutate') {
  const { mode, retry, admission } = HOST_OPERATION_SPECS[key];
  return { mode, retry, admission };
}

function request(operation: 'memory.query' | 'memory.mutate', input: unknown): void {
  decodeClientFrame({ requestId: 'request', operation, input });
}

function response(operation: 'memory.query' | 'memory.mutate', result: unknown): void {
  decodeHostFrame({ requestId: 'response', operation, ok: true, result });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
