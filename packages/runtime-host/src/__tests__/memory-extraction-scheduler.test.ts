import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImmutableRuntimePrefix,
  type ImmutableRuntimePrefixV1,
  type RuntimeEvent,
} from '@maka/core';
import type {
  CreateMemoryExtractionOperationRequest,
  MemoryExtractionCursor,
  MemoryExtractionOperation,
  MemoryExtractionSweepDebt,
  RaiseMemoryExtractionRequestedBoundaryRequest,
} from '@maka/core/long-term-memory';
import { MemoryItemStoreConflictError } from '@maka/core/long-term-memory';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { MemoryExtractionScheduleRequest } from '@maka/runtime';
import { HostMemoryExtractionScheduler } from '../server/memory-extraction-scheduler.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('targeted scheduling freezes authority and maps durable admission outcomes', async () => {
  const fixture = schedulerFixture({ agentReadEnabled: false });

  assert.deepEqual(await fixture.scheduler.schedule(scheduleRequest('targeted')), {
    status: 'accepted',
  });
  assert.equal(fixture.created.length, 1);
  const operation = fixture.created[0]!;
  assert.equal(operation.mode, 'targeted');
  assert.equal(operation.triggerKind, 'user_requested');
  assert.equal(operation.ranges, undefined);
  const manifest = JSON.parse(operation.requestJson) as {
    targetedReference: { userRequestEventId: string; toolCallId: string };
    searchBoundary: { position: { lastEventSeq: number; lastEventId: string } };
  };
  assert.deepEqual(manifest.targetedReference, {
    userRequestEventId: 'user-event',
    toolCallId: 'remember-call',
  });
  assert.deepEqual(manifest.searchBoundary.position, {
    eventCount: 1,
    lastEventSeq: 1,
    lastEventId: 'user-event',
  });
  assert.deepEqual(fixture.prefixReads, [undefined, 1]);

  const fullQueue = schedulerFixture({
    createError: new MemoryItemStoreConflictError(
      'extraction_queue_full',
      'Targeted extraction queue is full',
    ),
  });
  assert.deepEqual(await fullQueue.scheduler.schedule(scheduleRequest('targeted')), {
    status: 'rejected',
    reason: 'queue_full',
  });

  const replayed = schedulerFixture({ replayed: true });
  assert.deepEqual(await replayed.scheduler.schedule(scheduleRequest('targeted')), {
    status: 'coalesced',
  });
  assert.equal(replayed.ready.length, 1);

  const missingDispatch = schedulerFixture({ omitDispatch: true });
  assert.deepEqual(await missingDispatch.scheduler.schedule(scheduleRequest('targeted')), {
    status: 'rejected',
    reason: 'runtime_unavailable',
  });
  assert.deepEqual(missingDispatch.created, []);
});

test('scheduler rejects incognito and disabled Memory before reading RuntimeEvent evidence', async () => {
  const incognito = schedulerFixture({ incognitoActive: true });
  assert.deepEqual(await incognito.scheduler.schedule(scheduleRequest('targeted')), {
    status: 'rejected',
    reason: 'incognito_active',
  });
  assert.deepEqual(incognito.prefixReads, []);
  assert.deepEqual(incognito.created, []);

  const disabled = schedulerFixture({ memoryEnabled: false });
  assert.deepEqual(await disabled.scheduler.schedule(scheduleRequest('sweep')), {
    status: 'rejected',
    reason: 'memory_disabled',
  });
  assert.deepEqual(disabled.prefixReads, []);
  assert.deepEqual(disabled.created, []);
});

test('sweep scheduling freezes the dispatch high-water and creates a Cursor range', async () => {
  const fixture = schedulerFixture();

  assert.deepEqual(await fixture.scheduler.schedule(scheduleRequest('sweep')), {
    status: 'accepted',
  });
  assert.equal(fixture.created.length, 1);
  const range = fixture.created[0]!.ranges?.[0];
  assert.ok(range);
  assert.deepEqual(
    {
      fromEventSeqExclusive: range.fromEventSeqExclusive,
      fromEventId: range.fromEventId,
      fromPrefixDigest: range.fromPrefixDigest,
      toEventSeqInclusive: range.toEventSeqInclusive,
      toEventId: range.toEventId,
    },
    {
      fromEventSeqExclusive: 0,
      fromEventId: null,
      fromPrefixDigest: null,
      toEventSeqInclusive: 1,
      toEventId: 'user-event',
    },
  );
  assert.deepEqual(fixture.prefixReads, [undefined, 1]);
});

test('sweep distinguishes committed and active Cursor boundaries', async () => {
  // The same Tool Call may be replayed after a later boundary was committed.
  // The committed digest is revalidated at its own high-water before the old
  // dispatch boundary is classified as covered.
  const prefix = prefixFor('sweep', 3);
  const fixture = schedulerFixture({ cursor: cursorAt(prefix) });

  assert.deepEqual(await fixture.scheduler.schedule(scheduleRequest('sweep')), {
    status: 'already_covered',
  });
  assert.deepEqual(fixture.created, []);

  const active = schedulerFixture({
    cursor: {
      ...emptyCursor(),
      activeSweepOperationId: 'active-sweep',
      requestedEventSeq: 0,
      requestedEventId: null,
      requestedPrefixDigest: null,
    },
  });

  assert.deepEqual(await active.scheduler.schedule(scheduleRequest('sweep')), {
    status: 'coalesced',
  });
  assert.equal(active.raised.length, 1);
  assert.deepEqual(active.raised[0], {
    sessionId: 'session-1',
    runId: 'run-1',
    activeSweepOperationId: 'active-sweep',
    requestedEventSeq: 1,
    requestedEventId: 'user-event',
    requestedPrefixDigest: prefixFor('sweep', 1).prefixDigest,
  });
  assert.deepEqual(active.created, []);
});

test('a concurrent Sweep winner is re-read and coalesced after create loses the Cursor race', async () => {
  const active = {
    ...emptyCursor(),
    activeSweepOperationId: 'concurrent-sweep',
    requestedEventSeq: 2,
    requestedEventId: 'extract-dispatch',
    requestedPrefixDigest: prefixFor('sweep', 2).prefixDigest,
  };
  const fixture = schedulerFixture({
    cursorReads: [undefined, active],
    createError: new Error('cursor changed'),
  });

  assert.deepEqual(await fixture.scheduler.schedule(scheduleRequest('sweep')), {
    status: 'coalesced',
  });
  assert.equal(fixture.created.length, 1);
  assert.deepEqual(fixture.ready, ['concurrent-sweep']);
});

test('reconciles durable Cursor debt into one CAS-bound follow-up Sweep', async () => {
  const debt: MemoryExtractionSweepDebt = {
    ...emptyCursor(),
    committedEventSeq: 3,
    committedEventId: 'event-3',
    committedPrefixDigest: digest('a'),
    requestedEventSeq: 5,
    requestedEventId: 'event-5',
    requestedPrefixDigest: digest('b'),
    activeSweepOperationId: null,
    version: 4,
  };
  const fixture = schedulerFixture({ debts: [debt] });

  assert.equal(await fixture.reconcileSweepDebts(), 1);
  assert.equal(fixture.followups.length, 1);
  assert.equal(fixture.followups[0]!.expectedCursorVersion, 4);
  assert.deepEqual(fixture.followups[0]!.operation.ranges?.[0], {
    rangeOrdinal: 0,
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    fromEventSeqExclusive: 3,
    fromEventId: 'event-3',
    fromPrefixDigest: digest('a'),
    toEventSeqInclusive: 5,
    toEventId: 'event-5',
    toPrefixDigest: digest('b'),
  });
});

test('does not create an Operation after parent Session retirement wins admission', async () => {
  const admission = new SessionAdmissionGate();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let parentExists = true;
  const holder = admission.run('session-1', async () => {
    entered();
    await blocked;
  });
  await acquired;
  const fixture = schedulerFixture({
    admission,
    readHeaderSnapshot: async () => {
      if (!parentExists) throw new Error('Session not found');
      return {};
    },
  });
  const scheduled = fixture.scheduler.schedule(scheduleRequest('targeted'));
  parentExists = false;
  release();
  await holder;

  assert.deepEqual(await scheduled, { status: 'rejected', reason: 'runtime_unavailable' });
  assert.equal(fixture.created.length, 0);
});

function schedulerFixture(
  options: {
    incognitoActive?: boolean;
    memoryEnabled?: boolean;
    agentReadEnabled?: boolean;
    cursor?: MemoryExtractionCursor;
    cursorReads?: readonly (MemoryExtractionCursor | undefined)[];
    replayed?: boolean;
    createError?: Error;
    omitDispatch?: boolean;
    debts?: readonly MemoryExtractionSweepDebt[];
    admission?: SessionAdmissionGate;
    readHeaderSnapshot?: () => Promise<unknown>;
  } = {},
) {
  const created: CreateMemoryExtractionOperationRequest[] = [];
  const raised: RaiseMemoryExtractionRequestedBoundaryRequest[] = [];
  const prefixReads: Array<number | undefined> = [];
  const ready: string[] = [];
  const followups: Array<{
    expectedCursorVersion: number;
    operation: CreateMemoryExtractionOperationRequest;
  }> = [];
  const policy = createDefaultRuntimePolicy();
  const eventsByMode = {
    targeted: prefixFor('targeted', options.omitDispatch ? 1 : 3),
    sweep: prefixFor('sweep', options.omitDispatch ? 1 : 3),
  };
  let activeMode: 'targeted' | 'sweep' = 'targeted';
  let cursorReadIndex = 0;
  const scheduler = new HostMemoryExtractionScheduler({
    activation: new RuntimePolicyActivationGate(),
    admission: options.admission ?? new SessionAdmissionGate(),
    sessions: {
      readHeaderSnapshot: options.readHeaderSnapshot ?? (async () => ({})),
    },
    policy: {
      getSnapshot: async () => ({
        revision: 1,
        policy: {
          ...policy,
          privacy: { incognitoActive: options.incognitoActive ?? false },
          memory: {
            enabled: options.memoryEnabled ?? true,
            agentReadEnabled: options.agentReadEnabled ?? false,
          },
        },
      }),
    },
    runtimeEvents: {
      readImmutableRuntimePrefix: async ({ upToEventSeq }) => {
        prefixReads.push(upToEventSeq);
        return prefixFor(activeMode, upToEventSeq ?? eventsByMode[activeMode].events.length, {
          omitDispatch: options.omitDispatch,
        });
      },
    },
    agentRuns: {
      listSessionRuns: async () => [],
    },
    operations: {
      createMemoryExtractionOperation: async (request) => {
        created.push(request);
        if (options.createError) throw options.createError;
        return {
          operation: { operationId: request.operationId } as MemoryExtractionOperation,
          replayed: options.replayed ?? false,
        };
      },
      readMemoryExtractionCursor: async () =>
        options.cursorReads?.[cursorReadIndex++] ?? options.cursor,
      raiseMemoryExtractionRequestedBoundary: async (request) => {
        raised.push(request);
        return options.cursor ?? emptyCursor();
      },
      listUnassignedMemoryExtractionSweepDebts: async () => options.debts ?? [],
      createMemoryExtractionSweepFollowup: async (request) => {
        followups.push(request);
        return {
          operation: {
            operationId: request.operation.operationId,
          } as MemoryExtractionOperation,
          replayed: false,
        };
      },
    },
    onOperationReady: (operationId) => ready.push(operationId),
  });
  return {
    scheduler: {
      schedule: (request: MemoryExtractionScheduleRequest) => {
        activeMode = request.mode;
        return scheduler.schedule(request);
      },
    },
    reconcileSweepDebts: () => scheduler.reconcileSweepDebts(),
    created,
    raised,
    prefixReads,
    ready,
    followups,
  };
}

function scheduleRequest(mode: 'targeted' | 'sweep'): MemoryExtractionScheduleRequest {
  return {
    mode,
    triggerKind: mode === 'targeted' ? 'user_requested' : 'agent_requested',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    toolCallId: mode === 'targeted' ? 'remember-call' : 'extract-call',
  };
}

function prefixFor(
  mode: 'targeted' | 'sweep',
  highWater: number,
  options: { omitDispatch?: boolean } = {},
): ImmutableRuntimePrefixV1 {
  const toolName = mode === 'targeted' ? 'memory_remember' : 'memory_extract';
  const toolCallId = mode === 'targeted' ? 'remember-call' : 'extract-call';
  const events: RuntimeEvent[] = [
    {
      id: 'user-event',
      invocationId: 'invocation-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 1,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Remember this preference.' },
    },
    ...(options.omitDispatch
      ? []
      : [
          {
            id: `${mode === 'targeted' ? 'remember' : 'extract'}-dispatch`,
            invocationId: 'invocation-1',
            runId: 'run-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            ts: 2,
            partial: false,
            role: 'system' as const,
            author: 'system' as const,
            actions: {
              toolDispatch: {
                protocol: 't1_after_preflight_v1' as const,
                operationId: 'tool-operation',
                providerToolCallId: toolCallId,
                toolName,
                canonicalArgsHash: `sha256:${'a'.repeat(64)}`,
                recoveryMode: 'replay_safe' as const,
              },
            },
          },
        ]),
    {
      id: 'later-event',
      invocationId: 'invocation-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 3,
      partial: false,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'Later content must not move the scheduling boundary.' },
    },
  ];
  const bounded = events.slice(0, highWater);
  return buildImmutableRuntimePrefix(
    {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
    },
    bounded.map((event, index) => ({ eventSeq: index + 1, event })),
  );
}

function emptyCursor(): MemoryExtractionCursor {
  return {
    sessionId: 'session-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    committedEventSeq: 0,
    committedEventId: null,
    committedPrefixDigest: null,
    requestedEventSeq: 0,
    requestedEventId: null,
    requestedPrefixDigest: null,
    activeSweepOperationId: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function cursorAt(prefix: ImmutableRuntimePrefixV1): MemoryExtractionCursor {
  return {
    ...emptyCursor(),
    committedEventSeq: prefix.position.lastEventSeq,
    committedEventId: prefix.position.lastEventId,
    committedPrefixDigest: prefix.prefixDigest,
    requestedEventSeq: prefix.position.lastEventSeq,
    requestedEventId: prefix.position.lastEventId,
    requestedPrefixDigest: prefix.prefixDigest,
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
