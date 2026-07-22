import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRunStore } from '@maka/core/agent-run';
import {
  BackendRegistry,
  classifyTerminalRuntimeLedger,
  FakeBackend,
  FAKE_ASK_USER_QUESTION_PROMPT,
  SessionManager,
} from '@maka/runtime';
import {
  openInteractiveExecutionStoresForWrite,
  type RootTurnAdmissionStore,
} from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { SubscriptionFrame } from '../protocol/index.js';
import type { RuntimeHostResidency } from '../server/host-kernel.js';
import { CanonicalSessionProjectionReader } from '../server/canonical-session-projection.js';
import { type HostMessageRootPort, HostMessageCoordinator } from '../server/message-coordinator.js';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { RootTurnCoordinator } from '../server/root-turn-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { SessionContinuityCoordinator } from '../server/session-continuity-coordinator.js';
import type { SessionContinuityFrameSink } from '../server/session-continuity-service.js';

test('shutdown re-scans a successor created by an in-flight terminal handoff', {
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-root-turn-close-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');

  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const followupAdmissionStarted = deferred<void>();
    const releaseFollowupAdmission = deferred<void>();
    const admissionStore: RootTurnAdmissionStore = {
      admitRootTurn: async (input) => {
        if (input.previousRootTurnId !== null) {
          followupAdmissionStarted.resolve();
          await releaseFollowupAdmission.promise;
        }
        return stores.agentRunStore.admitRootTurn(input);
      },
      readRootTurnAdmission: (sessionId, turnId) =>
        stores.agentRunStore.readRootTurnAdmission(sessionId, turnId),
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        stores.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId),
    };
    const rootAdmissionOwner = new RootAdmissionOwner(admissionStore);
    await rootAdmissionOwner.recoverSession(session.id);

    let liveResidencies = 0;
    const acquireResidency = (): RuntimeHostResidency => {
      liveResidencies += 1;
      let released = false;
      return {
        release: () => {
          assert.equal(released, false);
          released = true;
          liveResidencies -= 1;
        },
      };
    };
    const sessionAdmission = new SessionAdmissionGate();
    let coordinator: RootTurnCoordinator | undefined;
    let continuity: SessionContinuityCoordinator | undefined;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      startFromMessage: (input, admission) =>
        requireCoordinator(coordinator).startFromMessage(input, admission),
      claimStop: (input, commitQueueFence) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence),
    };
    const hostEpoch = 'epoch-close-handoff';
    const messages = new HostMessageCoordinator({
      hostEpoch,
      root: rootPort,
      durableProof: {
        readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
          stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
        readImmutableSessionRuntimeEvents: async (sessionId) => {
          const runs = await stores.agentRunStore.listSessionRuns(sessionId);
          return (
            await Promise.all(
              runs.map((run) =>
                stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, run.runId),
              ),
            )
          ).flat();
        },
      },
      sessionAdmission,
      acquireResidency,
      onProjectionChanged: (sessionId) =>
        requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
    });
    const canonicalProjection = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: rootAdmissionOwner,
      messages,
    });
    continuity = new SessionContinuityCoordinator(
      hostEpoch,
      (sessionId) => canonicalProjection.read(sessionId),
      sessionAdmission,
    );
    const backends = new BackendRegistry();
    backends.register('fake', (context) => new FakeBackend(context));
    const manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      backends,
      newId: randomUUID,
      now: Date.now,
      messageAuthority: messages,
    });
    let drainRequested = false;
    coordinator = new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      messages,
      continuity,
      acquireResidency,
      () => {
        drainRequested = true;
      },
    );

    const firstTurnId = 'turn-close-first';
    const started = await coordinator.handlers['turn.start'](
      {
        sessionId: session.id,
        turnId: firstTurnId,
        content: { text: `long-running root ${'x'.repeat(540)}` },
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.equal(started.ok, true);
    const followup = await messages.handlers['turn.message.submit'](
      {
        originHostEpoch: hostEpoch,
        sessionId: session.id,
        messageId: 'message-close-followup',
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        placement: 'next_turn',
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.equal(followup.ok && followup.result.disposition, 'followup');

    await followupAdmissionStarted.promise;
    messages.beginDrain();
    const closing = coordinator.close();
    assert.equal(await settlesWithin(closing, 25), false);
    releaseFollowupAdmission.resolve();
    await closing;
    await messages.close();
    continuity.close();

    assert.deepEqual(coordinator.readRootState(session.id), { kind: 'idle' });
    assert.equal(liveResidencies, 0);
    assert.equal(drainRequested, false);
    const admissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id);
    assert.equal(admissions.length, 2);
    const successor = admissions[1];
    assert.ok(successor);
    const run = await stores.agentRunStore.readRun(session.id, successor.runId);
    const runtimeEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
      session.id,
      successor.runId,
    );
    const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
    assert.equal(terminal.kind, 'fact');
    if (terminal.kind === 'fact') assert.equal(terminal.fact.runStatus, 'cancelled');
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('pre-start message interrupt does not deadlock the Session admission lane', {
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-root-turn-pre-start-interrupt-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');

  const releaseRunCreation = deferred<void>();
  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const rootAdmissionOwner = new RootAdmissionOwner(stores.agentRunStore);
    await rootAdmissionOwner.recoverSession(session.id);

    let liveResidencies = 0;
    const acquireResidency = (): RuntimeHostResidency => {
      liveResidencies += 1;
      let released = false;
      return {
        release: () => {
          assert.equal(released, false);
          released = true;
          liveResidencies -= 1;
        },
      };
    };
    const sessionAdmission = new SessionAdmissionGate();
    const runCreationEntered = deferred<void>();
    let coordinator: RootTurnCoordinator | undefined;
    let continuity: SessionContinuityCoordinator | undefined;
    const stopClaimEntered = deferred<void>();
    const stopFenceCommitted = deferred<void>();
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      startFromMessage: (input, admission) =>
        requireCoordinator(coordinator).startFromMessage(input, admission),
      claimStop: (input, commitQueueFence) => {
        stopClaimEntered.resolve();
        return requireCoordinator(coordinator).claimStop(input, () => {
          const result = commitQueueFence();
          stopFenceCommitted.resolve();
          return result;
        });
      },
    };
    const hostEpoch = 'epoch-pre-start-interrupt';
    const messages = new HostMessageCoordinator({
      hostEpoch,
      root: rootPort,
      durableProof: {
        readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
          stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
        readImmutableSessionRuntimeEvents: async (sessionId) => {
          const runs = await stores.agentRunStore.listSessionRuns(sessionId);
          return (
            await Promise.all(
              runs.map((run) =>
                stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, run.runId),
              ),
            )
          ).flat();
        },
      },
      sessionAdmission,
      acquireResidency,
      onProjectionChanged: (sessionId) =>
        requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
    });
    const canonicalProjection = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: rootAdmissionOwner,
      messages,
    });
    continuity = new SessionContinuityCoordinator(
      hostEpoch,
      (sessionId) => canonicalProjection.read(sessionId),
      sessionAdmission,
    );
    const sink = new RecordingContinuitySink();
    const connectionId = 'connection-pre-start-interrupt';
    const subscription = continuity.attachConnection(connectionId, sink);
    const opened = await continuity.handlers['subscription.open'](
      { sessionId: session.id },
      operationContext(hostEpoch, acquireResidency, connectionId),
    );
    assert.equal(opened.ok, true);
    assert.equal(opened.result.snapshot.rootTurn, null);
    subscription.activate(opened.result.subscriptionId);

    const backends = new BackendRegistry();
    backends.register('fake', (context) => new FakeBackend(context));
    const runtimeRunStore = pauseRunCreation(
      stores.agentRunStore,
      runCreationEntered,
      releaseRunCreation,
    );
    const manager = new SessionManager({
      store: stores.sessionStore,
      runStore: runtimeRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      backends,
      newId: randomUUID,
      now: Date.now,
      messageAuthority: messages,
    });
    let drainRequested = false;
    coordinator = new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      messages,
      continuity,
      acquireResidency,
      () => {
        drainRequested = true;
      },
    );

    const turnId = 'turn-pre-start-interrupt';
    const starting = coordinator.handlers['turn.start'](
      {
        sessionId: session.id,
        turnId,
        content: { text: `long-running root ${'x'.repeat(540)}` },
      },
      operationContext(hostEpoch, acquireResidency, connectionId),
    );
    await runCreationEntered.promise;

    const active = coordinator.readRootState(session.id);
    assert.equal(active.kind, 'active');
    if (active.kind !== 'active') throw new Error('Root Turn was not reserved');
    const admittedFrame = sink.frames.find(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn?.turnId === turnId,
    );
    assert.equal(admittedFrame?.kind, 'subscription.session_projection');
    if (admittedFrame?.kind === 'subscription.session_projection') {
      assert.deepEqual(admittedFrame.snapshot.rootTurn, {
        sessionId: session.id,
        turnId,
        runId: active.runId,
        status: 'admitted',
      });
    }

    const interrupting = messages.handlers['turn.interrupt'](
      {
        originHostEpoch: hostEpoch,
        sessionId: session.id,
        interruptId: 'interrupt-pre-start',
        turnId,
        runId: active.runId,
      },
      operationContext(hostEpoch, acquireResidency, connectionId),
    );
    await stopClaimEntered.promise;
    await completesWithin(stopFenceCommitted.promise, 5_000, 'pre-bind stop fence');
    releaseRunCreation.resolve();

    const [startOutcome, interruptOutcome] = await completesWithin(
      Promise.all([starting, interrupting]),
      5_000,
      'pre-start Turn start and interrupt',
    );
    assert.equal(startOutcome.ok, true);
    assert.equal(interruptOutcome.ok, true);
    assert.equal(interruptOutcome.result.turn.status, 'cancelled');

    await coordinator.close();
    await messages.close();
    subscription.close();
    continuity.close();
    assert.deepEqual(coordinator.readRootState(session.id), { kind: 'idle' });
    assert.equal(liveResidencies, 0);
    assert.equal(drainRequested, false);
  } finally {
    releaseRunCreation.resolve();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

class RecordingContinuitySink implements SessionContinuityFrameSink {
  readonly frames: SubscriptionFrame[] = [];

  async send(frame: SubscriptionFrame): Promise<void> {
    this.frames.push(frame);
  }

  close(): void {}
}

function pauseRunCreation(
  store: AgentRunStore,
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
): AgentRunStore {
  return {
    ...store,
    createRun: async (...args) => {
      entered.resolve();
      await release.promise;
      return store.createRun(...args);
    },
  };
}

function requireCoordinator(coordinator: RootTurnCoordinator | undefined): RootTurnCoordinator {
  if (!coordinator) throw new Error('RootTurnCoordinator is not composed');
  return coordinator;
}

function requireContinuity(
  continuity: SessionContinuityCoordinator | undefined,
): SessionContinuityCoordinator {
  if (!continuity) throw new Error('Continuity coordinator is not bound');
  return continuity;
}

function operationContext(
  hostEpoch: string,
  acquireResidency: () => RuntimeHostResidency,
  connectionId = 'connection-close-handoff',
) {
  return {
    hostEpoch,
    connectionId,
    surface: 'tui' as const,
    principal: 'local_os_user' as const,
    acquireResidency,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

async function completesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
