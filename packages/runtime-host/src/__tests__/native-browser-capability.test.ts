import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BrowserBackendError,
  type BrowserBackend,
  type BrowserInvocationContext,
} from '@maka/runtime/browser-tools';
import { createBrowserNativeCapability } from '../native-provider/browser.js';
import {
  decodeNativeProviderBrowserResultPayload,
  NATIVE_PROVIDER_BROWSER_MAX_RESULT_JSON_BYTES,
  NATIVE_PROVIDER_BROWSER_MAX_RESULT_TEXT_UTF8_BYTES,
  NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS,
  NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_ELEMENTS,
  type NativeProviderBrowserResultPayload,
  type NativeProviderBrowserSubcall,
  type NativeProviderBrowserSubcallFrame,
} from '../protocol/index.js';

const CONTEXT = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
} as const;

test('maps all six closed Browser subcalls with their context and handler signal', async () => {
  const recorder = recordingBackend();
  const capability = createBrowserNativeCapability(recorder.backend);
  const controller = new AbortController();
  const subcalls: readonly NativeProviderBrowserSubcall[] = [
    { kind: 'navigate', input: { url: 'https://example.test/' }, context: CONTEXT },
    { kind: 'snapshot', context: CONTEXT },
    { kind: 'click', input: { target: { kind: 'ref', value: '[1]' } }, context: CONTEXT },
    {
      kind: 'type',
      input: {
        target: { kind: 'selector', value: '#query' },
        text: 'hello',
        submit: true,
      },
      context: CONTEXT,
    },
    {
      kind: 'wait',
      input: { condition: { kind: 'text', value: 'Ready', timeoutSeconds: 4 } },
      context: CONTEXT,
    },
    {
      kind: 'extract',
      input: { selector: 'main', start: 2, limit: 100 },
      context: CONTEXT,
    },
  ];

  const results: NativeProviderBrowserResultPayload[] = [];
  for (const [index, subcall] of subcalls.entries()) {
    const outcome = await capability.handle(frame(subcall, index + 1), {
      signal: controller.signal,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) continue;
    assert.equal(outcome.attachment, undefined);
    results.push(outcome.complete());
  }

  assert.deepEqual(
    results.map(({ kind }) => kind),
    ['navigate', 'snapshot', 'click', 'type', 'wait', 'extract'],
  );
  assert.deepEqual(
    recorder.calls.map(({ kind, input }) => ({ kind, input })),
    [
      { kind: 'navigate', input: { url: 'https://example.test/' } },
      { kind: 'snapshot', input: undefined },
      { kind: 'click', input: { target: { kind: 'ref', value: '[1]' } } },
      {
        kind: 'type',
        input: {
          target: { kind: 'selector', value: '#query' },
          text: 'hello',
          submit: true,
        },
      },
      {
        kind: 'wait',
        input: { condition: { kind: 'text', value: 'Ready', timeoutSeconds: 4 } },
      },
      { kind: 'extract', input: { selector: 'main', start: 2, limit: 100 } },
    ],
  );
  for (const call of recorder.calls) {
    assert.equal(call.context, CONTEXT);
    assert.equal(call.signal, controller.signal);
  }
});

test('bounds a large Browser snapshot to a decodable whole-entry prefix', async () => {
  const elements = Array.from({ length: 240 }, (_, index) => ({
    text: `[${index + 1}]<button>${'界'.repeat(100)} ${index + 1}</button>`,
    ref: `[${index + 1}]` as `[${string}]`,
  }));
  assert.ok(
    new TextEncoder().encode(elements.map(({ text }) => text).join('')).byteLength >
      NATIVE_PROVIDER_BROWSER_MAX_RESULT_TEXT_UTF8_BYTES,
  );
  const backend = recordingBackend({
    snapshot: async () => ({
      url: 'https://example.test/large',
      elements,
      totalElements: elements.length,
      takeoverReloaded: false,
    }),
  }).backend;
  const outcome = await createBrowserNativeCapability(backend).handle(
    frame({ kind: 'snapshot', context: CONTEXT }, 1),
    { signal: new AbortController().signal },
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const payload = outcome.complete();
  assert.equal(payload.kind, 'snapshot');
  if (payload.kind !== 'snapshot') return;
  assert.deepEqual(decodeNativeProviderBrowserResultPayload(payload), payload);
  assert.equal(payload.totalElements, elements.length);
  assert.ok(payload.elements.length > 0);
  assert.ok(payload.elements.length < elements.length);
  assert.ok(payload.elements.length <= NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_ELEMENTS);
  assert.deepEqual(payload.elements, elements.slice(0, payload.elements.length));
  assert.ok(
    payload.elements.reduce((total, element) => total + element.text.length, 0) <=
      NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS,
  );
  assert.ok(
    new TextEncoder().encode(payload.elements.map(({ text }) => text).join('')).byteLength <=
      NATIVE_PROVIDER_BROWSER_MAX_RESULT_TEXT_UTF8_BYTES,
  );
  assert.ok(
    new TextEncoder().encode(JSON.stringify(payload)).byteLength <=
      NATIVE_PROVIDER_BROWSER_MAX_RESULT_JSON_BYTES,
  );
});

test('preserves only unknown outcomes and closes definite failures', async () => {
  const cases = [
    {
      error: new BrowserBackendError('outcome_unknown', 'navigation may have committed'),
      expected: 'outcome_unknown',
    },
    {
      error: new BrowserBackendError('service_unavailable', 'backend is unavailable'),
      expected: 'operation_failed',
    },
    { error: new Error('definite backend failure'), expected: 'operation_failed' },
  ] as const;

  for (const [index, { error, expected }] of cases.entries()) {
    const backend = recordingBackend({ snapshot: async () => Promise.reject(error) }).backend;
    const outcome = await createBrowserNativeCapability(backend).handle(
      frame({ kind: 'snapshot', context: CONTEXT }, index + 1),
      { signal: new AbortController().signal },
    );
    assert.deepEqual(outcome, { ok: false, code: expected });
  }

  const invalid = recordingBackend({
    snapshot: async () =>
      ({
        url: 'https://example.test/',
        elements: [],
        takeoverReloaded: 'invalid',
      }) as never,
  }).backend;
  assert.deepEqual(
    await createBrowserNativeCapability(invalid).handle(
      frame({ kind: 'snapshot', context: CONTEXT }, 4),
      { signal: new AbortController().signal },
    ),
    { ok: false, code: 'operation_failed' },
  );
});

test('awaits Browser Turn cleanup with the complete identity', async () => {
  let release!: () => void;
  const cleanupFinished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder = recordingBackend({ releaseTurnState: async () => cleanupFinished });
  let settled = false;
  const cleanup = Promise.resolve(
    createBrowserNativeCapability(recorder.backend).releaseTurnState({
      sessionId: 'session-cleanup',
      turnId: 'turn-cleanup',
    }),
  ).then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(recorder.turnReleases, [
    { sessionId: 'session-cleanup', turnId: 'turn-cleanup' },
  ]);
  release();
  await cleanup;
  assert.equal(settled, true);
});

interface RecordedCall {
  readonly kind: NativeProviderBrowserSubcall['kind'];
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly context: BrowserInvocationContext;
}

function recordingBackend(overrides: Partial<BrowserBackend> = {}) {
  const calls: RecordedCall[] = [];
  const turnReleases: Array<{ sessionId: string; turnId: string }> = [];
  const record = <T>(
    kind: RecordedCall['kind'],
    input: unknown,
    signal: AbortSignal,
    context: BrowserInvocationContext,
    result: T,
  ): Promise<T> => {
    calls.push({ kind, input, signal, context });
    return Promise.resolve(result);
  };
  const backend: BrowserBackend = {
    navigate: (input, signal, context) =>
      record('navigate', input, signal, context, {
        url: input.url,
        title: 'Example',
        takeoverReloaded: false,
      }),
    snapshot: (signal, context) =>
      record('snapshot', undefined, signal, context, {
        url: 'https://example.test/',
        elements: [{ text: '[1]<a>Home</a>', ref: '[1]' }],
        totalElements: 1,
        takeoverReloaded: false,
      }),
    click: (input, signal, context) =>
      record('click', input, signal, context, {
        matches: 1,
        matchLevel: 'exact',
        takeoverReloaded: false,
      }),
    type: (input, signal, context) =>
      record('type', input, signal, context, {
        verified: true,
        actual: input.text,
        matchLevel: 'exact',
        takeoverReloaded: false,
      }),
    wait: (input, signal, context) =>
      record('wait', input, signal, context, { takeoverReloaded: false }),
    extract: (input, signal, context) =>
      record('extract', input, signal, context, {
        url: 'https://example.test/',
        chunk: '# Example',
        hasMore: false,
        nextStart: input.start + 9,
        sourceTruncated: false,
        takeoverReloaded: false,
      }),
    ...overrides,
    async releaseTurnState(input) {
      turnReleases.push(input);
      await overrides.releaseTurnState?.(input);
    },
  };
  return { backend, calls, turnReleases };
}

function frame(
  subcall: NativeProviderBrowserSubcall,
  ordinal: number,
): NativeProviderBrowserSubcallFrame {
  return {
    kind: 'native.provider.subcall',
    hostEpoch: 'epoch-1',
    operationId: 'operation-1',
    bindingId: 'binding-1',
    subcallId: `subcall-${ordinal}`,
    ordinal,
    capability: 'browser',
    subcall,
  };
}
