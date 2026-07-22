import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeOAuthCredentialRefreshResult,
  decodeOAuthLoginProjection,
  decodeRequestFrame,
  decodeResponseFrame,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

test('registers the four closed OAuth ordinary operations', () => {
  assert.deepEqual(
    Object.keys(HOST_OPERATION_SPECS).filter((key) => key.startsWith('oauth.')),
    ['oauth.login.start', 'oauth.login.query', 'oauth.login.cancel', 'oauth.credential.refresh'],
  );
  assert.equal(HOST_OPERATION_SPECS['oauth.login.start'].retry, 'semantic');
  assert.ok(HOST_OPERATION_SPECS['oauth.login.start'].errors.includes('authorization_in_progress'));
  assert.equal(HOST_OPERATION_SPECS['oauth.credential.refresh'].retry, 'none');
  assert.ok(
    HOST_OPERATION_SPECS['oauth.credential.refresh'].errors.includes('commit_outcome_unknown'),
  );
});

test('decodes exact OAuth inputs and rejects secret-bearing extensions', () => {
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-1',
      operation: 'oauth.login.start',
      input: { attemptId: 'attempt_1', connectionId: 'connection_1' },
    }),
    {
      requestId: 'request-1',
      operation: 'oauth.login.start',
      input: { attemptId: 'attempt_1', connectionId: 'connection_1' },
    },
  );
  for (const extra of [
    { url: 'https://example.test/authorize' },
    { state: 'complete-provider-state' },
    { code: 'authorization-code' },
    { token: 'secret-token' },
  ]) {
    assert.throws(
      () =>
        decodeRequestFrame({
          requestId: 'request-2',
          operation: 'oauth.login.start',
          input: { attemptId: 'attempt_1', connectionId: 'connection_1', ...extra },
        }),
      RuntimeHostProtocolError,
    );
  }
});

test('projects only safe OAuth attempt state and closed refresh outcomes', () => {
  assert.deepEqual(
    decodeOAuthLoginProjection({
      attemptId: 'attempt_1',
      connectionId: 'connection_1',
      provider: 'claude-subscription',
      phase: 'failed',
      failure: 'provider_rejected',
    }),
    {
      attemptId: 'attempt_1',
      connectionId: 'connection_1',
      provider: 'claude-subscription',
      phase: 'failed',
      failure: 'provider_rejected',
    },
  );
  assert.throws(
    () =>
      decodeOAuthLoginProjection({
        attemptId: 'attempt_1',
        connectionId: 'connection_1',
        provider: 'openai-codex',
        phase: 'failed',
        failure: 'provider_error: invalid_grant',
      }),
    RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeOAuthLoginProjection({
        attemptId: 'attempt_1',
        connectionId: 'connection_1',
        provider: 'openai-codex',
        phase: 'authenticated',
        accessToken: 'secret',
      }),
    RuntimeHostProtocolError,
  );
  assert.deepEqual(decodeOAuthCredentialRefreshResult({ kind: 'relogin_required' }), {
    kind: 'relogin_required',
  });
  assert.throws(
    () => decodeOAuthCredentialRefreshResult({ kind: 'refresh_failed', rawError: 'secret' }),
    RuntimeHostProtocolError,
  );
});

test('accepts not_found as the only absent-attempt response shape', () => {
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'request-3',
      operation: 'oauth.login.query',
      ok: false,
      error: { code: 'not_found', message: 'OAuth login was not found' },
    }),
    {
      requestId: 'request-3',
      operation: 'oauth.login.query',
      ok: false,
      error: { code: 'not_found', message: 'OAuth login was not found' },
    },
  );
  assert.throws(
    () =>
      decodeResponseFrame({
        requestId: 'request-4',
        operation: 'oauth.login.query',
        ok: true,
        result: { kind: 'stale', hostEpoch: 'old-epoch' },
      }),
    RuntimeHostProtocolError,
  );
});
