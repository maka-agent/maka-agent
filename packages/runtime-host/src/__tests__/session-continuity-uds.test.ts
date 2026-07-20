import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { readHostRegistration } from '../control/registration.js';
import {
  decodeHostFrame,
  encodeProtocolFrame,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
  SESSION_LIVE_DELTA_MAX_BYTES,
  type HostStatusResult,
  type SubscriptionOpenResult,
  type TurnSnapshot,
} from '../protocol/index.js';
import { RuntimeHostKernel } from '../server/index.js';
import {
  combineDomainOperationHandlers,
  createUnavailableDomainOperationHandlers,
  type TurnOperationHandlerMap,
} from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import {
  type CanonicalSessionProjection,
  type ReadCanonicalSessionProjection,
  SessionContinuityCoordinator,
} from '../server/session-continuity-coordinator.js';
import { FramedTransport } from '../transport/framed-transport.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('a connection accepted during recovery resolves ready handlers and continuity without reconnecting', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-pre-ready-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const recoveryEntered = deferred();
  const releaseRecovery = deferred();
  const canonicalReadEntered = deferred();
  const releaseCanonicalRead = deferred();
  const concurrentReadEntered = deferred();
  const releaseConcurrentRead = deferred();
  let blockCanonicalRead = false;
  let blockConcurrentRead = false;
  const canonicalReadCounts = new Map<string, number>();
  let continuity: SessionContinuityCoordinator | undefined;
  const hostTask = RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    compositionFactory: async (context) => {
      continuity = new SessionContinuityCoordinator(
        context.hostEpoch,
        async (sessionId) => {
          const previousReadCount = canonicalReadCounts.get(sessionId) ?? 0;
          if (sessionId === 'session' && blockCanonicalRead && previousReadCount === 0) {
            canonicalReadEntered.resolve();
            await releaseCanonicalRead.promise;
          }
          if (sessionId === 'session' && blockConcurrentRead) {
            concurrentReadEntered.resolve();
            await releaseConcurrentRead.promise;
            blockConcurrentRead = false;
          }
          const readCount = previousReadCount + 1;
          canonicalReadCounts.set(sessionId, readCount);
          return canonicalProjection(sessionId, readCount);
        },
        new SessionAdmissionGate(),
      );
      recoveryEntered.resolve();
      return {
        handlers: combineDomainOperationHandlers(
          createTurnHandlers(),
          continuity.handlers,
          createUnavailableInteractionHandlers(),
        ),
        continuity,
        async recover() {
          await releaseRecovery.promise;
        },
        async close() {
          continuity?.close();
          return { kind: 'clean' };
        },
      };
    },
  });
  let transport: FramedTransport | undefined;
  let host: RuntimeHostKernel | undefined;
  try {
    await withTimeout(recoveryEntered.promise, 1_000, 'Runtime Host did not enter recovery');
    const registration = await readHostRegistration(owner.controlDirectory);
    assert.ok(registration);
    assert.equal(registration.state, 'recovering');
    transport = await openAcceptedTransport(registration.endpoint, 'pre-ready-client');

    await transport.write({
      requestId: 'before-ready',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn' },
    });
    const beforeReady = decodeHostFrame(await transport.read(1_000));
    if ('kind' in beforeReady) assert.fail('Expected an operation response');
    if (beforeReady.ok) assert.fail('Pre-ready request unexpectedly succeeded');
    assert.equal(beforeReady.error.code, 'host_not_ready');

    releaseRecovery.resolve();
    host = await withTimeout(hostTask, 1_000, 'Runtime Host did not become ready');
    const continuityService = continuity;
    assert.ok(continuityService);

    await transport.write({
      requestId: 'after-ready',
      operation: 'turn.query',
      input: { sessionId: 'session', turnId: 'turn' },
    });
    const afterReady = decodeHostFrame(await transport.read(1_000));
    if ('kind' in afterReady) assert.fail('Expected an operation response');
    if (afterReady.operation !== 'turn.query') {
      assert.fail('Expected a turn.query response');
    }
    if (!afterReady.ok) assert.fail(afterReady.error.message);
    assert.equal(afterReady.result.runId, 'run-turn');

    blockCanonicalRead = true;
    const opening = openSubscription(transport, 'session');
    await withTimeout(
      canonicalReadEntered.promise,
      1_000,
      'subscription.open did not enter its canonical snapshot cut',
    );
    const queuedDelta = continuityService.acceptAssistantDelta('session', 'run-turn', {
      type: 'text_delta',
      turnId: 'turn',
      messageId: 'message',
      text: 'ready',
    });
    const queuedRefresh = continuityService.refreshCanonical('session');
    releaseCanonicalRead.resolve();
    const opened = await opening;
    assert.equal(opened.snapshot.session.sessionId, 'session');
    assert.equal(opened.snapshot.projectionRevision, 1);
    assert.equal(opened.snapshot.session.lastUsedAt, 1);
    await Promise.all([queuedDelta, queuedRefresh]);
    const delta = decodeHostFrame(await transport.read(1_000));
    if (!('kind' in delta) || delta.kind !== 'subscription.session_delta') {
      assert.fail('Expected a session delta');
    }
    assert.equal(delta.sequence, 1);
    assert.equal(delta.delta.text, 'ready');
    const projection = decodeHostFrame(await transport.read(1_000));
    if (!('kind' in projection) || projection.kind !== 'subscription.session_projection') {
      assert.fail('Expected a session projection');
    }
    assert.equal(projection.sequence, 2);
    assert.equal(projection.snapshot.projectionRevision, 2);
    assert.equal(projection.snapshot.session.lastUsedAt, 2);

    blockConcurrentRead = true;
    await transport.write({
      requestId: 'concurrent-open',
      operation: 'subscription.open',
      input: { sessionId: 'session' },
    });
    await withTimeout(
      concurrentReadEntered.promise,
      1_000,
      'concurrent subscription.open did not enter canonical read',
    );
    await closeSubscription(transport, opened.subscriptionId, 'close-during-open');
    releaseConcurrentRead.resolve();
    const concurrentOpen = await readOpenSubscriptionResponse(transport);
    assert.equal(concurrentOpen.snapshot.projectionRevision, 3);
    const concurrentMarkerRead = transport.read(1_000);
    await continuityService.acceptAssistantDelta('session', 'run-turn', {
      type: 'text_delta',
      turnId: 'turn',
      messageId: 'message',
      text: 'survived-concurrent-close',
    });
    const concurrentMarker = decodeHostFrame(await concurrentMarkerRead);
    if (!('kind' in concurrentMarker) || concurrentMarker.kind !== 'subscription.session_delta') {
      assert.fail('New subscription was orphaned by inactive state cleanup');
    }
    assert.equal(concurrentMarker.sequence, 1);
    assert.equal(concurrentMarker.delta.text, 'survived-concurrent-close');
    await closeSubscription(transport, concurrentOpen.subscriptionId, 'close-concurrent-open');
    await continuityService.refreshCanonical('session');
    const reopenedSession = await openSubscription(transport, 'session', 'reopen-session');
    assert.equal(reopenedSession.snapshot.projectionRevision, 1);
    assert.equal(reopenedSession.snapshot.session.lastUsedAt, 4);
    await closeSubscription(transport, reopenedSession.subscriptionId, 'close-reopened-session');
    await continuityService.refreshCanonical('session');
  } finally {
    releaseRecovery.resolve();
    releaseCanonicalRead.resolve();
    releaseConcurrentRead.resolve();
    transport?.destroy();
    host ??= await hostTask.catch(() => undefined);
    await host?.close().catch(() => undefined);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

test('a disconnected opener cannot consume a canonical update from existing subscribers', async () => {
  const canonicalReadEntered = deferred();
  const releaseCanonicalRead = deferred();
  let deferCanonicalRead = false;
  let canonical = canonicalProjection('session', 1);
  await withContinuityHost(
    'session',
    async ({ continuity, endpoint }) => {
      const subscriber = await openAcceptedTransport(endpoint, 'subscriber');
      const opener = await openAcceptedTransport(endpoint, 'disconnecting-opener');
      try {
        const opened = await openSubscription(subscriber, 'session');
        canonical = canonicalProjection('session', 2);
        deferCanonicalRead = true;
        const opening = openSubscription(opener, 'session', 'disconnecting-open').then(
          () => assert.fail('Disconnected subscription.open unexpectedly resolved'),
          () => {},
        );
        await withTimeout(
          canonicalReadEntered.promise,
          1_000,
          'subscription.open did not enter its deferred canonical read',
        );

        opener.destroy();
        await opener.closed;
        await waitForStatus(subscriber, (status) => status.connections === 1);
        releaseCanonicalRead.resolve();

        const projectionRead = subscriber.read(1_000);
        await continuity.refreshCanonical('session');
        const projection = decodeHostFrame(await projectionRead);
        if (!('kind' in projection) || projection.kind !== 'subscription.session_projection') {
          assert.fail('Existing subscriber did not receive the canonical update');
        }
        assert.equal(projection.sequence, opened.nextSequence);
        assert.equal(projection.snapshot.projectionRevision, 2);
        assert.equal(projection.snapshot.session.lastUsedAt, 2);
        await opening;
      } finally {
        releaseCanonicalRead.resolve();
        opener.destroy();
        subscriber.destroy();
      }
    },
    {
      readCanonical: async (requestedSessionId) => {
        if (requestedSessionId !== 'session') return null;
        if (deferCanonicalRead) {
          deferCanonicalRead = false;
          canonicalReadEntered.resolve();
          await releaseCanonicalRead.promise;
        }
        return canonical;
      },
    },
  );
});

test('a terminal publication fence withholds terminal projection until explicit publish', async () => {
  let canonical = canonicalProjection('session', 1);
  await withContinuityHost(
    'session',
    async ({ continuity, endpoint }) => {
      await continuity.holdTerminalPublication('session', 'turn', 'run-turn');
      const subscriber = await openAcceptedTransport(endpoint, 'subscriber');
      const terminalOpener = await openAcceptedTransport(endpoint, 'terminal-opener');
      try {
        const opened = await openSubscription(subscriber, 'session');
        assert.equal(opened.snapshot.rootTurn?.status, 'running');
        assert.equal(opened.snapshot.projectionRevision, 1);

        canonical = {
          ...canonicalProjection('session', 2),
          rootTurn: completedSnapshot('session', 'turn'),
        };
        const withheld = await openSubscription(
          terminalOpener,
          'session',
          'open-before-terminal-publish',
        );
        assert.equal(withheld.snapshot.rootTurn?.status, 'running');
        assert.equal(withheld.snapshot.session.lastUsedAt, 1);
        assert.equal(withheld.snapshot.projectionRevision, 1);

        const terminalRead = subscriber.read(1_000);
        await continuity.publishTerminalProjection('session', 'turn', 'run-turn', () => undefined);
        const terminal = decodeHostFrame(await terminalRead);
        if (!('kind' in terminal) || terminal.kind !== 'subscription.session_projection') {
          assert.fail('Existing subscriber did not receive terminal projection');
        }
        assert.equal(terminal.sequence, opened.nextSequence);
        assert.equal(terminal.snapshot.rootTurn?.status, 'completed');
        assert.equal(terminal.snapshot.projectionRevision, 2);

        const afterPublish = await openAcceptedTransport(endpoint, 'after-publish');
        try {
          const published = await openSubscription(
            afterPublish,
            'session',
            'open-after-terminal-publish',
          );
          assert.equal(published.snapshot.rootTurn?.status, 'completed');
          assert.equal(published.snapshot.session.lastUsedAt, 2);
          assert.equal(published.snapshot.projectionRevision, 2);
        } finally {
          afterPublish.destroy();
        }
      } finally {
        terminalOpener.destroy();
        subscriber.destroy();
      }
    },
    {
      readCanonical: async (requestedSessionId) =>
        requestedSessionId === 'session' ? canonical : null,
    },
  );
});

test('live deltas stay within the encoded wire budget for control characters and lone surrogates', async () => {
  const sessionId = 's'.repeat(128);
  await withContinuityHost(sessionId, async ({ continuity, endpoint }) => {
    const transport = await openAcceptedTransport(endpoint, 'wire-budget-client');
    try {
      const opened = await openSubscription(transport, sessionId);
      const text =
        '\0'.repeat(12_000) + '\u0001\u0002\b\f\n\r\t'.repeat(500) + '\ud800'.repeat(1_000);
      await continuity.acceptAssistantDelta(sessionId, 'r'.repeat(128), {
        type: 'text_delta',
        turnId: 't'.repeat(128),
        messageId: 'm'.repeat(128),
        text,
      });

      let received = '';
      let sequence = opened.nextSequence;
      while (received.length < text.length) {
        const frame = decodeHostFrame(await transport.read(1_000));
        if (!('kind' in frame) || frame.kind !== 'subscription.session_delta') {
          assert.fail('Expected a session delta');
        }
        assert.equal(frame.sequence, sequence);
        assert.ok(Buffer.byteLength(frame.delta.text, 'utf8') <= SESSION_LIVE_DELTA_MAX_BYTES);
        assert.ok(encodeProtocolFrame(frame).byteLength <= RUNTIME_HOST_MAX_FRAME_BYTES);
        received += frame.delta.text;
        sequence += 1;
      }
      assert.equal(received, text);
    } finally {
      transport.destroy();
    }
  });
});

test('a paused UDS subscriber does not block another client', async () => {
  await withContinuityHost('session', async ({ continuity, endpoint }) => {
    const slow = await openAcceptedTransport(endpoint, 'slow-client');
    const observer = await openAcceptedTransport(endpoint, 'observer-client');
    try {
      await openSubscription(slow, 'session');
      const observerSubscription = await openSubscription(observer, 'session');
      slow.socket.pause();
      assert.equal(slow.socket.isPaused(), true);
      const text = '\0'.repeat(10_000);
      let observerSequence = observerSubscription.nextSequence;
      for (let index = 0; index < 8; index += 1) {
        const observerRead = observer.read(5_000);
        await continuity.acceptAssistantDelta('session', 'run-turn', {
          type: 'text_delta',
          turnId: 'turn',
          messageId: 'message',
          text,
        });
        const frame = decodeHostFrame(await observerRead);
        if (!('kind' in frame) || frame.kind !== 'subscription.session_delta') {
          assert.fail('Observer did not receive the burst delta');
        }
        assert.equal(frame.sequence, observerSequence);
        assert.equal(frame.delta.text, text);
        observerSequence += 1;
      }

      const markerRead = observer.read(1_000);
      await continuity.acceptAssistantDelta('session', 'run-turn', {
        type: 'text_delta',
        turnId: 'turn',
        messageId: 'message',
        text: 'after-slow-client',
      });
      const marker = decodeHostFrame(await markerRead);
      if (!('kind' in marker) || marker.kind !== 'subscription.session_delta') {
        assert.fail('Observer did not receive the marker');
      }
      assert.equal(marker.sequence, observerSequence);
      assert.equal(marker.delta.text, 'after-slow-client');

      slow.destroy();
      await slow.closed;
      const status = await waitForStatus(observer, (value) => value.connections === 1);
      assert.equal(status.state, 'ready');
      assert.equal(status.connections, 1);
    } finally {
      slow.destroy();
      observer.destroy();
    }
  });
});

interface ContinuityHostFixture {
  continuity: SessionContinuityCoordinator;
  endpoint: string;
}

interface ContinuityHostConfig {
  readCanonical?: ReadCanonicalSessionProjection;
}

async function withContinuityHost(
  sessionId: string,
  run: (fixture: ContinuityHostFixture) => Promise<void>,
  config: ContinuityHostConfig = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-continuity-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let continuity: SessionContinuityCoordinator | undefined;
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    compositionFactory: async (context) => {
      continuity = config.readCanonical
        ? new SessionContinuityCoordinator(
            context.hostEpoch,
            config.readCanonical,
            new SessionAdmissionGate(),
          )
        : createContinuity(context.hostEpoch, sessionId);
      return {
        handlers: combineDomainOperationHandlers(
          createTurnHandlers(),
          continuity.handlers,
          createUnavailableInteractionHandlers(),
        ),
        continuity,
        async recover() {},
        async close() {
          continuity?.close();
          return { kind: 'clean' };
        },
      };
    },
  });
  assert.ok(continuity);
  try {
    await run({ continuity, endpoint: host.endpoint });
  } finally {
    await host.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
}

function createUnavailableInteractionHandlers() {
  const unavailable = createUnavailableDomainOperationHandlers();
  return {
    'interaction.query': unavailable['interaction.query'],
    'interaction.answer': unavailable['interaction.answer'],
  };
}

function createContinuity(hostEpoch: string, sessionId: string): SessionContinuityCoordinator {
  return new SessionContinuityCoordinator(
    hostEpoch,
    async (requestedSessionId) =>
      requestedSessionId === sessionId ? canonicalProjection(sessionId, 1) : null,
    new SessionAdmissionGate(),
  );
}

function canonicalProjection(sessionId: string, lastUsedAt: number): CanonicalSessionProjection {
  return {
    session: {
      sessionId,
      status: 'running',
      createdAt: 1,
      lastUsedAt,
      isArchived: false,
    },
    rootTurn: runningSnapshot(sessionId, 'turn'),
    interactions: { pending: [] },
  };
}

function createTurnHandlers(): TurnOperationHandlerMap {
  return {
    'turn.start': async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    'turn.query': async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
    'turn.stop': async (input) => ({
      ok: true,
      result: runningSnapshot(input.sessionId, input.turnId),
    }),
  };
}

function runningSnapshot(sessionId: string, turnId: string): TurnSnapshot {
  return {
    sessionId,
    turnId,
    runId: `run-${turnId}`,
    status: 'running',
  };
}

function completedSnapshot(sessionId: string, turnId: string): TurnSnapshot {
  return {
    sessionId,
    turnId,
    runId: `run-${turnId}`,
    status: 'completed',
    terminalEventId: `terminal-${turnId}`,
  };
}

async function openAcceptedTransport(
  endpoint: string,
  clientInstanceId: string,
): Promise<FramedTransport> {
  const socket = connect(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const transport = new FramedTransport(socket);
  await transport.write({
    kind: 'hello',
    clientInstanceId,
    surface: 'tui',
    protocolMin: CURRENT_PROTOCOL.min,
    protocolMax: CURRENT_PROTOCOL.max,
  });
  const handshake = decodeHostFrame(await transport.read(1_000));
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  return transport;
}

async function openSubscription(
  transport: FramedTransport,
  sessionId: string,
  requestId = 'open-subscription',
): Promise<SubscriptionOpenResult> {
  await transport.write({
    requestId,
    operation: 'subscription.open',
    input: { sessionId },
  });
  return readOpenSubscriptionResponse(transport);
}

async function readOpenSubscriptionResponse(
  transport: FramedTransport,
): Promise<SubscriptionOpenResult> {
  const response = decodeHostFrame(await transport.read(1_000));
  if ('kind' in response) assert.fail('Expected an operation response');
  if (response.operation !== 'subscription.open') {
    assert.fail('Expected a subscription.open response');
  }
  if (!response.ok) assert.fail(response.error.message);
  return response.result;
}

async function closeSubscription(
  transport: FramedTransport,
  subscriptionId: string,
  requestId: string,
): Promise<void> {
  await transport.write({
    requestId,
    operation: 'subscription.close',
    input: { subscriptionId },
  });
  const response = decodeHostFrame(await transport.read(1_000));
  if ('kind' in response || response.operation !== 'subscription.close') {
    assert.fail('Expected a subscription.close response');
  }
  if (!response.ok) assert.fail(response.error.message);
  assert.equal(response.result.subscriptionId, subscriptionId);
}

async function waitForStatus(
  transport: FramedTransport,
  predicate: (status: HostStatusResult) => boolean,
): Promise<HostStatusResult> {
  const deadline = Date.now() + 1_000;
  let status: HostStatusResult;
  do {
    await transport.write({
      requestId: `status-${Date.now()}-${Math.random()}`,
      operation: 'host.status',
      input: {},
    });
    const response = decodeHostFrame(await transport.read(1_000));
    if ('kind' in response) assert.fail('Expected an operation response');
    if (response.operation !== 'host.status') {
      assert.fail('Expected a host.status response');
    }
    if (!response.ok) assert.fail(response.error.message);
    status = response.result;
    if (predicate(status)) return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail('Runtime Host status did not reach the expected state');
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
