import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUTOMATION_PAGE_MAX_ITEMS,
  AUTOMATION_PROMPT_MAX_BYTES,
  decodeClientFrame,
  decodeHostFrame,
  encodeAutomationQueryResult,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

describe('Automation protocol', () => {
  test('registers only query and mutate with ready admission and declared retry semantics', () => {
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter((key) => key.startsWith('automation.')),
      ['automation.query', 'automation.mutate'],
    );
    assert.deepEqual(metadata('automation.query'), ['query', 'safe', 'ready']);
    assert.deepEqual(metadata('automation.mutate'), ['command', 'semantic', 'ready']);
    assert.deepEqual(HOST_OPERATION_SPECS['automation.query'].errors, [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'invalid_request',
      'not_found',
      'persistence_failed',
      'internal_failure',
    ]);
    assert.deepEqual(HOST_OPERATION_SPECS['automation.mutate'].errors, [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'invalid_request',
      'not_found',
      'operation_conflict',
      'persistence_failed',
      'commit_outcome_unknown',
      'internal_failure',
    ]);
  });

  test('requires caller identity for create and CAS revisions for later mutations', () => {
    assert.doesNotThrow(() => mutate({ kind: 'create', automationId: 'auto-1', definition: definition() }));
    assert.doesNotThrow(() =>
      mutate({
        kind: 'update',
        automationId: 'auto-1',
        expectedRevision: 1,
        definition: definition(),
      }),
    );
    assert.doesNotThrow(() =>
      mutate({ kind: 'set_enabled', automationId: 'auto-1', expectedRevision: 2, enabled: false }),
    );
    assert.doesNotThrow(() =>
      mutate({ kind: 'delete', automationId: 'auto-1', expectedRevision: 3 }),
    );

    for (const mutation of [
      { kind: 'create', definition: definition() },
      { kind: 'create', automationId: 'auto-1', expectedRevision: 0, definition: definition() },
      { kind: 'update', automationId: 'auto-1', definition: definition() },
      { kind: 'set_enabled', automationId: 'auto-1', enabled: false },
      { kind: 'delete', automationId: 'auto-1', expectedRevision: 0 },
      { kind: 'fire', automationId: 'auto-1' },
    ]) {
      assert.throws(() => mutate(mutation), isInvalidFrame);
    }
  });

  test('freezes the execution target and matches it to the automation kind', () => {
    assert.doesNotThrow(() =>
      mutate({
        kind: 'create',
        automationId: 'heartbeat-1',
        definition: definition('Check the build', 'heartbeat'),
      }),
    );
    assert.throws(
      () =>
        mutate({
          kind: 'create',
          automationId: 'wrong-target',
          definition: { ...definition(), executionTarget: existingSessionTarget() },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        mutate({
          kind: 'create',
          automationId: 'wrong-permission',
          definition: {
            ...definition(),
            executionTarget: { ...freshSessionTarget(), permissionMode: 'ask' },
          },
        }),
      isInvalidFrame,
    );
  });

  test('uses a bounded revision-pinned list cursor and exact query variants', () => {
    assert.doesNotThrow(() => query({ kind: 'get', automationId: 'auto-1' }));
    assert.doesNotThrow(() =>
      query({ kind: 'list', limit: AUTOMATION_PAGE_MAX_ITEMS, revision: null, cursor: null }),
    );
    assert.doesNotThrow(() =>
      query({ kind: 'list', limit: 4, revision: 7, cursor: 'opaque-next' }),
    );
    for (const input of [
      { kind: 'get', automationId: 'auto-1', history: true },
      { kind: 'list', limit: 1, revision: 7, cursor: null },
      { kind: 'list', limit: 1, revision: null, cursor: 'opaque-next' },
      { kind: 'list', limit: 0, revision: null, cursor: null },
      { kind: 'list', limit: AUTOMATION_PAGE_MAX_ITEMS + 1, revision: null, cursor: null },
      { kind: 'history', automationId: 'auto-1' },
    ]) {
      assert.throws(() => query(input), isInvalidFrame);
    }
  });

  test('closes and bounds definition and fire projections', () => {
    const automation = projection();
    assert.doesNotThrow(() => response('automation.query', { kind: 'item', catalogRevision: 4, automation }));
    assert.doesNotThrow(() =>
      response('automation.query', {
        kind: 'page',
        revision: 4,
        items: [automation],
        nextCursor: null,
      }),
    );
    assert.doesNotThrow(() =>
      response('automation.mutate', { kind: 'unchanged', catalogRevision: 4, automation }),
    );
    assert.deepEqual(
      encodeAutomationQueryResult({ kind: 'item', catalogRevision: 4, automation }),
      { kind: 'item', catalogRevision: 4, automation },
    );

    for (const result of [
      { kind: 'page', revision: 4, items: Array(AUTOMATION_PAGE_MAX_ITEMS + 1).fill(automation), nextCursor: null },
      { kind: 'item', catalogRevision: 4, automation: { ...automation, fireCount: 1 } },
      {
        kind: 'item',
        catalogRevision: 4,
        automation: {
          ...automation,
          lastFire: {
            fireId: 'fire-1',
            status: 'succeeded',
            admittedAt: 1_100,
            completedAt: 1_200,
            runId: null,
            failure: 'should be null',
          },
        },
      },
      { kind: 'history', items: [] },
    ]) {
      assert.throws(() => response('automation.query', result), isInvalidFrame);
    }

    assert.throws(
      () => mutate({ kind: 'create', automationId: 'auto-2', definition: definition('x'.repeat(AUTOMATION_PROMPT_MAX_BYTES + 1)) }),
      isInvalidFrame,
    );
  });
});

function definition(
  prompt = 'Check the build',
  kind: 'heartbeat' | 'cron' = 'cron',
): Record<string, unknown> {
  return {
    kind,
    name: 'Build check',
    prompt,
    executionTarget: kind === 'cron' ? freshSessionTarget() : existingSessionTarget(),
    schedule: { type: 'interval', seconds: 60 },
    maxFires: null,
    expiresAt: null,
  };
}

function existingSessionTarget(): Record<string, unknown> {
  return { kind: 'existing_session', sessionId: 'session-1' };
}

function freshSessionTarget(): Record<string, unknown> {
  return {
    kind: 'fresh_session',
    sourceSessionId: 'session-1',
    cwd: '/workspace/project',
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    model: 'gpt-5.4',
    thinkingLevel: 'high',
    permissionMode: 'explore',
  };
}

function projection(): Record<string, unknown> {
  return {
    automationId: 'auto-1',
    revision: 3,
    ...definition(),
    enabled: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    nextFireAt: 3_000,
    currentFire: {
      fireId: 'fire-2',
      status: 'running',
      admittedAt: 1_900,
      runId: 'run-2',
    },
    lastFire: {
      fireId: 'fire-1',
      status: 'failed',
      admittedAt: 1_100,
      completedAt: 1_200,
      runId: null,
      failure: 'target unavailable',
    },
  };
}

function metadata(key: 'automation.query' | 'automation.mutate') {
  const { mode, retry, admission } = HOST_OPERATION_SPECS[key];
  return [mode, retry, admission];
}

function query(input: unknown): void {
  decodeClientFrame({ requestId: 'automation-query', operation: 'automation.query', input });
}

function mutate(mutation: unknown): void {
  decodeClientFrame({
    requestId: 'automation-mutate',
    operation: 'automation.mutate',
    input: { mutation },
  });
}

function response(operation: 'automation.query' | 'automation.mutate', result: unknown): void {
  decodeHostFrame({ requestId: 'automation-result', operation, ok: true, result });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
