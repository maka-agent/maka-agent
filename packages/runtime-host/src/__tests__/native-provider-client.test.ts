import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  connectRuntimeHost,
  createNativeCapabilityProvider,
  type NativeCapabilityImplementation,
  type NativeCapabilityProvider,
  type RuntimeHostConnection,
} from '../client/index.js';
import type { ClientNativeProviderAttachment } from '../client/native-provider.js';
import { prepareRuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  decodeNativeProviderClientFrame,
  encodeProtocolFrame,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostFrame,
  type NativeProviderBrowserSubcallFrame,
  type NativeProviderClientFrame,
  type NativeProviderComputerUseSubcall,
  type NativeProviderSubcallFrame,
  type RequestFrame,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('derives advertised capabilities and rejects empty or duplicate implementations', () => {
  const implementation = computerUseImplementation({
    releaseTurnState: () => {},
    handle: async () => ({ ok: false, code: 'operation_failed' }),
  });

  const provider = createNativeCapabilityProvider([implementation]);
  assert.deepEqual(provider.capabilities, ['computer_use']);
  assert.throws(
    () => createNativeCapabilityProvider([] as never),
    /must offer at least one capability/,
  );
  assert.throws(
    () => createNativeCapabilityProvider([implementation, implementation]),
    /capabilities must be unique/,
  );
});

test('host-operation invocations drain without creating fake Turn cleanup', async () => {
  const provider = createNativeCapabilityProvider([
    {
      capability: 'oauth_presentation',
      handle: async (frame) => ({
        ok: true,
        complete: () =>
          frame.subcall.kind === 'open_external'
            ? { kind: 'open_external', opened: true }
            : { kind: 'request_authorization_code', payload: 'code#state' },
      }),
    },
  ]);
  const frames: NativeProviderClientFrame[] = [];
  const attachment = await provider.attach({
    hostEpoch: 'epoch-oauth',
    send: async (frame) => {
      frames.push(frame);
    },
    fail: (error) => assert.fail(error.message),
  });
  attachment.bindRegistration('registration-oauth');
  const owner = { ownerId: 'oauth-login', attemptId: 'attempt-1' } as const;
  const first = {
    kind: 'native.provider.subcall' as const,
    hostEpoch: 'epoch-oauth',
    operationId: 'operation-oauth',
    subcallId: 'subcall-oauth-1',
    ordinal: 1,
    bindingId: 'binding-oauth',
    capability: 'oauth_presentation' as const,
    subcall: {
      kind: 'open_external' as const,
      input: { url: 'https://example.test/authorize' },
      context: owner,
    },
  };
  attachment.acceptSubcall(first);
  assert.equal((await waitForResult(frames, first.subcallId)).ok, true);
  attachment.acceptRelease(releaseFrame('epoch-oauth', 'operation-oauth', 'binding-oauth'));

  assert.throws(
    () =>
      attachment.acceptTurnRelease(
        turnReleaseFrame(
          'epoch-oauth',
          'registration-oauth',
          'release-oauth',
          'fake-session',
          'fake-turn',
        ),
      ),
    /unseen Turn state/,
  );
  attachment.sealAdmission();
  await attachment.drained;
  assert.equal(
    frames.some((frame) => frame.kind === 'native.provider.turn_released'),
    false,
  );
});

test('fans in cleanup for exactly the capabilities used by each Turn', async () => {
  const fanInComputerCleanup = deferred<void>();
  const fanInBrowserCleanup = deferred<void>();
  const failureBrowserCleanupEntered = deferred<void>();
  const failureBrowserCleanup = deferred<void>();
  const transportFailure = deferred<Error>();
  const cleanupCalls: Array<{ capability: 'computer_use' | 'browser'; turnId: string }> = [];
  const computerUse = computerUseImplementation({
    handle: async () => ({
      ok: true,
      complete: () => ({
        kind: 'preflight',
        accessibility: true,
        screenRecording: true,
      }),
    }),
    releaseTurnState: ({ turnId }) => {
      cleanupCalls.push({ capability: 'computer_use', turnId });
      if (turnId === 'turn-fan-in') return fanInComputerCleanup.promise;
      if (turnId === 'turn-failure') throw new Error('computer cleanup failed');
    },
  });
  const browser: NativeCapabilityImplementation<'browser'> = {
    capability: 'browser',
    handle: async () => ({
      ok: true,
      complete: () => ({
        kind: 'snapshot',
        url: 'https://example.test/',
        elements: [],
        totalElements: 0,
        takeoverReloaded: false,
      }),
    }),
    releaseTurnState: ({ turnId }) => {
      cleanupCalls.push({ capability: 'browser', turnId });
      if (turnId === 'turn-fan-in') return fanInBrowserCleanup.promise;
      if (turnId === 'turn-failure') {
        failureBrowserCleanupEntered.resolve();
        return failureBrowserCleanup.promise;
      }
    },
  };
  const provider = createNativeCapabilityProvider([computerUse, browser]);
  assert.deepEqual(provider.capabilities, ['computer_use', 'browser']);

  const frames: NativeProviderClientFrame[] = [];
  let transportFailed = false;
  const attachment = await provider.attach({
    hostEpoch: 'epoch-composed',
    send: async (frame) => {
      frames.push(decodeNativeProviderClientFrame(JSON.parse(JSON.stringify(frame))));
    },
    fail: (error) => {
      transportFailed = true;
      transportFailure.resolve(error);
    },
  });
  attachment.bindRegistration('registration-composed');
  const completeInvocation = async (frame: NativeProviderSubcallFrame) => {
    attachment.acceptSubcall(frame);
    assert.equal((await waitForResult(frames, frame.subcallId)).ok, true);
    attachment.acceptRelease(releaseFrame(frame.hostEpoch, frame.operationId, frame.bindingId));
  };
  const computerFrame = (operationId: string, turnId: string) =>
    subcallFrame('epoch-composed', operationId, 1, {
      kind: 'preflight',
      context: { ...context(), turnId, toolCallId: `tool-call-${operationId}` },
    });
  const browserFrame = (
    operationId: string,
    turnId: string,
  ): NativeProviderBrowserSubcallFrame => ({
    kind: 'native.provider.subcall',
    hostEpoch: 'epoch-composed',
    operationId,
    subcallId: `subcall-${operationId}-1`,
    ordinal: 1,
    bindingId: `binding-${operationId}`,
    capability: 'browser',
    subcall: {
      kind: 'snapshot',
      context: { ...context(), turnId, toolCallId: `tool-call-${operationId}` },
    },
  });
  const ackCount = (releaseId: string) =>
    frames.filter(
      (frame) => frame.kind === 'native.provider.turn_released' && frame.releaseId === releaseId,
    ).length;

  await completeInvocation(computerFrame('operation-computer-only', 'turn-computer-only'));
  attachment.acceptTurnRelease(
    turnReleaseFrame(
      'epoch-composed',
      'registration-composed',
      'release-computer-only',
      'session-1',
      'turn-computer-only',
    ),
  );
  await waitForTurnReleased(frames, 'release-computer-only');
  assert.deepEqual(
    cleanupCalls.filter(({ turnId }) => turnId === 'turn-computer-only'),
    [{ capability: 'computer_use', turnId: 'turn-computer-only' }],
  );

  await Promise.all([
    completeInvocation(computerFrame('operation-fan-in-computer', 'turn-fan-in')),
    completeInvocation(browserFrame('operation-fan-in-browser', 'turn-fan-in')),
  ]);
  const fanInRelease = turnReleaseFrame(
    'epoch-composed',
    'registration-composed',
    'release-fan-in',
    'session-1',
    'turn-fan-in',
  );
  attachment.acceptTurnRelease(fanInRelease);
  attachment.acceptTurnRelease(fanInRelease);
  await immediate();
  assert.deepEqual(
    cleanupCalls
      .filter(({ turnId }) => turnId === 'turn-fan-in')
      .map(({ capability }) => capability)
      .sort(),
    ['browser', 'computer_use'],
  );
  assert.equal(ackCount('release-fan-in'), 0);
  fanInComputerCleanup.resolve();
  await immediate();
  assert.equal(ackCount('release-fan-in'), 0);
  fanInBrowserCleanup.resolve();
  await waitForTurnReleased(frames, 'release-fan-in');
  assert.equal(ackCount('release-fan-in'), 1);

  await Promise.all([
    completeInvocation(computerFrame('operation-failure-computer', 'turn-failure')),
    completeInvocation(browserFrame('operation-failure-browser', 'turn-failure')),
  ]);
  attachment.acceptTurnRelease(
    turnReleaseFrame(
      'epoch-composed',
      'registration-composed',
      'release-failure',
      'session-1',
      'turn-failure',
    ),
  );
  await failureBrowserCleanupEntered.promise;
  await immediate();
  assert.equal(transportFailed, false);
  assert.equal(ackCount('release-failure'), 0);
  failureBrowserCleanup.resolve();
  assert.match((await transportFailure.promise).message, /computer cleanup failed/);
  await attachment.drained;
  assert.equal(ackCount('release-failure'), 0);
  await assert.rejects(
    provider.attach({
      hostEpoch: 'epoch-after-failure',
      send: async () => undefined,
      fail: (error) => assert.fail(error.message),
    }),
    /failed during Turn cleanup/,
  );
});

test('pumps ordinary responses while a subcall blocks and waits for real settlement after cancel', async () => {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const settle = deferred<void>();
  const resultObserved = deferred<void>();
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const register = await acceptConnectionAndReadRegister(transport, hostEpoch);
      const subcall = subcallFrame(hostEpoch, 'operation-blocked', 1, {
        kind: 'preflight',
        context: context(),
      });
      await transport.writeEncoded(
        Buffer.concat([
          encodeProtocolFrame(registerSuccess(register, 'registration-blocked')),
          encodeProtocolFrame(subcall),
        ]),
      );
      await entered.promise;

      await answerStatus(transport, hostEpoch);
      await transport.write({
        kind: 'native.provider.cancel',
        hostEpoch,
        operationId: subcall.operationId,
        subcallId: subcall.subcallId,
        ordinal: subcall.ordinal,
        bindingId: subcall.bindingId,
      });
      await aborted.promise;

      // A second ordinary response must overtake the still-unsettled backend handler.
      await answerStatus(transport, hostEpoch);
      settle.resolve();
      const result = await readNativeFrame(transport, 'native.provider.result');
      assert.equal(result.operationId, subcall.operationId);
      assert.equal(result.ok, false);
      await transport.write(releaseFrame(hostEpoch, subcall.operationId, subcall.bindingId));
      resultObserved.resolve();

      const unregister = await readRequest(transport, 'native.provider.unregister');
      await transport.write(unregisterSuccess(unregister, 'registration-blocked'));
    },
    async (connection) => {
      const provider = testProvider({
        releaseTurnState: () => {},
        handle: async (_frame, { signal }) => {
          entered.resolve();
          await waitForAbort(signal);
          aborted.resolve();
          await settle.promise;
          return { ok: false, code: 'operation_failed' };
        },
      });
      const registration = await connection.registerNativeProvider(provider);
      assert.equal((await connection.status(5_000)).hostEpoch, connection.hostEpoch);
      assert.equal((await connection.status(5_000)).hostEpoch, connection.hostEpoch);
      await resultObserved.promise;
      await registration.unregister();
    },
  );
});

test('enforces invocation identity and ordinary release does not clear its Turn state', async () => {
  const frames: NativeProviderClientFrame[] = [];
  const releases: Array<{ sessionId: string; turnId: string }> = [];
  const provider = testProvider({
    releaseTurnState: (identity) => {
      releases.push(identity);
    },
    handle: async () => ({
      ok: true,
      complete: () => ({
        kind: 'preflight',
        accessibility: true,
        screenRecording: true,
      }),
    }),
  });
  const attachment = await directAttachment(provider, 'epoch-sequence', frames);
  const first = subcallFrame('epoch-sequence', 'operation-sequence', 1, {
    kind: 'preflight',
    context: context(),
  });
  attachment.acceptSubcall(first);
  await waitForResult(frames, first.subcallId);

  const second = subcallFrame('epoch-sequence', first.operationId, 2, {
    kind: 'preflight',
    context: context(),
  });
  attachment.acceptSubcall(second);
  await waitForResult(frames, second.subcallId);
  assert.throws(
    () =>
      attachment.acceptSubcall({
        ...subcallFrame('epoch-sequence', first.operationId, 3, {
          kind: 'preflight',
          context: context(),
        }),
        bindingId: 'changed-binding',
      }),
    /changed.*identity/,
  );
  assert.throws(
    () =>
      attachment.acceptSubcall(
        subcallFrame('epoch-sequence', first.operationId, 4, {
          kind: 'preflight',
          context: context(),
        }),
      ),
    /non-contiguous/,
  );

  attachment.acceptRelease(releaseFrame('epoch-sequence', first.operationId, first.bindingId));
  assert.deepEqual(releases, []);

  const otherTurn = subcallFrame('epoch-sequence', 'operation-other-turn', 1, {
    kind: 'preflight',
    context: { ...context(), turnId: 'turn-2', toolCallId: 'tool-call-2' },
  });
  attachment.acceptSubcall(otherTurn);
  await waitForResult(frames, otherTurn.subcallId);
  attachment.acceptRelease(
    releaseFrame(otherTurn.hostEpoch, otherTurn.operationId, otherTurn.bindingId),
  );

  // release leaves no tombstone: the durable operation identity may be admitted anew.
  const reused = {
    ...subcallFrame('epoch-sequence', first.operationId, 1, {
      kind: 'preflight',
      context: context(),
    }),
    subcallId: 'subcall-reused-operation-sequence',
  };
  attachment.acceptSubcall(reused);
  await waitForResult(frames, reused.subcallId);
  attachment.acceptRelease(releaseFrame('epoch-sequence', reused.operationId, reused.bindingId));
  attachment.acceptTurnRelease(
    turnReleaseFrame('epoch-sequence', 'registration-epoch-sequence', 'release-session-1'),
  );
  await waitForTurnReleased(frames, 'release-session-1');
  assert.deepEqual(releases, [{ sessionId: 'session-1', turnId: 'turn-1' }]);
  attachment.sealAdmission();
  await attachment.drained;
  assert.deepEqual(releases, [
    { sessionId: 'session-1', turnId: 'turn-1' },
    { sessionId: 'session-1', turnId: 'turn-2' },
  ]);
});

test('ack loss permits reattach after remaining cleanup, while callback failure blocks it', async () => {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const settle = deferred<void>();
  const cleanup = deferred<void>();
  const transportFailed = deferred<void>();
  const cleanupFailed = deferred<void>();
  const frames: NativeProviderClientFrame[] = [];
  const releasedSessions: string[] = [];
  const provider = testProvider({
    releaseTurnState: async ({ sessionId }) => {
      releasedSessions.push(sessionId);
      if (sessionId === 'session-3') throw new Error('permanent cleanup failure');
      await cleanup.promise;
    },
    handle: async (frame, { signal }) => {
      if (frame.subcall.context.sessionId !== 'session-1') {
        return { ok: false, code: 'operation_failed' };
      }
      entered.resolve();
      await waitForAbort(signal);
      aborted.resolve();
      await settle.promise;
      return { ok: false, code: 'operation_failed' };
    },
  });
  const oldAttachment = await provider.attach({
    hostEpoch: 'epoch-old',
    send: async (frame) => {
      frames.push(frame);
      if (frame.kind === 'native.provider.turn_released') throw new Error('ack lost');
    },
    fail: () => transportFailed.resolve(),
  });
  oldAttachment.bindRegistration('registration-old');
  const subcall = subcallFrame('epoch-old', 'operation-old', 1, {
    kind: 'preflight',
    context: context(),
  });
  oldAttachment.acceptSubcall(subcall);
  await entered.promise;
  const secondSession = subcallFrame('epoch-old', 'operation-old-s2', 1, {
    kind: 'preflight',
    context: { ...context(), sessionId: 'session-2' },
  });
  oldAttachment.acceptSubcall(secondSession);
  await waitForResult(frames, secondSession.subcallId);
  oldAttachment.acceptRelease(
    releaseFrame(secondSession.hostEpoch, secondSession.operationId, secondSession.bindingId),
  );

  let attachedNew = false;
  const newFrames: NativeProviderClientFrame[] = [];
  const newAttachmentTask = provider
    .attach({
      hostEpoch: 'epoch-new',
      send: async (frame) => {
        newFrames.push(frame);
      },
      fail: () => cleanupFailed.resolve(),
    })
    .then((attachment) => {
      attachedNew = true;
      return attachment;
    });
  await immediate();
  assert.equal(attachedNew, false);
  oldAttachment.acceptCancel({
    kind: 'native.provider.cancel',
    hostEpoch: subcall.hostEpoch,
    operationId: subcall.operationId,
    subcallId: subcall.subcallId,
    ordinal: subcall.ordinal,
    bindingId: subcall.bindingId,
  });
  await aborted.promise;
  settle.resolve();
  await waitForResult(frames, subcall.subcallId);
  oldAttachment.acceptRelease(
    releaseFrame(subcall.hostEpoch, subcall.operationId, subcall.bindingId),
  );
  oldAttachment.acceptTurnRelease(turnReleaseFrame('epoch-old', 'registration-old', 'release-old'));
  await immediate();
  assert.deepEqual(releasedSessions, ['session-1']);
  assert.equal(attachedNew, false);
  cleanup.resolve();
  await transportFailed.promise;
  await oldAttachment.drained;
  const newAttachment = await newAttachmentTask;
  assert.equal(attachedNew, true);
  assert.deepEqual(releasedSessions, ['session-1', 'session-2']);

  newAttachment.bindRegistration('registration-new');
  const thirdSession = subcallFrame('epoch-new', 'operation-cleanup-failure', 1, {
    kind: 'preflight',
    context: { ...context(), sessionId: 'session-3' },
  });
  newAttachment.acceptSubcall(thirdSession);
  await waitForResult(newFrames, thirdSession.subcallId);
  newAttachment.acceptRelease(
    releaseFrame(thirdSession.hostEpoch, thirdSession.operationId, thirdSession.bindingId),
  );
  newAttachment.detach();
  await cleanupFailed.promise;
  await newAttachment.drained;
  assert.deepEqual(releasedSessions, ['session-1', 'session-2', 'session-3']);
  await assert.rejects(
    provider.attach({
      hostEpoch: 'epoch-after-cleanup-failure',
      send: async () => undefined,
      fail: (error) => assert.fail(error.message),
    }),
    /failed during Turn cleanup/,
  );
});

test('unregister is an ordinary request and rejected registration rolls back for retry', async () => {
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const rejected = await acceptConnectionAndReadRegister(transport, hostEpoch);
      await transport.write({
        requestId: rejected.requestId,
        operation: 'native.provider.register',
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'Provider registration rejected',
        },
      });
      const accepted = await readRequest(transport, 'native.provider.register');
      await transport.write(registerSuccess(accepted, 'registration-after-rollback'));
      const unregister = await readRequest(transport, 'native.provider.unregister');
      assert.deepEqual(unregister.input, {
        registrationId: 'registration-after-rollback',
      });
      await transport.write(unregisterSuccess(unregister, 'registration-after-rollback'));
    },
    async (connection) => {
      const provider = testProvider({
        releaseTurnState: () => {},
        handle: async () => ({ ok: false, code: 'operation_failed' }),
      });
      await assert.rejects(
        () => connection.registerNativeProvider(provider),
        /Provider registration rejected/,
      );
      const registration = await connection.registerNativeProvider(provider);
      await registration.unregister();
      await registration.drained;
    },
  );
});

test('reserves a connection synchronously against concurrent Native Provider registration', async () => {
  const registerReceived = deferred<void>();
  const acceptRegistration = deferred<void>();
  await withProtocolPeer(
    async (transport, hostEpoch) => {
      const register = await acceptConnectionAndReadRegister(transport, hostEpoch);
      registerReceived.resolve();
      await acceptRegistration.promise;
      await transport.write(registerSuccess(register, 'registration-reserved'));
      const unregister = await readRequest(transport, 'native.provider.unregister');
      await transport.write(unregisterSuccess(unregister, 'registration-reserved'));
    },
    async (connection) => {
      const firstProvider = testProvider({
        releaseTurnState: () => {},
        handle: async () => ({ ok: false, code: 'operation_failed' }),
      });
      const secondProvider = testProvider({
        releaseTurnState: () => {},
        handle: async () => ({ ok: false, code: 'operation_failed' }),
      });

      const firstRegistration = connection.registerNativeProvider(firstProvider);
      await assert.rejects(
        connection.registerNativeProvider(secondProvider),
        /already has a Native Provider registration/,
      );
      await registerReceived.promise;
      acceptRegistration.resolve();
      const registration = await firstRegistration;
      await registration.unregister();
    },
  );
});

async function directAttachment(
  provider: NativeCapabilityProvider,
  hostEpoch: string,
  frames: NativeProviderClientFrame[],
): Promise<ClientNativeProviderAttachment> {
  const attachment = await provider.attach({
    hostEpoch,
    send: async (frame) => {
      frames.push(decodeNativeProviderClientFrame(JSON.parse(JSON.stringify(frame))));
    },
    fail: (error) => assert.fail(error.message),
  });
  attachment.bindRegistration(`registration-${hostEpoch}`);
  return attachment;
}

function testProvider(
  implementation: Omit<NativeCapabilityImplementation<'computer_use'>, 'capability'>,
): NativeCapabilityProvider {
  return createNativeCapabilityProvider([computerUseImplementation(implementation)]);
}

function computerUseImplementation(
  implementation: Omit<NativeCapabilityImplementation<'computer_use'>, 'capability'>,
): NativeCapabilityImplementation<'computer_use'> {
  return { capability: 'computer_use', ...implementation };
}

function subcallFrame(
  hostEpoch: string,
  operationId: string,
  ordinal: number,
  subcall: NativeProviderComputerUseSubcall,
): Extract<NativeProviderSubcallFrame, { capability: 'computer_use' }> {
  return {
    kind: 'native.provider.subcall',
    hostEpoch,
    operationId,
    subcallId: `subcall-${operationId}-${ordinal}`,
    ordinal,
    bindingId: `binding-${operationId}`,
    capability: 'computer_use',
    subcall,
  };
}

function context() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
  };
}

function releaseFrame(hostEpoch: string, operationId: string, bindingId: string) {
  return {
    kind: 'native.provider.release' as const,
    hostEpoch,
    operationId,
    bindingId,
  };
}

function turnReleaseFrame(
  hostEpoch: string,
  registrationId: string,
  releaseId: string,
  sessionId = 'session-1',
  turnId = 'turn-1',
) {
  return {
    kind: 'native.provider.turn_release' as const,
    hostEpoch,
    registrationId,
    releaseId,
    sessionId,
    turnId,
  };
}

async function waitForTurnReleased(frames: NativeProviderClientFrame[], releaseId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ack = frames.find(
      (frame) => frame.kind === 'native.provider.turn_released' && frame.releaseId === releaseId,
    );
    if (ack) return ack;
    await immediate();
  }
  throw new Error(`Timed out waiting for Turn release ${releaseId}`);
}

async function waitForResult(frames: NativeProviderClientFrame[], subcallId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = frames.find(
      (frame) => frame.kind === 'native.provider.result' && frame.subcallId === subcallId,
    );
    if (result?.kind === 'native.provider.result') return result;
    await immediate();
  }
  throw new Error(`Timed out waiting for ${subcallId}`);
}

async function withProtocolPeer(
  serve: (transport: FramedTransport, hostEpoch: string) => Promise<void>,
  run: (connection: RuntimeHostConnection) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-native-provider-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
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
      rootPath: join(base, 'root'),
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

async function acceptConnectionAndReadRegister(transport: FramedTransport, hostEpoch: string) {
  const hello = decodeClientFrame(await transport.read(1_000));
  assert.ok('kind' in hello && hello.kind === 'hello');
  await transport.write({
    kind: 'accepted',
    hostEpoch,
    connectionId: 'connection-native-provider',
    selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
    state: 'ready',
  });
  return readRequest(transport, 'native.provider.register');
}

async function answerStatus(transport: FramedTransport, hostEpoch: string): Promise<void> {
  const status = await readRequest(transport, 'host.status');
  await transport.write({
    requestId: status.requestId,
    operation: 'host.status',
    ok: true,
    result: {
      hostEpoch,
      state: 'ready',
      connections: 1,
      activeOperations: 1,
      activeResidencies: 1,
    },
  });
}

async function readRequest<K extends RequestFrame['operation']>(
  transport: FramedTransport,
  operation: K,
) {
  const frame = decodeClientFrame(await transport.read(1_000));
  assert.ok(!('kind' in frame));
  assert.equal(frame.operation, operation);
  return frame as Extract<RequestFrame, { operation: K }>;
}

async function readNativeFrame<K extends NativeProviderClientFrame['kind']>(
  transport: FramedTransport,
  kind: K,
) {
  const frame = decodeClientFrame(await transport.read(1_000));
  assert.ok('kind' in frame && frame.kind === kind);
  return frame as Extract<NativeProviderClientFrame, { kind: K }>;
}

function registerSuccess(
  request: Extract<RequestFrame, { operation: 'native.provider.register' }>,
  registrationId: string,
): HostFrame {
  return {
    requestId: request.requestId,
    operation: 'native.provider.register',
    ok: true,
    result: { registrationId },
  };
}

function unregisterSuccess(
  request: Extract<RequestFrame, { operation: 'native.provider.unregister' }>,
  registrationId: string,
): HostFrame {
  return {
    requestId: request.requestId,
    operation: 'native.provider.unregister',
    ok: true,
    result: { registrationId },
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
