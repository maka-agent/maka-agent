import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeNativeProviderClientFrame,
  decodeNativeProviderHostFrame,
  encodeProtocolFrame,
  HOST_OPERATION_SPECS,
  NATIVE_PROVIDER_BROWSER_MAX_ADDRESS_INPUT_CHARS,
  NATIVE_PROVIDER_BROWSER_MAX_EXTRACT_CHARS,
  NATIVE_PROVIDER_BROWSER_MAX_RESULT_JSON_BYTES,
  NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS,
  NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_ELEMENTS,
  NATIVE_PROVIDER_BROWSER_MAX_TYPE_TEXT_UTF8_BYTES,
  NATIVE_PROVIDER_BROWSER_MAX_URL_CHARS,
  NATIVE_PROVIDER_BROWSER_MAX_WAIT_TEXT_UTF8_BYTES,
  NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES,
  NATIVE_PROVIDER_MAX_APPS,
  NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES,
  NATIVE_PROVIDER_MAX_ATTACHMENTS_PER_RESULT,
  NATIVE_PROVIDER_MAX_DISPLAYS,
  NATIVE_PROVIDER_MAX_ELEMENTS,
  NATIVE_PROVIDER_MAX_INLINE_PAYLOAD_BYTES,
  NATIVE_PROVIDER_MAX_PENDING_INVOCATIONS,
  NATIVE_PROVIDER_MAX_RESULT_ATTACHMENT_BYTES,
  NATIVE_PROVIDER_MAX_SUBCALLS_PER_INVOCATION,
  NATIVE_PROVIDER_MAX_WINDOWS,
  NATIVE_PROVIDER_MAX_WINDOWS_PER_APP,
  NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_PASTE_PAYLOAD_UTF8_BYTES,
  NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_STATE_HINT_UTF8_BYTES,
  NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_URL_CHARS,
  RuntimeHostProtocolError,
  type BrowserSnapshotElement,
  type ClientFrame,
} from '../protocol/index.js';

const invocationIdentity = {
  hostEpoch: 'epoch-1',
  operationId: 'operation-1',
  bindingId: 'binding-1',
} as const;

const subcallIdentity = {
  ...invocationIdentity,
  subcallId: 'subcall-1',
  ordinal: 1,
} as const;

const context = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-call-1',
  backendObservationId: 'backend-observation-1',
  boundAction: {
    frameId: 'frame-1',
    epoch: 1,
    target: {
      pid: 42,
      windowId: 7,
      bundleId: 'dev.maka.app',
      appName: 'Maka',
      title: 'Workspace',
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      sourceBoundsPx: { x: 0, y: 0, width: 1600, height: 1200 },
      zIndex: 2,
      contentFingerprint: 'b'.repeat(64),
    },
    display: {
      displayId: 'display-1',
      logicalBounds: { x: 0, y: 0, width: 1440, height: 900 },
      sourceBoundsPx: { x: 0, y: 0, width: 2880, height: 1800 },
      scaleFactor: 2,
    },
    elementId: 'element-1',
    sourceCoordinate: { x: 200, y: 100 },
    windowCoordinate: { x: 100, y: 50 },
    coordinateSpace: 'window-screenshot-local' as const,
  },
} as const;

const attachment = {
  attachmentId: 'attachment-1',
  byteLength: 128,
  sha256: 'a'.repeat(64),
  mimeType: 'image/png' as const,
};

const screenshot = {
  image: attachment,
  widthPx: 800,
  heightPx: 600,
};

const observation = {
  observationId: 'observation-1',
  appId: 'dev.maka.app',
  pid: 42,
  windowId: 7,
  windowTitle: 'Workspace',
  capturedAt: 123,
  windowBounds: { x: 10, y: 20, width: 800, height: 600 },
  sourceBoundsPx: { x: 0, y: 0, width: 1600, height: 1200 },
  zIndex: 2,
  bundleId: 'dev.maka.app',
  contentFingerprint: 'b'.repeat(64),
  displays: [
    {
      displayId: 'display-1',
      logicalBounds: { x: 0, y: 0, width: 1440, height: 900 },
      sourceBoundsPx: { x: 0, y: 0, width: 2880, height: 1800 },
      scaleFactor: 2,
    },
  ],
  elements: [
    {
      elementId: 'element-1',
      role: 'button',
      label: 'Save',
      value: '',
      frame: { x: 20, y: 30, width: 80, height: 24 },
      identity: { role: 'button', label: 'Save', value: '' },
    },
  ],
} as const;

describe('Native Provider protocol', () => {
  test('keeps register and unregister as the only ordinary operations', () => {
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter((key) => key.startsWith('native.provider.')),
      ['native.provider.register', 'native.provider.unregister'],
    );
    assert.deepEqual(metadata('native.provider.register'), ['control', 'none', 'ready']);
    assert.deepEqual(metadata('native.provider.unregister'), ['control', 'none', 'ready']);

    const register = HOST_OPERATION_SPECS['native.provider.register'];
    const unregister = HOST_OPERATION_SPECS['native.provider.unregister'];
    assert.deepEqual(register.decodeInput({ capabilities: ['computer_use'] }), {
      capabilities: ['computer_use'],
    });
    assert.deepEqual(register.decodeOutput({ registrationId: 'registration-1' }), {
      registrationId: 'registration-1',
    });
    assert.deepEqual(unregister.decodeInput({ registrationId: 'registration-1' }), {
      registrationId: 'registration-1',
    });
    assert.deepEqual(unregister.decodeOutput({ registrationId: 'registration-1' }), {
      registrationId: 'registration-1',
    });
    assert.throws(
      () => register.decodeInput({ capabilities: ['computer_use'], legacy: true }),
      isInvalidFrame,
    );
  });

  test('decodes all six closed typed subcalls under one invocation identity', () => {
    const subcalls = [
      { kind: 'preflight', context },
      { kind: 'listApps', context },
      {
        kind: 'observeApp',
        input: { app: 'Maka', includeScreenshot: false },
        context,
      },
      {
        kind: 'runSemantic',
        action: {
          type: 'set_value',
          observationId: 'observation-1',
          elementId: 'element-1',
          value: 'done',
          elementIdentity: { role: 'text_field', label: 'Status', value: '' },
        },
        context,
      },
      {
        kind: 'captureObservation',
        input: { windowId: 7, includeScreenshot: true },
        context,
      },
      {
        kind: 'run',
        action: {
          type: 'scroll',
          coordinate: { x: 100, y: 200 },
          scrollDirection: 'down',
          scrollAmount: 3,
          text: 'results',
        },
        context,
      },
    ] as const;

    for (const [index, subcall] of subcalls.entries()) {
      const frame = subcallFrame(subcall, index + 1);
      assert.deepEqual(decodeHostFrame(frame), frame);
      const withoutContext = { ...subcall } as Record<string, unknown>;
      delete withoutContext.context;
      assert.throws(() => decodeHostFrame(subcallFrame(withoutContext, index + 1)), isInvalidFrame);
    }
  });

  test('requires invocation context and keeps backend observation affinity opaque', () => {
    const contextWithoutAffinity = {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
    };
    const preflight = subcallFrame({
      kind: 'preflight',
      context: contextWithoutAffinity,
    });
    assert.deepEqual(decodeHostFrame(preflight), preflight);

    for (const sensitive of [
      { page: { pageTargetId: 'page-1' } },
      { cdpPort: 9222 },
      { token: 'native-token' },
      { path: '/private/observation' },
      { rawResponse: {} },
      { secret: 'secret' },
    ]) {
      assert.throws(
        () =>
          decodeHostFrame(
            subcallFrame({
              kind: 'listApps',
              context: { ...context, ...sensitive },
            }),
          ),
        isInvalidFrame,
      );
    }
    assert.throws(
      () =>
        decodeHostFrame(
          subcallFrame({
            kind: 'preflight',
            context: { ...context, backendObservationId: 'x'.repeat(129) },
          }),
        ),
      isInvalidFrame,
    );
  });

  test('requires an app or windowId for observation subcalls', () => {
    for (const subcall of [
      {
        kind: 'observeApp',
        input: { includeScreenshot: false },
        context,
      },
      {
        kind: 'captureObservation',
        input: { includeScreenshot: true },
        context,
      },
      {
        kind: 'captureObservation',
        input: { app: 'Maka', includeScreenshot: false },
        context,
      },
    ]) {
      assert.throws(() => decodeHostFrame(subcallFrame(subcall)), isInvalidFrame);
    }
  });

  test('requires every transient and durable identity field on subcalls, results, and chunks', () => {
    const frames = [
      subcallFrame({ kind: 'preflight', context }),
      resultFrame({
        kind: 'preflight',
        accessibility: true,
        screenRecording: true,
      }),
      {
        kind: 'native.provider.chunk',
        ...subcallIdentity,
        attachmentId: 'attachment-1',
        index: 0,
        data: Buffer.from('image').toString('base64'),
      },
    ];
    for (const frame of frames) {
      for (const field of ['hostEpoch', 'operationId', 'subcallId', 'ordinal', 'bindingId']) {
        const missing = { ...frame } as Record<string, unknown>;
        delete missing[field];
        assert.throws(
          () =>
            frame.kind === 'native.provider.subcall'
              ? decodeHostFrame(missing)
              : decodeNativeProviderClientFrame(missing),
          isInvalidFrame,
        );
      }
    }

    const rebound = {
      ...resultFrame({
        kind: 'preflight',
        accessibility: true,
        screenRecording: false,
      }),
      hostEpoch: 'epoch-2',
      operationId: 'operation-2',
      subcallId: 'subcall-2',
      ordinal: 2,
      bindingId: 'binding-2',
    } as const;
    assert.deepEqual(decodeNativeProviderClientFrame(rebound), rebound);
    assert.notDeepEqual(
      identityOf(decodeNativeProviderClientFrame(rebound)),
      identityOf(
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'preflight',
            accessibility: true,
            screenRecording: false,
          }),
        ),
      ),
    );

    for (const ordinal of [0, NATIVE_PROVIDER_MAX_SUBCALLS_PER_INVOCATION + 1]) {
      assert.throws(
        () =>
          decodeHostFrame({
            ...subcallFrame({ kind: 'preflight', context }),
            ordinal,
          }),
        isInvalidFrame,
      );
    }
  });

  test('decodes one-way invocation cancel and release controls', () => {
    const release = {
      kind: 'native.provider.release' as const,
      ...invocationIdentity,
    };
    assert.deepEqual(decodeHostFrame(release), release);
    assert.deepEqual(decodeHostFrame({ kind: 'native.provider.cancel', ...subcallIdentity }), {
      kind: 'native.provider.cancel',
      ...subcallIdentity,
    });

    for (const invalid of [{ ...release, subcallId: 'not-allowed' }]) {
      assert.throws(() => decodeHostFrame(invalid), isInvalidFrame);
    }
  });

  test('keeps OAuth presentation to exact HTTPS open and bounded paste-code calls', () => {
    const oauthContext = { ownerId: 'oauth-login', attemptId: 'attempt-1' } as const;
    const subcalls = [
      {
        kind: 'open_external',
        input: { url: 'https://console.anthropic.com/oauth/authorize?state=opaque' },
        context: oauthContext,
      },
      {
        kind: 'request_authorization_code',
        input: {
          url: 'https://console.anthropic.com/oauth/authorize?state=opaque',
          stateHint: 'abcd1234',
        },
        context: oauthContext,
      },
    ] as const;
    for (const [index, subcall] of subcalls.entries()) {
      const frame = {
        kind: 'native.provider.subcall' as const,
        ...subcallIdentity,
        subcallId: `oauth-subcall-${index + 1}`,
        ordinal: index + 1,
        capability: 'oauth_presentation' as const,
        subcall,
      };
      assert.deepEqual(decodeHostFrame(frame), frame);
    }

    const normalized = decodeNativeProviderHostFrame({
      kind: 'native.provider.subcall',
      ...subcallIdentity,
      capability: 'oauth_presentation',
      subcall: {
        kind: 'open_external',
        input: { url: 'https://EXAMPLE.test:443/oauth/../authorize?q=hello world' },
        context: oauthContext,
      },
    });
    assert.equal(normalized.kind, 'native.provider.subcall');
    if (normalized.kind !== 'native.provider.subcall') assert.fail('Expected Native Provider call');
    assert.equal(normalized.capability, 'oauth_presentation');
    if (normalized.capability !== 'oauth_presentation') {
      assert.fail('Expected OAuth presentation call');
    }
    assert.equal(normalized.subcall.input.url, 'https://example.test/authorize?q=hello%20world');

    const results = [
      { kind: 'open_external', opened: true },
      { kind: 'request_authorization_code', payload: 'authorization-code#state' },
    ] as const;
    for (const result of results) {
      const frame = {
        kind: 'native.provider.result' as const,
        ...subcallIdentity,
        capability: 'oauth_presentation' as const,
        ok: true as const,
        result,
      };
      assert.deepEqual(decodeNativeProviderClientFrame(frame), frame);
    }

    const request = subcalls[1];
    for (const invalid of [
      { ...request, input: { ...request.input, url: 'http://example.test/oauth' } },
      { ...request, input: { ...request.input, url: 'https://user:secret@example.test/oauth' } },
      {
        ...request,
        input: {
          ...request.input,
          url: `https://example.test/${'a'.repeat(NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_URL_CHARS)}`,
        },
      },
      {
        ...request,
        input: {
          ...request.input,
          stateHint: 'a'.repeat(NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_STATE_HINT_UTF8_BYTES + 1),
        },
      },
      { ...request, verifier: 'must-stay-in-host' },
    ]) {
      assert.throws(
        () =>
          decodeHostFrame({
            kind: 'native.provider.subcall',
            ...subcallIdentity,
            capability: 'oauth_presentation',
            subcall: invalid,
          }),
        isInvalidFrame,
      );
    }
    assert.throws(
      () =>
        decodeNativeProviderClientFrame({
          kind: 'native.provider.result',
          ...subcallIdentity,
          capability: 'oauth_presentation',
          ok: true,
          result: {
            kind: 'request_authorization_code',
            payload: 'a'.repeat(
              NATIVE_PROVIDER_OAUTH_PRESENTATION_MAX_PASTE_PAYLOAD_UTF8_BYTES + 1,
            ),
          },
        }),
      isInvalidFrame,
    );
  });

  test('decodes acknowledged attachment-scoped Turn release with exact identity', () => {
    const identity = {
      hostEpoch: 'epoch-1',
      registrationId: 'registration-1',
      releaseId: 'release-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
    } as const;
    const release = {
      kind: 'native.provider.turn_release' as const,
      ...identity,
    };
    const acknowledged = {
      kind: 'native.provider.turn_released' as const,
      ...identity,
    };
    assert.deepEqual(decodeHostFrame(release), release);
    assert.deepEqual(decodeNativeProviderClientFrame(acknowledged), acknowledged);
    for (const field of ['hostEpoch', 'registrationId', 'releaseId', 'sessionId', 'turnId']) {
      const invalidRelease = { ...release } as Record<string, unknown>;
      const invalidAcknowledgement = { ...acknowledged } as Record<string, unknown>;
      delete invalidRelease[field];
      delete invalidAcknowledgement[field];
      assert.throws(() => decodeHostFrame(invalidRelease), isInvalidFrame);
      assert.throws(() => decodeNativeProviderClientFrame(invalidAcknowledgement), isInvalidFrame);
    }
  });

  test('decodes matching closed results for all six subcall kinds', () => {
    const runResult = {
      outcome: {
        ok: true as const,
        tier: 'ax' as const,
        verified: true,
        effect: 'confirmed' as const,
        completedSubSteps: 1,
      },
      resolvedScreenPoint: { x: 100, y: 200 },
      observation,
    };
    const payloads = [
      { kind: 'preflight', accessibility: true, screenRecording: false },
      {
        kind: 'listApps',
        apps: [
          {
            appId: 'dev.maka.app',
            pid: 42,
            name: 'Maka',
            windowCount: 1,
            windows: [{ windowId: 7, title: 'Workspace' }],
          },
        ],
      },
      { kind: 'observeApp', observation },
      { kind: 'runSemantic', result: runResult },
      {
        kind: 'captureObservation',
        observation: { ...observation, screenshot },
      },
      {
        kind: 'run',
        result: {
          outcome: runResult.outcome,
          resolvedScreenPoint: runResult.resolvedScreenPoint,
          screenshot,
        },
      },
    ] as const;
    for (const payload of payloads) {
      const frame = resultFrame(payload);
      assert.deepEqual(decodeNativeProviderClientFrame(frame), frame);
    }

    const failure = {
      kind: 'native.provider.result' as const,
      ...subcallIdentity,
      capability: 'computer_use' as const,
      ok: false as const,
      error: { code: 'outcome_unknown' as const },
    };
    assert.deepEqual(decodeNativeProviderClientFrame(failure), failure);
    assert.throws(
      () =>
        decodeNativeProviderClientFrame({
          ...failure,
          error: { ...failure.error, message: 'raw failure' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () => decodeNativeProviderClientFrame({ ...failure, capability: 'future_capability' }),
      isInvalidFrame,
    );
  });

  test('roundtrips all six closed Browser subcalls and results', () => {
    const browserContext = {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
    };
    const subcalls = [
      { kind: 'navigate', input: { url: 'https://example.com/' }, context: browserContext },
      { kind: 'snapshot', context: browserContext },
      {
        kind: 'click',
        input: { target: { kind: 'ref', value: '[12]' } },
        context: browserContext,
      },
      {
        kind: 'type',
        input: {
          target: { kind: 'selector', value: '#search' },
          text: 'query',
          submit: true,
        },
        context: browserContext,
      },
      {
        kind: 'wait',
        input: { condition: { kind: 'text', value: 'Loaded', timeoutSeconds: 30 } },
        context: browserContext,
      },
      {
        kind: 'extract',
        input: { selector: 'main', start: 0, limit: 16_000 },
        context: browserContext,
      },
    ] as const;
    const results = [
      {
        kind: 'navigate',
        url: 'https://example.com/',
        title: 'Example',
        takeoverReloaded: false,
      },
      {
        kind: 'snapshot',
        url: 'https://example.com/',
        elements: [{ text: '[1]<a>Home</a>', ref: '[1]' }],
        totalElements: 3,
        takeoverReloaded: false,
      },
      { kind: 'click', matches: 1, matchLevel: 'exact', takeoverReloaded: false },
      {
        kind: 'type',
        verified: true,
        actual: 'query',
        matchLevel: 'exact',
        takeoverReloaded: false,
      },
      { kind: 'wait', takeoverReloaded: true },
      {
        kind: 'extract',
        url: 'https://example.com/',
        chunk: '# Example',
        hasMore: false,
        nextStart: 9,
        sourceTruncated: false,
        takeoverReloaded: false,
      },
    ] as const;

    for (const subcall of subcalls) {
      const frame = browserSubcallFrame(subcall);
      assert.deepEqual(decodeHostFrame(frame), frame);
    }
    for (const result of results) {
      const frame = browserResultFrame(result);
      assert.deepEqual(decodeNativeProviderClientFrame(frame), frame);
    }
  });

  test('enforces Browser character, UTF-8, integer, and wire envelope bounds', () => {
    assert.equal(NATIVE_PROVIDER_BROWSER_MAX_ADDRESS_INPUT_CHARS, 4_000);
    assert.equal(NATIVE_PROVIDER_BROWSER_MAX_URL_CHARS, 4_009);
    assert.equal(NATIVE_PROVIDER_BROWSER_MAX_RESULT_JSON_BYTES, 56 * 1024);

    const browserContext = {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
    };
    const typeFrame = (text: string) =>
      browserSubcallFrame({
        kind: 'type',
        input: { target: { kind: 'selector', value: '#field' }, text, submit: false },
        context: browserContext,
      });
    const waitTextFrame = (text: string) =>
      browserSubcallFrame({
        kind: 'wait',
        input: { condition: { kind: 'text', value: text, timeoutSeconds: 1 } },
        context: browserContext,
      });
    assert.equal(NATIVE_PROVIDER_BROWSER_MAX_TYPE_TEXT_UTF8_BYTES, 8 * 1024);
    assert.equal(
      NATIVE_PROVIDER_BROWSER_MAX_WAIT_TEXT_UTF8_BYTES,
      NATIVE_PROVIDER_BROWSER_MAX_TYPE_TEXT_UTF8_BYTES,
    );
    const exactReviewText = 'a'.repeat(NATIVE_PROVIDER_BROWSER_MAX_TYPE_TEXT_UTF8_BYTES);
    for (const frame of [typeFrame(exactReviewText), waitTextFrame(exactReviewText)]) {
      assert.deepEqual(decodeHostFrame(frame), frame);
    }
    const oversizedEmojiText = '😀'.repeat(
      NATIVE_PROVIDER_BROWSER_MAX_TYPE_TEXT_UTF8_BYTES / 4 + 1,
    );
    for (const frame of [typeFrame(oversizedEmojiText), waitTextFrame(oversizedEmojiText)]) {
      assert.throws(() => decodeHostFrame(frame), isInvalidFrame);
    }

    for (const invalid of [
      {
        kind: 'navigate',
        input: { url: 'x'.repeat(NATIVE_PROVIDER_BROWSER_MAX_URL_CHARS + 1) },
        context: browserContext,
      },
      {
        kind: 'click',
        input: { target: { kind: 'selector', value: 'x'.repeat(2_001) } },
        context: browserContext,
      },
      {
        kind: 'wait',
        input: {
          condition: {
            kind: 'text',
            value: 'x'.repeat(NATIVE_PROVIDER_BROWSER_MAX_WAIT_TEXT_UTF8_BYTES + 1),
            timeoutSeconds: 1,
          },
        },
        context: browserContext,
      },
      {
        kind: 'wait',
        input: { condition: { kind: 'time', seconds: 121 } },
        context: browserContext,
      },
      {
        kind: 'extract',
        input: { start: -1, limit: NATIVE_PROVIDER_BROWSER_MAX_EXTRACT_CHARS },
        context: browserContext,
      },
      {
        kind: 'extract',
        input: { start: 1.5, limit: NATIVE_PROVIDER_BROWSER_MAX_EXTRACT_CHARS },
        context: browserContext,
      },
      { kind: 'extract', input: { start: 0, limit: 1.5 }, context: browserContext },
      {
        kind: 'extract',
        input: { start: 0, limit: NATIVE_PROVIDER_BROWSER_MAX_EXTRACT_CHARS + 1 },
        context: browserContext,
      },
    ]) {
      assert.throws(() => decodeHostFrame(browserSubcallFrame(invalid)), isInvalidFrame);
    }

    const snapshot = (
      elements: readonly BrowserSnapshotElement[],
      totalElements = elements.length,
    ) =>
      browserResultFrame({
        kind: 'snapshot',
        url: '',
        elements,
        totalElements,
        takeoverReloaded: false,
      });
    assert.deepEqual(
      decodeNativeProviderClientFrame(
        snapshot([{ text: 'x'.repeat(NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS) }], 201),
      ),
      snapshot([{ text: 'x'.repeat(NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS) }], 201),
    );
    for (const totalElements of [0, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual(
        decodeNativeProviderClientFrame(snapshot([], totalElements)),
        snapshot([], totalElements),
      );
    }
    for (const elements of [
      Array.from({ length: NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_ELEMENTS + 1 }, () => ({
        text: 'x',
      })),
      [{ text: 'x'.repeat(NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS + 1) }],
      [{ text: 'first\nsecond' }],
      [{ text: '😀'.repeat(NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS) }],
    ]) {
      assert.throws(() => decodeNativeProviderClientFrame(snapshot(elements)), isInvalidFrame);
    }
    for (const invalid of [
      snapshot([{ text: 'first' }, { text: 'second' }], 1),
      snapshot([], -1),
      snapshot([], 1.5),
      snapshot([], Number.MAX_SAFE_INTEGER + 1),
    ]) {
      assert.throws(() => decodeNativeProviderClientFrame(invalid), isInvalidFrame);
    }

    assert.deepEqual(
      decodeNativeProviderClientFrame(
        snapshot([
          { text: '  *[7]<button>Save</button>', ref: '[7]' },
          { text: '  *|scroll[8]|<main />', ref: '[8]' },
          { text: '[9]<x:control state="ready" />', ref: '[9]' },
          { text: '<p>Documentation [9]</p>' },
        ]),
      ),
      snapshot([
        { text: '  *[7]<button>Save</button>', ref: '[7]' },
        { text: '  *|scroll[8]|<main />', ref: '[8]' },
        { text: '[9]<x:control state="ready" />', ref: '[9]' },
        { text: '<p>Documentation [9]</p>' },
      ]),
    );
    for (const elements of [
      ['[1]<button />'],
      [{ text: '[1]<button />', ref: '[1]', legacy: true }],
      [{ text: '' }],
      [{ text: '<button />', ref: '[1]' }],
      [{ text: '[2]<button />', ref: '[1]' }],
      [{ text: '[1] button "Save"', ref: '[1]' }],
      [{ text: '[01]<button />', ref: '[01]' }],
      [{ text: '[1]<button />', ref: undefined }],
      [
        { text: '[1]<button />', ref: '[1]' },
        { text: '|scroll[1]|<main />', ref: '[1]' },
      ],
    ]) {
      assert.throws(
        () =>
          decodeNativeProviderClientFrame(
            snapshot(elements as unknown as BrowserSnapshotElement[]),
          ),
        isInvalidFrame,
      );
    }
    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          browserResultFrame({
            kind: 'extract',
            url: '',
            chunk: '\u0000'.repeat(NATIVE_PROVIDER_BROWSER_MAX_EXTRACT_CHARS),
            hasMore: false,
            nextStart: 0,
            sourceTruncated: false,
            takeoverReloaded: false,
          }),
        ),
      isInvalidFrame,
    );
  });

  test('selects the advertised capability decoder before reading a result domain', () => {
    assert.throws(
      () =>
        decodeNativeProviderClientFrame({
          ...browserResultFrame({ kind: 'preflight', accessibility: true, screenRecording: true }),
          capability: 'browser',
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeNativeProviderClientFrame({
          ...resultFrame({ kind: 'navigate', url: '', title: '', takeoverReloaded: false }),
          capability: 'computer_use',
        }),
      isInvalidFrame,
    );
  });

  test('keeps Host inbound payload opaque and outbound encoding capability-closed', () => {
    const mismatched = {
      ...resultFrame({
        kind: 'snapshot',
        url: 'https://example.com/',
        elements: [{ text: '[1]<a>Home</a>', ref: '[1]' }],
        totalElements: 1,
        takeoverReloaded: false,
      }),
      capability: 'computer_use' as const,
    };
    assert.deepEqual(decodeClientFrame(mismatched), mismatched);
    assert.throws(() => decodeNativeProviderClientFrame(mismatched), isInvalidFrame);
    assert.throws(
      () =>
        decodeClientFrame({
          ...mismatched,
          result: { text: 'x'.repeat(NATIVE_PROVIDER_MAX_INLINE_PAYLOAD_BYTES) },
        }),
      isInvalidFrame,
    );

    const outbound = decodeNativeProviderClientFrame(
      browserResultFrame({
        kind: 'snapshot',
        url: 'https://example.com/',
        elements: [{ text: '[1]<a>Home</a>', ref: '[1]' }],
        totalElements: 1,
        takeoverReloaded: false,
      }),
    );
    const closedOutbound: ClientFrame = outbound;
    type OutboundResult = Extract<
      Extract<ClientFrame, { kind: 'native.provider.result' }>,
      { ok: true }
    >['result'];
    const outboundResultIsUnknown: unknown extends OutboundResult ? true : false = false;
    assert.equal(outboundResultIsUnknown, false);
    assert.deepEqual(JSON.parse(encodeProtocolFrame(closedOutbound).toString('utf8')), outbound);
  });

  test('rejects page identity, element tokens, raw responses, paths, secrets, and evidence text', () => {
    const sensitiveObservationFields = [
      { page: { cdpPort: 9222 } },
      { cdpPort: 9222 },
      { pageTargetId: 'page-1' },
      { pageUrl: 'https://private.example' },
      { targetUrlContains: 'private.example' },
      { documentFingerprint: 'fingerprint' },
      { path: '/private/capture.png' },
      { rawResponse: { native: true } },
      { secret: 'secret' },
    ];
    for (const sensitive of sensitiveObservationFields) {
      assert.throws(
        () =>
          decodeNativeProviderClientFrame(
            resultFrame({
              kind: 'observeApp',
              observation: { ...observation, ...sensitive },
            }),
          ),
        isInvalidFrame,
      );
    }

    for (const identity of [
      { role: 'button', token: 'native-token' },
      { role: 'button', endpoint: 'ws://localhost/devtools' },
    ]) {
      assert.throws(
        () =>
          decodeNativeProviderClientFrame(
            resultFrame({
              kind: 'observeApp',
              observation: {
                ...observation,
                elements: [{ elementId: 'element-1', role: 'button', identity }],
              },
            }),
          ),
        isInvalidFrame,
      );
    }

    for (const outcome of [
      { ok: false, error: 'capture_failed', message: 'raw native message' },
      { ok: true, tier: 'ax', evidence: { reason: 'raw reason' } },
      { ok: true, tier: 'ax', evidence: { path: '/private' } },
      { ok: true, tier: 'ax', rawResponse: {} },
    ]) {
      assert.throws(
        () => decodeNativeProviderClientFrame(resultFrame({ kind: 'run', result: { outcome } })),
        isInvalidFrame,
      );
    }

    assert.throws(
      () =>
        decodeHostFrame(
          subcallFrame({
            kind: 'runSemantic',
            action: {
              type: 'click_element',
              observationId: 'observation-1',
              elementId: 'element-1',
              elementIdentity: { role: 'button', token: 'native-token' },
            },
            context,
          }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame(
          subcallFrame({
            kind: 'run',
            action: { type: 'wait', durationMs: 1 },
            context: {
              ...context,
              boundAction: {
                ...context.boundAction,
                target: {
                  ...context.boundAction.target,
                  page: { cdpPort: 9222 },
                },
              },
            },
          }),
        ),
      isInvalidFrame,
    );
  });

  test('enforces array, string, number, and inline payload bounds without truncation', () => {
    assert.equal(NATIVE_PROVIDER_MAX_APPS, 128);
    assert.equal(NATIVE_PROVIDER_MAX_WINDOWS_PER_APP, 64);
    assert.equal(NATIVE_PROVIDER_MAX_WINDOWS, 512);
    assert.equal(NATIVE_PROVIDER_MAX_DISPLAYS, 16);
    assert.equal(NATIVE_PROVIDER_MAX_ELEMENTS, 500);
    assert.equal(NATIVE_PROVIDER_MAX_INLINE_PAYLOAD_BYTES, 60 * 1024);

    const app = { appId: 'app', pid: 1, windowCount: 0 };
    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'listApps',
            apps: Array.from({ length: NATIVE_PROVIDER_MAX_APPS + 1 }, () => app),
          }),
        ),
      isInvalidFrame,
    );
    const maximumDeclaredWindows = resultFrame({
      kind: 'listApps',
      apps: [
        {
          appId: 'app',
          pid: 1,
          windowCount: NATIVE_PROVIDER_MAX_WINDOWS,
          windows: Array.from({ length: NATIVE_PROVIDER_MAX_WINDOWS_PER_APP }, (_, index) => ({
            windowId: index + 1,
          })),
        },
      ],
    });
    assert.deepEqual(
      decodeNativeProviderClientFrame(maximumDeclaredWindows),
      maximumDeclaredWindows,
    );
    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'listApps',
            apps: [
              {
                appId: 'app',
                pid: 1,
                windowCount: NATIVE_PROVIDER_MAX_WINDOWS,
                windows: Array.from(
                  { length: NATIVE_PROVIDER_MAX_WINDOWS_PER_APP + 1 },
                  (_, index) => ({ windowId: index + 1 }),
                ),
              },
            ],
          }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'listApps',
            apps: [
              { appId: 'app-1', pid: 1, windowCount: 256 },
              { appId: 'app-2', pid: 2, windowCount: 257 },
            ],
          }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'listApps',
            apps: [
              {
                appId: 'app',
                pid: 1,
                windowCount: NATIVE_PROVIDER_MAX_WINDOWS + 1,
              },
            ],
          }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'observeApp',
            observation: {
              ...observation,
              displays: Array.from(
                { length: NATIVE_PROVIDER_MAX_DISPLAYS + 1 },
                () => observation.displays[0],
              ),
            },
          }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'observeApp',
            observation: {
              ...observation,
              elements: Array.from({ length: NATIVE_PROVIDER_MAX_ELEMENTS + 1 }, (_, index) => ({
                elementId: `element-${index}`,
                role: 'button',
              })),
            },
          }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'observeApp',
            observation: {
              ...observation,
              elements: Array.from({ length: NATIVE_PROVIDER_MAX_ELEMENTS }, (_, index) => ({
                elementId: `element-${index}`,
                role: 'button',
                value: 'x'.repeat(200),
              })),
            },
          }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame(
          subcallFrame({
            kind: 'run',
            action: { type: 'wait', durationMs: Infinity },
            context,
          }),
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame(
          subcallFrame({
            kind: 'run',
            action: { type: 'type', text: 'x'.repeat(8_001) },
            context,
          }),
        ),
      isInvalidFrame,
    );
  });

  test('binds chunks and the single screenshot attachment to the full subcall identity', () => {
    assert.equal(NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES, 32 * 1024);
    assert.equal(NATIVE_PROVIDER_MAX_ATTACHMENTS_PER_RESULT, 1);
    assert.equal(NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024);
    assert.equal(NATIVE_PROVIDER_MAX_RESULT_ATTACHMENT_BYTES, 8 * 1024 * 1024);
    assert.equal(NATIVE_PROVIDER_MAX_PENDING_INVOCATIONS, 8);

    const chunkFrame = (data: string) => ({
      kind: 'native.provider.chunk' as const,
      ...subcallIdentity,
      attachmentId: attachment.attachmentId,
      index: 0,
      data,
    });
    const maximum = Buffer.alloc(NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES, 0xa5).toString('base64');
    const oversized = Buffer.alloc(NATIVE_PROVIDER_ATTACHMENT_CHUNK_BYTES + 1, 0xa5).toString(
      'base64',
    );
    assert.deepEqual(decodeNativeProviderClientFrame(chunkFrame(maximum)), chunkFrame(maximum));
    assert.throws(() => decodeNativeProviderClientFrame(chunkFrame(oversized)), isInvalidFrame);

    const capture = resultFrame({
      kind: 'captureObservation',
      observation: { ...observation, screenshot },
    });
    assert.deepEqual(decodeNativeProviderClientFrame(capture), capture);
    assert.throws(
      () =>
        decodeNativeProviderClientFrame({
          ...capture,
          result: {
            ...capture.result,
            observation: {
              ...capture.result.observation,
              screenshot: {
                ...screenshot,
                image: {
                  ...attachment,
                  byteLength: NATIVE_PROVIDER_MAX_ATTACHMENT_BYTES + 1,
                },
              },
            },
          },
        }),
      isInvalidFrame,
    );

    assert.throws(
      () =>
        decodeNativeProviderClientFrame(
          resultFrame({
            kind: 'run',
            result: {
              outcome: { ok: true, tier: 'ax' },
              screenshot,
              observation: { ...observation, screenshot },
            },
          }),
        ),
      isInvalidFrame,
    );
  });
});

function subcallFrame<T>(
  subcall: T,
  ordinal = 1,
): {
  kind: 'native.provider.subcall';
  hostEpoch: string;
  operationId: string;
  subcallId: string;
  ordinal: number;
  bindingId: string;
  capability: 'computer_use';
  subcall: T;
} {
  return {
    kind: 'native.provider.subcall',
    ...subcallIdentity,
    ordinal,
    capability: 'computer_use',
    subcall,
  };
}

function resultFrame<T>(result: T): {
  kind: 'native.provider.result';
  hostEpoch: string;
  operationId: string;
  subcallId: string;
  ordinal: number;
  bindingId: string;
  capability: 'computer_use';
  ok: true;
  result: T;
} {
  return {
    kind: 'native.provider.result',
    ...subcallIdentity,
    capability: 'computer_use',
    ok: true,
    result,
  };
}

function browserSubcallFrame<T>(subcall: T) {
  return {
    kind: 'native.provider.subcall' as const,
    ...subcallIdentity,
    capability: 'browser' as const,
    subcall,
  };
}

function browserResultFrame<T>(result: T) {
  return {
    kind: 'native.provider.result' as const,
    ...subcallIdentity,
    capability: 'browser' as const,
    ok: true as const,
    result,
  };
}

function identityOf(frame: unknown): unknown {
  if (!frame || typeof frame !== 'object') assert.fail('expected a frame');
  const record = frame as Record<string, unknown>;
  return {
    hostEpoch: record.hostEpoch,
    operationId: record.operationId,
    subcallId: record.subcallId,
    ordinal: record.ordinal,
    bindingId: record.bindingId,
  };
}

function metadata(
  operation: 'native.provider.register' | 'native.provider.unregister',
): readonly string[] {
  const { mode, retry, admission } = HOST_OPERATION_SPECS[operation];
  return [mode, retry, admission];
}

function isInvalidFrame(error: unknown): error is RuntimeHostProtocolError {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
