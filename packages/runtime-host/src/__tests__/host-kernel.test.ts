import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
  rm,
  unlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  connectOrSpawnRuntimeHost,
  connectRuntimeHost,
  RuntimeHostOperationError,
} from '../client/index.js';
import { connectOrSpawnRuntimeHostWithDependencies } from '../client/connect-or-spawn.js';
import {
  launchDetachedRuntimeHostCandidate,
  type DetachedCandidateAttempt,
  type DetachedCandidateLaunch,
  type DetachedCandidateInput,
} from '../client/launcher.js';
import { readHostRegistration, RUNTIME_HOST_REGISTRATION_FILE } from '../control/registration.js';
import {
  decodeHostFrame,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RuntimeHostProtocolError,
  type ClientSurface,
} from '../protocol/index.js';
import {
  RuntimeHostKernel,
  startRuntimeHostCandidate,
  type RuntimeHostCandidateOptions,
  type RuntimeHostCandidateResult,
} from '../server/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import {
  createUnavailableDomainOperationHandlers,
  type OperationHandlerMap,
} from '../server/operation-dispatcher.js';
import { FramedTransport, RuntimeHostTransportError } from '../transport/framed-transport.js';
import { FAKE_ASK_USER_QUESTION_PROMPT, RuntimeInteractionFailStopError } from '@maka/runtime';
import {
  prepareStorageRootControlDirectory,
  resolveRootControlNamespace,
  resolveStorageRoot,
  runWithStorageRootLease,
  STORAGE_ROOT_MARKER_FILE,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const LEGACY_PROTOCOL = { min: 1, max: 1 } as const;
const require = createRequire(import.meta.url);

describe('non-serving Runtime Host kernel', () => {
  test('elects one owner, serves status, and releases ownership after true-idle shutdown', async () => {
    await withHostPaths(async (paths) => {
      const winner = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 250,
      });
      assert.equal(winner.kind, 'winner');
      if (winner.kind !== 'winner') return;

      // Connect before the loser assertion: a resident connection cancels the
      // winner's idle timer, so the loser candidate's storage work cannot drain
      // the Host before this bounded connection attempt establishes residency.
      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;

      assert.deepEqual(
        await startTestRuntimeHostCandidate(paths, {
          rootPath: paths.root,
        }),
        { kind: 'loser' },
      );
      const statuses = await Promise.all([
        connected.connection.status(),
        connected.connection.status(),
      ]);
      for (const status of statuses) {
        assert.equal(status.hostEpoch, winner.host.hostEpoch);
        assert.equal(status.state, 'ready');
        assert.equal(status.connections, 1);
      }
      await connected.connection.close();
      await winner.host.closed;

      const next = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 0,
      });
      assert.equal(next.kind, 'winner');
      if (next.kind === 'winner') await next.host.closed;
    });
  });

  test('blocks incompatible replacement while resident and permits it only after true idle', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 500,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;
      const resident = await retryConnect(paths, CURRENT_PROTOCOL, 'desktop');
      assert.equal(resident.kind, 'connected');
      if (resident.kind !== 'connected') return;

      const blocked = await connectOrSpawnRuntimeHost({
        ...paths,
        rootPath: paths.root,
        surface: 'tui',
        protocol: LEGACY_PROTOCOL,
        electionDeadlineMs: 2_000,
      });
      assert.equal(blocked.kind, 'incompatible');
      if (blocked.kind === 'incompatible')
        assert.equal(blocked.handshake.replacement, 'blocked_by_residency');
      await resident.connection.close();

      const replaceable = await Promise.all([
        connectRuntimeHost({
          ...paths,
          rootPath: paths.root,
          surface: 'tui',
          protocol: LEGACY_PROTOCOL,
        }),
        connectRuntimeHost({
          ...paths,
          rootPath: paths.root,
          surface: 'run',
          protocol: LEGACY_PROTOCOL,
        }),
      ]);
      for (const result of replaceable) {
        assert.equal(result.kind, 'incompatible');
        if (result.kind === 'incompatible') {
          assert.equal(result.handshake.replacement, 'wait_for_idle_exit');
        }
      }
      await candidate.host.closed;
      const replacement = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(replacement.kind, 'winner');
      if (replacement.kind !== 'winner') return;
      assert.notEqual(replacement.host.hostEpoch, candidate.host.hostEpoch);
      const attached = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(attached.kind, 'connected');
      if (attached.kind !== 'connected') return;
      await attached.connection.close();
      await replacement.host.close();
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await retryOwner(capability, paths);
      assert.ok(owner);
      await owner?.close();
    });
  });

  test('two independent Clients with different cache environments attach to one cold-start Host', async () => {
    await withHostPaths(async (paths) => {
      const first = spawnConnectClient(paths, 'desktop', 'a');
      const second = spawnConnectClient(paths, 'tui', 'b');
      const [firstConnected, secondConnected] = await Promise.all([
        waitForConnectedClient(first),
        waitForConnectedClient(second),
      ]);
      for (const pid of [...firstConnected.candidatePids, ...secondConnected.candidatePids]) {
        paths.resources.trackPid(pid);
      }
      assert.equal(firstConnected.hostEpoch, secondConnected.hostEpoch);
      first.send('close');
      second.send('close');
      await Promise.all([
        waitForSuccessfulExit(first, 'first connect Client'),
        waitForSuccessfulExit(second, 'second connect Client'),
      ]);

      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await retryOwner(capability, paths);
      assert.ok(owner);
      await owner?.close();
    });
  });

  test('Node and Electron Candidates arbitrate in both directions and force-kill releases ownership', async () => {
    const electronPath = require('electron') as string;
    const runtimes = [
      [{}, { executable: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }],
      [{ executable: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, {}],
    ] as const;

    for (const [holderRuntime, contenderRuntime] of runtimes) {
      await withHostPaths(async (paths) => {
        let holderPid: number | undefined;
        let contenderPid: number | undefined;
        let successorPid: number | undefined;
        try {
          const holder = await spawnTestRuntimeHostCandidate(paths, {
            ...paths,
            ...holderRuntime,
            rootPath: paths.root,
            idleGraceMs: 10_000,
          });
          holderPid = holder.pid;
          const connected = await retryConnect(paths, CURRENT_PROTOCOL);
          assert.equal(connected.kind, 'connected');
          if (connected.kind !== 'connected') return;
          assert.equal(connected.registration.pid, holderPid);
          const previousEndpoint = connected.registration.endpoint;

          const contender = await spawnTestRuntimeHostCandidate(paths, {
            ...paths,
            ...contenderRuntime,
            rootPath: paths.root,
            idleGraceMs: 10_000,
          });
          contenderPid = contender.pid;
          await waitForProcessExit(contenderPid);
          paths.resources.forgetPid(contenderPid);
          contenderPid = undefined;
          const stillConnected = await connectRuntimeHost({
            ...paths,
            rootPath: paths.root,
            surface: 'run',
            protocol: CURRENT_PROTOCOL,
          });
          assert.equal(stillConnected.kind, 'connected');
          if (stillConnected.kind !== 'connected') return;
          assert.equal(stillConnected.connection.hostEpoch, connected.connection.hostEpoch);
          await stillConnected.connection.close();

          const previousEpoch = connected.connection.hostEpoch;
          process.kill(holderPid, 'SIGKILL');
          await connected.connection.closed;
          await waitForProcessExit(holderPid);
          paths.resources.forgetPid(holderPid);
          holderPid = undefined;

          const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
          const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
          const staleRegistration = await readHostRegistration(controlDirectory);
          assert.equal(staleRegistration?.hostEpoch, previousEpoch);

          let staleLaunchAttempts = 0;
          const staleDiscovery = await connectOrSpawnRuntimeHostWithDependencies(
            {
              rootPath: paths.root,
              surface: 'inspect',
              protocol: CURRENT_PROTOCOL,
              electionDeadlineMs: 100,
            },
            {
              random: () => 0.5,
              launchCandidate: () => {
                staleLaunchAttempts += 1;
                return { spawned: Promise.resolve({ pid: process.pid }) };
              },
            },
          );
          assert.deepEqual(staleDiscovery, { kind: 'failed', reason: 'startup_timeout' });
          assert.ok(staleLaunchAttempts > 0);

          const successor = await connectOrSpawnRuntimeHostWithDependencies(
            {
              rootPath: paths.root,
              surface: 'inspect',
              protocol: CURRENT_PROTOCOL,
              electionDeadlineMs: 5_000,
            },
            {
              random: Math.random,
              launchCandidate: (input) => {
                const launch = launchTestRuntimeHostCandidate(paths, {
                  ...input,
                  ...contenderRuntime,
                  idleGraceMs: 200,
                });
                return {
                  spawned: launch.spawned.then((attempt) => {
                    successorPid = attempt.pid;
                    return attempt;
                  }),
                };
              },
            },
          );
          assert.equal(successor.kind, 'connected');
          if (successor.kind !== 'connected') return;
          assert.notEqual(successor.connection.hostEpoch, previousEpoch);
          if (process.platform !== 'win32') {
            await assertPathMissing(previousEndpoint);
            await assertPathMissing(dirname(previousEndpoint));
          }
          await successor.connection.close();

          const owner = await retryOwner(capability, paths);
          assert.ok(owner);
          await owner?.close();
          if (successorPid !== undefined) {
            await waitForProcessExit(successorPid);
            paths.resources.forgetPid(successorPid);
          }
          successorPid = undefined;
        } finally {
          terminateProcess(successorPid);
          terminateProcess(contenderPid);
          terminateProcess(holderPid);
        }
      });
    }
  });

  test('a detached Host survives the launcher process that created it', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const launcher = paths.resources.trackChild(
        fork(
          new URL('./fixtures/detached-launcher.js', import.meta.url),
          [paths.root, capability.rootId],
          { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
        ),
      );
      const launchedPid = await waitForLaunch(launcher);
      paths.resources.trackPid(launchedPid);
      await waitForExit(launcher);

      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;
      assert.equal(connected.registration.pid, launchedPid);
      process.kill(launchedPid, 'SIGKILL');
      await connected.connection.closed;
      await waitForProcessExit(launchedPid);
      paths.resources.forgetPid(launchedPid);
    });
  });

  test('a Host launched by the public Electron Client survives its parent process', async () => {
    const electronPath = require('electron') as string;
    await withHostPaths(async (paths) => {
      const parent = paths.resources.trackChild(
        fork(new URL('./fixtures/electron-connect-parent.js', import.meta.url), [paths.root], {
          execPath: electronPath,
          execArgv: [],
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        }),
      );
      const launched = await waitForElectronParentLaunch(parent);
      paths.resources.trackPid(launched.pid);
      await waitForSuccessfulExit(parent, 'Electron connect parent');

      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;
      assert.equal(connected.connection.hostEpoch, launched.hostEpoch);
      assert.equal(connected.registration.pid, launched.pid);

      process.kill(launched.pid, 'SIGKILL');
      await connected.connection.closed;
      await waitForProcessExit(launched.pid);
      paths.resources.forgetPid(launched.pid);
    });
  });

  test('a response timeout is connection-fatal and Client close stays local', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const attempt = await spawnTestRuntimeHostCandidate(paths, {
        ...paths,
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      let stopped = false;
      try {
        const connected = await retryConnect(paths, CURRENT_PROTOCOL);
        assert.equal(connected.kind, 'connected');
        if (connected.kind !== 'connected') return;

        process.kill(attempt.pid, 'SIGSTOP');
        stopped = true;
        await sleep(20);
        await assert.rejects(
          () => connected.connection.status(50),
          (error: unknown) =>
            error instanceof RuntimeHostTransportError && error.code === 'read_timeout',
        );
        await withTimeout(
          connected.connection.closed,
          500,
          'timed-out Runtime Host connection did not close',
        );
        await withTimeout(
          connected.connection.close(),
          500,
          'closing an already failed connection did not settle',
        );

        process.kill(attempt.pid, 'SIGCONT');
        stopped = false;
        const reconnected = await retryConnect(paths, CURRENT_PROTOCOL);
        assert.equal(reconnected.kind, 'connected');
        if (reconnected.kind !== 'connected') return;
        assert.equal(
          (await reconnected.connection.status()).hostEpoch,
          connected.connection.hostEpoch,
        );

        process.kill(attempt.pid, 'SIGSTOP');
        stopped = true;
        await sleep(20);
        await withTimeout(
          reconnected.connection.close(),
          500,
          'Client close waited for an unresponsive Host',
        );
      } finally {
        if (stopped) process.kill(attempt.pid, 'SIGCONT');
        terminateProcess(attempt.pid);
      }
    });
  });

  test('bounded election never steals a live owner with no endpoint', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      const result = await connectOrSpawnRuntimeHost({
        rootPath: paths.root,
        surface: 'tui',
        protocol: CURRENT_PROTOCOL,
        electionDeadlineMs: 100,
      });
      assert.deepEqual(result, { kind: 'failed', reason: 'startup_timeout' });
      assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
      await owner?.close();
    });
  });

  test('rejects a structural owner copy before Host startup can use its lifecycle fields', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      assert.equal(Object.isFrozen(owner), true);

      const redirectedControlDirectory = join(paths.base, 'redirected-control');
      let copiedCloseCalled = false;
      const copiedOwner = {
        ...owner,
        controlDirectory: redirectedControlDirectory,
        close: async () => {
          copiedCloseCalled = true;
        },
      };

      await assert.rejects(
        () => RuntimeHostKernel.start({ owner: copiedOwner }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_owner',
      );
      assert.equal(copiedCloseCalled, false);
      await assertPathMissing(redirectedControlDirectory);
      assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);

      await owner.close();
      const nextOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(nextOwner);
      await nextOwner.close();
    });
  });

  test('releases an authentic owner when live validation fails before Host startup', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      const movedRoot = join(paths.base, 'moved-before-host-start');
      await rename(paths.root, movedRoot);
      await mkdir(paths.root);
      await assert.rejects(
        () => RuntimeHostKernel.start({ owner }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
      );
      assert.equal(owner.closed, true);

      const movedCapability = await resolveStorageRoot({ path: movedRoot, kind: 'interactive' });
      assert.equal(movedCapability.rootId, capability.rootId);
      const nextOwner = await tryAcquireInteractiveRootOwner(movedCapability);
      assert.ok(nextOwner);
      await nextOwner.close();
    });
  });

  test('does not open ready admission when ready registration publication fails', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      const recoveryEntered = deferred<void>();
      const releaseRecovery = deferred<void>();
      const handlers = createUnavailableDomainOperationHandlers();
      handlers['turn.start'] = async (input) => ({
        ok: true,
        result: {
          sessionId: input.sessionId,
          turnId: input.turnId,
          runId: 'unexpected-run',
          status: 'running',
        },
      });
      const startup = RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        compositionFactory: async () => ({
          handlers,
          recover: async () => {
            recoveryEntered.resolve();
            await releaseRecovery.promise;
          },
          close: async () => ({ kind: 'clean' }),
        }),
      });
      const startupOutcome = observeStartup(startup);
      let transport: FramedTransport | undefined;
      const registrationPath = join(owner.controlDirectory, RUNTIME_HOST_REGISTRATION_FILE);
      try {
        await recoveryEntered.promise;
        const registration = await readHostRegistration(owner.controlDirectory);
        assert.ok(registration);
        assert.equal(registration.state, 'recovering');
        transport = await openAcceptedTransport(registration.endpoint, 'ready-publication-client');

        await unlink(registrationPath);
        await mkdir(registrationPath);
        const request = JSON.stringify({
          requestId: 'ready-publication-turn',
          operation: 'turn.start',
          input: {
            sessionId: 'session',
            turnId: 'turn',
            content: { text: 'must remain fenced' },
          },
        });
        await writeSocket(transport.socket, request);
        releaseRecovery.resolve();
        await writeSocket(transport.socket, '\n');

        const response = decodeHostFrame(await transport.read(2_000));
        const outcome = await startupOutcome;
        assert.equal(outcome.kind, 'failed');
        assert.ok(!('kind' in response));
        assert.equal(response.requestId, 'ready-publication-turn');
        assert.equal(response.operation, 'turn.start');
        assert.equal(response.ok, false);
        if (!response.ok) assert.equal(response.error.code, 'host_not_ready');
        assert.equal(owner.closed, true);
      } finally {
        releaseRecovery.resolve();
        transport?.destroy();
        await rm(registrationPath, { recursive: true, force: true });
      }

      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      await successor?.close();
    });
  });

  test('a recovering connection waits for the composition factory outcome before settlement', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      const factoryEntered = deferred<void>();
      const releaseFactory = deferred<void>();
      const hookCalled = deferred<void>();
      const settledConnectionIds: string[] = [];
      const startup = RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        compositionFactory: async () => {
          factoryEntered.resolve();
          await releaseFactory.promise;
          return {
            handlers: createUnavailableDomainOperationHandlers(),
            onConnectionSettled: async (connectionId) => {
              settledConnectionIds.push(connectionId);
              hookCalled.resolve();
            },
            recover: async () => undefined,
            close: async () => ({ kind: 'clean' }),
          };
        },
      });
      const startupOutcome = observeStartup(startup);
      let transport: FramedTransport | undefined;
      try {
        await factoryEntered.promise;
        const registration = await readHostRegistration(owner.controlDirectory);
        assert.ok(registration);
        const accepted = await openAcceptedConnection(
          registration.endpoint,
          'factory-gated-settlement-client',
        );
        transport = accepted.transport;
        transport.destroy();
        await transport.closed;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(settledConnectionIds, []);

        releaseFactory.resolve();
        const outcome = await startupOutcome;
        assert.equal(outcome.kind, 'started');
        if (outcome.kind !== 'started') return;
        paths.resources.trackCloseable(outcome.host);
        await hookCalled.promise;
        assert.deepEqual(settledConnectionIds, [accepted.connectionId]);
        await outcome.host.close();
        assert.deepEqual(settledConnectionIds, [accepted.connectionId]);
      } finally {
        releaseFactory.resolve();
        transport?.destroy();
        const outcome = await startupOutcome;
        if (outcome.kind === 'started') await outcome.host.close().catch(() => undefined);
      }
    });
  });

  test('startup recovery failure waits for a blocked connection hook before composition close', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      const recoveryEntered = deferred<void>();
      const failRecovery = deferred<void>();
      const hookEntered = deferred<void>();
      const releaseHook = deferred<void>();
      const compositionDraining = deferred<void>();
      const startupFailure = new Error('controlled startup recovery failure');
      const lifecycleEvents: string[] = [];
      let expectedConnectionId: string | undefined;
      const startup = RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        compositionFactory: async () => ({
          handlers: createUnavailableDomainOperationHandlers(),
          onConnectionSettled: async (connectionId) => {
            assert.equal(connectionId, expectedConnectionId);
            lifecycleEvents.push('hook-start');
            hookEntered.resolve();
            await releaseHook.promise;
            lifecycleEvents.push('hook-settled');
          },
          beginDrain: () => {
            lifecycleEvents.push('composition-draining');
            compositionDraining.resolve();
          },
          recover: async () => {
            recoveryEntered.resolve();
            await failRecovery.promise;
            throw startupFailure;
          },
          close: async () => {
            lifecycleEvents.push('composition-close');
            return { kind: 'clean' };
          },
        }),
      });
      const startupOutcome = observeStartup(startup);
      let transport: FramedTransport | undefined;
      try {
        await recoveryEntered.promise;
        const registration = await readHostRegistration(owner.controlDirectory);
        assert.ok(registration);
        const accepted = await openAcceptedConnection(
          registration.endpoint,
          'recovery-failure-settlement-client',
        );
        expectedConnectionId = accepted.connectionId;
        transport = accepted.transport;
        transport.destroy();
        await Promise.all([transport.closed, hookEntered.promise]);

        failRecovery.resolve();
        await compositionDraining.promise;
        const startupSettledBeforeHook = await Promise.race([
          startupOutcome.then(() => true),
          new Promise<false>((resolve) => setImmediate(() => resolve(false))),
        ]);
        assert.equal(startupSettledBeforeHook, false);
        assert.equal(owner.closed, false);
        assert.deepEqual(lifecycleEvents, ['hook-start', 'composition-draining']);

        releaseHook.resolve();
        const outcome = await startupOutcome;
        assert.deepEqual(outcome, { kind: 'failed', error: startupFailure });
        assert.deepEqual(lifecycleEvents, [
          'hook-start',
          'composition-draining',
          'hook-settled',
          'composition-close',
        ]);
        assert.equal(owner.closed, true);
      } finally {
        failRecovery.resolve();
        releaseHook.resolve();
        transport?.destroy();
        await startupOutcome;
      }
    });
  });

  test('startup abort drains an issued operation before composition close and owner release', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      const operationEntered = deferred<void>();
      const releaseOperation = deferred<void>();
      const operationFinished = deferred<void>();
      const recoveryEntered = deferred<void>();
      const failRecovery = deferred<void>();
      const startupFailure = new Error('controlled startup recovery failure');
      const lifecycleEvents: string[] = [];
      const handlers = createUnavailableDomainOperationHandlers();
      // Hold one real pre-ready kernel token across the controlled recovery failure.
      Object.assign(handlers, {
        'host.status': (async (_input, context) => {
          lifecycleEvents.push('operation_entered');
          operationEntered.resolve();
          await releaseOperation.promise;
          lifecycleEvents.push('operation_finished');
          operationFinished.resolve();
          return {
            ok: true,
            result: {
              hostEpoch: context.hostEpoch,
              state: 'recovering',
              connections: 1,
              activeOperations: 1,
              activeResidencies: 0,
            },
          };
        }) satisfies OperationHandlerMap['host.status'],
      });
      const startup = RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        compositionFactory: async () => ({
          handlers,
          beginDrain: () => {
            lifecycleEvents.push('composition_draining');
          },
          recover: async () => {
            recoveryEntered.resolve();
            await failRecovery.promise;
            throw startupFailure;
          },
          close: async () => {
            lifecycleEvents.push('composition_closed');
            assert.equal(owner.closed, false);
            return { kind: 'clean' };
          },
        }),
      });
      const startupOutcome = observeStartup(startup);
      let transport: FramedTransport | undefined;
      try {
        await recoveryEntered.promise;
        const registration = await readHostRegistration(owner.controlDirectory);
        assert.ok(registration);
        assert.equal(registration.state, 'recovering');
        transport = await openAcceptedTransport(registration.endpoint, 'startup-abort-client');
        await transport.write({
          requestId: 'held-startup-status',
          operation: 'host.status',
          input: {},
        });
        await operationEntered.promise;

        failRecovery.resolve();
        await withTimeout(
          transport.closed,
          2_000,
          'startup abort did not unwind the accepted transport',
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseOperation.resolve();
        await operationFinished.promise;

        const outcome = await startupOutcome;
        assert.deepEqual(outcome, { kind: 'failed', error: startupFailure });
        assert.deepEqual(lifecycleEvents, [
          'operation_entered',
          'composition_draining',
          'operation_finished',
          'composition_closed',
        ]);
        assert.equal(owner.closed, true);
      } finally {
        failRecovery.resolve();
        releaseOperation.resolve();
        transport?.destroy();
      }

      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      await successor?.close();
    });
  });

  test('bounded election does not launch a Candidate after handshake exhausts the deadline', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const attempt = await spawnTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      let stopped = false;
      try {
        const connected = await retryConnect(paths, CURRENT_PROTOCOL);
        assert.equal(connected.kind, 'connected');
        if (connected.kind !== 'connected') return;
        await connected.connection.close();

        process.kill(attempt.pid, 'SIGSTOP');
        stopped = true;
        await sleep(20);
        let launchCount = 0;
        const result = await withTimeout(
          connectOrSpawnRuntimeHostWithDependencies(
            {
              rootPath: paths.root,
              surface: 'tui',
              protocol: CURRENT_PROTOCOL,
              electionDeadlineMs: 50,
              handshakeTimeoutMs: 5_000,
            },
            {
              random: () => 0.5,
              launchCandidate: () => {
                launchCount += 1;
                return { spawned: Promise.resolve({ pid: process.pid }) };
              },
            },
          ),
          1_000,
          'election exceeded its total deadline',
        );
        assert.deepEqual(result, { kind: 'failed', reason: 'host_unresponsive' });
        assert.equal(launchCount, 0);
      } finally {
        if (stopped) process.kill(attempt.pid, 'SIGCONT');
        terminateProcess(attempt.pid);
      }
    });
  });

  test('answers an admitted bootstrap with draining after shutdown commits', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      const socket = await openSocket(candidate.host.endpoint);
      const transport = new FramedTransport(socket);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closing = candidate.host.close();
      await transport.write({
        kind: 'hello',
        clientInstanceId: 'draining-client',
        surface: 'tui',
        protocolMin: CURRENT_PROTOCOL.min,
        protocolMax: CURRENT_PROTOCOL.max,
      });
      const response = decodeHostFrame(await transport.read(2_000));
      assert.deepEqual(response, { kind: 'draining', hostEpoch: candidate.host.hostEpoch });
      transport.destroy();
      await transport.closed;
      await closing;
    });
  });

  test('fences composition admission before an active command permits final shutdown', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      let requestDrain!: () => void;
      let enterCommand!: () => void;
      const commandEntered = new Promise<void>((resolve) => {
        enterCommand = resolve;
      });
      let releaseCommand!: () => void;
      const commandRelease = new Promise<void>((resolve) => {
        releaseCommand = resolve;
      });
      let commandState: 'active' | 'completed' = 'active';
      let compositionState: 'accepting' | 'draining' | 'closed' = 'accepting';
      const handlers = createUnavailableDomainOperationHandlers();
      handlers['turn.start'] = async (input) => {
        if (input.turnId === 'must-not-enter-composition') {
          throw new Error('Draining command entered the composition handler');
        }
        enterCommand();
        await commandRelease;
        commandState = 'completed';
        return {
          ok: true,
          result: {
            sessionId: input.sessionId,
            turnId: input.turnId,
            runId: 'run',
            status: 'running',
          },
        };
      };
      const host = paths.resources.trackCloseable(
        await RuntimeHostKernel.start({
          owner,
          idleGraceMs: 10_000,
          compositionFactory: async (context) => {
            requestDrain = context.requestDrain;
            return {
              handlers,
              beginDrain: () => {
                compositionState = 'draining';
              },
              recover: async () => undefined,
              close: async () => {
                assert.equal(commandState, 'completed');
                assert.equal(owner.closed, false);
                compositionState = 'closed';
                return { kind: 'clean' };
              },
            };
          },
        }),
      );
      const connected = await connectRuntimeHost({
        rootPath: paths.root,
        surface: 'tui',
        protocol: CURRENT_PROTOCOL,
      });
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;

      const command = connected.connection.startTurn({
        sessionId: 'session',
        turnId: 'turn',
        content: { text: 'hold shutdown' },
      });
      await commandEntered;
      try {
        requestDrain();
        assert.equal(compositionState, 'draining');
        assert.equal(host.state, 'ready');
        await assert.rejects(
          () =>
            connected.connection.startTurn({
              sessionId: 'session',
              turnId: 'must-not-enter-composition',
              content: { text: 'must be rejected by Host admission' },
            }),
          (error: unknown) =>
            error instanceof RuntimeHostOperationError &&
            error.operation === 'turn.start' &&
            error.code === 'host_draining',
        );
      } finally {
        releaseCommand();
      }
      await command;
      await host.closed;
      assert.equal(compositionState, 'closed');
      assert.equal(owner.closed, true);
    });
  });

  test('waits for accepted connection settlement before composition close and host close', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      const hookEntered = deferred<void>();
      const releaseHook = deferred<void>();
      const hookFailure = new Error('controlled connection settlement failure');
      const lifecycleEvents: string[] = [];
      let expectedConnectionId: string | undefined;
      const host = paths.resources.trackCloseable(
        await RuntimeHostKernel.start({
          owner,
          idleGraceMs: 10_000,
          compositionFactory: async () => ({
            handlers: createUnavailableDomainOperationHandlers(),
            onConnectionSettled: async (connectionId) => {
              assert.equal(connectionId, expectedConnectionId);
              lifecycleEvents.push('hook-start');
              hookEntered.resolve();
              try {
                await releaseHook.promise;
              } finally {
                lifecycleEvents.push('hook-settled');
              }
            },
            recover: async () => undefined,
            close: async () => {
              lifecycleEvents.push('composition-close');
              return { kind: 'clean' };
            },
          }),
        }),
      );
      const connected = await connectRuntimeHost({
        rootPath: paths.root,
        surface: 'tui',
        protocol: CURRENT_PROTOCOL,
      });
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;
      expectedConnectionId = connected.connection.connectionId;
      const hostClosed = host.closed.then(
        () => lifecycleEvents.push('host-closed'),
        (error: unknown) => {
          lifecycleEvents.push('host-closed');
          throw error;
        },
      );
      try {
        const closing = host.close();
        await hookEntered.promise;
        await connected.connection.closed;
        const closedBeforeHook = await Promise.race([
          host.closed.then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => setImmediate(() => resolve(false))),
        ]);
        assert.equal(closedBeforeHook, false);
        assert.deepEqual(lifecycleEvents, ['hook-start']);

        releaseHook.reject(hookFailure);
        const preservesHookFailure = (error: unknown) =>
          error instanceof AggregateError && error.errors.includes(hookFailure);
        await assert.rejects(() => closing, preservesHookFailure);
        await assert.rejects(() => hostClosed, preservesHookFailure);
        assert.deepEqual(lifecycleEvents, [
          'hook-start',
          'hook-settled',
          'composition-close',
          'host-closed',
        ]);
      } finally {
        releaseHook.resolve();
        await connected.connection.close().catch(() => undefined);
      }
    });
  });

  test('settles an admitted connection when its accepted response write fails', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);

      const hookCalled = deferred<void>();
      const acceptedWriteEntered = deferred<void>();
      const releaseAcceptedWrite = deferred<void>();
      const settledConnectionIds: string[] = [];
      let acceptedConnectionId: string | undefined;
      let serverTransport: FramedTransport | undefined;
      const originalWrite = FramedTransport.prototype.write;
      const host = paths.resources.trackCloseable(
        await RuntimeHostKernel.start({
          owner,
          idleGraceMs: 10_000,
          compositionFactory: async () => ({
            handlers: createUnavailableDomainOperationHandlers(),
            onConnectionSettled: async (connectionId) => {
              settledConnectionIds.push(connectionId);
              hookCalled.resolve();
            },
            recover: async () => undefined,
            close: async () => ({ kind: 'clean' }),
          }),
        }),
      );
      let clientTransport: FramedTransport | undefined;
      FramedTransport.prototype.write = async function (frame) {
        if ('kind' in frame && frame.kind === 'accepted') {
          acceptedConnectionId = frame.connectionId;
          serverTransport = this;
          acceptedWriteEntered.resolve();
          await releaseAcceptedWrite.promise;
        }
        return originalWrite.call(this, frame);
      };
      try {
        clientTransport = new FramedTransport(await openSocket(host.endpoint));
        await clientTransport.write({
          kind: 'hello',
          clientInstanceId: 'disconnect-during-accepted-response',
          surface: 'tui',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
        });
        await acceptedWriteEntered.promise;
        const acceptedTransport = serverTransport;
        assert.ok(acceptedTransport);

        clientTransport.destroy();
        await Promise.all([clientTransport.closed, acceptedTransport.closed]);
        assert.deepEqual(settledConnectionIds, []);
        releaseAcceptedWrite.resolve();

        await hookCalled.promise;
        await host.close();
        assert.deepEqual(settledConnectionIds, [acceptedConnectionId]);
      } finally {
        FramedTransport.prototype.write = originalWrite;
        releaseAcceptedWrite.resolve();
        clientTransport?.destroy();
      }
    });
  });

  test('shutdown releases ownership after bounded handling of accepted and incomplete Clients', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      const transport = new FramedTransport(await openHalfOpenSocket(candidate.host.endpoint));
      const incompleteSocket = await openHalfOpenSocket(candidate.host.endpoint);
      try {
        await transport.write({
          kind: 'hello',
          clientInstanceId: 'half-open-client',
          surface: 'tui',
          protocolMin: CURRENT_PROTOCOL.min,
          protocolMax: CURRENT_PROTOCOL.max,
        });
        const handshake = decodeHostFrame(await transport.read(2_000));
        assert.ok('kind' in handshake);
        assert.equal(handshake.kind, 'accepted');
        incompleteSocket.write('{"kind":"hello"');
        await new Promise<void>((resolve) => setImmediate(resolve));

        await withTimeout(
          candidate.host.close(),
          2_000,
          'Host shutdown did not bound incomplete Clients',
        );
        const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
        const owner = await retryOwner(capability, paths);
        assert.ok(owner);
        await owner?.close();
      } finally {
        transport.destroy();
        incompleteSocket.destroy();
      }
    });
  });

  test('bounded response backpressure evicts only a non-reading Client', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      const nonReadingSocket = await openNonReadingStatusSocket(candidate.host.endpoint);
      const observer = await connectRuntimeHost({
        ...paths,
        rootPath: paths.root,
        surface: 'inspect',
        protocol: CURRENT_PROTOCOL,
      });
      assert.equal(observer.kind, 'connected');
      if (observer.kind !== 'connected') return;
      try {
        const nonReadingClosed = new Promise<void>((resolve) => {
          nonReadingSocket.once('close', () => resolve());
        });
        for (let index = 0; index < 10_000 && !nonReadingSocket.destroyed; index += 8) {
          const batch = Array.from({ length: 8 }, (_, offset) =>
            JSON.stringify({
              requestId: `non-reading-${index + offset}`,
              operation: 'host.status',
              input: {},
            }),
          ).join('\n');
          nonReadingSocket.write(`${batch}\n`);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await withTimeout(
          nonReadingClosed,
          2_000,
          'Runtime Host did not evict a Client with bounded outbound backpressure',
        );
        assert.equal((await observer.connection.status(2_000)).state, 'ready');

        await observer.connection.close();
        await withTimeout(
          candidate.host.close(),
          2_500,
          'Host shutdown remained blocked after eviction',
        );
        const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
        const owner = await retryOwner(capability, paths);
        assert.ok(owner);
        await owner?.close();
      } finally {
        nonReadingSocket.destroy();
        await observer.connection.close();
      }
    });
  });

  test('reports one shutdown failure through close and closed while releasing ownership', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      await unlink(candidate.host.endpoint);
      await mkdir(candidate.host.endpoint);
      await Promise.all([
        assert.rejects(candidate.host.close(), AggregateError),
        assert.rejects(candidate.host.closed, AggregateError),
      ]);

      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = await retryOwner(capability, paths);
      assert.ok(owner);
      await owner?.close();
    });
  });

  test('post-commit canonical refresh failure fail-stops the Host and isolates its Store lease', {
    timeout: 30_000,
  }, async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      if (!owner) return;

      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const session = await stores.sessionStore.create({
        cwd: paths.root,
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const host = paths.resources.trackCloseable(
        await RuntimeHostKernel.start({
          owner,
          idleGraceMs: 10_000,
          compositionFactory: createExecutionRuntimeHostComposition,
        }),
      );
      const connected = await connectRuntimeHost({
        rootPath: paths.root,
        surface: 'tui',
        protocol: CURRENT_PROTOCOL,
      });
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;
      const invalidInteractionArtifact = join(
        paths.root,
        'interactions',
        'post-commit-refresh.invalid',
      );
      const answer = {
        kind: 'question' as const,
        answers: ['邀请制', '本周', '是'],
      };
      let interactionId: string | undefined;
      try {
        const turnId = 'post-commit-refresh-turn';
        const started = await connected.connection.startTurn({
          sessionId: session.id,
          turnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        });
        const pendingDeadline = Date.now() + 5_000;
        let pending;
        while (!pending) {
          [pending] = await stores.interactionStore.listPending({ sessionId: session.id });
          if (!pending && Date.now() >= pendingDeadline) {
            throw new Error('FakeBackend did not persist a pending Interaction');
          }
        }
        assert.equal(pending.runId, started.runId);
        interactionId = pending.requestId;
        const admitted = await connected.connection.request('interaction.query', {
          sessionId: session.id,
          interactionId,
        });
        assert.equal(admitted.status, 'pending');

        await writeFile(invalidInteractionArtifact, 'invalid canonical artifact', 'utf8');
        const closedOutcome = host.closed.then(
          () => ({ status: 'fulfilled' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        const answerOutcome = connected.connection
          .request('interaction.answer', {
            interactionId,
            answer,
          })
          .then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
          );
        const [attempt, closed] = await Promise.all([
          withTimeout(
            answerOutcome,
            5_000,
            'wire Interaction answer did not settle after Host fail-stop',
          ),
          withTimeout(
            closedOutcome,
            5_000,
            'post-commit canonical refresh failure did not fail-stop the Host',
          ),
        ]);
        assert.equal(attempt.status, 'rejected');
        assert.equal(closed.status, 'rejected');
        if (closed.status !== 'rejected') return;
        assert.ok(closed.error instanceof RuntimeInteractionFailStopError);
        assert.ok(closed.error.authorityFailure instanceof Error);
        assert.equal(
          'code' in closed.error.authorityFailure ? closed.error.authorityFailure.code : undefined,
          'invalid_record',
        );
        assert.equal(owner.closed, true);
        await assertPathMissing(host.endpoint);
        assert.equal(await readHostRegistration(owner.controlDirectory), undefined);
        await assert.rejects(
          () =>
            stores.interactionStore.establishRequest({
              sessionId: 'late-post-commit-session',
              turnId: 'late-post-commit-turn',
              runId: 'late-post-commit-run',
              requestId: 'late-post-commit-request',
              createdAt: 1,
              request: {
                kind: 'question',
                toolUseId: 'late-post-commit-tool',
                questions: [
                  {
                    question: 'Can a post-commit failed Host still write?',
                    options: [{ label: 'No' }, { label: 'Never' }],
                  },
                ],
              },
            }),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
        );
      } finally {
        await connected.connection.close().catch(() => undefined);
        await rm(invalidInteractionArtifact, { force: true });
      }

      assert.ok(interactionId);
      const successor = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(successor);
      if (!successor) return;
      const successorStores = await openInteractiveExecutionStoresForWrite(successor.lease);
      const durable = await successorStores.interactionStore.readInteraction(interactionId);
      assert.ok(durable?.outcome);
      assert.equal(durable.outcome.outcome.kind, 'question_answer');
      if (durable.outcome.outcome.kind === 'question_answer') {
        assert.deepEqual(durable.outcome.outcome.answers, answer.answers);
      }
      await successor.close();
    });
  });

  test('fail-stop aggregates beginDrain failure without waiting for ordinary composition close', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      if (!owner) return;

      let requestFailStop!: Parameters<
        NonNullable<Parameters<typeof RuntimeHostKernel.start>[0]['compositionFactory']>
      >[0]['requestFailStop'];
      const compositionCloseEntered = deferred<void>();
      const releaseCompositionClose = deferred<{ readonly kind: 'clean' }>();
      const reclaim = { state: 'retained' as 'retained' | 'reclaimed' };
      const drainFailure = new Error('controlled composition beginDrain failure');
      let interactionStore!: Awaited<
        ReturnType<typeof openInteractiveExecutionStoresForWrite>
      >['interactionStore'];
      const host = await RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        compositionFactory: async (context) => {
          requestFailStop = context.requestFailStop;
          interactionStore = (await openInteractiveExecutionStoresForWrite(context.owner.lease))
            .interactionStore;
          return {
            handlers: createUnavailableDomainOperationHandlers(),
            beginDrain: () => {
              throw drainFailure;
            },
            recover: async () => undefined,
            close: () => {
              compositionCloseEntered.resolve();
              return releaseCompositionClose.promise;
            },
          };
        },
      });
      const failure = new Error('permanent Interaction Store uncertainty');
      const endpoint = host.endpoint;
      try {
        requestFailStop(
          Object.freeze({
            kind: 'fail_stop',
            cause: failure,
            reclaimAfterOwnerIsolation: () => {
              reclaim.state = 'reclaimed';
            },
          }),
        );
        await withTimeout(
          compositionCloseEntered.promise,
          2_000,
          'fail-stop did not begin ordinary composition close',
        );
        await assert.rejects(
          () =>
            withTimeout(
              host.closed,
              2_000,
              'fail-stop waited for ordinary composition close before releasing ownership',
            ),
          (error: unknown) =>
            error instanceof AggregateError &&
            error.errors.includes(failure) &&
            error.errors.includes(drainFailure),
        );
        assert.equal(owner.closed, true);
        assert.equal(reclaim.state, 'reclaimed');
        await assertPathMissing(endpoint);
        assert.equal(await readHostRegistration(owner.controlDirectory), undefined);
        await assert.rejects(
          () =>
            interactionStore.establishRequest({
              sessionId: 'late-session',
              turnId: 'late-turn',
              runId: 'late-run',
              requestId: 'late-request',
              createdAt: 1,
              request: {
                kind: 'question',
                toolUseId: 'late-tool',
                questions: [
                  {
                    question: 'Can an isolated execution write?',
                    options: [{ label: 'No' }, { label: 'Never' }],
                  },
                ],
              },
            }),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
        );
        const successor = await retryOwner(capability, paths);
        assert.ok(successor);
        await successor?.close();
      } finally {
        releaseCompositionClose.resolve({ kind: 'clean' });
      }
    });
  });

  test('fail-stop bounds root owner close and never reclaims before owner isolation', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const owner = paths.resources.trackCloseable(
        await tryAcquireInteractiveRootOwner(capability),
      );
      assert.ok(owner);
      if (!owner) return;

      let requestFailStop!: Parameters<
        NonNullable<Parameters<typeof RuntimeHostKernel.start>[0]['compositionFactory']>
      >[0]['requestFailStop'];
      const reclaim = { state: 'retained' as 'retained' | 'reclaimed' };
      const host = await RuntimeHostKernel.start({
        owner,
        idleGraceMs: 10_000,
        compositionFactory: async (context) => {
          requestFailStop = context.requestFailStop;
          return {
            handlers: createUnavailableDomainOperationHandlers(),
            recover: async () => undefined,
            close: async () => ({ kind: 'clean' }),
          };
        },
      });
      const operationEntered = deferred<void>();
      const releaseOperation = deferred<void>();
      const ownerOperation = runWithStorageRootLease(
        owner.lease,
        'interactive',
        'write',
        async () => {
          operationEntered.resolve();
          await releaseOperation.promise;
        },
      );
      await operationEntered.promise;
      const failure = new Error('controlled fail-stop with pending owner operation');
      try {
        requestFailStop(
          Object.freeze({
            kind: 'fail_stop',
            cause: failure,
            reclaimAfterOwnerIsolation: () => {
              reclaim.state = 'reclaimed';
            },
          }),
        );
        await assert.rejects(
          () =>
            withTimeout(host.closed, 2_500, 'fail-stop did not bound a pending root owner close'),
          (error: unknown) =>
            error instanceof AggregateError &&
            error.errors.includes(failure) &&
            error.errors.some(
              (item) => item instanceof Error && item.message.includes('root owner close exceeded'),
            ),
        );
        assert.equal(owner.closed, true);
        assert.equal(reclaim.state, 'retained');
        assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
      } finally {
        releaseOperation.resolve();
      }
      await ownerOperation;
      await owner.close();
      assert.equal(reclaim.state, 'retained');
      const successor = await retryOwner(capability, paths);
      assert.ok(successor);
      await successor?.close();
    });
  });

  test('startup rejects invalid lifecycle durations and releases the owner lock', async () => {
    await withHostPaths(async (paths) => {
      await assert.rejects(
        () =>
          startTestRuntimeHostCandidate(paths, {
            rootPath: paths.root,
            idleGraceMs: -1,
          }),
        RangeError,
      );
      await assert.rejects(
        () =>
          startTestRuntimeHostCandidate(paths, {
            rootPath: paths.root,
            handshakeTimeoutMs: 0,
          }),
        RangeError,
      );
      const retry = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 0,
      });
      assert.equal(retry.kind, 'winner');
      if (retry.kind === 'winner') await retry.host.closed;
    });
  });

  test('rejects invalid Client configuration before root mutation or Host classification', async () => {
    await withHostPaths(async (paths) => {
      await assert.rejects(
        () =>
          connectRuntimeHost({
            rootPath: paths.root,
            surface: 'tui',
            protocol: CURRENT_PROTOCOL,
            connectTimeoutMs: 0,
          }),
        RangeError,
      );
      await assert.rejects(
        () =>
          connectRuntimeHost({
            rootPath: paths.root,
            surface: 'tui',
            protocol: CURRENT_PROTOCOL,
            handshakeTimeoutMs: 0,
          }),
        RangeError,
      );
      await assert.rejects(
        () =>
          connectRuntimeHost({
            rootPath: paths.root,
            surface: 'tui',
            protocol: CURRENT_PROTOCOL,
            clientInstanceId: '',
          }),
        RuntimeHostProtocolError,
      );
      await assertPathMissing(paths.root);

      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;
      await assert.rejects(
        () =>
          connectOrSpawnRuntimeHost({
            rootPath: paths.root,
            surface: 'tui',
            protocol: CURRENT_PROTOCOL,
            clientInstanceId: 'x'.repeat(129),
            electionDeadlineMs: 100,
          }),
        RuntimeHostProtocolError,
      );
      assert.equal(candidate.host.state, 'ready');
      await candidate.host.close();
    });
  });

  test('detached launcher reports an executable spawn failure to its caller', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      await assert.rejects(
        () =>
          launchDetachedRuntimeHostCandidate({
            rootPath: paths.root,
            expectedRootId: capability.rootId,
            executable: join(paths.root, 'missing-node'),
          }).spawned,
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    });
  });

  test('Candidate refuses a replacement root without initializing or owning it', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      await rename(paths.root, join(paths.base, 'original-root'));
      await mkdir(paths.root);

      const attempt = await spawnTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        expectedRootId: capability.rootId,
        idleGraceMs: 10_000,
      });
      await waitForProcessExit(attempt.pid, 2_000);
      paths.resources.forgetPid(attempt.pid);
      await assertPathMissing(join(paths.root, STORAGE_ROOT_MARKER_FILE));

      const replacement = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      assert.notEqual(replacement.rootId, capability.rootId);
      const owner = await tryAcquireInteractiveRootOwner(replacement);
      assert.ok(owner);
      await owner?.close();
    });
  });

  test('invalid registration fails closed without following its endpoint', async () => {
    await withHostPaths(async (paths) => {
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
      await writeFile(
        join(controlDirectory, 'registration.json'),
        '{"endpoint":"/tmp/not-authority"}\n',
        {
          mode: 0o600,
        },
      );
      const result = await connectRuntimeHost({
        ...paths,
        rootPath: paths.root,
        surface: 'inspect',
        protocol: CURRENT_PROTOCOL,
      });
      assert.deepEqual(result, { kind: 'unavailable', reason: 'invalid_registration' });
    });
  });

  test('malformed and oversized bootstrap frames close only the offending connection', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;

      await sendInvalidBootstrap(candidate.host.endpoint, Buffer.from('not-json\n'));
      await sendInvalidBootstrap(
        candidate.host.endpoint,
        Buffer.alloc(RUNTIME_HOST_MAX_FRAME_BYTES + 1, 0x61),
      );

      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;
      assert.equal((await connected.connection.status()).state, 'ready');
      await connected.connection.close();
      await candidate.host.close();
    });
  });

  test('drains after the live storage root identity disappears and releases the moved root', async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;
      const connected = await retryConnect(paths, CURRENT_PROTOCOL);
      assert.equal(connected.kind, 'connected');
      if (connected.kind !== 'connected') return;

      const movedRoot = join(paths.base, 'moved-root');
      await rename(paths.root, movedRoot);
      await assert.rejects(() => connected.connection.status());
      await candidate.host.closed;
      assert.equal(candidate.host.state, 'draining');

      const replacement = await startTestRuntimeHostCandidate(paths, {
        rootPath: movedRoot,
        idleGraceMs: 10_000,
      });
      assert.equal(replacement.kind, 'winner');
      if (replacement.kind === 'winner') await replacement.host.close();
    });
  });

  test('publishes private POSIX endpoint and registration permissions', {
    skip: process.platform === 'win32',
  }, async () => {
    await withHostPaths(async (paths) => {
      const candidate = await startTestRuntimeHostCandidate(paths, {
        rootPath: paths.root,
        idleGraceMs: 10_000,
      });
      assert.equal(candidate.kind, 'winner');
      if (candidate.kind !== 'winner') return;
      const capability = await resolveStorageRoot({ path: paths.root, kind: 'interactive' });
      const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
      const registration = await readHostRegistration(controlDirectory);
      assert.ok(registration);
      assert.equal((await stat(registration.endpoint)).mode & 0o077, 0);
      assert.equal((await stat(dirname(registration.endpoint))).mode & 0o077, 0);
      assert.equal((await stat(join(controlDirectory, 'registration.json'))).mode & 0o077, 0);
      await candidate.host.close();
    });
  });
});

interface HostPaths {
  base: string;
  root: string;
  resources: HostTestResources;
}

interface CloseableTestResource {
  close(): Promise<void>;
}

class HostTestResources {
  readonly #closeables = new Set<CloseableTestResource>();
  readonly #children = new Set<ChildProcess>();
  readonly #pids = new Set<number>();

  trackCloseable<T extends CloseableTestResource | undefined>(resource: T): T {
    if (resource) this.#closeables.add(resource);
    return resource;
  }

  trackChild<T extends ChildProcess>(child: T): T {
    this.#children.add(child);
    return child;
  }

  trackPid(pid: number): number {
    this.#pids.add(pid);
    return pid;
  }

  forgetPid(pid: number): void {
    this.#pids.delete(pid);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#closeables].reverse().map((resource) => resource.close()));
    for (const child of this.#children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = waitForExit(child);
      child.kill('SIGKILL');
      await withTimeout(exited, 1_000, 'test launcher did not exit during cleanup').catch(
        () => undefined,
      );
    }
    for (const pid of this.#pids) {
      if (!isProcessAlive(pid)) continue;
      terminateProcess(pid);
      await waitForProcessExit(pid, 1_000).catch(() => undefined);
    }
  }
}

async function withHostPaths(run: (paths: HostPaths) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-'));
  const resources = new HostTestResources();
  const paths = {
    base,
    root: join(base, 'root'),
    resources,
  };
  try {
    await run(paths);
  } finally {
    await resources.close();
    await removeControlDirectoriesForRootsUnder(base);
    await chmod(base, 0o700).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

function spawnConnectClient(
  paths: HostPaths,
  surface: 'desktop' | 'tui',
  environmentSuffix: string,
): ChildProcess {
  const fakeHome = join(paths.base, `fake-home-${environmentSuffix}`);
  return paths.resources.trackChild(
    fork(new URL('./fixtures/connect-client.js', import.meta.url), [paths.root, surface], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: {
        ...process.env,
        HOME: fakeHome,
        XDG_CACHE_HOME: join(fakeHome, 'cache'),
        XDG_RUNTIME_DIR: join(fakeHome, 'runtime'),
        LOCALAPPDATA: join(fakeHome, 'local-app-data'),
      },
    }),
  );
}

function waitForConnectedClient(
  child: ChildProcess,
): Promise<{ hostEpoch: string; candidatePids: number[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('connect Client did not report readiness'));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`connect Client exited before readiness: ${code ?? signal}`));
    };
    const onMessage = (message: unknown) => {
      if (!isConnectedClientMessage(message)) return;
      cleanup();
      resolve({ hostEpoch: message.hostEpoch, candidatePids: message.candidatePids });
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function isConnectedClientMessage(
  value: unknown,
): value is { type: 'connected'; hostEpoch: string; candidatePids: number[] } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'connected' &&
    typeof message.hostEpoch === 'string' &&
    Array.isArray(message.candidatePids) &&
    message.candidatePids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
  );
}

async function retryConnect(
  paths: HostPaths,
  protocol: { min: number; max: number },
  surface: ClientSurface = 'tui',
) {
  const deadline = Date.now() + 5_000;
  let result = await connectRuntimeHost({
    ...paths,
    rootPath: paths.root,
    surface,
    protocol,
  });
  while (result.kind !== 'connected' && Date.now() < deadline) {
    await sleep(20);
    result = await connectRuntimeHost({ ...paths, rootPath: paths.root, surface, protocol });
  }
  return result;
}

async function retryOwner(capability: StorageRootCapability<'interactive'>, paths: HostPaths) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    if (owner) return paths.resources.trackCloseable(owner);
    await sleep(20);
  }
  return undefined;
}

async function startTestRuntimeHostCandidate(
  paths: HostPaths,
  options: Omit<RuntimeHostCandidateOptions, 'expectedRootId'> & { expectedRootId?: string },
): Promise<RuntimeHostCandidateResult> {
  const expectedRootId =
    options.expectedRootId ??
    (await resolveStorageRoot({ path: options.rootPath, kind: 'interactive' })).rootId;
  const result = await startRuntimeHostCandidate({ ...options, expectedRootId });
  if (result.kind === 'winner') paths.resources.trackCloseable(result.host);
  return result;
}

async function spawnTestRuntimeHostCandidate(
  paths: HostPaths,
  input: Omit<DetachedCandidateInput, 'expectedRootId'> & { expectedRootId?: string },
): Promise<DetachedCandidateAttempt> {
  const expectedRootId =
    input.expectedRootId ??
    (await resolveStorageRoot({ path: input.rootPath, kind: 'interactive' })).rootId;
  return launchTestRuntimeHostCandidate(paths, { ...input, expectedRootId }).spawned;
}

function launchTestRuntimeHostCandidate(
  paths: HostPaths,
  input: DetachedCandidateInput,
): DetachedCandidateLaunch {
  const launch = launchDetachedRuntimeHostCandidate(input);
  return {
    spawned: launch.spawned.then((attempt) => {
      paths.resources.trackPid(attempt.pid);
      return attempt;
    }),
  };
}

function waitForLaunch(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launcher did not report')), 5_000);
    child.once('message', (message) => {
      if (
        !message ||
        typeof message !== 'object' ||
        (message as { type?: unknown }).type !== 'launched'
      )
        return;
      clearTimeout(timer);
      resolve((message as { pid: number }).pid);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) reject(new Error(`launcher exited: ${code ?? signal}`));
    });
  });
}

function waitForElectronParentLaunch(
  child: ChildProcess,
): Promise<{ hostEpoch: string; pid: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Electron connect parent did not report its Host'));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`Electron connect parent exited before reporting its Host: ${code ?? signal}`),
      );
    };
    const onMessage = (message: unknown) => {
      if (!isElectronParentLaunch(message)) return;
      cleanup();
      resolve({ hostEpoch: message.hostEpoch, pid: message.pid });
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function isElectronParentLaunch(
  value: unknown,
): value is { type: 'electron-parent-launched'; hostEpoch: string; pid: number } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'electron-parent-launched' &&
    typeof message.hostEpoch === 'string' &&
    Number.isSafeInteger(message.pid) &&
    (message.pid as number) > 0
  );
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function waitForSuccessfulExit(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`${label} exited: ${child.exitCode ?? child.signalCode}`));
  }
  return new Promise((resolve, reject) =>
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited: ${code ?? signal}`));
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(20);
  if (isProcessAlive(pid)) throw new Error(`process ${pid} did not exit`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    ) {
      return false;
    }
    throw error;
  }
}

function terminateProcess(pid: number | undefined): void {
  if (pid === undefined || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ESRCH'
      )
    ) {
      throw error;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

function observeStartup(promise: Promise<RuntimeHostKernel>) {
  return promise.then(
    (host) => ({ kind: 'started' as const, host }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );
}

async function openAcceptedTransport(
  path: string,
  clientInstanceId: string,
): Promise<FramedTransport> {
  return (await openAcceptedConnection(path, clientInstanceId)).transport;
}

async function openAcceptedConnection(
  path: string,
  clientInstanceId: string,
): Promise<{ transport: FramedTransport; connectionId: string }> {
  const transport = new FramedTransport(await openSocket(path));
  await transport.write({
    kind: 'hello',
    clientInstanceId,
    surface: 'tui',
    protocolMin: CURRENT_PROTOCOL.min,
    protocolMax: CURRENT_PROTOCOL.max,
  });
  const handshake = decodeHostFrame(await transport.read(2_000));
  assert.ok('kind' in handshake && handshake.kind === 'accepted');
  assert.equal(handshake.state, 'recovering');
  return { transport, connectionId: handshake.connectionId };
}

function writeSocket(socket: Socket, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function openHalfOpenSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket({ allowHalfOpen: true });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
    socket.connect(path);
  });
}

async function openNonReadingStatusSocket(path: string): Promise<Socket> {
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.connect(path);
  });
  const handshake = await new Promise<ReturnType<typeof decodeHostFrame>>((resolve, reject) => {
    let buffered = '';
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      socket.pause();
      try {
        resolve(decodeHostFrame(JSON.parse(buffered.slice(0, newline))));
      } catch (error) {
        reject(error);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(
      `${JSON.stringify({
        kind: 'hello',
        clientInstanceId: 'non-reading-client',
        surface: 'tui',
        protocolMin: CURRENT_PROTOCOL.min,
        protocolMax: CURRENT_PROTOCOL.max,
      })}\n`,
    );
  });
  assert.ok('kind' in handshake);
  assert.equal(handshake.kind, 'accepted');
  socket.on('error', () => undefined);
  return socket;
}

async function sendInvalidBootstrap(path: string, payload: Buffer): Promise<void> {
  const socket = await openSocket(path);
  socket.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write(payload);
  await withTimeout(closed, 1_000, 'Runtime Host did not close an invalid bootstrap connection');
}

async function removeControlDirectoriesForRootsUnder(base: string): Promise<void> {
  const rootIds = new Set<string>();
  await collectRootIds(base, rootIds);
  await Promise.all(
    [...rootIds].map(async (rootId) => {
      await rm(join(resolveRootControlNamespace(), rootId), { recursive: true, force: true });
      if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
      const prefix = `m-${process.getuid()}-${Buffer.from(rootId, 'hex').toString('base64url')}-`;
      const entries = await readdir('/tmp', { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          if (
            !entry.isDirectory() ||
            !entry.name.startsWith(prefix) ||
            entry.name.length !== prefix.length + 6
          )
            return;
          const path = join('/tmp', entry.name);
          const directoryStat = await lstat(path).catch(() => undefined);
          if (directoryStat?.isDirectory() && directoryStat.uid === process.getuid?.()) {
            await rm(path, { recursive: true, force: true });
          }
        }),
      );
    }),
  );
}

async function collectRootIds(directory: string, rootIds: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const marker = await readFile(join(path, STORAGE_ROOT_MARKER_FILE), 'utf8').catch(
      () => undefined,
    );
    if (marker) {
      try {
        const rootId = (JSON.parse(marker) as { rootId?: unknown }).rootId;
        if (typeof rootId === 'string' && /^[a-f0-9]{64}$/.test(rootId)) rootIds.add(rootId);
      } catch {
        // Invalid markers never reach the Runtime Host control namespace.
      }
    }
    await collectRootIds(path, rootIds);
  }
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(
    () => lstat(path),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
}
