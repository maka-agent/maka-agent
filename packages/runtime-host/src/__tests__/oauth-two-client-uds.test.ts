import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  createNativeCapabilityProvider,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { createOAuthPresentationNativeCapability } from '../native-provider/oauth-presentation.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import { HostNativeProviderCoordinator } from '../server/native-provider-coordinator.js';
import { HostOAuthCoordinator } from '../server/oauth-coordinator.js';
import {
  combineDomainOperationHandlers,
  createUnavailableDomainOperationHandlers,
} from '../server/operation-dispatcher.js';
import { HostRuntimePolicyCoordinator } from '../server/runtime-policy-coordinator.js';
import { connectClient, withExecutionRoot, withTimeout } from './support/execution-root-fixture.js';

test('real UDS login keeps initiating-client affinity and commits from a later Client', async () => {
  await withExecutionRoot(async (fixture) => {
    const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
    assert.ok(owner);
    if (!owner) return;
    const connectionReady = deferred<string>();
    let invalidations = 0;
    const host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      compositionFactory: async (context) => {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(context.owner.lease);
        const created = await stores.connectionCatalog.create({
          expectedCatalogRevision: 0,
          connection: {
            slug: 'uds-oauth',
            name: 'UDS OAuth',
            providerType: 'claude-subscription',
            enabled: true,
            enabledModelIds: [],
          },
        });
        assert.equal(created.kind, 'committed');
        if (created.kind !== 'committed') throw new Error('OAuth connection was not created');
        const connection = created.snapshot.connections[0];
        if (!connection) throw new Error('OAuth connection is missing');
        connectionReady.resolve(connection.connectionId);
        const native = new HostNativeProviderCoordinator(
          context.hostEpoch,
          context.acquireResidency,
        );
        const invalidate = async () => {
          invalidations += 1;
        };
        const oauth = new HostOAuthCoordinator({
          runtimePolicy: stores,
          nativeProvider: native,
          acquireResidency: context.acquireResidency,
          invalidateBackends: invalidate,
          onFatal: (error) => assert.fail(error.message),
          exchangeCode: async () => ({
            access_token: 'uds-access',
            refresh_token: 'uds-refresh',
            expires_at: Date.now() + 60_000,
            account_uuid: 'uds-account',
          }),
        });
        const policy = new HostRuntimePolicyCoordinator(stores, invalidate);
        return {
          handlers: combineDomainOperationHandlers({
            ...createUnavailableDomainOperationHandlers(),
            ...policy.handlers,
            ...native.handlers,
            ...oauth.handlers,
          }),
          nativeProvider: native,
          beginDrain: () => oauth.beginDrain(),
          recover: async () => undefined,
          close: async () => {
            await oauth.close();
            return { kind: 'clean' };
          },
        };
      },
    });

    let clientA: RuntimeHostConnection | undefined;
    let clientB: RuntimeHostConnection | undefined;
    try {
      const connectionId = await connectionReady.promise;
      clientA = await connectClient(fixture.root, 'desktop');
      clientB = await connectClient(fixture.root, 'tui');
      const aEntered = deferred<void>();
      const registrationA = await clientA.registerNativeProvider(
        createNativeCapabilityProvider([
          createOAuthPresentationNativeCapability({
            async openExternal() {
              assert.fail('Claude login must request a paste code');
            },
            async requestAuthorizationCode(_input, _context, signal) {
              aEntered.resolve();
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              });
              throw new Error('unreachable');
            },
          }),
        ]),
      );
      let bCalls = 0;
      await clientB.registerNativeProvider(
        createNativeCapabilityProvider([
          createOAuthPresentationNativeCapability({
            async openExternal() {
              assert.fail('Claude login must request a paste code');
            },
            async requestAuthorizationCode(input) {
              bCalls += 1;
              const state = new URL(input.url).searchParams.get('state');
              assert.ok(state);
              return `uds-code#${state}`;
            },
          }),
        ]),
      );

      const first = await clientA.request('oauth.login.start', {
        attemptId: 'attempt-a',
        connectionId,
      });
      assert.equal(first.phase, 'awaiting_authorization');
      await aEntered.promise;
      await assert.rejects(
        clientB.request('oauth.login.start', {
          attemptId: 'attempt-b-blocked',
          connectionId,
        }),
        (error: unknown) =>
          error instanceof RuntimeHostOperationError && error.code === 'authorization_in_progress',
      );

      await clientA.close();
      await registrationA.drained;
      await waitForPhase(clientB, 'attempt-a', 'failed');
      assert.equal(bCalls, 0);

      const second = await clientB.request('oauth.login.start', {
        attemptId: 'attempt-b',
        connectionId,
      });
      assert.equal(second.attemptId, 'attempt-b');
      assert.equal(second.connectionId, connectionId);
      await waitForPhase(clientB, 'attempt-b', 'authenticated');
      assert.equal(bCalls, 1);
      assert.equal(invalidations, 1);
      const status = await clientB.request('credential.vault.query', {
        locator: { scope: 'connection', connectionId, kind: 'oauth_token' },
      });
      assert.equal(status.kind, 'status');
      if (status.kind === 'status') assert.equal(status.status.configured, true);
    } finally {
      await clientA?.close().catch(() => undefined);
      await clientB?.close().catch(() => undefined);
      await withTimeout(host.close(), 3_000, 'OAuth UDS Host did not close');
    }
  });
});

async function waitForPhase(
  client: RuntimeHostConnection,
  attemptId: string,
  phase: 'failed' | 'authenticated',
): Promise<void> {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const result = await client.request('oauth.login.query', { attemptId });
    if (result.phase === phase) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`OAuth attempt did not reach ${phase}`);
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
