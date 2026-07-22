import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOAuthPresentationNativeCapability } from '../native-provider/oauth-presentation.js';
import type { NativeProviderOAuthPresentationSubcallFrame } from '../protocol/native-provider.js';

test('OAuth presentation capability projects only open and paste-code handler data', async () => {
  const calls: unknown[] = [];
  const capability = createOAuthPresentationNativeCapability({
    openExternal: async (input, context, signal) => {
      calls.push({ kind: 'open', input, context, aborted: signal.aborted });
    },
    requestAuthorizationCode: async (input, context, signal) => {
      calls.push({ kind: 'paste', input, context, aborted: signal.aborted });
      return 'authorization-code#returned-state';
    },
  });
  const context = { ownerId: 'oauth-login', attemptId: 'attempt-1' } as const;
  const controller = new AbortController();
  const open = await capability.handle(
    frame({
      kind: 'open_external',
      input: { url: 'https://example.test/authorize' },
      context,
    }),
    { signal: controller.signal },
  );
  assert.equal(open.ok, true);
  if (!open.ok) assert.fail('open_external failed');
  assert.deepEqual(open.complete(), { kind: 'open_external', opened: true });

  const request = await capability.handle(
    frame({
      kind: 'request_authorization_code',
      input: { url: 'https://example.test/authorize', stateHint: 'abcd1234' },
      context,
    }),
    { signal: controller.signal },
  );
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail('request_authorization_code failed');
  assert.deepEqual(request.complete(), {
    kind: 'request_authorization_code',
    payload: 'authorization-code#returned-state',
  });
  assert.deepEqual(calls, [
    {
      kind: 'open',
      input: { url: 'https://example.test/authorize' },
      context,
      aborted: false,
    },
    {
      kind: 'paste',
      input: { url: 'https://example.test/authorize', stateHint: 'abcd1234' },
      context,
      aborted: false,
    },
  ]);
});

test('OAuth presentation capability contains backend and invalid paste failures', async () => {
  const backendFailure = createOAuthPresentationNativeCapability({
    openExternal: async () => {
      throw new Error('raw native failure');
    },
    requestAuthorizationCode: async () => 'unused',
  });
  const context = { ownerId: 'oauth-login', attemptId: 'attempt-1' } as const;
  const outcome = await backendFailure.handle(
    frame({
      kind: 'open_external',
      input: { url: 'https://example.test/authorize' },
      context,
    }),
    { signal: new AbortController().signal },
  );
  assert.deepEqual(outcome, { ok: false, code: 'operation_failed' });

  const invalidPaste = createOAuthPresentationNativeCapability({
    openExternal: async () => {},
    requestAuthorizationCode: async () => '',
  });
  const invalid = await invalidPaste.handle(
    frame({
      kind: 'request_authorization_code',
      input: { url: 'https://example.test/authorize', stateHint: 'abcd1234' },
      context,
    }),
    { signal: new AbortController().signal },
  );
  assert.deepEqual(invalid, { ok: false, code: 'operation_failed' });
});

function frame(
  subcall: NativeProviderOAuthPresentationSubcallFrame['subcall'],
): NativeProviderOAuthPresentationSubcallFrame {
  return {
    kind: 'native.provider.subcall',
    hostEpoch: 'epoch-1',
    operationId: 'operation-1',
    subcallId: 'subcall-1',
    ordinal: 1,
    bindingId: 'binding-1',
    capability: 'oauth_presentation',
    subcall,
  };
}
