import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { CuObservation, CuRunContext } from '@maka/runtime';
import { createNativeCapabilityProvider, type NativeCapabilityProvider } from '../client/index.js';
import type { ClientNativeProviderAttachment } from '../client/native-provider.js';
import {
  createComputerUseNativeCapability,
  type ComputerUseNativeProviderBackend,
} from '../native-provider/computer-use.js';
import {
  decodeNativeProviderClientFrame,
  NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES,
  type NativeProviderChunkFrame,
  type NativeProviderClientFrame,
  type NativeProviderComputerUseSubcall,
  type NativeProviderComputerUseSubcallFrame,
} from '../protocol/index.js';

test('streams one canonical screenshot in ordered 32KiB chunks with complete identity and hash', async () => {
  const observationBytes = Buffer.alloc(2 * NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES + 19, 0x5a);
  const topBytes = Buffer.from('non-canonical-top-level-screenshot');
  const backend = completeBackend({
    async run() {
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        screenshot: screenshot(topBytes),
        observation: observation('observation-canonical', screenshot(observationBytes)),
      };
    },
  });
  const frames: NativeProviderClientFrame[] = [];
  const attachment = await directAttachment(backendProvider(backend), 'epoch-chunks', frames);
  const frame = subcallFrame('epoch-chunks', 'operation-chunks', 1, {
    kind: 'run',
    action: { type: 'screenshot' },
    context: context(),
  });
  attachment.acceptSubcall(frame);
  const result = await waitForResult(frames, frame.subcallId);
  assert.equal(result.ok, true);
  if (!result.ok || result.result.kind !== 'run') return;

  const chunks = frames.filter((item) => item.kind === 'native.provider.chunk');
  assert.deepEqual(
    chunks.map((chunk) => chunk.index),
    [0, 1, 2],
  );
  assert.ok(
    chunks.every(
      (chunk) =>
        chunk.operationId === frame.operationId &&
        chunk.subcallId === frame.subcallId &&
        chunk.ordinal === 1 &&
        chunk.bindingId === frame.bindingId,
    ),
  );
  assert.deepEqual(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))),
    observationBytes,
  );
  assert.equal(result.result.result.screenshot, undefined);
  const ref = result.result.result.observation?.screenshot?.image;
  assert.equal(ref?.byteLength, observationBytes.byteLength);
  assert.equal(ref?.sha256, createHash('sha256').update(observationBytes).digest('hex'));
  assert.equal(ref?.attachmentId, chunks[0]?.attachmentId);

  attachment.acceptRelease(releaseFrame('epoch-chunks', frame.operationId, frame.bindingId));
  attachment.sealAdmission();
  await attachment.drained;
});

test('keeps raw observation state local, restores page and element token, and maps all backend methods', async () => {
  const seen: string[] = [];
  const semanticCalls: Array<{
    action: Parameters<ComputerUseNativeProviderBackend['runSemantic']>[0];
    context: CuRunContext;
  }> = [];
  const rawObservationId = `token=sk-raw-observation-secret-${'o'.repeat(180)}`;
  const rawElementId = `token=sk-raw-element-secret-${'e'.repeat(180)}`;
  const rawObservation = observation(rawObservationId);
  rawObservation.elements[0]!.elementId = rawElementId;
  rawObservation.page = {
    cdpPort: 9222,
    pageTargetId: 'raw-target',
    pageUrl: 'https://user:secret@example.test/?token=sk-secretsecret',
    targetUrlContains: 'example.test',
  };
  rawObservation.elements[0]!.identity = {
    token: 'raw-element-token',
    role: 'button',
    label: 'token=sk-secretsecret',
  };
  const backend: ComputerUseNativeProviderBackend = {
    clearSession() {},
    async preflight() {
      seen.push('preflight');
      return { accessibility: true, screenRecording: true };
    },
    async listApps() {
      seen.push('listApps');
      return Array.from({ length: 140 }, (_, appIndex) => ({
        appId: `app-${appIndex}-${'x'.repeat(600)}`,
        pid: appIndex + 1,
        name: `token=sk-secretsecret-${'n'.repeat(600)}`,
        windowCount: 80,
        windows: Array.from({ length: 10 }, (_, windowIndex) => ({
          windowId: windowIndex + 1,
          title: 'w'.repeat(2_000),
        })),
      }));
    },
    async observeApp() {
      seen.push('observeApp');
      return rawObservation;
    },
    async captureObservation() {
      seen.push('captureObservation');
      return observation('capture-observation', screenshot(Buffer.from('capture')));
    },
    async runSemantic(action, _signal, runContext) {
      seen.push('runSemantic');
      semanticCalls.push({ action, context: runContext });
      return {
        outcome: {
          ok: true,
          tier: 'ax',
          verified: true,
          evidence: {
            effect: 'confirmed',
            path: '/private/path',
            reason: 'secret',
          },
        },
      };
    },
    async run() {
      seen.push('run');
      return {
        outcome: {
          ok: false,
          error: 'target_missing',
          message: 'raw backend message',
          evidence: { path: '/private/path', reason: 'secret' },
        },
      };
    },
  };
  const frames: NativeProviderClientFrame[] = [];
  const attachment = await directAttachment(backendProvider(backend), 'epoch-adapter', frames);
  let ordinal = 1;
  const invoke = async (subcall: NativeProviderComputerUseSubcall) => {
    const frame = subcallFrame('epoch-adapter', 'operation-adapter', ordinal++, subcall);
    attachment.acceptSubcall(frame);
    return waitForResult(frames, frame.subcallId);
  };

  await invoke({ kind: 'preflight', context: context() });
  const listed = await invoke({ kind: 'listApps', context: context() });
  assert.ok(Buffer.byteLength(JSON.stringify(listed), 'utf8') < 60 * 1024);
  assert.doesNotMatch(JSON.stringify(listed), /secretsecret/);
  const observed = await invoke({
    kind: 'observeApp',
    input: { app: 'app', includeScreenshot: false },
    context: context(),
  });
  const observedJson = JSON.stringify(observed);
  assert.doesNotMatch(
    observedJson,
    /cdpPort|pageTargetId|raw-element-token|raw-observation-secret|raw-element-secret|secretsecret|\/private\/path|raw backend message/,
  );
  if (!observed.ok || observed.result.kind !== 'observeApp') {
    assert.fail('observeApp did not return an observation');
  }
  const wireObservationId = observed.result.observation.observationId;
  const wireElementId = observed.result.observation.elements[0]?.elementId;
  assert.ok(wireElementId);
  assert.notEqual(wireObservationId, rawObservationId);
  assert.notEqual(wireElementId, rawElementId);
  assert.match(wireObservationId, /^[0-9a-f-]{36}$/);
  assert.match(wireElementId, /^[0-9a-f-]{36}$/);
  await invoke({
    kind: 'runSemantic',
    action: {
      type: 'set_value',
      observationId: wireObservationId,
      elementId: wireElementId,
      value: 'new value',
      elementIdentity: { role: 'button' },
    },
    context: {
      ...context(),
      backendObservationId: wireObservationId,
      boundAction: {
        frameId: 'frame-1',
        epoch: 1,
        target: { pid: 1, windowId: 1 },
        elementId: wireElementId,
      },
    },
  });
  await invoke({
    kind: 'runSemantic',
    action: {
      type: 'press_key',
      observationId: wireObservationId,
      key: 'Enter',
    },
    context: { ...context(), backendObservationId: wireObservationId },
  });
  await invoke({
    kind: 'captureObservation',
    input: { app: 'app', includeScreenshot: true },
    context: context(),
  });
  const run = await invoke({
    kind: 'run',
    action: { type: 'wait', durationMs: 0 },
    context: context(),
  });
  assert.doesNotMatch(JSON.stringify(run), /raw backend message|\/private\/path|"reason"/);

  assert.equal(semanticCalls[0]?.action.observationId, rawObservationId);
  assert.ok(semanticCalls[0]?.action.type === 'set_value');
  if (semanticCalls[0]?.action.type === 'set_value') {
    assert.equal(semanticCalls[0].action.elementId, rawElementId);
    assert.equal(semanticCalls[0].action.elementIdentity?.token, 'raw-element-token');
  }
  assert.equal(semanticCalls[0]?.context.operationId, 'operation-adapter');
  assert.equal(semanticCalls[0]?.context.backendObservationId, rawObservationId);
  assert.equal(semanticCalls[0]?.context.boundAction?.elementId, rawElementId);
  assert.equal(semanticCalls[0]?.context.boundAction?.target.page?.pageTargetId, 'raw-target');
  assert.equal(semanticCalls[1]?.action.type, 'press_key');
  assert.equal(semanticCalls[1]?.action.observationId, rawObservationId);
  assert.deepEqual(seen, [
    'preflight',
    'listApps',
    'observeApp',
    'runSemantic',
    'runSemantic',
    'captureObservation',
    'run',
  ]);

  for (let index = 0; index < 15; index += 1) {
    await invoke({
      kind: 'observeApp',
      input: { app: 'app', includeScreenshot: false },
      context: context(),
    });
  }
  const evicted = await invoke({
    kind: 'runSemantic',
    action: {
      type: 'press_key',
      observationId: wireObservationId,
      key: 'Enter',
    },
    context: { ...context(), backendObservationId: wireObservationId },
  });
  assert.equal(evicted.ok, false);
  assert.equal(semanticCalls.length, 2);

  attachment.acceptRelease(
    releaseFrame('epoch-adapter', 'operation-adapter', 'binding-operation-adapter'),
  );
  attachment.sealAdmission();
  await attachment.drained;
});

test('Turn release invalidates S1 opaque handles without clearing S2 provider state', async () => {
  const cleared: string[] = [];
  const semanticSessions: string[] = [];
  const backend = completeBackend({
    clearSession(sessionId) {
      cleared.push(sessionId);
    },
    async observeApp(_input, _signal, runContext) {
      return observation(`raw-${runContext.sessionId}`);
    },
    async runSemantic(_action, _signal, runContext) {
      semanticSessions.push(runContext.sessionId);
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  });
  const frames: NativeProviderClientFrame[] = [];
  const attachment = await directAttachment(backendProvider(backend), 'epoch-sessions', frames);
  const observe = async (sessionId: string, operationId: string) => {
    const frame = subcallFrame('epoch-sessions', operationId, 1, {
      kind: 'observeApp',
      input: { app: 'app', includeScreenshot: false },
      context: { ...context(), sessionId },
    });
    attachment.acceptSubcall(frame);
    const result = await waitForResult(frames, frame.subcallId);
    assert.ok(result.ok && result.result.kind === 'observeApp');
    if (!result.ok || result.result.kind !== 'observeApp') throw new Error('observe failed');
    attachment.acceptRelease(releaseFrame(frame.hostEpoch, frame.operationId, frame.bindingId));
    return result.result.observation.observationId;
  };
  const s1Observation = await observe('session-1', 'operation-s1-observe');
  const s2Observation = await observe('session-2', 'operation-s2-observe');

  attachment.acceptTurnRelease({
    kind: 'native.provider.turn_release',
    hostEpoch: 'epoch-sessions',
    registrationId: 'registration-epoch-sessions',
    releaseId: 'release-s1',
    sessionId: 'session-1',
    turnId: 'turn-1',
  });
  await waitForTurnReleased(frames, 'release-s1');
  assert.deepEqual(cleared, ['session-1']);

  const runSemantic = async (
    sessionId: string,
    turnId: string,
    operationId: string,
    observationId: string,
  ) => {
    const frame = subcallFrame('epoch-sessions', operationId, 1, {
      kind: 'runSemantic',
      action: { type: 'press_key', observationId, key: 'Enter' },
      context: {
        ...context(),
        sessionId,
        turnId,
        toolCallId: `tool-call-${operationId}`,
        backendObservationId: observationId,
      },
    });
    attachment.acceptSubcall(frame);
    const result = await waitForResult(frames, frame.subcallId);
    attachment.acceptRelease(releaseFrame(frame.hostEpoch, frame.operationId, frame.bindingId));
    return result;
  };
  assert.equal(
    (await runSemantic('session-1', 'turn-2', 'operation-s1-old', s1Observation)).ok,
    false,
  );
  assert.equal(
    (await runSemantic('session-2', 'turn-1', 'operation-s2-live', s2Observation)).ok,
    true,
  );
  assert.deepEqual(semanticSessions, ['session-2']);

  attachment.detach();
  await attachment.drained;
});

test('keeps a top-level run screenshot when its observation has no screenshot', async () => {
  const imageBytes = Buffer.from('run top-level screenshot');
  const backend = completeBackend({
    async run() {
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation('run-observation-without-screenshot'),
        screenshot: screenshot(imageBytes),
      };
    },
  });
  const frames: NativeProviderClientFrame[] = [];
  const attachment = await directAttachment(
    backendProvider(backend),
    'epoch-run-top-level',
    frames,
  );
  const frame = subcallFrame('epoch-run-top-level', 'operation-run-top-level', 1, {
    kind: 'run',
    action: { type: 'screenshot' },
    context: context(),
  });

  attachment.acceptSubcall(frame);
  const result = await waitForResult(frames, frame.subcallId);
  assert.equal(result.ok, true);
  if (result.ok && result.result.kind === 'run') {
    assert.equal(result.result.result.observation?.screenshot, undefined);
    assertWireScreenshot(result.result.result.screenshot?.image, frames, imageBytes);
  }
  attachment.acceptRelease(releaseFrame(frame.hostEpoch, frame.operationId, frame.bindingId));
  attachment.sealAdmission();
  await attachment.drained;
});

test('keeps a top-level runSemantic screenshot when its observation has no screenshot', async () => {
  const imageBytes = Buffer.from('semantic top-level screenshot');
  const backend = completeBackend({
    async observeApp() {
      return observation('raw-semantic-observation');
    },
    async runSemantic() {
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation('semantic-observation-without-screenshot'),
        screenshot: screenshot(imageBytes),
      };
    },
  });
  const frames: NativeProviderClientFrame[] = [];
  const attachment = await directAttachment(
    backendProvider(backend),
    'epoch-semantic-top-level',
    frames,
  );
  const observeFrame = subcallFrame('epoch-semantic-top-level', 'operation-semantic', 1, {
    kind: 'observeApp',
    input: { app: 'app', includeScreenshot: false },
    context: context(),
  });
  attachment.acceptSubcall(observeFrame);
  const observed = await waitForResult(frames, observeFrame.subcallId);
  assert.equal(observed.ok, true);
  if (!observed.ok || observed.result.kind !== 'observeApp') return;
  const observationId = observed.result.observation.observationId;
  const semanticFrame = subcallFrame('epoch-semantic-top-level', 'operation-semantic', 2, {
    kind: 'runSemantic',
    action: { type: 'press_key', observationId, key: 'Enter' },
    context: { ...context(), backendObservationId: observationId },
  });

  attachment.acceptSubcall(semanticFrame);
  const result = await waitForResult(frames, semanticFrame.subcallId);
  assert.equal(result.ok, true);
  if (result.ok && result.result.kind === 'runSemantic') {
    assert.equal(result.result.result.observation?.screenshot, undefined);
    assertWireScreenshot(result.result.result.screenshot?.image, frames, imageBytes);
  }
  attachment.acceptRelease(
    releaseFrame(semanticFrame.hostEpoch, semanticFrame.operationId, semanticFrame.bindingId),
  );
  attachment.sealAdmission();
  await attachment.drained;
});

function backendProvider(backend: ComputerUseNativeProviderBackend): NativeCapabilityProvider {
  return createNativeCapabilityProvider([createComputerUseNativeCapability(backend)]);
}

function completeBackend(
  overrides: Partial<ComputerUseNativeProviderBackend>,
): ComputerUseNativeProviderBackend {
  return {
    clearSession() {},
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async listApps() {
      return [];
    },
    async observeApp() {
      return observation('default-observation');
    },
    async runSemantic() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
    async captureObservation() {
      return observation('default-capture');
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
    ...overrides,
  };
}

function assertWireScreenshot(
  ref: { attachmentId: string; byteLength: number; sha256: string } | undefined,
  frames: NativeProviderClientFrame[],
  expectedBytes: Buffer,
): void {
  assert.ok(ref);
  const chunks = frames.filter(
    (frame): frame is NativeProviderChunkFrame =>
      frame.kind === 'native.provider.chunk' && frame.attachmentId === ref.attachmentId,
  );
  assert.equal(ref.byteLength, expectedBytes.byteLength);
  assert.equal(ref.sha256, createHash('sha256').update(expectedBytes).digest('hex'));
  assert.deepEqual(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64'))),
    expectedBytes,
  );
}

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

function subcallFrame(
  hostEpoch: string,
  operationId: string,
  ordinal: number,
  subcall: NativeProviderComputerUseSubcall,
): NativeProviderComputerUseSubcallFrame {
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

function observation(observationId: string, image?: ReturnType<typeof screenshot>): CuObservation {
  return {
    observationId,
    appId: 'app',
    pid: 1,
    windowId: 1,
    elements: [{ elementId: 'element-1', role: 'button', identity: { role: 'button' } }],
    ...(image ? { screenshot: image } : {}),
  };
}

function screenshot(bytes: Buffer) {
  return {
    base64: bytes.toString('base64'),
    mimeType: 'image/png' as const,
    widthPx: 10,
    heightPx: 10,
  };
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

async function waitForTurnReleased(frames: NativeProviderClientFrame[], releaseId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const released = frames.find(
      (frame) => frame.kind === 'native.provider.turn_released' && frame.releaseId === releaseId,
    );
    if (released) return released;
    await immediate();
  }
  throw new Error(`Timed out waiting for Turn release ${releaseId}`);
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
