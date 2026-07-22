import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildComputerUseTools,
  type CuObservation,
  type CuRunContext,
  type CuSemanticAction,
  type MakaToolContext,
} from '@maka/runtime';
import { tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createNativeCapabilityProvider, type RuntimeHostConnection } from '../client/index.js';
import {
  createComputerUseNativeCapability,
  type ComputerUseNativeProviderBackend,
} from '../native-provider/computer-use.js';
import { createHostNativeComputerUseInvocationProvider } from '../server/native-computer-use-provider.js';
import { HostNativeProviderCoordinator } from '../server/native-provider-coordinator.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import {
  combineDomainOperationHandlers,
  createUnavailableDomainOperationHandlers,
} from '../server/operation-dispatcher.js';
import { connectClient, withExecutionRoot, withTimeout } from './support/execution-root-fixture.js';

const RAW_OBSERVATION_1 = 'backend-observation-access_token=raw-observation-secret';
const RAW_OBSERVATION_2 = 'backend-observation-refresh_token=second-observation-secret';
const RAW_OBSERVATION_3 = 'backend-observation-client_secret=final-observation-secret';
const RAW_ELEMENT_1 = `backend-element-sk-private-${'x'.repeat(700)}`;
const RAW_ELEMENT_2 = `backend-element-refresh-token-${'y'.repeat(700)}`;
const RAW_ELEMENT_3 = `backend-element-client-secret-${'z'.repeat(700)}`;
const RAW_TOKEN_1 = 'access_token=raw-element-token';
const RAW_TOKEN_2 = 'refresh_token=raw-second-element-token';
const RAW_TOKEN_3 = 'client_secret=raw-final-element-token';
const RAW_PAGE = {
  cdpPort: 49_281,
  pageTargetId: 'page-target-access_token=raw-page-target',
  pageUrl: 'https://private.example.test/editor?access_token=raw-page-url-token',
  targetUrlContains: 'private.example.test/editor?access_token=',
  documentFingerprint: 'raw-private-document-fingerprint',
} as const;

test('real UDS Native Provider keeps backend identities opaque and drains an accepted action', async () => {
  await withExecutionRoot(async (fixture) => {
    const blockedActionEntered = deferred();
    const releaseBlockedAction = deferred();
    const compositionDrainEntered = deferred();
    const observeContexts: CuRunContext[] = [];
    const captureContexts: CuRunContext[] = [];
    const semanticCalls: Array<{
      action: CuSemanticAction;
      context: CuRunContext;
    }> = [];
    let captureCount = 0;
    const backend: ComputerUseNativeProviderBackend = {
      clearSession() {},
      async preflight() {
        return { accessibility: true, screenRecording: true };
      },
      async listApps() {
        return [];
      },
      async observeApp(_input, _signal, context) {
        observeContexts.push(context);
        return observation(RAW_OBSERVATION_1, RAW_ELEMENT_1, RAW_TOKEN_1);
      },
      async runSemantic(action, _signal, context) {
        semanticCalls.push({ action, context });
        if (semanticCalls.length === 2) {
          blockedActionEntered.resolve();
          await releaseBlockedAction.promise;
        }
        return { outcome: { ok: true, tier: 'ax', verified: true } };
      },
      async captureObservation(_input, _signal, context) {
        captureContexts.push(context);
        captureCount += 1;
        return captureCount === 1
          ? observation(RAW_OBSERVATION_2, RAW_ELEMENT_2, RAW_TOKEN_2)
          : observation(RAW_OBSERVATION_3, RAW_ELEMENT_3, RAW_TOKEN_3);
      },
      async run() {
        assert.fail('The acceptance slice must stay on the semantic action path');
      },
    };

    const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
    assert.ok(owner);
    let tools!: ReturnType<typeof buildComputerUseTools>;
    const host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      compositionFactory: async (context) => {
        const coordinator = new HostNativeProviderCoordinator(
          context.hostEpoch,
          context.acquireResidency,
        );
        tools = buildComputerUseTools({
          invocationProvider: createHostNativeComputerUseInvocationProvider(coordinator),
        });
        return {
          handlers: combineDomainOperationHandlers({
            ...createUnavailableDomainOperationHandlers(),
            ...coordinator.handlers,
          }),
          nativeProvider: coordinator,
          beginDrain: () => compositionDrainEntered.resolve(),
          recover: async () => undefined,
          close: async () => ({ kind: 'clean' }),
        };
      },
    });

    let client: RuntimeHostConnection | undefined;
    let blockedTool: Promise<unknown> | undefined;
    try {
      client = await connectClient(fixture.root, 'desktop');
      const registration = await client.registerNativeProvider(
        createNativeCapabilityProvider([createComputerUseNativeCapability(backend)]),
      );
      const [tool] = tools;
      assert.ok(tool);

      const observed = (await tool.impl(
        { action: 'observe', app: 'Fixture' } as never,
        toolContext(fixture.root, fixture.sessionId, 'observe-call', 'durable-observe'),
      )) as { text: string; modelText?: string };
      assert.equal((await client.status()).activeResidencies, 0);
      assertPrivateValuesAbsent(observed);
      assert.equal(observeContexts[0]?.operationId, 'durable-observe');
      const modelObservation = parseObservation(observed.modelText);
      assert.notEqual(modelObservation.observation_id, RAW_OBSERVATION_1);
      assert.notEqual(modelObservation.elements[0]?.element_id, RAW_ELEMENT_1);

      const firstAction = (await tool.impl(
        {
          action: 'click_element',
          observation_id: modelObservation.observation_id,
          element_id: requiredElementId(modelObservation),
        } as never,
        toolContext(fixture.root, fixture.sessionId, 'first-action-call', 'durable-action-1'),
      )) as { text: string; modelText?: string };
      assert.equal((await client.status()).activeResidencies, 0);
      assertPrivateValuesAbsent(firstAction);
      assert.equal(semanticCalls.length, 1);
      assertRestoredCall(semanticCalls[0], {
        operationId: 'durable-action-1',
        observationId: RAW_OBSERVATION_1,
        elementId: RAW_ELEMENT_1,
        token: RAW_TOKEN_1,
      });
      assert.equal(captureContexts[0]?.operationId, 'durable-action-1');

      const freshObservation = parseFreshObservation(firstAction.modelText);
      blockedTool = Promise.resolve(
        tool.impl(
          {
            action: 'click_element',
            observation_id: freshObservation.observation_id,
            element_id: requiredElementId(freshObservation),
          } as never,
          toolContext(fixture.root, fixture.sessionId, 'blocked-action-call', 'durable-action-2'),
        ),
      );
      await withTimeout(
        blockedActionEntered.promise,
        2_000,
        'accepted Native Provider action did not reach the backend gate',
      );
      assert.equal((await client.status()).activeResidencies, 1);
      assertRestoredCall(semanticCalls[1], {
        operationId: 'durable-action-2',
        observationId: RAW_OBSERVATION_2,
        elementId: RAW_ELEMENT_2,
        token: RAW_TOKEN_2,
      });
      assert.deepEqual(
        [
          observeContexts[0]?.operationId,
          ...semanticCalls.map(({ context }) => context.operationId),
        ],
        ['durable-observe', 'durable-action-1', 'durable-action-2'],
      );

      let hostClosed = false;
      let registrationDrained = false;
      let clientClosed = false;
      let toolSettled = false;
      const hostClose = host.close().then(() => {
        hostClosed = true;
      });
      void registration.drained.then(() => {
        registrationDrained = true;
      });
      void client.closed.then(() => {
        clientClosed = true;
      });
      void blockedTool.then(() => {
        toolSettled = true;
      });
      await compositionDrainEntered.promise;
      await Promise.resolve();

      assert.equal(host.state, 'draining');
      assert.equal(hostClosed, false);
      assert.equal(registrationDrained, false);
      assert.equal(clientClosed, false);
      assert.equal(toolSettled, false);
      assert.equal(await tryAcquireInteractiveRootOwner(fixture.capability), undefined);

      releaseBlockedAction.resolve();
      const [blockedResult] = await withTimeout(
        Promise.all([blockedTool, hostClose, registration.drained, client.closed]),
        3_000,
        'Native Provider action and Host shutdown did not converge',
      );
      assertPrivateValuesAbsent(blockedResult);
      assert.equal(hostClosed, true);
      assert.equal(registrationDrained, true);
      assert.equal(clientClosed, true);
      assert.equal(toolSettled, true);
      await assertPathMissing(host.endpoint);

      const successor = await tryAcquireInteractiveRootOwner(fixture.capability);
      assert.ok(successor);
      await successor.close();
      client = undefined;
      blockedTool = undefined;
    } finally {
      releaseBlockedAction.resolve();
      await blockedTool?.catch(() => undefined);
      await host.close().catch(() => undefined);
      await client?.close().catch(() => undefined);
    }
  });
});

function observation(observationId: string, elementId: string, token: string): CuObservation {
  return {
    observationId,
    appId: 'com.example.fixture',
    pid: 731,
    windowId: 19,
    windowTitle: 'Fixture editor',
    capturedAt: 1_700_000_000_000,
    windowBounds: { x: 10, y: 20, width: 900, height: 700 },
    sourceBoundsPx: { x: 0, y: 0, width: 900, height: 700 },
    page: RAW_PAGE,
    elements: [
      {
        elementId,
        role: 'button',
        label: 'Submit',
        frame: { x: 100, y: 120, width: 80, height: 30 },
        identity: { token, role: 'button', label: 'Submit' },
      },
    ],
  };
}

function toolContext(
  cwd: string,
  sessionId: string,
  toolCallId: string,
  operationId: string,
): MakaToolContext {
  return {
    cwd,
    sessionId,
    turnId: 'turn-native-provider-acceptance',
    toolCallId,
    operationId,
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}

interface ModelObservation {
  observation_id: string;
  elements: Array<{ element_id?: string }>;
}

function parseObservation(value: string | undefined): ModelObservation {
  assert.ok(value);
  return JSON.parse(value) as ModelObservation;
}

function parseFreshObservation(value: string | undefined): ModelObservation {
  assert.ok(value);
  const marker = 'Fresh observation:\n';
  const offset = value.indexOf(marker);
  assert.notEqual(offset, -1);
  return JSON.parse(value.slice(offset + marker.length)) as ModelObservation;
}

function requiredElementId(observation: ModelObservation): string {
  const elementId = observation.elements[0]?.element_id;
  assert.ok(elementId);
  return elementId;
}

function assertRestoredCall(
  call: { action: CuSemanticAction; context: CuRunContext } | undefined,
  expected: {
    operationId: string;
    observationId: string;
    elementId: string;
    token: string;
  },
): void {
  assert.ok(call);
  assert.equal(call.context.operationId, expected.operationId);
  assert.equal(call.context.backendObservationId, expected.observationId);
  assert.deepEqual(call.context.boundAction?.target.page, RAW_PAGE);
  assert.equal(call.action.observationId, expected.observationId);
  assert.ok('elementId' in call.action);
  assert.equal(call.action.elementId, expected.elementId);
  assert.equal(call.action.elementIdentity?.token, expected.token);
}

function assertPrivateValuesAbsent(value: unknown): void {
  const projection = JSON.stringify(value);
  for (const privateValue of [
    RAW_OBSERVATION_1,
    RAW_OBSERVATION_2,
    RAW_OBSERVATION_3,
    RAW_ELEMENT_1,
    RAW_ELEMENT_2,
    RAW_ELEMENT_3,
    RAW_TOKEN_1,
    RAW_TOKEN_2,
    RAW_TOKEN_3,
    RAW_PAGE.cdpPort,
    RAW_PAGE.pageTargetId,
    RAW_PAGE.pageUrl,
    RAW_PAGE.targetUrlContains,
    RAW_PAGE.documentFingerprint,
  ]) {
    assert.equal(projection.includes(String(privateValue)), false);
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
