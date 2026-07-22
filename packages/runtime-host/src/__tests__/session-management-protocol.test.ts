import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  SESSION_MANAGEMENT_LABEL_MAX_ITEMS,
  SESSION_MANAGEMENT_NAME_MAX_BYTES,
  SESSION_MANAGEMENT_OPERATION_SPECS,
  SESSION_MANAGEMENT_PAGE_DEFAULT_ITEMS,
  SESSION_MANAGEMENT_PAGE_MAX_ITEMS,
  SESSION_MANAGEMENT_RESULT_MAX_BYTES,
  decodeSessionManagementCreateInput,
  decodeSessionManagementMutation,
  decodeSessionManagementQueryInput,
  encodeSessionManagementCreateResult,
  encodeSessionManagementMutateResult,
  encodeSessionManagementQueryResult,
} from '../protocol/session-management.js';

describe('Session management protocol', () => {
  test('declares the closed operation contract and coordinator error surface', () => {
    assert.deepEqual(Object.keys(SESSION_MANAGEMENT_OPERATION_SPECS), [
      'session.query',
      'session.create',
      'session.mutate',
    ]);
    assert.deepEqual(metadata('session.query'), ['query', 'safe', 'ready']);
    assert.deepEqual(metadata('session.create'), ['command', 'semantic', 'ready']);
    assert.deepEqual(metadata('session.mutate'), ['command', 'safe', 'session']);
    assert.equal(SESSION_MANAGEMENT_PAGE_DEFAULT_ITEMS, 32);
    assert.equal(SESSION_MANAGEMENT_PAGE_MAX_ITEMS, 32);

    const declared = new Set(
      Object.values(SESSION_MANAGEMENT_OPERATION_SPECS).flatMap((spec) => spec.errors),
    );
    for (const code of [
      'operation_unavailable',
      'internal_failure',
      'invalid_request',
      'persistence_failed',
      'commit_outcome_unknown',
      'not_found',
      'session_busy',
      'operation_conflict',
    ] as const) {
      assert.equal(declared.has(code), true, `missing ${code}`);
    }
  });

  test('accepts only exact list/get queries with the bounded filter and opaque cursor', () => {
    assert.deepEqual(decodeSessionManagementQueryInput({ kind: 'list' }), {
      kind: 'list',
    });
    assert.deepEqual(
      decodeSessionManagementQueryInput({
        kind: 'list',
        filter: { isArchived: false, isFlagged: true, labelSlug: 'release' },
        cursor: 'opaque:page/2',
      }),
      {
        kind: 'list',
        filter: { isArchived: false, isFlagged: true, labelSlug: 'release' },
        cursor: 'opaque:page/2',
      },
    );
    assert.deepEqual(
      decodeSessionManagementQueryInput({
        kind: 'get',
        sessionId: 'session-1',
      }),
      {
        kind: 'get',
        sessionId: 'session-1',
      },
    );

    for (const input of [
      { kind: 'list', limit: 10 },
      { kind: 'list', filter: { workspaceRoot: '/private' } },
      { kind: 'list', filter: { isArchived: 1 } },
      { kind: 'list', cursor: '' },
      { kind: 'get', sessionId: 'session-1', transcript: true },
      { kind: 'history', sessionId: 'session-1' },
    ]) {
      assert.throws(() => decodeSessionManagementQueryInput(input), isInvalidFrame);
    }
  });

  test('requires stable create identity and closes default and explicit model targets', () => {
    assert.deepEqual(
      decodeSessionManagementCreateInput({
        sessionId: 'session-1',
        cwd: '/workspace/project',
        modelTarget: { kind: 'default' },
      }),
      {
        sessionId: 'session-1',
        cwd: '/workspace/project',
        modelTarget: { kind: 'default' },
      },
    );
    assert.doesNotThrow(() =>
      decodeSessionManagementCreateInput({
        sessionId: 'session-2',
        cwd: '/workspace/project',
        name: 'Protocol work',
        labels: ['runtime-host', 'protocol'],
        modelTarget: {
          kind: 'explicit',
          connectionSlug: 'openai-main',
          model: 'gpt-5.4',
        },
        thinkingLevel: 'high',
        permissionMode: 'execute',
        collaborationMode: 'plan',
      }),
    );

    for (const input of [
      { cwd: '/workspace/project', modelTarget: { kind: 'default' } },
      { sessionId: 'session-1', cwd: '/workspace/project' },
      {
        sessionId: 'session-1',
        cwd: '/workspace/project',
        modelTarget: { kind: 'default', model: 'gpt-5.4' },
      },
      {
        sessionId: 'session-1',
        cwd: '/workspace/project',
        modelTarget: { kind: 'explicit', connectionSlug: 'openai-main' },
      },
      {
        sessionId: 'session-1',
        cwd: '/workspace/project',
        modelTarget: { kind: 'default' },
        backend: 'ai-sdk',
      },
      {
        sessionId: 'session-1',
        cwd: '/workspace/project',
        modelTarget: { kind: 'default' },
        labels: Array(SESSION_MANAGEMENT_LABEL_MAX_ITEMS + 1).fill('label'),
      },
    ]) {
      assert.throws(() => decodeSessionManagementCreateInput(input), isInvalidFrame);
    }
  });

  test('decodes every desired-state mutation without identity or CAS metadata', () => {
    const mutations = [
      { kind: 'rename', sessionId: 'session-1', name: 'New name' },
      { kind: 'set_flagged', sessionId: 'session-1', isFlagged: false },
      { kind: 'mark_read', sessionId: 'session-1', readThroughTs: 123 },
      {
        kind: 'set_permission_mode',
        sessionId: 'session-1',
        permissionMode: 'ask',
      },
      {
        kind: 'set_collaboration_mode',
        sessionId: 'session-1',
        collaborationMode: 'agent',
      },
      {
        kind: 'set_model',
        sessionId: 'session-1',
        modelTarget: {
          kind: 'explicit',
          connectionSlug: 'openai-main',
          model: 'gpt-5.4',
        },
      },
      {
        kind: 'set_model',
        sessionId: 'session-1',
        modelTarget: {
          kind: 'explicit',
          connectionSlug: 'openai-main',
          model: 'gpt-5.4',
        },
        thinkingLevel: 'xhigh',
      },
      {
        kind: 'set_thinking_level',
        sessionId: 'session-1',
        thinkingLevel: null,
      },
      { kind: 'move_cwd', sessionId: 'session-1', cwd: '/workspace/moved' },
      { kind: 'archive', sessionId: 'session-1' },
      { kind: 'unarchive', sessionId: 'session-1' },
      { kind: 'remove', sessionId: 'session-1' },
    ] as const;
    for (const mutation of mutations) {
      assert.deepEqual(decodeSessionManagementMutation(mutation), mutation);
    }

    for (const mutation of [
      { kind: 'rename', sessionId: 'session-1', name: 'New name', revision: 1 },
      { kind: 'archive', sessionId: 'session-1', operationId: 'op-1' },
      { kind: 'remove', sessionId: 'session-1', expectedRevision: 1 },
      {
        kind: 'set_model',
        sessionId: 'session-1',
        modelTarget: { kind: 'default' },
      },
      { kind: 'set_thinking_level', sessionId: 'session-1' },
      {
        kind: 'mark_read',
        sessionId: 'session-1',
        readThroughTs: Number.POSITIVE_INFINITY,
      },
      { kind: 'delete', sessionId: 'session-1' },
    ]) {
      assert.throws(() => decodeSessionManagementMutation(mutation), isInvalidFrame);
    }
  });

  test('validates exact bounded projections for page, item, create, and mutate outputs', () => {
    const session = projection();
    assert.deepEqual(encodeSessionManagementQueryResult({ kind: 'item', session }), {
      kind: 'item',
      session,
    });
    assert.deepEqual(encodeSessionManagementQueryResult({ kind: 'page', items: [session] }), {
      kind: 'page',
      items: [session],
    });
    assert.deepEqual(encodeSessionManagementCreateResult(session), session);
    assert.deepEqual(encodeSessionManagementMutateResult({ kind: 'session', session }), {
      kind: 'session',
      session,
    });
    assert.deepEqual(
      encodeSessionManagementMutateResult({
        kind: 'removed',
        sessionId: 'session-1',
      }),
      { kind: 'removed', sessionId: 'session-1' },
    );

    for (const output of [
      { kind: 'item', session: { ...session, workspaceRoot: '/private' } },
      { kind: 'item', session: { ...session, origin: { kind: 'automation' } } },
      { kind: 'item', session: { ...session, schemaVersion: 1 } },
      { kind: 'item', session: { ...session, createdAt: 1.5 } },
      {
        kind: 'page',
        items: Array(SESSION_MANAGEMENT_PAGE_MAX_ITEMS + 1).fill(session),
      },
      { kind: 'page', items: [session], revision: 1 },
      { kind: 'transcript', sessionId: 'session-1', messages: [] },
    ]) {
      assert.throws(() => encodeSessionManagementQueryResult(output), isInvalidFrame);
    }

    assert.throws(
      () =>
        encodeSessionManagementCreateResult({
          ...session,
          name: '界'.repeat(86),
        }),
      isInvalidFrame,
    );
    assert.equal(
      Buffer.byteLength('界'.repeat(85), 'utf8') <= SESSION_MANAGEMENT_NAME_MAX_BYTES,
      true,
    );
  });

  test('enforces the 48 KiB encoded page bound independently of the item count', () => {
    const item = projection({
      labels: Array.from(
        { length: SESSION_MANAGEMENT_LABEL_MAX_ITEMS },
        (_, index) => `${index}-${'l'.repeat(120)}`,
      ),
      lastMessagePreview: 'p'.repeat(4 * 1024),
      model: 'm'.repeat(512),
    });
    const page = { kind: 'page', items: Array(8).fill(item) };
    assert.ok(
      Buffer.byteLength(JSON.stringify(page), 'utf8') > SESSION_MANAGEMENT_RESULT_MAX_BYTES,
    );
    assert.throws(() => encodeSessionManagementQueryResult(page), isInvalidFrame);
  });
});

function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'session-1',
    cwd: '/workspace/project',
    pendingCwdReminder: { from: '/workspace/old', to: '/workspace/project' },
    createdAt: 1_000,
    lastUsedAt: 2_000,
    name: 'Protocol work',
    isFlagged: true,
    isArchived: false,
    labels: ['runtime-host', 'protocol'],
    hasUnread: true,
    lastMessageAt: 1_900,
    lastMessagePreview: 'Closed contract',
    status: 'running',
    statusUpdatedAt: 1_800,
    parentSessionId: 'session-parent',
    branchOfTurnId: 'turn-1',
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5.4',
    thinkingLevel: 'high',
    permissionMode: 'execute',
    collaborationMode: 'agent',
    ...overrides,
  };
}

function metadata(key: keyof typeof SESSION_MANAGEMENT_OPERATION_SPECS) {
  const { mode, retry, admission } = SESSION_MANAGEMENT_OPERATION_SPECS[key];
  return [mode, retry, admission];
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
