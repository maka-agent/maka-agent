import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/index.js';
import {
  SESSION_MANAGEMENT_LABEL_MAX_BYTES,
  SESSION_MANAGEMENT_LABEL_MAX_ITEMS,
  SESSION_MANAGEMENT_PAGE_MAX_ITEMS,
  SESSION_MANAGEMENT_RESULT_MAX_BYTES,
  type SessionManagementCreateInput,
  type SessionManagementQueryResult,
} from '../protocol/index.js';
import {
  connectClient,
  type ExecutionFixture,
  PROCESS_TIMEOUT_MS,
  waitForTerminalTurn,
  withExecutionRoot,
  withTimeout,
} from './support/execution-root-fixture.js';
import {
  startScriptedOpenAiProvider,
  type ScriptedOpenAiProvider,
} from './support/scripted-openai-provider.js';
import {
  HostSessionCoordinator,
  type HostSessionCoordinatorOptions,
} from '../server/session-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('a Session mutation queued before the lifecycle fence retains admission', async () => {
  await withExecutionRoot(async (fixture) => {
    const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
    assert.ok(owner);
    if (!owner) throw new Error('Unable to acquire the Interactive root for Session mutation');
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const admission = new SessionAdmissionGate();
      const unused = (): never => {
        throw new Error('Unexpected Session lifecycle collaborator call');
      };
      const unusedAsync = async (): Promise<never> => unused();
      let drainRequests = 0;
      const options = {
        stores,
        runtimePolicy: {
          connectionCatalog: { getSnapshot: unusedAsync },
          runtimePolicy: { getSnapshot: unusedAsync },
        },
        usage: { flush: unusedAsync },
        manager: {
          disposeSessionBackend: unusedAsync,
          markSessionRead: unusedAsync,
          renameSession: (sessionId: string, name: string) =>
            stores.sessionStore.rename(sessionId, name),
          setFlagged: unusedAsync,
          setPermissionMode: unusedAsync,
          updateSession: unusedAsync,
        },
        admission,
        root: { readRootState: () => ({ kind: 'idle' as const }) },
        messages: { beginSessionClose: unusedAsync, resumeSession: unusedAsync },
        continuity: { refreshCanonical: async () => undefined, retireSession: unusedAsync },
        goals: { beginSessionClose: unused, unarchiveSession: unused },
        automation: { beginSessionClose: unused, unarchiveSession: unused },
        resources: { beginSessionClose: unused, resumeSession: unused },
        requestDrain: () => {
          drainRequests += 1;
        },
      } satisfies HostSessionCoordinatorOptions;
      const coordinator = new HostSessionCoordinator(options);
      const blockerEntered = deferred<void>();
      const releaseBlocker = deferred<void>();
      const order: string[] = [];
      const blocker = admission.run(fixture.sessionId, async () => {
        order.push('blocker:start');
        blockerEntered.resolve();
        await releaseBlocker.promise;
        order.push('blocker:end');
      });
      await blockerEntered.promise;

      const preFence = coordinator.handlers['session.mutate'](
        { kind: 'rename', sessionId: fixture.sessionId, name: 'Queued before fence' },
        operationContext(),
      ).then((outcome) => {
        order.push('pre-fence');
        return outcome;
      });
      const lifecycle = admission.beginSessionLifecycle(fixture.sessionId);
      const postFence = coordinator.handlers['session.mutate'](
        { kind: 'rename', sessionId: fixture.sessionId, name: 'Submitted after fence' },
        operationContext(),
      ).then((outcome) => {
        order.push('post-fence');
        return outcome;
      });
      const durableConflict = coordinator.handlers['session.create'](
        {
          sessionId: fixture.sessionId,
          cwd: fixture.root,
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'unused-existing-connection',
            model: 'unused-existing-model',
          },
        },
        operationContext(),
      ).then((outcome) => {
        order.push('durable-proof');
        return outcome;
      });

      releaseBlocker.resolve();
      const admitted = await preFence;
      assert.equal(admitted.ok, true);
      if (admitted.ok) assert.equal(admitted.result.kind, 'session');
      const rejected = await postFence;
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.error.code, 'session_busy');
      const proven = await durableConflict;
      assert.equal(proven.ok, false);
      if (!proven.ok) {
        assert.equal(proven.error.code, 'operation_conflict');
        assert.equal(proven.error.message, 'Session id belongs to a different create request');
      }
      await blocker;
      lifecycle.release();
      assert.equal(
        (await stores.sessionStore.readHeaderSnapshot(fixture.sessionId)).name,
        'Queued before fence',
      );
      assert.equal(drainRequests, 0);
      assert.deepEqual(order, [
        'blocker:start',
        'blocker:end',
        'pre-fence',
        'post-fence',
        'durable-proof',
      ]);
    } finally {
      await owner.close();
    }
  });
});

test('two UDS Clients observe stable Session create after the default model target changes', async () => {
  await withExecutionRoot(async (fixture) => {
    const models = await configureModels(fixture, 'http://127.0.0.1:1/v1');
    const host = await fixture.startHost();
    let clientA: RuntimeHostConnection | undefined;
    let clientB: RuntimeHostConnection | undefined;
    try {
      clientA = await connectClient(fixture.root, 'desktop');
      clientB = await connectClient(fixture.root, 'tui');
      const createInput: SessionManagementCreateInput = {
        sessionId: randomUUID(),
        cwd: fixture.root,
        name: 'Stable UDS Session',
        labels: ['acceptance'],
        modelTarget: { kind: 'default' },
        permissionMode: 'bypass',
      };

      const created = await clientA.request('session.create', createInput);
      assert.equal(created.id, createInput.sessionId);
      assert.equal(created.llmConnectionSlug, models.connectionSlug);
      assert.equal(created.model, models.firstModelId);

      const catalog = await clientB.request('connection.catalog.query', { kind: 'start' });
      assert.equal(catalog.kind, 'page');
      if (catalog.kind !== 'page') assert.fail('Connection catalog query did not return a page');
      const switched = await clientB.request('connection.catalog.set-default-target', {
        expectedCatalogRevision: catalog.revision,
        target: {
          connectionId: models.connectionId,
          modelId: models.secondModelId,
        },
      });
      assert.equal(switched.kind, 'committed');

      const retried = await clientA.request('session.create', createInput);
      assert.deepEqual(retried, created);

      const queried = await clientB.request('session.query', {
        kind: 'get',
        sessionId: createInput.sessionId,
      });
      assert.equal(queried.kind, 'item');
      assert.deepEqual(queried.session, created);

      const renamed = await clientA.request('session.mutate', {
        kind: 'rename',
        sessionId: createInput.sessionId,
        name: 'Renamed across UDS',
      });
      assert.equal(renamed.kind, 'session');
      if (renamed.kind !== 'session') assert.fail('Rename did not return a Session');
      assert.equal(renamed.session.name, 'Renamed across UDS');

      const visibleToB = await clientB.request('session.query', {
        kind: 'get',
        sessionId: createInput.sessionId,
      });
      assert.equal(visibleToB.kind, 'item');
      assert.equal(visibleToB.session.name, 'Renamed across UDS');
      assert.equal(visibleToB.session.model, models.firstModelId);

      const createdIds = new Set([createInput.sessionId]);
      let firstPage: Extract<SessionManagementQueryResult, { kind: 'page' }> | undefined;
      for (let index = 0; index < SESSION_MANAGEMENT_PAGE_MAX_ITEMS - 2; index += 1) {
        const paginationSession = await clientA.request('session.create', {
          sessionId: randomUUID(),
          cwd: fixture.root,
          labels: paginationLabels(index),
          modelTarget: { kind: 'default' },
          permissionMode: 'bypass',
        });
        createdIds.add(paginationSession.id);

        const page: SessionManagementQueryResult = await clientB.request('session.query', {
          kind: 'list',
        });
        assert.equal(page.kind, 'page');
        if (page.kind !== 'page') assert.fail('Session list did not return a page');
        if (page.nextCursor !== undefined) {
          firstPage = page;
          break;
        }
      }
      assert.ok(firstPage, 'Label-heavy Sessions did not reach the list byte boundary');
      assert.ok(firstPage.items.length < SESSION_MANAGEMENT_PAGE_MAX_ITEMS);
      assert.ok(createdIds.size + 1 < SESSION_MANAGEMENT_PAGE_MAX_ITEMS);

      const listed = [...firstPage.items];
      let cursor = firstPage.nextCursor;
      while (cursor !== undefined) {
        const page: SessionManagementQueryResult = await clientB.request('session.query', {
          kind: 'list',
          cursor,
        });
        assert.equal(page.kind, 'page');
        if (page.kind !== 'page') assert.fail('Session continuation did not return a page');
        listed.push(...page.items);
        cursor = page.nextCursor;
      }
      assert.ok(
        Buffer.byteLength(JSON.stringify({ kind: 'page', items: listed }), 'utf8') >
          SESSION_MANAGEMENT_RESULT_MAX_BYTES,
      );
      const listedIds = new Set(listed.map((session) => session.id));
      for (const sessionId of createdIds) assert.ok(listedIds.has(sessionId));
    } finally {
      await Promise.allSettled([clientA?.close(), clientB?.close()]);
      await fixture.stopHost(host);
    }
  });
});

test('archive survives Host restart, unarchive restores resources, and stable removal cannot revive', async () => {
  const modelId = `session-management-model-${randomUUID()}`;
  const toolCallId = `session-management-bash-${randomUUID()}`;
  const provider = await startScriptedOpenAiProvider({
    modelId,
    toolCallId,
    toolName: 'Bash',
    toolArgs: {
      command: 'node -e "setInterval(function () {}, 1000)"',
      run_in_background: true,
    },
    finalText: 'Background resource admitted.',
  });

  try {
    await withExecutionRoot(async (fixture) => {
      const models = await configureModels(fixture, provider.baseUrl, modelId);
      let host = await fixture.startHost();
      let hostRunning = true;
      let clientA: RuntimeHostConnection | undefined;
      let clientB: RuntimeHostConnection | undefined;
      try {
        clientA = await connectClient(fixture.root, 'desktop');
        clientB = await connectClient(fixture.root, 'tui');
        const sessionId = randomUUID();
        const createInput: SessionManagementCreateInput = {
          sessionId,
          cwd: fixture.root,
          modelTarget: { kind: 'default' },
          permissionMode: 'bypass',
        };
        const created = await clientA.request('session.create', createInput);
        assert.equal(created.model, models.firstModelId);

        const archived = await clientA.request('session.mutate', {
          kind: 'archive',
          sessionId,
        });
        assert.equal(archived.kind, 'session');
        if (archived.kind !== 'session') assert.fail('Archive did not return a Session');
        assert.equal(archived.session.isArchived, true);

        const rejectedTurnId = randomUUID();
        await assert.rejects(
          () =>
            clientB!.startTurn({
              sessionId,
              turnId: rejectedTurnId,
              content: { text: 'This must not admit a Turn or Runtime Resource.' },
            }),
          isOperationError('session_archived'),
        );
        await assert.rejects(
          () => clientA!.request('turn.query', { sessionId, turnId: rejectedTurnId }),
          isOperationError('not_found'),
        );
        assert.equal(provider.requests.length, 0);

        await Promise.all([clientA.close(), clientB.close()]);
        clientA = undefined;
        clientB = undefined;
        await fixture.stopHost(host);
        hostRunning = false;

        host = await fixture.startHost();
        hostRunning = true;
        clientA = await connectClient(fixture.root, 'desktop');
        clientB = await connectClient(fixture.root, 'tui');
        const recovered = await clientA.request('session.query', { kind: 'get', sessionId });
        assert.equal(recovered.kind, 'item');
        assert.equal(recovered.session.isArchived, true);

        const unarchived = await clientB.request('session.mutate', {
          kind: 'unarchive',
          sessionId,
        });
        assert.equal(unarchived.kind, 'session');
        if (unarchived.kind !== 'session') assert.fail('Unarchive did not return a Session');
        assert.equal(unarchived.session.isArchived, false);

        const admittedTurnId = randomUUID();
        const started = await clientA.startTurn({
          sessionId,
          turnId: admittedTurnId,
          content: { text: 'Admit the scripted background Runtime Resource.' },
        });
        await waitForProviderRequestCount(provider, 2);
        const terminal = await waitForTerminalTurn(clientB, sessionId, admittedTurnId);
        assert.equal(terminal.runId, started.runId);
        assert.equal(terminal.status, 'completed');
        assert.equal(provider.requests[0]?.body.model, modelId);
        assert.equal(provider.handlerErrors.length, 0);

        const subscription = await clientB.openSessionSubscription({ sessionId });
        const iterator = subscription[Symbol.asyncIterator]();
        const removed = await clientA.request('session.mutate', {
          kind: 'remove',
          sessionId,
        });
        assert.deepEqual(removed, { kind: 'removed', sessionId });

        const terminalFrame = await withTimeout(
          iterator.next(),
          PROCESS_TIMEOUT_MS,
          'Session removal did not retire the UDS subscription',
        );
        assert.equal(terminalFrame.done, false);
        assert.equal(terminalFrame.value.kind, 'subscription.closed');
        if (terminalFrame.value.kind !== 'subscription.closed') {
          assert.fail('Session removal did not publish a terminal subscription frame');
        }
        assert.equal(terminalFrame.value.reason, 'session_removed');
        await assert.rejects(
          () => clientA!.request('session.create', createInput),
          (error) => {
            assert.ok(error instanceof RuntimeHostOperationError);
            assert.equal(error.operation, 'session.create');
            assert.equal(error.code, 'operation_conflict');
            return true;
          },
        );
        await assert.rejects(
          () => clientB!.request('session.query', { kind: 'get', sessionId }),
          isOperationError('not_found'),
        );
      } finally {
        await Promise.allSettled([clientA?.close(), clientB?.close()]);
        if (hostRunning) await fixture.stopHost(host);
      }
    });
  } finally {
    await provider.close();
  }
});

async function configureModels(
  fixture: ExecutionFixture,
  baseUrl: string,
  firstModelId = `session-management-first-${randomUUID()}`,
): Promise<{
  connectionId: string;
  connectionSlug: string;
  firstModelId: string;
  secondModelId: string;
}> {
  const connectionSlug = `session-management-${randomUUID()}`;
  const secondModelId = `session-management-second-${randomUUID()}`;
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the Interactive root for model setup');
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: connectionSlug,
        name: 'Session management UDS provider',
        providerType: 'openai',
        baseUrl,
        enabled: true,
        enabledModelIds: [firstModelId, secondModelId],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') throw new Error('Provider connection was not committed');
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) throw new Error('Provider connection is missing');

    const credential = await stores.credentialVault.set({
      locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
      expected: null,
      secret: `session-management-key-${randomUUID()}`,
    });
    assert.equal(credential.kind, 'committed');
    const fetch = await stores.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') throw new Error('Provider model fetch was not ready');
    const fetched = await stores.operations.completeModelFetch(fetch.ticket, {
      models: [firstModelId, secondModelId].map((id) => ({
        id,
        apiProtocol: 'openai-chat' as const,
        capabilities: { chat: true, functionCalling: true },
      })),
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    assert.equal(fetched.kind, 'committed');

    const catalog = await stores.connectionCatalog.getSnapshot();
    const defaulted = await stores.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: catalog.revision,
      target: { connectionId: connection.connectionId, modelId: firstModelId },
    });
    assert.equal(defaulted.kind, 'committed');
    return {
      connectionId: connection.connectionId,
      connectionSlug,
      firstModelId,
      secondModelId,
    };
  } finally {
    await owner.close();
  }
}

async function waitForProviderRequestCount(
  provider: ScriptedOpenAiProvider,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (provider.requests.length < expected) {
    if (Date.now() >= deadline) throw new Error('Scripted provider request count did not converge');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isOperationError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RuntimeHostOperationError && error.code === code;
}

function paginationLabels(sessionIndex: number): string[] {
  return Array.from({ length: SESSION_MANAGEMENT_LABEL_MAX_ITEMS }, (_, labelIndex) => {
    const prefix = `page-${sessionIndex}-${labelIndex}-`;
    const label = prefix.padEnd(SESSION_MANAGEMENT_LABEL_MAX_BYTES, 'x');
    assert.equal(Buffer.byteLength(label, 'utf8'), SESSION_MANAGEMENT_LABEL_MAX_BYTES);
    return label;
  });
}

function operationContext() {
  return {
    hostEpoch: 'epoch-session-lifecycle',
    connectionId: 'session-lifecycle-test',
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
