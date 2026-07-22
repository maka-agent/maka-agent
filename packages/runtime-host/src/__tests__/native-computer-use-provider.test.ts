import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CuBackendError, type CuBackendInvocationContext, type CuRunContext } from '@maka/runtime';
import type { NativeProviderResultPayload, NativeProviderSubcall } from '../protocol/index.js';
import { createHostNativeComputerUseInvocationProvider } from '../server/native-computer-use-provider.js';
import type {
  HostNativeProviderService,
  HostNativeProviderSubcallOutcome,
  NativeProviderAttachmentData,
} from '../server/native-provider-coordinator.js';

const BASE_CONTEXT: CuBackendInvocationContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  operationId: 'operation-1',
};

test('adapts all six backend methods through one frozen Host invocation', async () => {
  const image = attachment('image-1', Buffer.from('trusted screenshot bytes'));
  const observation = providerObservation(image);
  const recorder = recorderService([
    success({ kind: 'preflight', accessibility: true, screenRecording: false }),
    success({
      kind: 'listApps',
      apps: [
        {
          appId: 'com.example.editor',
          pid: 41,
          name: 'Editor',
          windowCount: 1,
          windows: [{ windowId: 7, title: 'Draft' }],
        },
      ],
    }),
    success({ kind: 'observeApp', observation }, [image]),
    success(
      {
        kind: 'runSemantic',
        result: {
          outcome: {
            ok: true,
            tier: 'ax',
            verified: true,
            effect: 'confirmed',
          },
          observation,
        },
      },
      [image],
    ),
    success({ kind: 'captureObservation', observation }, [image]),
    success(
      {
        kind: 'run',
        result: {
          outcome: {
            ok: true,
            tier: 'coordinate-background',
            completedSubSteps: 2,
          },
          resolvedScreenPoint: { x: 21, y: 34 },
          screenshot: observation.screenshot,
        },
      },
      [image],
    ),
  ]);
  const provider = createHostNativeComputerUseInvocationProvider(recorder.service);
  const signal = new AbortController().signal;

  const acquired = await provider.acquire(
    { context: BASE_CONTEXT, affinity: 'provider-generation-7' },
    signal,
  );
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  assert.equal(acquired.invocation.affinity, 'provider-generation-8');

  const boundContext: CuRunContext = {
    ...BASE_CONTEXT,
    backendObservationId: 'backend-observation-1',
    boundAction: {
      frameId: 'runtime-frame-1',
      epoch: 3,
      actionFingerprint: 'private-action-fingerprint',
      fingerprint: 'private-bound-fingerprint',
      target: {
        pid: 41,
        windowId: 7,
        bundleId: 'com.example.editor',
        title: 'Draft',
        page: {
          cdpPort: 9222,
          pageTargetId: 'private-page-target',
          pageUrl: 'https://secret.example/path',
          targetUrlContains: 'secret.example',
        },
      },
      elementId: 'element-4',
      sourceCoordinate: { x: 10, y: 11 },
      windowCoordinate: { x: 12, y: 13 },
      coordinateSpace: 'window-screenshot-local',
    },
  };
  const backend = acquired.invocation.backend;
  assert.deepEqual(await backend.preflight(signal), {
    accessibility: true,
    screenRecording: false,
  });
  assert.deepEqual(await backend.listApps?.(signal), [
    {
      appId: 'com.example.editor',
      pid: 41,
      name: 'Editor',
      windowCount: 1,
      windows: [{ windowId: 7, title: 'Draft' }],
    },
  ]);
  const observed = await backend.observeApp?.(
    { app: 'Editor', includeScreenshot: true },
    signal,
    boundContext,
  );
  assert.equal(observed?.screenshot?.base64, image.bytes.toString('base64'));
  assert.equal(observed?.elements[0]?.identity?.role, 'button');

  const semantic = await backend.runSemantic?.(
    {
      type: 'set_value',
      observationId: 'backend-observation-1',
      elementId: 'element-4',
      value: 'hello',
      elementIdentity: { role: 'button', label: 'Save' },
    },
    signal,
    boundContext,
  );
  assert.deepEqual(semantic?.outcome, {
    ok: true,
    tier: 'ax',
    verified: true,
    evidence: { effect: 'confirmed' },
  });
  assert.equal(semantic?.observation?.screenshot?.base64, image.bytes.toString('base64'));

  const captured = await backend.captureObservation?.(
    { windowId: 7, includeScreenshot: true },
    signal,
    boundContext,
  );
  assert.equal(captured?.observationId, 'provider-observation-1');
  const run = await backend.run(
    { type: 'left_click', coordinate: { x: 10, y: 11 }, text: 'Save' },
    signal,
    boundContext,
  );
  assert.deepEqual(run.outcome, {
    ok: true,
    tier: 'coordinate-background',
    completedSubSteps: 2,
  });
  assert.deepEqual(run.resolvedScreenPoint, { x: 21, y: 34 });
  assert.equal(run.screenshot?.base64, image.bytes.toString('base64'));

  assert.deepEqual(recorder.acquireInputs, [
    {
      operationId: 'operation-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      capability: 'computer_use',
      affinity: 'provider-generation-7',
    },
  ]);
  assert.equal(recorder.calls.length, 6);
  assert.deepEqual(
    recorder.calls.map((call) => call.subcall.kind),
    ['preflight', 'listApps', 'observeApp', 'runSemantic', 'captureObservation', 'run'],
  );
  assert.deepEqual(recorder.calls[0]?.subcall, {
    kind: 'preflight',
    context: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
    },
  });
  assert.deepEqual(recorder.calls[2]?.subcall, {
    kind: 'observeApp',
    input: { app: 'Editor', includeScreenshot: true },
    context: providerContext(),
  });
  assert.deepEqual(recorder.calls[3]?.subcall, {
    kind: 'runSemantic',
    action: {
      type: 'set_value',
      observationId: 'backend-observation-1',
      elementId: 'element-4',
      value: 'hello',
      elementIdentity: { role: 'button', label: 'Save' },
    },
    context: providerContext(),
  });
  assert.deepEqual(recorder.calls[4]?.subcall, {
    kind: 'captureObservation',
    input: { windowId: 7, includeScreenshot: true },
    context: providerContext(),
  });
  assert.deepEqual(recorder.calls[5]?.subcall, {
    kind: 'run',
    action: { type: 'left_click', coordinate: { x: 10, y: 11 }, text: 'Save' },
    context: providerContext(),
  });
  assert.equal(JSON.stringify(recorder.calls).includes('operation-1'), false);
  assert.equal(JSON.stringify(recorder.calls).includes('private-action-fingerprint'), false);
  assert.equal(JSON.stringify(recorder.calls).includes('private-bound-fingerprint'), false);
  assert.equal(JSON.stringify(recorder.calls).includes('secret.example'), false);

  acquired.invocation.release();
  assert.equal(recorder.releaseCount, 1);
});

test('maps acquisition, shared backend errors, and run outcomes without remote messages', async () => {
  for (const [coordinatorCode, expected] of [
    ['capability_unavailable', 'service_unavailable'],
    ['capability_ambiguous', 'service_unavailable'],
    ['service_mismatch', 'service_mismatch'],
  ] as const) {
    const recorder = recorderService([], {
      error: coordinatorCode,
      message: 'provider secret',
    });
    const acquired = await createHostNativeComputerUseInvocationProvider(recorder.service).acquire(
      { context: BASE_CONTEXT, affinity: 'old-provider' },
      new AbortController().signal,
    );
    assert.equal(acquired.ok, false);
    if (!acquired.ok) {
      assert.equal(acquired.error, expected);
      assert.equal(acquired.message.includes('provider secret'), false);
    }
  }

  const recorder = recorderService([
    failure('outcome_unknown', 'raw uncertain detail'),
    failure('capability_lost', 'raw disconnect detail'),
    failure('operation_failed', 'raw operation detail'),
    failure('operation_failed', 'raw provider processing detail'),
    failure('capability_lost', 'raw non-run disconnect detail'),
  ]);
  const acquired = await createHostNativeComputerUseInvocationProvider(recorder.service).acquire(
    { context: BASE_CONTEXT },
    new AbortController().signal,
  );
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;

  const unknown = await acquired.invocation.backend.run(
    { type: 'wait', durationMs: 1 },
    new AbortController().signal,
    BASE_CONTEXT,
  );
  assert.deepEqual(unknown.outcome, {
    ok: false,
    error: 'outcome_unknown',
    message: 'The Computer Use action outcome is unknown; re-observe before retrying',
  });

  const lost = await acquired.invocation.backend.run(
    { type: 'wait', durationMs: 1 },
    new AbortController().signal,
    BASE_CONTEXT,
  );
  assert.equal(lost.outcome.ok, false);
  if (!lost.outcome.ok) {
    assert.equal(lost.outcome.error, 'service_unavailable');
    assert.equal(lost.outcome.message.includes('raw disconnect detail'), false);
  }

  const aborted = new AbortController();
  aborted.abort();
  const failed = await acquired.invocation.backend.run(
    { type: 'wait', durationMs: 1 },
    aborted.signal,
    BASE_CONTEXT,
  );
  assert.equal(failed.outcome.ok, false);
  if (!failed.outcome.ok) {
    assert.equal(failed.outcome.error, 'aborted');
    assert.equal(failed.outcome.message.includes('raw operation detail'), false);
  }

  const operationFailed = await acquired.invocation.backend.run(
    { type: 'wait', durationMs: 1 },
    new AbortController().signal,
    BASE_CONTEXT,
  );
  assert.equal(operationFailed.outcome.ok, false);
  if (!operationFailed.outcome.ok) {
    assert.equal(operationFailed.outcome.error, 'service_unavailable');
    assert.equal(operationFailed.outcome.message.includes('raw provider processing detail'), false);
  }

  await assert.rejects(
    () =>
      acquired.invocation.backend.observeApp!(
        { app: 'Editor', includeScreenshot: true },
        new AbortController().signal,
        BASE_CONTEXT,
      ),
    (error: unknown) =>
      error instanceof CuBackendError &&
      error.code === 'service_unavailable' &&
      error.message === 'The native Computer Use provider is unavailable',
  );
});

function providerContext() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    backendObservationId: 'backend-observation-1',
    boundAction: {
      frameId: 'runtime-frame-1',
      epoch: 3,
      target: {
        pid: 41,
        windowId: 7,
        bundleId: 'com.example.editor',
        title: 'Draft',
      },
      elementId: 'element-4',
      sourceCoordinate: { x: 10, y: 11 },
      windowCoordinate: { x: 12, y: 13 },
      coordinateSpace: 'window-screenshot-local',
    },
  };
}

function providerObservation(image: NativeProviderAttachmentData) {
  return {
    observationId: 'provider-observation-1',
    appId: 'com.example.editor',
    pid: 41,
    windowId: 7,
    windowTitle: 'Draft',
    capturedAt: 1234,
    sourceBoundsPx: { x: 0, y: 0, width: 800, height: 600 },
    displays: [
      {
        displayId: 'display-1',
        logicalBounds: { x: 0, y: 0, width: 400, height: 300 },
        sourceBoundsPx: { x: 0, y: 0, width: 800, height: 600 },
        scaleFactor: 2,
      },
    ],
    elements: [
      {
        elementId: 'element-4',
        role: 'button',
        label: 'Save',
        frame: { x: 1, y: 2, width: 30, height: 20 },
        identity: { role: 'button', label: 'Save' },
      },
    ],
    screenshot: {
      image: {
        attachmentId: image.attachmentId,
        mimeType: 'image/png' as const,
        byteLength: image.byteLength,
        sha256: image.sha256,
      },
      widthPx: 800,
      heightPx: 600,
    },
  };
}

function attachment(attachmentId: string, bytes: Buffer): NativeProviderAttachmentData {
  return {
    attachmentId,
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function success(
  result: NativeProviderResultPayload,
  attachments: readonly NativeProviderAttachmentData[] = [],
): HostNativeProviderSubcallOutcome {
  return { ok: true, result, attachments };
}

function failure(code: string, message: string): HostNativeProviderSubcallOutcome {
  return {
    ok: false,
    error: { code, message },
  } as HostNativeProviderSubcallOutcome;
}

function recorderService(
  outcomes: HostNativeProviderSubcallOutcome[],
  acquisitionFailure?: { error: string; message: string },
) {
  const calls: Array<{ subcall: NativeProviderSubcall; signal: AbortSignal }> = [];
  const acquireInputs: unknown[] = [];
  let releaseCount = 0;
  const service = {
    acquireInvocation(input: unknown) {
      acquireInputs.push(input);
      if (acquisitionFailure) return { ok: false, ...acquisitionFailure };
      const invocation = Object.freeze({
        affinity: 'provider-generation-8',
        async call(input: { subcall: NativeProviderSubcall; signal: AbortSignal }) {
          calls.push(input);
          const outcome = outcomes.shift();
          if (!outcome) throw new Error('Unexpected recorder call');
          return outcome;
        },
        release() {
          releaseCount += 1;
        },
      });
      return {
        ok: true,
        invocation,
      };
    },
  } as unknown as HostNativeProviderService;
  return {
    service,
    calls,
    acquireInputs,
    get releaseCount() {
      return releaseCount;
    },
  };
}
