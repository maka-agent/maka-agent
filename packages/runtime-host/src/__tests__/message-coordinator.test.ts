import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageContent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  ROOT_TURN_ADMISSION_SCHEMA_VERSION,
  type RootTurnSourceMessageReceipt,
} from '@maka/storage/execution-stores';
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

  const outcome = await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'retract-1',
    },
    operationContext(),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    outcome.result.retracted.map((entry) => entry.messageId),
    ['follow-1'],
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 4,
    steering: [
      {
        entryId: 'id-1',
        messageId: 'steer-1',
        content: { text: 'steer me' },
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
  const interruptedContent = {
    text: '<model>queued</model>',
    displayText: 'queued',
    attachments: [attachment('interrupt', 'queued.png')],
  };
  await submitContent(fixture, 'follow-1', interruptedContent, 'next_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const interrupted = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-1',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  const retry = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-1',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
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
    assert.deepEqual(outcome.result.retracted, [
      {
        entryId: 'id-2',
        messageId: 'follow-1',
        content: interruptedContent,
        placement: 'next_turn',
        state: 'retracted',
      },
    ]);
  }

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('release folds unpulled steering ahead of follow-up without changing source semantics', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const firstAttachment = attachment('first-source', 'same-name.png');
  const secondAttachment = attachment('second-source', 'same-name.png');
  const thirdAttachment = attachment('third-source', 'same-name.png');
  await submitContent(
    fixture,
    'steer-1',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [firstAttachment],
    },
    'current_turn',
  );
  await submitContent(
    fixture,
    'follow-1',
    {
      text: '<model>third</model>',
      displayText: 'third',
      attachments: [thirdAttachment],
    },
    'next_turn',
  );
  await submitContent(
    fixture,
    'steer-2',
    { text: 'second', attachments: [secondAttachment] },
    'current_turn',
  );

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.content, {
    text: '<model>first</model>\n\nsecond\n\n<model>third</model>',
    displayText: 'first\n\nsecond\n\nthird',
    attachments: [firstAttachment, secondAttachment, thirdAttachment],
  });
  assert.deepEqual(batch.sources, [
    {
      messageId: 'steer-1',
      content: {
        text: '<model>first</model>',
        displayText: 'first',
        attachments: [firstAttachment],
      },
      placement: 'current_turn',
      disposition: 'steering',
    },
    {
      messageId: 'steer-2',
      content: { text: 'second', attachments: [secondAttachment] },
      placement: 'current_turn',
      disposition: 'steering',
    },
    {
      messageId: 'follow-1',
      content: {
        text: '<model>third</model>',
        displayText: 'third',
        attachments: [thirdAttachment],
      },
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

test('pending Session lifecycle rejects message admission and close reuses the root stop fence', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  fixture.coordinator.bindRun(ROOT);
  const accepted = await submit(fixture, 'steer-close', 'stop now', 'current_turn');
  await submit(fixture, 'follow-close', 'do not follow up', 'next_turn');

  const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(ROOT.sessionId);
  assert.deepEqual(await submit(fixture, 'steer-close', 'stop now', 'current_turn'), accepted);
  const rejected = await submit(fixture, 'late-message', 'too late', 'current_turn');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'session_busy');

  const close = await fixture.sessionAdmission.run(ROOT.sessionId, (lease) =>
    fixture.coordinator.beginSessionClose(ROOT.sessionId, lease),
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);
  assert.equal(fixture.liveResidencies(), 0);

  await close.deliverStop();
  await fixture.stopClaimed.promise;
  const terminal: TurnSnapshot = {
    ...ROOT,
    status: 'cancelled',
    terminalEventId: 'terminal-close',
    abortSource: 'user_interrupt',
  };
  fixture.resolveTerminal(terminal);
  assert.deepEqual(await close.terminal, terminal);
  lifecycle.release();
});

test('a Message submit queued before the Session lifecycle fence retains admission', async () => {
  const fixture = createFixture();
  fixture.setRootState({ kind: 'idle' });
  const blockerEntered = deferred<void>();
  const releaseBlocker = deferred<void>();
  const order: string[] = [];
  const blocker = fixture.sessionAdmission.run(ROOT.sessionId, async () => {
    order.push('blocker:start');
    blockerEntered.resolve();
    await releaseBlocker.promise;
    order.push('blocker:end');
  });
  await blockerEntered.promise;

  const preFence = submit(fixture, 'pre-fence-message', 'already queued', 'next_turn').then(
    (outcome) => {
      order.push('pre-fence');
      return outcome;
    },
  );
  const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(ROOT.sessionId);
  const postFence = submit(fixture, 'post-fence-message', 'new work', 'next_turn').then(
    (outcome) => {
      order.push('post-fence');
      return outcome;
    },
  );

  releaseBlocker.resolve();
  const admitted = await preFence;
  assert.equal(admitted.ok, true);
  if (admitted.ok) assert.equal(admitted.result.disposition, 'turn_started');
  const rejected = await postFence;
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'session_busy');
  await blocker;
  lifecycle.release();
  assert.deepEqual(order, ['blocker:start', 'blocker:end', 'pre-fence', 'post-fence']);
});

test('an idle Session close can resume message admission without restoring retracted entries', async () => {
  const fixture = createFixture();
  fixture.setRootState({ kind: 'idle' });
  const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(ROOT.sessionId);
  const close = await fixture.sessionAdmission.run(ROOT.sessionId, (lease) =>
    fixture.coordinator.beginSessionClose(ROOT.sessionId, lease),
  );
  assert.equal(await close.terminal, undefined);

  await fixture.sessionAdmission.run(ROOT.sessionId, (lease) =>
    fixture.coordinator.resumeSession(ROOT.sessionId, lease),
  );
  lifecycle.release();
  const submitted = await submit(fixture, 'after-resume', 'start again', 'next_turn');
  assert.equal(submitted.ok, true);
  if (submitted.ok) assert.equal(submitted.result.disposition, 'turn_started');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);
});

for (const priorState of ['absent', 'empty-open'] as const) {
  test(`message Session resume is idempotent for ${priorState} Epoch state`, async () => {
    const fixture = createFixture();
    fixture.setRootState({ kind: 'idle' });
    if (priorState === 'empty-open') {
      assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
        hostEpoch: 'epoch-1',
        queueRevision: 0,
        steering: [],
        followup: [],
      });
    }
    const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(ROOT.sessionId);

    await fixture.sessionAdmission.run(ROOT.sessionId, (lease) =>
      fixture.coordinator.resumeSession(ROOT.sessionId, lease),
    );
    lifecycle.release();

    const submitted = await submit(
      fixture,
      `after-${priorState}`,
      'start after unarchive',
      'next_turn',
    );
    assert.equal(submitted.ok, true);
    if (submitted.ok) assert.equal(submitted.result.disposition, 'turn_started');
  });
}

test('message Session resume fails closed while a terminal transition owns the state', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  owner.release();
  const transition = fixture.coordinator.beginTerminalTransition(ROOT);
  const lifecycle = fixture.sessionAdmission.beginSessionLifecycle(ROOT.sessionId);

  await assert.rejects(
    fixture.sessionAdmission.run(ROOT.sessionId, (lease) =>
      fixture.coordinator.resumeSession(ROOT.sessionId, lease),
    ),
    /live ownership or transition state/,
  );

  lifecycle.release();
  fixture.coordinator.completeIdle(transition);
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
    const outcome = await fixture.coordinator.handlers['queue.retract'](
      {
        originHostEpoch: 'epoch-1',
        sessionId: ROOT.sessionId,
        retractId: `retract-${index}`,
      },
      operationContext(),
    );
    assert.equal(outcome.ok, true);
  }
});

test('submit retries reuse memory and durable proof while old-Epoch rich conflicts fail', async () => {
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
    'current-follow',
    sourceReceipt('current-follow', 'durable current follow-up', 'next_turn', 'followup'),
  );
  fixture.receipts.set(
    'old-follow',
    sourceReceipt(
      'old-follow',
      {
        text: '<model>durable follow-up</model>',
        displayText: 'durable follow-up',
        attachments: [attachment('proof-follow', 'proof.png')],
      },
      'next_turn',
      'followup',
    ),
  );
  const oldFollow = await submitContent(
    fixture,
    'old-follow',
    {
      text: '<model>durable follow-up</model>',
      displayText: 'durable follow-up',
      attachments: [attachment('proof-follow', 'proof.png')],
    },
    'next_turn',
    'old-epoch',
  );
  assert.equal(oldFollow.ok && oldFollow.result.disposition, 'followup');

  fixture.events.push(
    steeringEvent('old-steer', {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('proof-steer', 'proof.png')],
    }),
  );
  const oldSteer = await submitContent(
    fixture,
    'old-steer',
    {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('proof-steer', 'proof.png')],
    },
    'current_turn',
    'old-epoch',
  );
  assert.equal(oldSteer.ok && oldSteer.result.disposition, 'steering');

  const durableBeforeRetries = {
    receipts: structuredClone([...fixture.receipts]),
    events: structuredClone(fixture.events),
  };
  const queueBeforeRetries = structuredClone(fixture.coordinator.projection(ROOT.sessionId));
  const currentFollow = await submit(
    fixture,
    'current-follow',
    'durable current follow-up',
    'next_turn',
  );
  assert.equal(currentFollow.ok && currentFollow.result.disposition, 'followup');
  const displayConflict = await submitContent(
    fixture,
    'old-follow',
    {
      text: '<model>durable follow-up</model>',
      displayText: 'changed display',
      attachments: [attachment('proof-follow', 'proof.png')],
    },
    'next_turn',
    'old-epoch',
  );
  assert.equal(displayConflict.ok, false);
  if (!displayConflict.ok) assert.equal(displayConflict.error.code, 'operation_conflict');
  const attachmentRefConflict = await submitContent(
    fixture,
    'old-steer',
    {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('changed-proof-steer', 'proof.png')],
    },
    'current_turn',
    'old-epoch',
  );
  assert.equal(attachmentRefConflict.ok, false);
  if (!attachmentRefConflict.ok) {
    assert.equal(attachmentRefConflict.error.code, 'operation_conflict');
  }
  assert.deepEqual(
    {
      receipts: [...fixture.receipts],
      events: fixture.events,
    },
    durableBeforeRetries,
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), queueBeforeRetries);

  const unknown = await submit(fixture, 'old-unknown', 'not durable', 'current_turn', 'old-epoch');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'outcome_unknown');

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'cleanup',
    },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('canonical content preserves attachment identity in projection and steering leases', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const firstAttachment = attachment('first', 'same-name.png');
  const secondAttachment = attachment('second', 'same-name.png');

  const submitted = await submitContent(
    fixture,
    'rich-steer',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [firstAttachment, secondAttachment],
    },
    'current_turn',
  );
  assert.equal(submitted.ok, true);
  const reordered = await submitContent(
    fixture,
    'rich-steer',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [secondAttachment, firstAttachment],
    },
    'current_turn',
  );
  assert.equal(reordered.ok, false);
  if (!reordered.ok) assert.equal(reordered.error.code, 'operation_conflict');

  const [lease] = owner.pull();
  assert.ok(lease);
  assert.deepEqual(lease.content, {
    text: '<model>first</model>',
    displayText: 'first',
    attachments: [firstAttachment, secondAttachment],
  });
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering[0]?.content,
    lease.content,
  );
  owner.ack([lease.id]);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('canonical retry omits redundant display text and empty attachments', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  const first = await submitContent(
    fixture,
    'canonical',
    { text: 'same', displayText: 'same', attachments: [] },
    'current_turn',
  );
  assert.deepEqual(
    await submitContent(fixture, 'canonical', { text: 'same' }, 'current_turn'),
    first,
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering[0]?.content, {
    text: 'same',
  });

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup' },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  if (retracted.ok) {
    assert.deepEqual(retracted.result.retracted[0]?.content, { text: 'same' });
  }
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
          input.sourceMessage.content,
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
  const sessionAdmission = new SessionAdmissionGate();
  const options: HostMessageCoordinatorOptions = {
    hostEpoch: 'epoch-1',
    root,
    durableProof: {
      readRootTurnSourceMessageReceipt: async (_sessionId, messageId) => receipts.get(messageId),
      readSessionRuntimeEvents: async () => events,
    },
    sessionAdmission,
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
    sessionAdmission,
    setRootState: (state: HostMessageRootState) => {
      rootState = state;
    },
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
  return submitContent(fixture, messageId, { text }, placement, originHostEpoch);
}

function submitContent(
  fixture: ReturnType<typeof createFixture>,
  messageId: string,
  content: MessageContent,
  placement: 'current_turn' | 'next_turn',
  originHostEpoch = 'epoch-1',
) {
  return fixture.coordinator.handlers['turn.message.submit'](
    {
      originHostEpoch,
      sessionId: ROOT.sessionId,
      messageId,
      content,
      placement,
    },
    operationContext(),
  );
}

function sourceReceipt(
  messageId: string,
  content: MessageContent | string,
  placement: 'current_turn' | 'next_turn',
  disposition: 'steering' | 'followup' | 'turn_started',
  turnId = 'durable-turn',
): RootTurnSourceMessageReceipt {
  const normalizedContent = typeof content === 'string' ? { text: content } : content;
  const sourceMessage = { messageId, content: normalizedContent, placement, disposition };
  return {
    admission: {
      schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
      sessionId: ROOT.sessionId,
      turnId,
      runId: 'durable-run',
      userMessageId: 'durable-user-message',
      previousRootTurnId: ROOT.turnId,
      normalizedInput: normalizedContent,
      sourceMessages: [sourceMessage],
      admittedAt: 1,
    },
    sourceMessage,
  };
}

function steeringEvent(messageId: string, content: MessageContent | string): RuntimeEvent {
  const normalizedContent = typeof content === 'string' ? { text: content } : content;
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
    content: { kind: 'text', ...normalizedContent, steering: true },
    refs: { providerEventId: messageId },
  };
}

function attachment(id: string, name: string) {
  return {
    kind: 'image' as const,
    name,
    mimeType: 'image/png',
    bytes: 10,
    ref: { kind: 'workspace_file' as const, relativePath: `attachments/${id}.png` },
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
