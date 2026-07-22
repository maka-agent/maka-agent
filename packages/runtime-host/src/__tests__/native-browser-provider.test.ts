import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserBackendError, type BrowserInvocationContext } from '@maka/runtime/browser-tools';
import type {
  NativeProviderBrowserResultPayload,
  NativeProviderSubcall,
} from '../protocol/index.js';
import { createHostNativeBrowserInvocationProvider } from '../server/native-browser-provider.js';
import type {
  HostNativeProviderService,
  HostNativeProviderSubcallOutcome,
} from '../server/native-provider-coordinator.js';

const CONTEXT: BrowserInvocationContext & { operationId: string } = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  operationId: 'operation-1',
};

test('maps all six Browser calls through one frozen Host invocation', async () => {
  const recorder = service([
    success({
      kind: 'navigate',
      url: 'https://example.com/',
      title: 'Example',
      takeoverReloaded: false,
    }),
    success({
      kind: 'snapshot',
      url: 'https://example.com/',
      elements: [{ text: '[1]<a>Home</a>', ref: '[1]' }],
      totalElements: 4,
      takeoverReloaded: false,
    }),
    success({ kind: 'click', matches: 1, matchLevel: 'exact', takeoverReloaded: false }),
    success({
      kind: 'type',
      verified: true,
      actual: 'hello',
      matchLevel: 'exact',
      takeoverReloaded: false,
    }),
    success({ kind: 'wait', takeoverReloaded: false }),
    success({
      kind: 'extract',
      url: 'https://example.com/',
      chunk: '# Example',
      hasMore: false,
      nextStart: 9,
      sourceTruncated: false,
      takeoverReloaded: false,
    }),
  ]);
  const provider = createHostNativeBrowserInvocationProvider(recorder.service);
  const signal = new AbortController().signal;
  const acquired = await provider.acquire(
    { context: CONTEXT, affinity: 'frozen-provider' },
    signal,
  );
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  assert.equal(acquired.invocation.affinity, 'opaque-provider-token');

  const backend = acquired.invocation.backend;
  assert.equal(
    (await backend.navigate({ url: 'https://example.com/' }, signal, CONTEXT)).title,
    'Example',
  );
  assert.deepEqual(await backend.snapshot(signal, CONTEXT), {
    url: 'https://example.com/',
    elements: [{ text: '[1]<a>Home</a>', ref: '[1]' }],
    totalElements: 4,
    takeoverReloaded: false,
  });
  assert.equal('releaseTurnState' in backend, false);
  assert.equal(
    (await backend.click({ target: { kind: 'ref', value: '[1]' } }, signal, CONTEXT)).matches,
    1,
  );
  assert.equal(
    (
      await backend.type(
        { target: { kind: 'selector', value: '#q' }, text: 'hello', submit: true },
        signal,
        CONTEXT,
      )
    ).verified,
    true,
  );
  assert.equal(
    (await backend.wait({ condition: { kind: 'time', seconds: 1 } }, signal, CONTEXT))
      .takeoverReloaded,
    false,
  );
  assert.equal(
    (await backend.extract({ start: 0, limit: 16_000 }, signal, CONTEXT)).chunk,
    '# Example',
  );

  assert.deepEqual(recorder.acquireInputs, [
    {
      operationId: 'operation-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      capability: 'browser',
      affinity: 'frozen-provider',
    },
  ]);
  assert.deepEqual(
    recorder.calls.map((call) => call.kind),
    ['navigate', 'snapshot', 'click', 'type', 'wait', 'extract'],
  );
  for (const call of recorder.calls) {
    assert.deepEqual(call.context, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
    });
  }
  acquired.invocation.release();
  assert.equal(recorder.releases, 1);
});

test('preserves acquisition mismatch and maps admitted failures without fallback', async () => {
  for (const [coordinatorError, expected] of [
    ['capability_unavailable', 'service_unavailable'],
    ['capability_ambiguous', 'service_unavailable'],
    ['service_mismatch', 'service_mismatch'],
  ] as const) {
    const unavailable = await createHostNativeBrowserInvocationProvider(
      service([], coordinatorError).service,
    ).acquire({ context: CONTEXT, affinity: 'stale' }, new AbortController().signal);
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.error, expected);
  }

  const recorder = service([
    failure('outcome_unknown'),
    failure('operation_failed'),
    failure('capability_lost'),
  ]);
  const acquired = await createHostNativeBrowserInvocationProvider(recorder.service).acquire(
    { context: CONTEXT },
    new AbortController().signal,
  );
  if (!acquired.ok) assert.fail(acquired.message);
  await assert.rejects(
    () => acquired.invocation.backend.snapshot(new AbortController().signal, CONTEXT),
    (error: unknown) => error instanceof BrowserBackendError && error.code === 'outcome_unknown',
  );
  await assert.rejects(
    () =>
      acquired.invocation.backend.wait(
        { condition: { kind: 'time', seconds: 1 } },
        new AbortController().signal,
        CONTEXT,
      ),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof BrowserBackendError) &&
      error.message === 'The native browser operation failed',
  );
  await assert.rejects(
    () =>
      acquired.invocation.backend.extract(
        { start: 0, limit: 16_000 },
        new AbortController().signal,
        CONTEXT,
      ),
    (error: unknown) =>
      error instanceof BrowserBackendError && error.code === 'service_unavailable',
  );
  assert.equal(recorder.acquireInputs.length, 1);
});

function service(
  outcomes: HostNativeProviderSubcallOutcome<NativeProviderBrowserResultPayload>[],
  acquisitionError?: 'capability_unavailable' | 'capability_ambiguous' | 'service_mismatch',
) {
  const calls: NativeProviderSubcall[] = [];
  const acquireInputs: unknown[] = [];
  let releases = 0;
  const hostService = {
    acquireInvocation(input: unknown) {
      acquireInputs.push(input);
      if (acquisitionError)
        return { ok: false as const, error: acquisitionError, message: 'private' };
      return {
        ok: true as const,
        invocation: {
          affinity: 'opaque-provider-token',
          async call({ subcall }: { subcall: NativeProviderSubcall }) {
            calls.push(subcall);
            const outcome = outcomes.shift();
            if (!outcome) throw new Error('Missing outcome');
            return outcome;
          },
          release: () => {
            releases += 1;
          },
        },
      };
    },
    attachConnection() {
      throw new Error('unused');
    },
    beginDrain() {},
    async close() {},
  } as unknown as HostNativeProviderService;
  return {
    service: hostService,
    calls,
    acquireInputs,
    get releases() {
      return releases;
    },
  };
}

function success(
  result: NativeProviderBrowserResultPayload,
): HostNativeProviderSubcallOutcome<NativeProviderBrowserResultPayload> {
  return { ok: true, result, attachments: [] };
}

function failure(
  code: 'operation_failed' | 'outcome_unknown' | 'capability_lost',
): HostNativeProviderSubcallOutcome<NativeProviderBrowserResultPayload> {
  return { ok: false, error: { code, message: 'private' } };
}
