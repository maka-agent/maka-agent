import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import {
  buildToolOperationId,
  canonicalToolArgsHash,
  executeDurableToolBoundary,
  type RuntimeCommitSink,
  type ToolOutcomeCommit,
  type ToolPreparedCommit,
} from '../runtime-commit-sink.js';

describe('RuntimeCommitSink', () => {
  it('builds operation identity from the invocation and provider call, never argument text', () => {
    const first = buildToolOperationId({
      invocationId: 'invocation-1',
      providerToolCallId: 'provider-call-1',
    });
    const repeated = buildToolOperationId({
      invocationId: 'invocation-1',
      providerToolCallId: 'provider-call-1',
    });
    const nextCall = buildToolOperationId({
      invocationId: 'invocation-1',
      providerToolCallId: 'provider-call-2',
    });

    assert.equal(first, repeated);
    assert.notEqual(first, nextCall);
    assert.match(first, /^toolop_[a-f0-9]{32}$/);
  });

  it('hashes stable-json tool identity while preserving semantic argument differences', () => {
    assert.equal(
      canonicalToolArgsHash('Read', { path: '/workspace/a', offset: 1 }),
      canonicalToolArgsHash('Read', { offset: 1, path: '/workspace/a' }),
    );
    assert.notEqual(
      canonicalToolArgsHash('Read', { path: '/workspace/a' }),
      canonicalToolArgsHash('Read', { path: '/workspace/b' }),
    );
    assert.notEqual(
      canonicalToolArgsHash('Read', { path: '/workspace/a' }),
      canonicalToolArgsHash('Write', { path: '/workspace/a' }),
    );
  });

  it('runs the implementation only after T1 and returns only after T2', async () => {
    const order: string[] = [];
    const sink = recordingSink(order);

    const result = await executeDurableToolBoundary({
      sink,
      prepared: preparedCommit(),
      execute: async () => {
        order.push('impl');
        return { text: 'contents' };
      },
      buildOutcome: (value) => {
        order.push('build-outcome');
        return outcomeCommit(value);
      },
    });

    order.push('delivered');
    assert.deepEqual(result, { text: 'contents' });
    assert.deepEqual(order, ['t1', 'impl', 'build-outcome', 't2', 'delivered']);
  });

  it('does not call the implementation when T1 fails', async () => {
    let implementationCalls = 0;
    const sink: RuntimeCommitSink = {
      commitToolPrepared: async () => { throw new Error('T1 unavailable'); },
      commitToolOutcome: async () => { throw new Error('must not run'); },
    };

    await assert.rejects(
      executeDurableToolBoundary({
        sink,
        prepared: preparedCommit(),
        execute: async () => {
          implementationCalls += 1;
          return 'unsafe';
        },
        buildOutcome: outcomeCommit,
      }),
      /T1 unavailable/,
    );
    assert.equal(implementationCalls, 0);
  });

  it('does not dispatch an operation whose durable T1 claim already exists', async () => {
    let implementationCalls = 0;
    const sink: RuntimeCommitSink = {
      commitToolPrepared: async () => ({ created: false, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => { throw new Error('must not run'); },
    };

    await assert.rejects(
      executeDurableToolBoundary({
        sink,
        prepared: preparedCommit(),
        execute: async () => {
          implementationCalls += 1;
          return 'duplicate side effect';
        },
        buildOutcome: outcomeCommit,
      }),
      /already claimed/,
    );
    assert.equal(implementationCalls, 0);
  });

  it('does not expose an implementation result when T2 fails', async () => {
    let implementationCalls = 0;
    const sink: RuntimeCommitSink = {
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => { throw new Error('T2 unavailable'); },
    };

    await assert.rejects(
      executeDurableToolBoundary({
        sink,
        prepared: preparedCommit(),
        execute: async () => {
          implementationCalls += 1;
          return 'side effect may have happened';
        },
        buildOutcome: outcomeCommit,
      }),
      /T2 unavailable/,
    );
    assert.equal(implementationCalls, 1);
  });
});

function recordingSink(order: string[]): RuntimeCommitSink {
  return {
    commitToolPrepared: async () => {
      order.push('t1');
      return { created: true, runtimeEventSeq: 1 };
    },
    commitToolOutcome: async () => {
      order.push('t2');
      return { created: true, runtimeEventSeq: 2 };
    },
  };
}

function preparedCommit(): ToolPreparedCommit {
  return {
    operationId: 'operation-1',
    journalEventId: 'journal-prepared-1',
    runtimeEvent: functionCallEvent(),
    providerToolCallId: 'provider-call-1',
    toolName: 'Read',
    canonicalArgsHash: canonicalToolArgsHash('Read', { path: '/workspace/README.md' }),
    recoveryMode: 'replay_safe',
    committedAt: 1,
  };
}

function outcomeCommit(result: unknown): ToolOutcomeCommit {
  return {
    operationId: 'operation-1',
    journalEventId: 'journal-outcome-1',
    runtimeEvent: functionResponseEvent(result),
    committedAt: 2,
  };
}

function functionCallEvent(): RuntimeEvent {
  return {
    id: 'call-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Read',
      args: { path: '/workspace/README.md' },
    },
    refs: { operationId: 'operation-1' },
  };
}

function functionResponseEvent(result: unknown): RuntimeEvent {
  return {
    id: 'response-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Read',
      result,
    },
    refs: { operationId: 'operation-1' },
  };
}
