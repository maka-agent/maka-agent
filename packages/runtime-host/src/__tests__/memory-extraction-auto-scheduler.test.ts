import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImmutableRuntimePrefix,
  type AgentRunHeader,
  type ImmutableRuntimePrefixV1,
  type RuntimeEvent,
} from '@maka/core';
import type {
  CreateMemoryExtractionOperationRequest,
  MemoryExtractionCursor,
  MemoryExtractionOperation,
} from '@maka/core/long-term-memory';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { HostMemoryExtractionScheduler } from '../server/memory-extraction-scheduler.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('automatic Sweep batches uncovered Runs and retreats before an open Tool pair', async () => {
  const first = prefix('run-1', 'turn-1', [textEvent('run-1', 'turn-1', 'one')]);
  const second = prefix('run-2', 'turn-2', [
    textEvent('run-2', 'turn-2', 'two'),
    callEvent('run-2', 'turn-2', 'open-call'),
  ]);
  const fixture = autoFixture([first, second]);

  assert.deepEqual(
    await fixture.scheduler.scheduleAutomatic({
      sessionId: 'session-1',
      runId: 'run-2',
      turnId: 'turn-2',
      triggerKind: 'context_threshold',
      triggerEpoch: 'history:initial',
    }),
    { status: 'accepted' },
  );
  assert.equal(fixture.created.length, 1);
  const operation = fixture.created[0]!;
  assert.equal(operation.triggerKind, 'context_threshold');
  assert.equal(operation.triggerEpoch, 'history:initial');
  assert.deepEqual(
    operation.ranges?.map((range) => [range.runId, range.toEventSeqInclusive]),
    [
      ['run-1', 1],
      ['run-2', 1],
    ],
  );
  assert.equal(fixture.ready.length, 1);
});

test('automatic Sweep raises an active Run while scheduling other uncovered Runs', async () => {
  const first = prefix('run-1', 'turn-1', [textEvent('run-1', 'turn-1', 'one')]);
  const second = prefix('run-2', 'turn-2', [textEvent('run-2', 'turn-2', 'two')]);
  const active: MemoryExtractionCursor = {
    sessionId: 'session-1',
    invocationId: 'invocation-run-1',
    runId: 'run-1',
    turnId: 'turn-1',
    committedEventSeq: 0,
    committedEventId: null,
    committedPrefixDigest: null,
    requestedEventSeq: 0,
    requestedEventId: null,
    requestedPrefixDigest: null,
    activeSweepOperationId: 'active-one',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const fixture = autoFixture([first, second], new Map([['run-1', active]]));

  assert.deepEqual(
    await fixture.scheduler.scheduleAutomatic({
      sessionId: 'session-1',
      runId: 'run-2',
      turnId: 'turn-2',
      triggerKind: 'compaction',
      triggerEpoch: 'history:checkpoint-1',
    }),
    { status: 'accepted' },
  );
  assert.equal(fixture.raised.length, 1);
  assert.deepEqual(
    fixture.created[0]!.ranges?.map((range) => range.runId),
    ['run-2'],
  );
  assert.ok(fixture.ready.includes('active-one'));
});

function autoFixture(
  prefixes: readonly ImmutableRuntimePrefixV1[],
  cursors: ReadonlyMap<string, MemoryExtractionCursor> = new Map(),
) {
  const byRun = new Map(prefixes.map((value) => [value.identity.runId, value]));
  const created: CreateMemoryExtractionOperationRequest[] = [];
  const raised: unknown[] = [];
  const ready: string[] = [];
  const policy = createDefaultRuntimePolicy();
  const scheduler = new HostMemoryExtractionScheduler({
    activation: new RuntimePolicyActivationGate(),
    admission: new SessionAdmissionGate(),
    sessions: { readHeaderSnapshot: async () => ({}) },
    policy: {
      getSnapshot: async () => ({
        revision: 1,
        policy: { ...policy, memory: { enabled: true, agentReadEnabled: false } },
      }),
    },
    runtimeEvents: {
      readImmutableRuntimePrefix: async ({ runId, upToEventSeq }) => {
        const value = byRun.get(runId);
        if (!value) throw new Error('missing Run');
        if (upToEventSeq === undefined || upToEventSeq === value.position.lastEventSeq)
          return value;
        return buildImmutableRuntimePrefix(
          value.identity,
          value.events
            .slice(0, upToEventSeq)
            .map((event, index) => ({ eventSeq: index + 1, event })),
        );
      },
    },
    agentRuns: {
      listSessionRuns: async () =>
        prefixes.map(
          (value, index) =>
            ({
              runId: value.identity.runId,
              invocationId: value.identity.invocationId,
              sessionId: 'session-1',
              turnId: value.identity.turnId,
              status: index === prefixes.length - 1 ? 'running' : 'completed',
              backendKind: 'fake',
              llmConnectionSlug: 'test',
              modelId: 'test',
              cwd: '/tmp',
              permissionMode: 'explore',
              createdAt: index + 1,
              updatedAt: index + 1,
            }) satisfies AgentRunHeader,
        ),
    },
    operations: {
      createMemoryExtractionOperation: async (request) => {
        created.push(request);
        return {
          operation: { operationId: request.operationId } as MemoryExtractionOperation,
          replayed: false,
        };
      },
      readMemoryExtractionCursor: async (_sessionId, runId) => cursors.get(runId),
      raiseMemoryExtractionRequestedBoundary: async (request) => {
        raised.push(request);
        return cursors.get(request.runId)!;
      },
      listUnassignedMemoryExtractionSweepDebts: async () => [],
      createMemoryExtractionSweepFollowup: async () => undefined,
    },
    onOperationReady: (operationId) => ready.push(operationId),
  });
  return { scheduler, created, raised, ready };
}

function prefix(
  runId: string,
  turnId: string,
  events: readonly RuntimeEvent[],
): ImmutableRuntimePrefixV1 {
  return buildImmutableRuntimePrefix(
    { sessionId: 'session-1', invocationId: `invocation-${runId}`, runId, turnId },
    events.map((event, index) => ({ eventSeq: index + 1, event })),
  );
}

function textEvent(runId: string, turnId: string, text: string): RuntimeEvent {
  return {
    id: `${runId}-text`,
    invocationId: `invocation-${runId}`,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
}

function callEvent(runId: string, turnId: string, id: string): RuntimeEvent {
  return {
    id: `${runId}-call`,
    invocationId: `invocation-${runId}`,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 2,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id, name: 'Read', args: {} },
  };
}
