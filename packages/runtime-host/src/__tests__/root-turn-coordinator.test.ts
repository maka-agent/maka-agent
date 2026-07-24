import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BackendRegistry,
  classifyTerminalRuntimeLedger,
  FakeBackend,
  FAKE_ASK_USER_QUESTION_PROMPT,
  LOCAL_READ_AGENT_PROFILE,
  SessionManager,
  type RuntimeHostedRootAuthority,
} from '@maka/runtime';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import type { MakaTool } from '@maka/runtime';
import {
  openInteractiveExecutionStoresForWrite,
  type RootTurnAdmissionStore,
} from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { RuntimeHostResidency } from '../server/host-kernel.js';
import { type HostMessageRootPort, HostMessageCoordinator } from '../server/message-coordinator.js';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { RootTurnCoordinator } from '../server/root-turn-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('hosted linked child roots share admission, message, terminal, and stop authority', {
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-linked-root-authority-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');

  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const parent = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const sessionAdmission = new SessionAdmissionGate();
    const rootAdmissionOwner = new RootAdmissionOwner(stores.agentRunStore);
    await rootAdmissionOwner.recoverSession(parent.id);
    const acquireResidency = (): RuntimeHostResidency => ({ release() {} });
    let coordinator: RootTurnCoordinator | undefined;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      startFromMessage: (input) => requireCoordinator(coordinator).startFromMessage(input),
      claimStop: (input, commitQueueFence) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence),
    };
    const hostEpoch = 'epoch-linked-root';
    await stores.messageReceiptStore.beginHostEpoch(hostEpoch);
    const messages = new HostMessageCoordinator({
      hostEpoch,
      root: rootPort,
      durableProof: {
        readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
          stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
        readImmutableSteeringMessageProof: (sessionId, messageId) =>
          stores.runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId),
      },
      receipts: stores.messageReceiptStore,
      sessionAdmission,
      acquireResidency,
    });
    const authority: RuntimeHostedRootAuthority = {
      bindRun: (identity) => messages.bindRun(identity),
      executeRoot: (input) => requireCoordinator(coordinator).executeRoot(input),
      stopRoot: (identity, input) => requireCoordinator(coordinator).stopRoot(identity, input),
      stopSession: (sessionId, input) =>
        requireCoordinator(coordinator).stopSession(sessionId, input),
    };
    const backends = new BackendRegistry();
    backends.register('fake', (context) =>
      context.header.subagentRuntime
        ? new LinkedChildAuthorityBackend(context.sessionId)
        : new FakeBackend(context),
    );
    const manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: randomUUID,
      now: Date.now,
      messageAuthority: authority,
    });
    let drainRequested = false;
    coordinator = new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      messages,
      acquireResidency,
      () => {
        drainRequested = true;
      },
    );

    const parentTurnId = randomUUID();
    const parentStarted = await coordinator.handlers['turn.start'](
      {
        sessionId: parent.id,
        turnId: parentTurnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      },
      operationContext('epoch-linked-root', acquireResidency),
    );
    assert.equal(parentStarted.ok, true);
    if (!parentStarted.ok) return;

    let initialReady:
      | {
          childSessionId: string;
          turnId: string;
          runId: string;
          agentId: string;
          agentName: string;
        }
      | undefined;
    let initialEventCount = 0;
    const child = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentStarted.result.runId,
        parentTurnId,
        toolCallId: 'linked-initial',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'initial linked child',
      onReady: (ready) => {
        initialReady = ready;
      },
      onEvent: () => {
        initialEventCount += 1;
      },
    });
    assert.equal(child.status, 'completed');
    assert.deepEqual(initialReady, {
      childSessionId: child.childSessionId,
      turnId: child.turnId,
      runId: child.runId,
      agentId: child.agentId,
      agentName: child.agentName,
    });
    assert.equal(initialEventCount, child.eventCount);
    const initialAdmissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      child.childSessionId,
    );
    assert.equal(initialAdmissions.length, 1);
    assert.equal(initialAdmissions[0]?.runId, child.runId);
    assert.ok(initialAdmissions[0]?.userMessageId);
    assert.deepEqual(initialAdmissions[0]?.execution, {
      kind: 'linked_child_initial',
      agentId: child.agentId,
      agentName: child.agentName,
    });
    const externalJoin = await coordinator.handlers['turn.start'](
      {
        sessionId: child.childSessionId,
        turnId: child.turnId,
        content: { text: 'initial linked child' },
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.deepEqual(externalJoin, {
      ok: false,
      error: {
        code: 'operation_conflict',
        message: 'Turn identity belongs to a different execution kind',
      },
    });

    let resumeReadyRunId: string | undefined;
    let resumeEventCount = 0;
    const resumed = await manager.resumeChildAgent(parent.id, {
      parentRunId: parentStarted.result.runId,
      sourceRunId: child.runId,
      prompt: 'rate limit this resumed child',
      onReady: (ready) => {
        resumeReadyRunId = ready.runId;
      },
      onEvent: () => {
        resumeEventCount += 1;
      },
    });
    assert.equal(resumed.status, 'failed');
    assert.equal(resumed.failureClass, 'RateLimit');
    assert.equal(resumed.resumedFromRunId, child.runId);
    assert.equal(resumeReadyRunId, resumed.runId);
    assert.equal(resumeEventCount, resumed.eventCount);

    let retryReadyRunId: string | undefined;
    let retryEventCount = 0;
    const retried = await manager.retryChildAgent(parent.id, {
      parentRunId: parentStarted.result.runId,
      sourceRunId: resumed.runId!,
      execution: {
        kind: 'child_session',
        sessionId: child.childSessionId,
        currentRunId: resumed.runId,
      },
      onReady: (ready) => {
        retryReadyRunId = ready.runId;
      },
      onEvent: () => {
        retryEventCount += 1;
      },
    });
    assert.equal(retried.status, 'completed');
    assert.equal(retried.retriedFromRunId, resumed.runId);
    assert.equal(retryReadyRunId, retried.runId);
    assert.equal(retryEventCount, retried.eventCount);
    const admissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      child.childSessionId,
    );
    assert.equal(admissions.length, 3);
    assert.equal(admissions[1]?.runId, resumed.runId);
    assert.ok(admissions[1]?.userMessageId);
    assert.deepEqual(admissions[1]?.execution, {
      kind: 'linked_child_resume',
      agentId: resumed.agentId,
      agentName: resumed.agentName,
      sourceRunId: child.runId,
    });
    assert.equal(admissions[2]?.runId, retried.runId);
    assert.equal(admissions[2]?.userMessageId, null);
    assert.deepEqual(admissions[2]?.execution, {
      kind: 'linked_child_provider_retry',
      agentId: retried.agentId,
      agentName: retried.agentName,
      sourceRunId: resumed.runId,
    });
    const retryMessages = (await stores.sessionStore.readMessages(child.childSessionId)).filter(
      (message) => 'turnId' in message && message.turnId === retried.turnId,
    );
    assert.deepEqual(retryMessages, []);
    assert.deepEqual(coordinator.readRootState(child.childSessionId), { kind: 'idle' });

    const abortController = new AbortController();
    let joinedInitial: Promise<typeof child> | undefined;
    const interrupted = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentStarted.result.runId,
        parentTurnId,
        toolCallId: 'linked-interrupt',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: FAKE_ASK_USER_QUESTION_PROMPT,
      abortSignal: abortController.signal,
      onReady: () => {
        joinedInitial = manager.spawnChildSession(parent.id, {
          spawnedBy: {
            parentRunId: parentStarted.result.runId,
            parentTurnId,
            toolCallId: 'linked-interrupt',
          },
          agentProfile: LOCAL_READ_AGENT_PROFILE,
          prompt: FAKE_ASK_USER_QUESTION_PROMPT,
        });
        abortController.abort();
      },
    });
    assert.ok(joinedInitial);
    const joinedInterrupted = await joinedInitial;
    assert.equal(interrupted.status, 'cancelled');
    assert.deepEqual(joinedInterrupted, interrupted);
    const interruptedRun = await stores.agentRunStore.readRun(
      interrupted.childSessionId,
      interrupted.runId,
    );
    const interruptedEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
      interrupted.childSessionId,
      interrupted.runId,
    );
    const interruptedTerminal = classifyTerminalRuntimeLedger(interruptedRun, interruptedEvents);
    assert.equal(interruptedTerminal.kind, 'fact');
    if (interruptedTerminal.kind === 'fact') {
      assert.equal(interruptedTerminal.fact.runStatus, 'cancelled');
    }
    assert.deepEqual(coordinator.readRootState(interrupted.childSessionId), { kind: 'idle' });
    assert.equal(drainRequested, false);

    await coordinator.stopRoot({
      sessionId: parent.id,
      turnId: parentTurnId,
      runId: parentStarted.result.runId,
    });
    await coordinator.close();
    await messages.close();
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('exact stop reaches a reserved pre-start Turn and releases its Host ownership', {
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-root-turn-pre-start-stop-'));
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
    const backendFactoryEntered = deferred<void>();
    const releaseBackendFactory = deferred<void>();
    const sessionAdmission = new SessionAdmissionGate();
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
    let coordinator: RootTurnCoordinator | undefined;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      startFromMessage: (input) => requireCoordinator(coordinator).startFromMessage(input),
      claimStop: (input, commitQueueFence) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence),
    };
    const hostEpoch = 'epoch-pre-start-stop';
    await stores.messageReceiptStore.beginHostEpoch(hostEpoch);
    const messages = new HostMessageCoordinator({
      hostEpoch,
      root: rootPort,
      durableProof: {
        readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
          stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
        readImmutableSteeringMessageProof: (sessionId, messageId) =>
          stores.runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId),
      },
      receipts: stores.messageReceiptStore,
      sessionAdmission,
      acquireResidency,
    });
    const backends = new BackendRegistry();
    backends.register('fake', async (context) => {
      backendFactoryEntered.resolve();
      await releaseBackendFactory.promise;
      return new FakeBackend(context);
    });
    const manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      backends,
      newId: randomUUID,
      now: Date.now,
      messageAuthority: messages,
    });
    const stopDeliveryStarted = deferred<void>();
    const coordinatorManager = {
      sendMessage: manager.sendMessage.bind(manager),
      closePendingHostedLinkedChildAdmission:
        manager.closePendingHostedLinkedChildAdmission.bind(manager),
      deliverHostedRootStop: async (
        sessionId: string,
        input?: Parameters<SessionManager['deliverHostedRootStop']>[1],
      ) => {
        stopDeliveryStarted.resolve();
        await manager.deliverHostedRootStop(sessionId, input);
      },
    } as SessionManager;
    let drainRequested = false;
    coordinator = new RootTurnCoordinator(
      coordinatorManager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      messages,
      acquireResidency,
      () => {
        drainRequested = true;
      },
    );

    const turnId = 'turn-pre-start-stop';
    const starting = coordinator.handlers['turn.start'](
      {
        sessionId: session.id,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      },
      operationContext(hostEpoch, acquireResidency),
    );
    await backendFactoryEntered.promise;
    const admission = await stores.agentRunStore.readRootTurnAdmission(session.id, turnId);
    assert.ok(admission);
    if (!admission) return;

    const stopping = coordinator.handlers['turn.stop'](
      {
        sessionId: session.id,
        turnId,
        runId: admission.runId,
      },
      operationContext(hostEpoch, acquireResidency),
    );
    await stopDeliveryStarted.promise;
    releaseBackendFactory.resolve();
    const [stopped, started] = await Promise.all([stopping, starting]);
    assert.equal(stopped.ok, true);
    if (stopped.ok) assert.equal(stopped.result.status, 'cancelled');
    assert.equal(started.ok, true);

    assert.deepEqual(coordinator.readRootState(session.id), { kind: 'idle' });
    assert.equal(liveResidencies, 0);
    assert.equal(drainRequested, false);
    await coordinator.close();
    await messages.close();
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

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
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      startFromMessage: (input) => requireCoordinator(coordinator).startFromMessage(input),
      claimStop: (input, commitQueueFence) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence),
    };
    const hostEpoch = 'epoch-close-handoff';
    await stores.messageReceiptStore.beginHostEpoch(hostEpoch);
    const messages = new HostMessageCoordinator({
      hostEpoch,
      root: rootPort,
      durableProof: {
        readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
          stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
        readImmutableSteeringMessageProof: (sessionId, messageId) =>
          stores.runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId),
      },
      receipts: stores.messageReceiptStore,
      sessionAdmission,
      acquireResidency,
    });
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

function requireCoordinator(coordinator: RootTurnCoordinator | undefined): RootTurnCoordinator {
  if (!coordinator) throw new Error('RootTurnCoordinator is not composed');
  return coordinator;
}

function operationContext(hostEpoch: string, acquireResidency: () => RuntimeHostResidency) {
  return {
    hostEpoch,
    connectionId: 'connection-close-handoff',
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

class LinkedChildAuthorityBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  private stopped = false;
  private releaseWait: (() => void) | undefined;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.stopped = false;
    if (input.text === FAKE_ASK_USER_QUESTION_PROMPT) {
      await new Promise<void>((resolve) => {
        this.releaseWait = resolve;
        if (this.stopped) resolve();
      });
      yield {
        type: 'abort',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        reason: 'user_stop',
      };
      yield {
        type: 'complete',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        stopReason: 'user_stop',
      };
      return;
    }
    if (input.text.includes('rate limit')) {
      yield {
        type: 'error',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        recoverable: true,
        reason: 'RateLimit',
        message: 'provider 429',
      };
      yield {
        type: 'complete',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        stopReason: 'error',
      };
      return;
    }
    yield {
      type: 'text_delta',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      messageId: randomUUID(),
      text: 'linked child complete',
    };
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.releaseWait?.();
  }

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    this.releaseWait?.();
  }
}

function testTool(name: string): MakaTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: {},
    permissionRequired: false,
    impl: async () => ({ ok: true }),
  };
}
