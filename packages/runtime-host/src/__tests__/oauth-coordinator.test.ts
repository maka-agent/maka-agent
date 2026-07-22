import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import {
  OAuthTokenEndpointError,
  parseOAuthSubscriptionTokens,
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '@maka/runtime';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  RuntimePolicyStoreError,
} from '@maka/storage/runtime-policy-stores';
import type {
  NativeProviderHostFrame,
  NativeProviderOAuthPresentationSubcallFrame,
} from '../protocol/index.js';
import { HostNativeProviderCoordinator } from '../server/native-provider-coordinator.js';
import { HostOAuthCoordinator, HostOAuthFatalError } from '../server/oauth-coordinator.js';

const CONNECTION_CONTEXT = {
  hostEpoch: 'host-epoch',
  connectionId: 'client-a',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
} as const;

test('freezes the initiating provider and cancellation cannot cross the exchange cut', async () => {
  await withFixture(async (fixture) => {
    const exchangeEntered = deferred<void>();
    const releaseExchange = deferred<void>();
    fixture.exchange = async () => {
      exchangeEntered.resolve();
      await releaseExchange.promise;
      return claudeTokens('new-access', 'new-refresh');
    };
    const oauth = fixture.createOAuth();
    try {
      const provider = await fixture.attachOAuthProvider('client-a');
      await fixture.attachOAuthProvider('client-b');

      const started = await oauth.handlers['oauth.login.start'](
        { attemptId: 'attempt-1', connectionId: fixture.connectionId },
        CONNECTION_CONTEXT,
      );
      assert.equal(started.ok, true);
      if (!started.ok) return;
      assert.equal(started.result.phase, 'awaiting_authorization');

      const retry = await oauth.handlers['oauth.login.start'](
        { attemptId: 'attempt-1', connectionId: fixture.connectionId },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(retry, started);
      const conflict = await oauth.handlers['oauth.login.start'](
        { attemptId: 'attempt-2', connectionId: fixture.connectionId },
        CONNECTION_CONTEXT,
      );
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error.code, 'authorization_in_progress');

      const call = await nextOAuthCall(provider.sent);
      const url = new URL(call.subcall.input.url);
      const state = url.searchParams.get('state');
      assert.ok(state);
      provider.attachment.accept({
        kind: 'native.provider.result',
        hostEpoch: call.hostEpoch,
        operationId: call.operationId,
        subcallId: call.subcallId,
        ordinal: call.ordinal,
        bindingId: call.bindingId,
        capability: 'oauth_presentation',
        ok: true,
        result: { kind: 'request_authorization_code', payload: `code-value#${state}` },
      });
      await exchangeEntered.promise;

      const cancelled = await oauth.handlers['oauth.login.cancel'](
        { attemptId: 'attempt-1' },
        CONNECTION_CONTEXT,
      );
      assert.equal(cancelled.ok, true);
      if (cancelled.ok) assert.equal(cancelled.result.phase, 'exchanging');
      releaseExchange.resolve();
      await assertAttemptSettledInPhase(oauth, 'attempt-1', 'authenticated');
      const terminalQuery = await oauth.handlers['oauth.login.query'](
        { attemptId: 'attempt-1' },
        CONNECTION_CONTEXT,
      );
      const terminalCancel = await oauth.handlers['oauth.login.cancel'](
        { attemptId: 'attempt-1' },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(terminalCancel, terminalQuery);
      const terminalRetry = await oauth.handlers['oauth.login.start'](
        { attemptId: 'attempt-1', connectionId: fixture.connectionId },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(terminalRetry, terminalQuery);
      const mismatchedRetry = await oauth.handlers['oauth.login.start'](
        { attemptId: 'attempt-1', connectionId: 'other-connection' },
        CONNECTION_CONTEXT,
      );
      assert.equal(mismatchedRetry.ok, false);
      if (!mismatchedRetry.ok) assert.equal(mismatchedRetry.error.code, 'invalid_request');

      const status = await fixture.stores.credentialVault.getStatus({
        scope: 'connection',
        connectionId: fixture.connectionId,
        kind: 'oauth_token',
      });
      assert.equal(status.kind, 'status');
      if (status.kind === 'status') assert.equal(status.status.configured, true);
      const resolved = await fixture.stores.operations.resolveExecutionConnection('oauth-test');
      assert.equal(resolved.kind, 'ready');
      if (resolved.kind === 'ready') {
        const persisted = parseOAuthSubscriptionTokens(
          resolved.secretMaterial.connection?.secret ?? '',
        );
        assert.equal(persisted?.account_uuid, 'account-uuid');
        assert.match(persisted?.device_id ?? '', /^[0-9a-f]{64}$/);
      }
      assert.equal(fixture.invalidations, 1);
      assert.deepEqual(
        provider.sent.filter((frame) => frame.kind === 'native.provider.subcall').length,
        1,
      );
    } finally {
      releaseExchange.resolve();
    }
  });
});

test('rejects a Claude exchange without account metadata before credential commit', async () => {
  await withFixture(async (fixture) => {
    fixture.exchange = async () => tokens('missing-account-access', 'missing-account-refresh');
    const oauth = fixture.createOAuth();
    const provider = await fixture.attachOAuthProvider('client-a');
    const started = await oauth.handlers['oauth.login.start'](
      { attemptId: 'missing-account', connectionId: fixture.connectionId },
      CONNECTION_CONTEXT,
    );
    assert.equal(started.ok, true);
    const call = await nextOAuthCall(provider.sent);
    const state = new URL(call.subcall.input.url).searchParams.get('state');
    assert.ok(state);
    provider.attachment.accept({
      kind: 'native.provider.result',
      hostEpoch: call.hostEpoch,
      operationId: call.operationId,
      subcallId: call.subcallId,
      ordinal: call.ordinal,
      bindingId: call.bindingId,
      capability: 'oauth_presentation',
      ok: true,
      result: { kind: 'request_authorization_code', payload: `code-value#${state}` },
    });

    await oauth.whenCurrentEffectsSettled();
    assert.deepEqual(
      await oauth.handlers['oauth.login.query'](
        { attemptId: 'missing-account' },
        CONNECTION_CONTEXT,
      ),
      {
        ok: true,
        result: {
          attemptId: 'missing-account',
          connectionId: fixture.connectionId,
          provider: 'claude-subscription',
          phase: 'failed',
          failure: 'authorization_failed',
        },
      },
    );
    const status = await fixture.stores.credentialVault.getStatus({
      scope: 'connection',
      connectionId: fixture.connectionId,
      kind: 'oauth_token',
    });
    assert.equal(status.kind, 'status');
    if (status.kind === 'status') assert.equal(status.status.configured, false);
    assert.equal(
      (await fixture.stores.operations.resolveExecutionConnection('oauth-test')).kind,
      'credential_not_configured',
    );
    assert.equal(fixture.invalidations, 0);
  });
});

test('cancels a pre-cut presentation without exchange or credential commit', async () => {
  await withFixture(async (fixture) => {
    let exchanges = 0;
    fixture.exchange = async () => {
      exchanges += 1;
      return tokens('unexpected', 'unexpected');
    };
    const oauth = fixture.createOAuth();
    const provider = await fixture.attachOAuthProvider('client-a');
    const started = await oauth.handlers['oauth.login.start'](
      { attemptId: 'attempt-cancel', connectionId: fixture.connectionId },
      CONNECTION_CONTEXT,
    );
    assert.equal(started.ok, true);
    await nextOAuthCall(provider.sent);
    const cancelled = await oauth.handlers['oauth.login.cancel'](
      { attemptId: 'attempt-cancel' },
      CONNECTION_CONTEXT,
    );
    assert.equal(cancelled.ok, true);
    if (cancelled.ok) assert.equal(cancelled.result.phase, 'cancelled');
    assert.equal(
      provider.sent.some((frame) => frame.kind === 'native.provider.cancel'),
      true,
    );
    provider.attachment.close();
    await assertAttemptSettledInPhase(oauth, 'attempt-cancel', 'cancelled');
    assert.equal(exchanges, 0);
    const status = await fixture.stores.credentialVault.getStatus({
      scope: 'connection',
      connectionId: fixture.connectionId,
      kind: 'oauth_token',
    });
    assert.equal(status.kind, 'status');
    if (status.kind === 'status') assert.equal(status.status.configured, false);
  });
});

test('singleflights refresh by credential basis and CAS-deletes deterministic rejection', async () => {
  await withFixture(async (fixture) => {
    await seedOAuthCredential(fixture.stores, fixture.connectionId, tokens('old', 'refresh'));
    const refreshEntered = deferred<void>();
    const releaseRefresh = deferred<void>();
    let refreshCalls = 0;
    let rejectCredential = false;
    fixture.refresh = async () => {
      refreshCalls += 1;
      if (rejectCredential) throw new OAuthTokenEndpointError('invalid_grant', 400);
      refreshEntered.resolve();
      await releaseRefresh.promise;
      return tokens('refreshed', 'rotated');
    };
    const oauth = fixture.createOAuth();
    try {
      const first = oauth.handlers['oauth.credential.refresh'](
        { connectionId: fixture.connectionId },
        CONNECTION_CONTEXT,
      );
      const second = oauth.handlers['oauth.credential.refresh'](
        { connectionId: fixture.connectionId },
        CONNECTION_CONTEXT,
      );
      await refreshEntered.promise;
      assert.equal(refreshCalls, 1);
      releaseRefresh.resolve();
      assert.deepEqual(await first, { ok: true, result: { kind: 'refreshed' } });
      assert.deepEqual(await second, { ok: true, result: { kind: 'refreshed' } });

      rejectCredential = true;
      const rejected = await oauth.handlers['oauth.credential.refresh'](
        { connectionId: fixture.connectionId },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(rejected, { ok: true, result: { kind: 'relogin_required' } });
      const resolved = await fixture.stores.operations.resolveExecutionConnection('oauth-test');
      assert.equal(resolved.kind, 'credential_not_configured');
      assert.equal(fixture.invalidations, 2);
    } finally {
      releaseRefresh.resolve();
    }
  });
});

test('manual refresh preserves typed commit unknown after real publication and fatal reaction', {
  skip: process.platform === 'win32',
}, async () => {
  await withFixture(async (fixture) => {
    await seedOAuthCredential(fixture.stores, fixture.connectionId, tokens('old', 'refresh'));
    const events: string[] = [];
    fixture.refresh = async () => tokens('published-access', 'published-refresh');
    fixture.onFatal = (error) => {
      assert.ok(error instanceof HostOAuthFatalError);
      events.push('fatal');
    };
    const oauth = fixture.createOAuth();
    const probe = await open(fixture.root, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync: typeof probe.sync;
    };
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    let syncCalls = 0;
    const syncMock = mock.method(fileHandlePrototype, 'sync', async function (this: typeof probe) {
      syncCalls += 1;
      if (syncCalls === 2) throw new Error('injected directory sync reply loss');
      return originalSync.call(this);
    });

    const outcome = await (async () => {
      try {
        return await oauth.handlers['oauth.credential.refresh'](
          { connectionId: fixture.connectionId },
          CONNECTION_CONTEXT,
        );
      } finally {
        syncMock.mock.restore();
      }
    })();
    events.push('result');

    assert.deepEqual(outcome, {
      ok: false,
      error: {
        code: 'commit_outcome_unknown',
        message: 'OAuth credential commit outcome is unknown',
      },
    });
    assert.deepEqual(events, ['fatal', 'result']);
    assert.equal(fixture.invalidations, 1);
    assert.equal(syncCalls, 2);
    const published = await fixture.stores.operations.resolveExecutionConnection('oauth-test');
    assert.equal(published.kind, 'ready');
    if (published.kind === 'ready') {
      assert.equal(
        parseOAuthSubscriptionTokens(published.secretMaterial.connection?.secret ?? '')
          ?.access_token,
        'published-access',
      );
    }
  });
});

test('execution refresh does not repeat fatal reaction for a published unknown commit', {
  skip: process.platform === 'win32',
}, async () => {
  await withFixture(async (fixture) => {
    const oldTokens = tokens('old', 'refresh');
    await seedOAuthCredential(fixture.stores, fixture.connectionId, oldTokens);
    let fatalCalls = 0;
    fixture.refresh = async () => tokens('execution-published', 'execution-refresh');
    fixture.onFatal = () => {
      fatalCalls += 1;
    };
    const oauth = fixture.createOAuth();
    const probe = await open(fixture.root, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync: typeof probe.sync;
    };
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    let syncCalls = 0;
    const syncMock = mock.method(fileHandlePrototype, 'sync', async function (this: typeof probe) {
      syncCalls += 1;
      if (syncCalls === 2) throw new Error('injected directory sync reply loss');
      return originalSync.call(this);
    });

    try {
      await assert.rejects(
        oauth.resolveExecutionCredential({
          connectionId: fixture.connectionId,
          provider: 'claude-subscription',
          secret: serializeOAuthSubscriptionTokens(oldTokens),
        }),
        (error: unknown) =>
          error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown',
      );
    } finally {
      syncMock.mock.restore();
    }

    assert.equal(syncCalls, 2);
    assert.equal(fixture.invalidations, 1);
    assert.equal(fatalCalls, 1);
  });
});

test('refresh transport preserves the Runtime-owned deadline signal', async () => {
  await withFixture(async (fixture) => {
    const oldTokens = tokens('old', 'refresh');
    await seedOAuthCredential(fixture.stores, fixture.connectionId, oldTokens);
    const server = createServer((_request, response) => {
      response.writeHead(200).end('signal was overwritten');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      assert.fail('OAuth deadline test server did not expose a TCP address');
    }
    const port = address.port;
    fixture.refresh = async (input) => {
      const fetchFn = input.fetchFn;
      if (!fetchFn) assert.fail('Runtime Host refresh did not provide its transport fetch');
      const deadline = new AbortController();
      deadline.abort(new Error('Runtime OAuth deadline elapsed'));
      await assert.rejects(
        fetchFn(`http://127.0.0.1:${port}/stalled-token-endpoint`, {
          signal: deadline.signal,
        }),
        (error: unknown) => error === deadline.signal.reason,
      );
      return tokens('deadline-preserved', 'deadline-refresh');
    };
    const oauth = fixture.createOAuth();

    try {
      const outcome = await oauth.handlers['oauth.credential.refresh'](
        { connectionId: fixture.connectionId },
        CONNECTION_CONTEXT,
      );
      assert.deepEqual(outcome, { ok: true, result: { kind: 'refreshed' } });
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('execution consumers keep shared post-cut refresh alive after one caller cancels', async () => {
  await withFixture(async (fixture) => {
    const oldTokens = tokens('old', 'refresh');
    await seedOAuthCredential(fixture.stores, fixture.connectionId, oldTokens);
    const refreshEntered = deferred<void>();
    const releaseRefresh = deferred<void>();
    let refreshCalls = 0;
    fixture.refresh = async () => {
      refreshCalls += 1;
      refreshEntered.resolve();
      await releaseRefresh.promise;
      return tokens('shared-access', 'shared-refresh');
    };
    const oauth = fixture.createOAuth();
    const firstAbort = new AbortController();
    try {
      const first = oauth.resolveExecutionCredential({
        connectionId: fixture.connectionId,
        provider: 'claude-subscription',
        secret: serializeOAuthSubscriptionTokens(oldTokens),
        signal: firstAbort.signal,
      });
      const second = oauth.resolveExecutionCredential({
        connectionId: fixture.connectionId,
        provider: 'claude-subscription',
        secret: serializeOAuthSubscriptionTokens(oldTokens),
      });
      await refreshEntered.promise;
      firstAbort.abort(new Error('first execution stopped'));
      releaseRefresh.resolve();

      assert.equal((await first).tokens.access_token, 'shared-access');
      assert.equal((await second).tokens.access_token, 'shared-access');
      assert.equal(refreshCalls, 1);
    } finally {
      releaseRefresh.resolve();
    }
  });
});

test('pre-cut cancellation detaches only its execution consumer from a queued refresh', {
  timeout: 5_000,
}, async (testContext) => {
  await withFixture(async (fixture) => {
    const oldTokens = tokens('old', 'refresh');
    await seedOAuthCredential(fixture.stores, fixture.connectionId, oldTokens);
    const refreshEntered = deferred<void>();
    const releaseRefresh = deferred<void>();
    let refreshCalls = 0;
    fixture.refresh = async () => {
      refreshCalls += 1;
      refreshEntered.resolve();
      await releaseRefresh.promise;
      return tokens('surviving-access', 'surviving-refresh');
    };
    const oauth = fixture.createOAuth();
    const provider = await fixture.attachOAuthProvider('client-a');
    await oauth.handlers['oauth.login.start'](
      { attemptId: 'tail-blocking-login', connectionId: fixture.connectionId },
      CONNECTION_CONTEXT,
    );
    await nextOAuthCall(provider.sent);

    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstAttached = deferred<void>();
    const secondAttached = deferred<void>();
    const firstAddEventListener = firstAbort.signal.addEventListener.bind(firstAbort.signal);
    const secondAddEventListener = secondAbort.signal.addEventListener.bind(secondAbort.signal);
    const firstListenerMock = mock.method(
      firstAbort.signal,
      'addEventListener',
      (...args: Parameters<AbortSignal['addEventListener']>) => {
        if (args[0] === 'abort') firstAttached.resolve();
        return firstAddEventListener(...args);
      },
    );
    const secondListenerMock = mock.method(
      secondAbort.signal,
      'addEventListener',
      (...args: Parameters<AbortSignal['addEventListener']>) => {
        if (args[0] === 'abort') secondAttached.resolve();
        return secondAddEventListener(...args);
      },
    );

    try {
      const first = oauth.resolveExecutionCredential({
        connectionId: fixture.connectionId,
        provider: 'claude-subscription',
        secret: serializeOAuthSubscriptionTokens(oldTokens),
        signal: firstAbort.signal,
      });
      const second = oauth.resolveExecutionCredential({
        connectionId: fixture.connectionId,
        provider: 'claude-subscription',
        secret: serializeOAuthSubscriptionTokens(oldTokens),
        signal: secondAbort.signal,
      });
      await waitForGate(
        Promise.all([firstAttached.promise, secondAttached.promise]),
        testContext.signal,
      );

      firstAbort.abort(new Error('first execution cancelled before refresh dispatch'));
      await assert.rejects(first, /cancelled before dispatch/);
      const cancelled = await oauth.handlers['oauth.login.cancel'](
        { attemptId: 'tail-blocking-login' },
        CONNECTION_CONTEXT,
      );
      assert.equal(cancelled.ok, true);
      provider.attachment.close();

      await refreshEntered.promise;
      releaseRefresh.resolve();
      assert.equal((await second).tokens.access_token, 'surviving-access');
      assert.equal(refreshCalls, 1);
    } finally {
      firstListenerMock.mock.restore();
      secondListenerMock.mock.restore();
      releaseRefresh.resolve();
      provider.attachment.close();
    }
  });
});

test('Codex loopback validates method, path, and state before claiming a success callback', async () => {
  await withFixture(async (fixture) => {
    let exchangedCode: string | undefined;
    fixture.exchange = async (input) => {
      exchangedCode = input.code;
      return tokens('codex-access', 'codex-refresh');
    };
    const oauth = fixture.createOAuth();
    const provider = await fixture.attachOAuthProvider('client-a');
    const started = await oauth.handlers['oauth.login.start'](
      { attemptId: 'codex-success', connectionId: fixture.connectionId },
      CONNECTION_CONTEXT,
    );
    assert.equal(started.ok, true);
    const call = await nextOAuthCall(provider.sent);
    assert.equal(call.subcall.kind, 'open_external');
    if (call.subcall.kind !== 'open_external') {
      assert.fail('Codex login did not request external authorization presentation');
    }
    const state = new URL(call.subcall.input.url).searchParams.get('state');
    assert.ok(state);
    acceptOAuthPresentation(provider.attachment, call);

    assert.equal(await callbackStatus(`/auth/callback?code=good&state=${state}`, 'POST'), 405);
    assert.equal(await callbackStatus(`/wrong?code=good&state=${state}`), 400);
    assert.equal(await callbackStatus('/auth/callback?code=good&state=wrong-state'), 400);
    assert.equal(
      await callbackStatus(`/auth/callback?code=${'x'.repeat(8 * 1024 + 1)}&state=${state}`),
      400,
    );
    const stillPending = await oauth.handlers['oauth.login.query'](
      { attemptId: 'codex-success' },
      CONNECTION_CONTEXT,
    );
    assert.equal(stillPending.ok, true);
    if (stillPending.ok) assert.equal(stillPending.result.phase, 'awaiting_authorization');

    assert.equal(await callbackStatus(`/auth/callback?code=bounded-code&state=${state}`), 200);
    await assertAttemptSettledInPhase(oauth, 'codex-success', 'authenticated');
    assert.equal(exchangedCode, 'bounded-code');
    const resolved = await fixture.stores.operations.resolveExecutionConnection('oauth-test');
    assert.equal(resolved.kind, 'ready');
    if (resolved.kind === 'ready') {
      const persisted = parseOAuthSubscriptionTokens(
        resolved.secretMaterial.connection?.secret ?? '',
      );
      assert.equal(persisted?.device_id, undefined);
    }
  }, 'openai-codex');
});

test('Codex denial validates state and settles to the fixed provider_rejected projection', async () => {
  await withFixture(async (fixture) => {
    let exchanges = 0;
    fixture.exchange = async () => {
      exchanges += 1;
      return tokens('unexpected', 'unexpected');
    };
    const oauth = fixture.createOAuth();
    const provider = await fixture.attachOAuthProvider('client-a');
    await oauth.handlers['oauth.login.start'](
      { attemptId: 'codex-denied', connectionId: fixture.connectionId },
      CONNECTION_CONTEXT,
    );
    const call = await nextOAuthCall(provider.sent);
    const state = new URL(call.subcall.input.url).searchParams.get('state');
    assert.ok(state);
    acceptOAuthPresentation(provider.attachment, call);

    assert.equal(await callbackStatus('/auth/callback?error=access_denied&state=wrong'), 400);
    assert.equal(
      await callbackStatus(`/auth/callback?error=access_denied&state=${state}&unknown=value`),
      400,
    );
    assert.equal(
      await callbackStatus(`/auth/callback?error=access_denied&error=second&state=${state}`),
      400,
    );
    assert.equal(
      await callbackStatus(
        `/auth/callback?error=provider-private-detail&state=${state}` +
          '&error_description=private+provider+description' +
          '&error_uri=https%3A%2F%2Fprovider.example%2Fprivate-error',
      ),
      200,
    );
    await oauth.whenCurrentEffectsSettled();
    const denied = await oauth.handlers['oauth.login.query'](
      { attemptId: 'codex-denied' },
      CONNECTION_CONTEXT,
    );
    assert.deepEqual(denied, {
      ok: true,
      result: {
        attemptId: 'codex-denied',
        connectionId: fixture.connectionId,
        provider: 'openai-codex',
        phase: 'failed',
        failure: 'provider_rejected',
      },
    });
    assert.equal(exchanges, 0);
  }, 'openai-codex');
});

test('Codex cancel closes the loopback listener before the effect settles', async () => {
  await withFixture(async (fixture) => {
    const oauth = fixture.createOAuth();
    const provider = await fixture.attachOAuthProvider('client-a');
    await oauth.handlers['oauth.login.start'](
      { attemptId: 'codex-cancel', connectionId: fixture.connectionId },
      CONNECTION_CONTEXT,
    );
    await nextOAuthCall(provider.sent);
    const cancelled = await oauth.handlers['oauth.login.cancel'](
      { attemptId: 'codex-cancel' },
      CONNECTION_CONTEXT,
    );
    assert.equal(cancelled.ok, true);
    await assert.rejects(callbackStatus('/auth/callback?code=late&state=late'));
  }, 'openai-codex');
});

test('Codex drain closes the loopback listener before coordinator close returns', async () => {
  await withFixture(async (fixture) => {
    const oauth = fixture.createOAuth();
    const provider = await fixture.attachOAuthProvider('client-a');
    await oauth.handlers['oauth.login.start'](
      { attemptId: 'codex-drain', connectionId: fixture.connectionId },
      CONNECTION_CONTEXT,
    );
    await nextOAuthCall(provider.sent);
    oauth.beginDrain();
    await assert.rejects(callbackStatus('/auth/callback?code=late&state=late'));
  }, 'openai-codex');
});

type Stores = Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;

interface Fixture {
  readonly stores: Stores;
  readonly root: string;
  readonly connectionId: string;
  invalidations: number;
  onFatal: (error: HostOAuthFatalError) => void;
  exchange: NonNullable<ConstructorParameters<typeof HostOAuthCoordinator>[0]['exchangeCode']>;
  refresh: NonNullable<ConstructorParameters<typeof HostOAuthCoordinator>[0]['refreshTokens']>;
  attachOAuthProvider(connectionId: string): ReturnType<typeof attachOAuthProvider>;
  createOAuth(): HostOAuthCoordinator;
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  providerType: 'claude-subscription' | 'openai-codex' = 'claude-subscription',
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-oauth-coordinator-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) {
    await rm(base, { recursive: true, force: true });
    assert.fail('OAuth coordinator fixture could not acquire its Storage root');
  }
  const oauthCoordinators = new Set<HostOAuthCoordinator>();
  const attachments = new Set<Awaited<ReturnType<typeof attachOAuthProvider>>['attachment']>();
  let native: HostNativeProviderCoordinator | undefined;
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'oauth-test',
        name: 'OAuth test',
        providerType,
        enabled: true,
        enabledModelIds: [],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const nativeCoordinator = new HostNativeProviderCoordinator('host-epoch', () => ({
      release() {},
    }));
    native = nativeCoordinator;
    const fixture: Fixture = {
      stores,
      root,
      connectionId: connection.connectionId,
      invalidations: 0,
      onFatal: (error) => assert.fail(error.message),
      exchange: async () =>
        providerType === 'claude-subscription'
          ? claudeTokens('default', 'default-refresh')
          : tokens('default', 'default-refresh'),
      refresh: async (input) => input.tokens,
      async attachOAuthProvider(connectionId) {
        const provider = await attachOAuthProvider(nativeCoordinator, connectionId);
        attachments.add(provider.attachment);
        return provider;
      },
      createOAuth() {
        const oauth = new HostOAuthCoordinator({
          runtimePolicy: stores,
          nativeProvider: nativeCoordinator,
          acquireResidency: () => ({ release() {} }),
          invalidateBackends: async () => {
            fixture.invalidations += 1;
          },
          onFatal: (error) => fixture.onFatal(error),
          exchangeCode: (input) => fixture.exchange(input),
          refreshTokens: (input) => fixture.refresh(input),
        });
        oauthCoordinators.add(oauth);
        return oauth;
      },
    };
    await run(fixture);
  } finally {
    for (const oauth of oauthCoordinators) oauth.beginDrain();
    for (const attachment of attachments) attachment.close();
    await Promise.allSettled([...oauthCoordinators].map((oauth) => oauth.close()));
    native?.beginDrain();
    try {
      await native?.close();
    } finally {
      try {
        await owner.close();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  }
}

async function seedOAuthCredential(
  stores: Stores,
  connectionId: string,
  value: OAuthSubscriptionTokens,
): Promise<void> {
  const admitted = await stores.operations.beginInteractiveOAuthLogin(connectionId);
  assert.equal(admitted.kind, 'ready');
  if (admitted.kind !== 'ready') return;
  const committed = await stores.operations.completeInteractiveOAuthLogin(admitted.ticket, {
    secret: serializeOAuthSubscriptionTokens(value),
  });
  assert.equal(committed.kind, 'committed');
}

async function attachOAuthProvider(
  coordinator: HostNativeProviderCoordinator,
  connectionId: string,
): Promise<{
  readonly sent: NativeProviderHostFrame[];
  readonly attachment: ReturnType<HostNativeProviderCoordinator['attachConnection']>;
}> {
  const sent: NativeProviderHostFrame[] = [];
  const attachment = coordinator.attachConnection(connectionId, {
    enqueue: (frame) => {
      sent.push(frame);
      return { flushed: Promise.resolve() };
    },
    close() {},
  });
  const registered = await coordinator.handlers['native.provider.register'](
    { capabilities: ['oauth_presentation'] },
    { ...CONNECTION_CONTEXT, connectionId },
  );
  assert.equal(registered.ok, true);
  return { sent, attachment };
}

async function nextOAuthCall(
  sent: NativeProviderHostFrame[],
): Promise<NativeProviderOAuthPresentationSubcallFrame> {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const frame = sent.find(
      (candidate): candidate is NativeProviderOAuthPresentationSubcallFrame =>
        candidate.kind === 'native.provider.subcall' &&
        candidate.capability === 'oauth_presentation',
    );
    if (frame) return frame;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('OAuth presentation call was not dispatched');
}

function acceptOAuthPresentation(
  attachment: ReturnType<HostNativeProviderCoordinator['attachConnection']>,
  call: NativeProviderOAuthPresentationSubcallFrame,
): void {
  attachment.accept({
    kind: 'native.provider.result',
    hostEpoch: call.hostEpoch,
    operationId: call.operationId,
    subcallId: call.subcallId,
    ordinal: call.ordinal,
    bindingId: call.bindingId,
    capability: 'oauth_presentation',
    ok: true,
    result: { kind: 'open_external', opened: true },
  });
}

async function callbackStatus(path: string, method = 'GET'): Promise<number> {
  const response = await fetch(`http://127.0.0.1:1455${path}`, { method });
  await response.arrayBuffer();
  return response.status;
}

async function assertAttemptSettledInPhase(
  oauth: HostOAuthCoordinator,
  attemptId: string,
  phase: 'authenticated' | 'cancelled',
): Promise<void> {
  await oauth.whenCurrentEffectsSettled();
  const result = await oauth.handlers['oauth.login.query']({ attemptId }, CONNECTION_CONTEXT);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.result.phase, phase);
}

function tokens(accessToken: string, refreshToken: string): OAuthSubscriptionTokens {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: 1,
  };
}

function claudeTokens(accessToken: string, refreshToken: string): OAuthSubscriptionTokens {
  return { ...tokens(accessToken, refreshToken), account_uuid: 'account-uuid' };
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

async function waitForGate(gate: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let rejectForAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectForAbort, { once: true });
  });
  try {
    await Promise.race([gate, aborted]);
  } finally {
    signal.removeEventListener('abort', rejectForAbort);
  }
}
