import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  encodeProtocolFrame,
  HOST_OPERATION_SPECS,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RuntimeHostProtocolError,
  SKILL_CATALOG_PAGE_MAX_ITEMS,
  SKILL_CATALOG_PREVIEW_CONTENT_MAX_BYTES,
} from '../protocol/index.js';

const rawDigest = 'a'.repeat(64);
const digest = `sha256:${rawDigest}`;
const revision = digest;

describe('Skill catalog protocol', () => {
  test('registers the four operations with closed ready admission and retry metadata', () => {
    const queries = ['skill.catalog.query', 'skill.catalog.preview-update'] as const;
    const commands = ['skill.catalog.refresh', 'skill.catalog.mutate'] as const;

    for (const operation of queries) {
      const spec = HOST_OPERATION_SPECS[operation];
      assert.equal(spec.mode, 'query');
      assert.equal(spec.retry, 'safe');
      assert.equal(spec.admission, 'ready');
      assert.deepEqual(spec.errors, [
        'host_not_ready',
        'host_draining',
        'operation_unavailable',
        'internal_failure',
        'invalid_request',
      ]);
    }
    for (const operation of commands) {
      const spec = HOST_OPERATION_SPECS[operation];
      assert.equal(spec.mode, 'command');
      assert.equal(spec.retry, 'none');
      assert.equal(spec.admission, 'ready');
      assert.deepEqual(spec.errors, [
        'host_not_ready',
        'host_draining',
        'operation_unavailable',
        'internal_failure',
        'invalid_request',
        'persistence_failed',
        'commit_outcome_unknown',
      ]);
    }
  });

  test('accepts only exact query shapes and canonical revisions', () => {
    assert.doesNotThrow(() =>
      decodeClientFrame({
        requestId: 'skills-1',
        operation: 'skill.catalog.query',
        input: { kind: 'start', view: 'installed' },
      }),
    );
    assert.doesNotThrow(() =>
      decodeClientFrame({
        requestId: 'skills-2',
        operation: 'skill.catalog.query',
        input: { kind: 'continue', view: 'sources', revision, cursor: 'next-1' },
      }),
    );
    for (const input of [
      { kind: 'start', view: 'installed', path: '/tmp/skills' },
      { kind: 'start', view: 'installed', cwd: '/tmp' },
      { kind: 'continue', view: 'sources', revision, cursor: 'next-1', body: 'secret' },
      { kind: 'continue', view: 'sources', revision: `sha256:${'A'.repeat(64)}`, cursor: 'x' },
      { kind: 'continue', view: 'sources', revision: rawDigest, cursor: 'x' },
    ]) {
      assert.throws(
        () =>
          decodeClientFrame({
            requestId: 'skills-invalid',
            operation: 'skill.catalog.query',
            input,
          }),
        isInvalidFrame,
      );
    }
  });

  test('matches each page view to its closed item kind and enforces page bounds', () => {
    const source = {
      kind: 'source' as const,
      sourceType: 'bundled' as const,
      id: 'skill.one',
      name: 'Skill One',
      description: 'A source entry',
      category: 'writing',
      contentSha256: digest,
      installed: false,
    };
    const page = {
      kind: 'page' as const,
      view: 'sources' as const,
      revision,
      items: [source],
      nextCursor: null,
    };
    assert.doesNotThrow(() => skillQueryResponse(page));
    assert.throws(() => skillQueryResponse({ ...page, view: 'installed' }), isInvalidFrame);
    assert.throws(
      () => skillQueryResponse({ ...page, items: [{ ...source, path: '/private/skill' }] }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        skillQueryResponse({
          ...page,
          items: [{ ...source, contentSha256: `sha256:${'A'.repeat(64)}` }],
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        skillQueryResponse({
          ...page,
          items: Array.from({ length: SKILL_CATALOG_PAGE_MAX_ITEMS + 1 }, () => source),
        }),
      isInvalidFrame,
    );
  });

  test('closes mutation and rejection unions', () => {
    const mutate = (mutation: unknown) =>
      decodeClientFrame({
        requestId: 'skills-mutate',
        operation: 'skill.catalog.mutate',
        input: { expectedRevision: revision, mutation },
      });
    assert.doesNotThrow(() => mutate({ kind: 'create_starter' }));
    assert.doesNotThrow(() => mutate({ kind: 'delete', skillId: `a${'b'.repeat(80)}` }));
    assert.doesNotThrow(() =>
      mutate({
        kind: 'update_managed',
        skillId: 'skill.one',
        expectedCurrentSha256: digest,
        expectedSourceSha256: digest,
        force: false,
      }),
    );
    assert.throws(
      () =>
        mutate({
          kind: 'install',
          sourceType: 'managed',
          sourceId: 'skill.one',
          expectedSourceSha256: rawDigest,
        }),
      isInvalidFrame,
    );
    assert.throws(() => mutate({ kind: 'import_path', path: '/tmp/skill' }), isInvalidFrame);
    assert.throws(() => mutate({ kind: 'delete', skillId: '../skill' }), isInvalidFrame);
    assert.throws(() => mutate({ kind: 'delete', skillId: '.hidden' }), isInvalidFrame);
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'skills-mutate',
          operation: 'skill.catalog.mutate',
          ok: true,
          result: { kind: 'rejected', reason: 'permission_denied' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'skills-preview',
          operation: 'skill.catalog.preview-update',
          ok: true,
          result: { kind: 'rejected', reason: 'state_error' },
        }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'skills-preview-large',
        operation: 'skill.catalog.preview-update',
        ok: true,
        result: { kind: 'rejected', reason: 'preview_too_large' },
      }),
    );
  });

  test('bounds both preview contents by UTF-8 bytes and keeps maximum ASCII output frame-safe', () => {
    const preview = (currentContent: string, sourceContent = 'source') => ({
      requestId: 'skills-preview',
      operation: 'skill.catalog.preview-update' as const,
      ok: true as const,
      result: {
        kind: 'preview' as const,
        revision,
        currentContent,
        sourceContent,
        currentContentSha256: digest,
        sourceContentSha256: digest,
      },
    });
    const maximum = 'a'.repeat(SKILL_CATALOG_PREVIEW_CONTENT_MAX_BYTES);
    const decoded = decodeHostFrame(preview(maximum, maximum));
    assert.ok(encodeProtocolFrame(decoded).byteLength <= RUNTIME_HOST_MAX_FRAME_BYTES);
    assert.throws(
      () =>
        decodeHostFrame(
          preview('界'.repeat(Math.floor(SKILL_CATALOG_PREVIEW_CONTENT_MAX_BYTES / 3) + 1)),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () => decodeHostFrame(preview('\0'.repeat(SKILL_CATALOG_PREVIEW_CONTENT_MAX_BYTES), '\0')),
      isInvalidFrame,
    );
  });
});

function skillQueryResponse(result: unknown): void {
  decodeHostFrame({
    requestId: 'skills-page',
    operation: 'skill.catalog.query',
    ok: true,
    result,
  });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
