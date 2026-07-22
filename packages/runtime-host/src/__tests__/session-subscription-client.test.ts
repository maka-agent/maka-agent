import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { prepareRuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  encodeProtocolFrame,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type HostFrame,
  type RequestFrame,
  type SubscriptionFrame,
  type SubscriptionOpenResult,
} from '../protocol/index.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const MIXED_BURST_REQUESTS = 64;

test('installs subscription state before resolving an open response', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-1');
      const delta = deltaFrame(hostEpoch, opened.subscriptionId, 1);
      await transport.writeEncoded(
        Buffer.concat([
          encodeProtocolFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeProtocolFrame(delta),
        ]),
      );
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      assert.deepEqual(await subscription[Symbol.asyncIterator]().next(), {
        done: false,
        value: deltaFrame(connection.hostEpoch, subscription.subscriptionId, 1),
      });
      await subscription.close();
    },
  );
});

test('delivers session removal as a normal terminal subscription frame', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-removed');
      await transport.write({
        requestId: request.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      await transport.write({
        kind: 'subscription.closed',
        hostEpoch,
        subscriptionId: opened.subscriptionId,
        sequence: opened.nextSequence,
        reason: 'session_removed',
      });
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({ sessionId: 'session-1' });
      const iterator = subscription[Symbol.asyncIterator]();
      const terminal = await iterator.next();
      assert.equal(terminal.done, false);
      if (!terminal.done) {
        assert.equal(terminal.value.kind, 'subscription.closed');
        if (terminal.value.kind === 'subscription.closed') {
          assert.equal(terminal.value.reason, 'session_removed');
        }
      }
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    },
  );
});

test('reserves the thirty-second client queue frame for normal Session removal', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-headroom');
      const frames: HostFrame[] = [
        {
          requestId: request.requestId,
          operation: 'subscription.open',
          ok: true,
          result: opened,
        },
        ...Array.from({ length: 31 }, (_, index) =>
          deltaFrame(hostEpoch, opened.subscriptionId, index + 1),
        ),
        {
          kind: 'subscription.closed',
          hostEpoch,
          subscriptionId: opened.subscriptionId,
          sequence: 32,
          reason: 'session_removed',
        },
      ];
      await transport.writeEncoded(
        Buffer.concat(frames.map((frame) => encodeProtocolFrame(frame))),
      );
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({ sessionId: 'session-1' });
      const iterator = subscription[Symbol.asyncIterator]();
      const received: SubscriptionFrame[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        received.push(next.value);
      }
      assert.equal(received.length, 32);
      assert.deepEqual(
        received.map((frame) => frame.sequence),
        Array.from({ length: 32 }, (_, index) => index + 1),
      );
      const terminal = received.at(-1);
      assert.equal(terminal?.kind, 'subscription.closed');
      if (terminal?.kind === 'subscription.closed') {
        assert.equal(terminal.reason, 'session_removed');
      }
    },
  );
});

test('keeps protocol correlation independent from caller mutation of the snapshot', async () => {
  const snapshotMutated = deferred<void>();
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-stable-identity');
      await transport.write({
        requestId: request.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      await snapshotMutated.promise;
      await transport.write(deltaFrame(hostEpoch, opened.subscriptionId, 1));
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      const exposedSession = subscription.snapshot.session as {
        sessionId: string;
      };
      exposedSession.sessionId = 'caller-mutated-session';
      snapshotMutated.resolve();
      const next = await subscription[Symbol.asyncIterator]().next();
      assert.equal(next.done, false);
      if (!next.done) {
        assert.equal(next.value.kind, 'subscription.session_delta');
        if (next.value.kind === 'subscription.session_delta') {
          assert.equal(next.value.sessionId, 'session-1');
        }
      }
      await subscription.close();
    },
  );
});

test('fails the connection when an open response changes the requested Session', async () => {
  const requestObserved = deferred<void>();
  const releaseResponse = deferred<void>();
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      assert.deepEqual(request.input, { sessionId: 'session-1' });
      requestObserved.resolve();
      await releaseResponse.promise;
      const opened = openResult(hostEpoch, 'subscription-wrong-session');
      await transport.write({
        requestId: request.requestId,
        operation: 'subscription.open',
        ok: true,
        result: {
          ...opened,
          snapshot: {
            ...opened.snapshot,
            session: {
              ...opened.snapshot.session,
              sessionId: 'session-2',
            },
            rootTurn: {
              ...opened.snapshot.rootTurn!,
              sessionId: 'session-2',
            },
          },
        },
      });
      await transport.closed;
    },
    async (connection) => {
      const input = { sessionId: 'session-1' };
      const opening = connection.openSessionSubscription(input);
      try {
        await requestObserved.promise;
        input.sessionId = 'session-2';
        releaseResponse.resolve();
        await assert.rejects(opening, /for a different Session/);
        await connection.closed;
      } finally {
        releaseResponse.resolve();
      }
    },
  );
});

test('reloads a sequence-gapped subscription on the same connection', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-gap');
      await transport.writeEncoded(
        Buffer.concat([
          encodeProtocolFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, 1)),
          encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, 3)),
        ]),
      );
      await answerClose(transport, opened.subscriptionId);
      const reload = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in reload));
      assert.equal(reload.operation, 'subscription.open');
      assert.deepEqual(reload.input, { sessionId: 'session-1' });
      const reloaded = openResult(hostEpoch, 'subscription-reloaded');
      await transport.writeEncoded(
        Buffer.concat([
          encodeProtocolFrame({
            requestId: reload.requestId,
            operation: 'subscription.open',
            ok: true,
            result: reloaded,
          }),
          encodeProtocolFrame(deltaFrame(hostEpoch, reloaded.subscriptionId, 1)),
        ]),
      );
      await answerClose(transport, reloaded.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      const first = await subscription[Symbol.asyncIterator]().next();
      assert.equal(first.done, false);
      if (!first.done) assert.equal(first.value.sequence, 1);
      await assert.rejects(
        () => subscription[Symbol.asyncIterator]().next(),
        (error: unknown) =>
          error instanceof RuntimeHostSubscriptionError && error.reason === 'sequence_gap',
      );
      const reloaded = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      assert.notEqual(reloaded.subscriptionId, subscription.subscriptionId);
      assert.equal(reloaded.snapshot.session.sessionId, 'session-1');
      const firstReloaded = await reloaded[Symbol.asyncIterator]().next();
      assert.equal(firstReloaded.done, false);
      if (!firstReloaded.done) assert.equal(firstReloaded.value.sequence, 1);
      await reloaded.close();
    },
  );
});

test('fails the connection when a live subscription frame changes Host Epoch', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-epoch');
      await transport.write({
        requestId: request.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });
      const status = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in status));
      assert.equal(status.operation, 'host.status');
      await transport.write(deltaFrame('different-host-epoch', opened.subscriptionId, 1));
      await transport.closed;
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      const statusFailure = connection.status(5_000).then(
        () => undefined,
        (error: unknown) => error,
      );
      await assert.rejects(
        () => subscription[Symbol.asyncIterator]().next(),
        (error: unknown) =>
          error instanceof RuntimeHostSubscriptionError && error.reason === 'host_epoch_changed',
      );
      const statusError = await statusFailure;
      assert.ok(statusError instanceof RuntimeHostSubscriptionError);
      assert.equal(statusError.reason, 'host_epoch_changed');
      await connection.closed;
    },
  );
});

test('fails the connection when an internal subscription close is rejected', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-close-error');
      await transport.writeEncoded(
        Buffer.concat([
          encodeProtocolFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, 1)),
          encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, 3)),
        ]),
      );
      const close = await readClose(transport, opened.subscriptionId);
      await transport.write({
        requestId: close.requestId,
        operation: 'subscription.close',
        ok: false,
        error: {
          code: 'not_found',
          message: 'Subscription residency no longer exists',
        },
      });
      await transport.closed;
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      assert.equal((await subscription[Symbol.asyncIterator]().next()).done, false);
      await assert.rejects(
        () => subscription[Symbol.asyncIterator]().next(),
        (error: unknown) =>
          error instanceof RuntimeHostSubscriptionError && error.reason === 'sequence_gap',
      );
      await connection.closed;
      await assert.rejects(
        () => connection.status(),
        (error: unknown) =>
          error instanceof RuntimeHostOperationError && error.operation === 'subscription.close',
      );
    },
  );
});

test('fails the connection when an internal subscription close times out', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-close-timeout');
      await transport.writeEncoded(
        Buffer.concat([
          encodeProtocolFrame({
            requestId: request.requestId,
            operation: 'subscription.open',
            ok: true,
            result: opened,
          }),
          encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, 1)),
          encodeProtocolFrame(deltaFrame(hostEpoch, opened.subscriptionId, 3)),
        ]),
      );
      await readClose(transport, opened.subscriptionId);
      await transport.closed;
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      assert.equal((await subscription[Symbol.asyncIterator]().next()).done, false);
      await assert.rejects(
        () => subscription[Symbol.asyncIterator]().next(),
        (error: unknown) =>
          error instanceof RuntimeHostSubscriptionError && error.reason === 'sequence_gap',
      );
      await connection.closed;
      await assert.rejects(
        () => connection.status(),
        (error: unknown) =>
          error instanceof RuntimeHostTransportError && error.code === 'read_timeout',
      );
    },
  );
});

test('evicts only a locally slow subscription and keeps the connection usable', async () => {
  const closeObserved = deferred<void>();
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const request = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-slow');
      const frames: HostFrame[] = [
        {
          requestId: request.requestId,
          operation: 'subscription.open',
          ok: true,
          result: opened,
        },
      ];
      for (let sequence = 1; sequence <= 33; sequence += 1) {
        frames.push(deltaFrame(hostEpoch, opened.subscriptionId, sequence));
      }
      await transport.writeEncoded(
        Buffer.concat(frames.map((frame) => encodeProtocolFrame(frame))),
      );
      await answerClose(transport, opened.subscriptionId, closeObserved.resolve);
      const status = decodeClientFrame(await transport.read(1_000));
      assert.ok(!('kind' in status));
      assert.equal(status.operation, 'host.status');
      await transport.write({
        requestId: status.requestId,
        operation: 'host.status',
        ok: true,
        result: {
          hostEpoch,
          state: 'ready',
          connections: 1,
          activeOperations: 1,
          activeResidencies: 0,
        },
      });
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      await closeObserved.promise;
      await assert.rejects(
        () => subscription[Symbol.asyncIterator]().next(),
        (error: unknown) =>
          error instanceof RuntimeHostSubscriptionError && error.reason === 'slow_consumer',
      );
      assert.equal((await connection.status()).hostEpoch, connection.hostEpoch);
    },
  );
});

test('drains a coalesced mixed burst beyond the transport queue frame bound', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const open = await acceptConnectionAndReadOpen(transport, hostEpoch);
      const opened = openResult(hostEpoch, 'subscription-mixed-burst');
      await transport.write({
        requestId: open.requestId,
        operation: 'subscription.open',
        ok: true,
        result: opened,
      });

      const statusRequests: RequestFrame[] = [];
      for (let index = 0; index < MIXED_BURST_REQUESTS; index += 1) {
        const request = decodeClientFrame(await transport.read(1_000));
        assert.ok(!('kind' in request));
        assert.equal(request.operation, 'host.status');
        statusRequests.push(request);
      }
      const frames: HostFrame[] = statusRequests.map((request) => ({
        requestId: request.requestId,
        operation: 'host.status',
        ok: true,
        result: {
          hostEpoch,
          state: 'ready',
          connections: 1,
          activeOperations: MIXED_BURST_REQUESTS,
          activeResidencies: 1,
        },
      }));
      frames.splice(1, 0, deltaFrame(hostEpoch, opened.subscriptionId, 1));
      frames.push(deltaFrame(hostEpoch, opened.subscriptionId, 2));
      await transport.writeEncoded(
        Buffer.concat(frames.map((frame) => encodeProtocolFrame(frame))),
      );
      await answerClose(transport, opened.subscriptionId);
    },
    async (connection) => {
      const subscription = await connection.openSessionSubscription({
        sessionId: 'session-1',
      });
      const statuses = Array.from({ length: MIXED_BURST_REQUESTS }, () => connection.status(5_000));
      const first = await subscription[Symbol.asyncIterator]().next();
      const second = await subscription[Symbol.asyncIterator]().next();
      assert.equal(first.done, false);
      assert.equal(second.done, false);
      if (!first.done) assert.equal(first.value.sequence, 1);
      if (!second.done) assert.equal(second.value.sequence, 2);
      assert.equal((await Promise.all(statuses)).length, MIXED_BURST_REQUESTS);
      await subscription.close();
    },
  );
});

async function withProtocolPeer(
  serve: (transport: FramedTransport, hostEpoch: string) => Promise<void>,
  run: (connection: RuntimeHostConnection) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-subscription-'));
  const rootPath = join(base, 'root');
  const capability = await resolveStorageRoot({
    path: rootPath,
    kind: 'interactive',
  });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const hostEpoch = randomUUID();
  const endpoint = await prepareRuntimeHostEndpoint({
    rootId: capability.rootId,
    hostEpoch,
  });
  const serverTask = deferred<void>();
  const server = createServer((socket) => {
    void serve(new FramedTransport(socket), hostEpoch).then(serverTask.resolve, serverTask.reject);
  });
  try {
    await listen(server, endpoint.path);
    await endpoint.prepareAfterListen();
    await writeHostRegistration(controlDirectory, {
      kind: 'maka-runtime-host',
      schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
      rootId: capability.rootId,
      hostEpoch,
      endpoint: endpoint.path,
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      state: 'ready',
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const connected = await connectRuntimeHost({
      rootPath,
      surface: 'tui',
      protocol: PROTOCOL,
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') return;
    try {
      await run(connected.connection);
    } finally {
      await connected.connection.close();
    }
    await serverTask.promise;
  } finally {
    await closeServer(server);
    await removeHostRegistration(controlDirectory, hostEpoch).catch(() => undefined);
    await endpoint.cleanup().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

async function acceptConnectionAndReadOpen(
  transport: FramedTransport,
  hostEpoch: string,
): Promise<Extract<RequestFrame, { operation: 'subscription.open' }>> {
  const hello = decodeClientFrame(await transport.read(1_000));
  assert.ok('kind' in hello && hello.kind === 'hello');
  await transport.write({
    kind: 'accepted',
    hostEpoch,
    connectionId: 'connection-1',
    selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
    state: 'ready',
  });
  const request = decodeClientFrame(await transport.read(1_000));
  assert.ok(!('kind' in request));
  assert.equal(request.operation, 'subscription.open');
  return request as Extract<RequestFrame, { operation: 'subscription.open' }>;
}

async function answerClose(
  transport: FramedTransport,
  subscriptionId: string,
  onObserved?: () => void,
): Promise<void> {
  const request = await readClose(transport, subscriptionId);
  onObserved?.();
  await transport.write({
    requestId: request.requestId,
    operation: 'subscription.close',
    ok: true,
    result: { subscriptionId },
  });
}

async function readClose(
  transport: FramedTransport,
  subscriptionId: string,
): Promise<Extract<RequestFrame, { operation: 'subscription.close' }>> {
  const request = decodeClientFrame(await transport.read(1_000));
  assert.ok(!('kind' in request));
  assert.equal(request.operation, 'subscription.close');
  assert.deepEqual(request.input, { subscriptionId });
  return request as Extract<RequestFrame, { operation: 'subscription.close' }>;
}

function openResult(hostEpoch: string, subscriptionId: string): SubscriptionOpenResult {
  return {
    hostEpoch,
    subscriptionId,
    nextSequence: 1,
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: {
        sessionId: 'session-1',
        status: 'running',
        createdAt: 1,
        lastUsedAt: 2,
        isArchived: false,
      },
      projectionRevision: 1,
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running',
      },
      interactions: { pending: [] },
      queue: {
        hostEpoch,
        queueRevision: 0,
        steering: [],
        followup: [],
      },
    },
  };
}

function deltaFrame(
  hostEpoch: string,
  subscriptionId: string,
  sequence: number,
): SubscriptionFrame {
  return {
    kind: 'subscription.session_delta',
    hostEpoch,
    subscriptionId,
    sequence,
    sessionId: 'session-1',
    delta: {
      kind: 'text',
      turnId: 'turn-1',
      runId: 'run-1',
      messageId: 'message-1',
      text: `chunk-${sequence}`,
    },
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
