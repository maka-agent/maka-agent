import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RootTurnSourceMessageReceipt } from '@maka/storage/execution-stores';
import type { TurnSnapshot } from '../protocol/index.js';
import {
  HostMessageCoordinator,
  type HostMessageCoordinatorOptions,
  type HostMessageRootPort,
  type HostMessageRootState,
} from '../server/message-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const ROOT = { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1' } as const;

test('pull crosses the retract commit cut and only queued entries are retracted', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  await submit(fixture, 'steer-1', 'steer me', 'current_turn');
  await submit(fixture, 'follow-1', 'later', 'next_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const outcome = await fixture.coordinator.handlers['queue.retract']({
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    retractId: 'retract-1',
  }, operationContext());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.result.retracted.map((entry) => entry.messageId), ['follow-1']);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 4,
    steering: [
      {
        entryId: 'id-1',
        messageId: 'steer-1',
        text: 'steer me',
        placement: 'current_turn',
        state: 'in_flight',
      },
    ],
    followup: [],
  });

  owner.ack([lease.id]);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
});

test('an interrupt generation fence makes a late nack discard its in-flight entry', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-1', 'leased', 'current_turn');
  await submit(fixture, 'follow-1', 'queued', 'next_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const interrupted = fixture.coordinator.handlers['turn.interrupt']({
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    interruptId: 'interrupt-1',
    turnId: ROOT.turnId,
    runId: ROOT.runId,
  }, operationContext());
  const retry = fixture.coordinator.handlers['turn.interrupt']({
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    interruptId: 'interrupt-1',
    turnId: ROOT.turnId,
    runId: ROOT.runId,
  }, operationContext());
  await fixture.stopClaimed.promise;

  owner.nack([lease.id]);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.equal(fixture.liveResidencies(), 0);
  fixture.resolveTerminal({
    ...ROOT,
    status: 'cancelled',
    terminalEventId: 'terminal-1',
    abortSource: 'user_interrupt',
  });
  const [outcome, retryOutcome] = await Promise.all([interrupted, retry]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(retryOutcome, outcome);
  if (outcome.ok) {
    assert.deepEqual(outcome.result.retracted.map((entry) => entry.messageId), ['follow-1']);
  }

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('release folds unpulled steering ahead of follow-up without changing source semantics', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-1', 'first', 'current_turn');
  await submit(fixture, 'follow-1', 'third', 'next_turn');
  await submit(fixture, 'steer-2', 'second', 'current_turn');

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.equal(batch.text, 'first\n\nsecond\n\nthird');
  assert.deepEqual(batch.sources, [
    {
      messageId: 'steer-1',
      text: 'first',
      placement: 'current_turn',
      disposition: 'steering',
    },
    {
      messageId: 'steer-2',
      text: 'second',
      placement: 'current_turn',
      disposition: 'steering',
    },
    {
      messageId: 'follow-1',
      text: 'third',
      placement: 'next_turn',
      disposition: 'followup',
    },
  ]);
  assert.equal(fixture.liveResidencies(), 3);

  fixture.coordinator.commitNextRoot(batch, {
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  assert.equal(fixture.liveResidencies(), 0);
  const next = fixture.coordinator.bindRun({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  next.release();
  const empty = fixture.coordinator.beginTerminalTransition({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  fixture.coordinator.completeIdle(empty);
});

test('run release closes message admission before the terminal transition', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  owner.release();
  const submitted = await submit(fixture, 'late-steer', 'too late', 'current_turn');
  assert.equal(submitted.ok, false);
  if (!submitted.ok) assert.equal(submitted.error.code, 'session_busy');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);

  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('fail-stop isolates the run owner before reclaiming message residency', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'follow-1', 'preserve until isolation', 'next_turn');

  const reclaim = fixture.coordinator.prepareFailStopReclaim();
  owner.release();
  assert.equal(fixture.liveResidencies(), 1);
  reclaim();
  assert.equal(fixture.liveResidencies(), 0);
  await fixture.coordinator.close();
});

test('administrative drain preserves accepted entries until the terminal stop fence', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-drain', 'current intent', 'current_turn');
  await submit(fixture, 'follow-drain', 'next intent', 'next_turn');

  fixture.coordinator.beginDrain();
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    ['steer-drain'],
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['follow-drain'],
  );

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.sources, []);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
});

test('semantic retry history does not become a permanent Session admission cap', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  for (let index = 0; index < 65; index += 1) {
    const outcome = await fixture.coordinator.handlers['queue.retract']({
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: `retract-${index}`,
    }, operationContext());
    assert.equal(outcome.ok, true);
  }
});

test('same-Epoch submit dedupes, conflicts on payload change, and old Epoch needs proof', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  const first = await submit(fixture, 'same-1', 'same text', 'current_turn');
  const retry = await submit(fixture, 'same-1', 'same text', 'current_turn');
  assert.deepEqual(retry, first);
  const conflict = await submit(fixture, 'same-1', 'changed', 'current_turn');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');
  assert.equal(fixture.coordinator.projection(ROOT.sessionId).steering.length, 1);

  fixture.receipts.set(
    'old-follow',
    sourceReceipt('old-follow', 'durable follow-up', 'next_turn', 'followup'),
  );
  const oldFollow = await submit(
    fixture,
    'old-follow',
    'durable follow-up',
    'next_turn',
    'old-epoch',
  );
  assert.equal(oldFollow.ok && oldFollow.result.disposition, 'followup');

  fixture.events.push(steeringEvent('old-steer', 'durable steering'));
  const oldSteer = await submit(
    fixture,
    'old-steer',
    'durable steering',
    'current_turn',
    'old-epoch',
  );
  assert.equal(oldSteer.ok && oldSteer.result.disposition, 'steering');

  const unknown = await submit(
    fixture,
    'old-unknown',
    'not durable',
    'current_turn',
    'old-epoch',
  );
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'outcome_unknown');

  const retracted = await fixture.coordinator.handlers['queue.retract']({
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    retractId: 'cleanup',
  }, operationContext());
  assert.equal(retracted.ok, true);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

function createFixture() {
  let nextId = 1;
  let liveResidencies = 0;
  let rootState: HostMessageRootState = { kind: 'active', ...ROOT };
  const receipts = new Map<string, RootTurnSourceMessageReceipt>();
  const events: RuntimeEvent[] = [];
  const stopClaimed = deferred<void>();
  const terminal = deferred<TurnSnapshot>();
  const root: HostMessageRootPort = {
    readSessionHeader: async () => ({ isArchived: false }),
    readRootState: () => rootState,
    startFromMessage: async (input) => {
      const turnId = 'idle-turn';
      receipts.set(
        input.sourceMessage.messageId,
        sourceReceipt(
          input.sourceMessage.messageId,
          input.sourceMessage.text,
          input.sourceMessage.placement,
          'turn_started',
          turnId,
        ),
      );
      rootState = { kind: 'active', sessionId: input.sessionId, turnId, runId: 'idle-run' };
      return { turnId };
    },
    claimStop: async (_input, _admission, commitQueueFence) => {
      commitQueueFence();
      return {
        deliverStop: async () => stopClaimed.resolve(undefined),
        terminal: terminal.promise,
      };
    },
  };
  const options: HostMessageCoordinatorOptions = {
    hostEpoch: 'epoch-1',
    root,
    durableProof: {
      readRootTurnSourceMessageReceipt: async (_sessionId, messageId) => receipts.get(messageId),
      readSessionRuntimeEvents: async () => events,
    },
    sessionAdmission: new SessionAdmissionGate(),
    acquireResidency: () => {
      liveResidencies += 1;
      let released = false;
      return {
        release: () => {
          assert.equal(released, false);
          released = true;
          liveResidencies -= 1;
        },
      };
    },
    validateProjectionCapacity: async () => true,
    onProjectionChanged: () => undefined,
    createId: () => `id-${nextId++}`,
  };
  return {
    coordinator: new HostMessageCoordinator(options),
    events,
    receipts,
    stopClaimed,
    resolveTerminal: terminal.resolve,
    liveResidencies: () => liveResidencies,
  };
}

function submit(
  fixture: ReturnType<typeof createFixture>,
  messageId: string,
  text: string,
  placement: 'current_turn' | 'next_turn',
  originHostEpoch = 'epoch-1',
) {
  return fixture.coordinator.handlers['turn.message.submit']({
    originHostEpoch,
    sessionId: ROOT.sessionId,
    messageId,
    text,
    placement,
  }, operationContext());
}

function sourceReceipt(
  messageId: string,
  text: string,
  placement: 'current_turn' | 'next_turn',
  disposition: 'steering' | 'followup' | 'turn_started',
  turnId = 'durable-turn',
): RootTurnSourceMessageReceipt {
  const sourceMessage = { messageId, text, placement, disposition };
  return {
    admission: {
      schemaVersion: 3,
      sessionId: ROOT.sessionId,
      turnId,
      runId: 'durable-run',
      userMessageId: 'durable-user-message',
      previousRootTurnId: ROOT.turnId,
      normalizedInput: { text },
      sourceMessages: [sourceMessage],
      admittedAt: 1,
    },
    sourceMessage,
  };
}

function steeringEvent(messageId: string, text: string): RuntimeEvent {
  return {
    id: `event-${messageId}`,
    invocationId: 'invocation-1',
    runId: ROOT.runId,
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text, steering: true },
    refs: { providerEventId: messageId },
  };
}

function operationContext() {
  return {
    hostEpoch: 'epoch-1',
    connectionId: 'connection-1',
    surface: 'tui' as const,
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release: () => undefined }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
