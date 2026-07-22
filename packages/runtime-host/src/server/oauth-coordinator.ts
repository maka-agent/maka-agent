import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { constantTimeStringEqual, parsePastedAuthorization } from '@maka/core';
import type { CredentialVersionBasis, RuntimePolicy } from '@maka/core/runtime-policy';
import {
  buildOAuthLoginAuthorization,
  createProxiedFetchTransport,
  exchangeOAuthAuthorizationCode,
  isDeterministicOAuthCredentialRejection,
  OAuthTokenEndpointError,
  parseOAuthSubscriptionTokens,
  refreshOAuthSubscriptionTokens,
  serializeOAuthSubscriptionTokens,
  TOKEN_REFRESH_SKEW_MS,
  type OAuthLoginProvider,
  type OAuthSubscriptionProvider,
  type OAuthSubscriptionTokens,
  type ProxiedFetchProxy,
} from '@maka/runtime';
import {
  RuntimePolicyStoreError,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import type {
  OAuthCredentialRefreshResult,
  OAuthLoginFailureCode,
  OAuthLoginProjection,
  OperationOutcome,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type {
  HostNativeProviderInvocation,
  HostNativeProviderService,
} from './native-provider-coordinator.js';
import type { OAuthOperationHandlerMap } from './operation-dispatcher.js';

const CODEX_CALLBACK_HOST = '127.0.0.1';
const CODEX_CALLBACK_PORT = 1455;
const CODEX_CALLBACK_PATH = '/auth/callback';
const CODEX_REDIRECT_URI = `http://localhost:${CODEX_CALLBACK_PORT}${CODEX_CALLBACK_PATH}`;
const OAUTH_OWNER_ID = 'oauth-login';
const CALLBACK_CODE_MAX_CHARS = 8 * 1024;
const CALLBACK_ERROR_MAX_CHARS = 1024;
const CALLBACK_ERROR_DESCRIPTION_MAX_CHARS = 8 * 1024;
const CALLBACK_ERROR_URI_MAX_CHARS = 8 * 1024;

export class HostOAuthFatalError extends Error {
  constructor(
    message: string,
    readonly fatalCause: unknown,
  ) {
    super(message, { cause: fatalCause });
    this.name = 'HostOAuthFatalError';
  }
}

export interface HostOAuthExecutionCredential {
  readonly tokens: OAuthSubscriptionTokens;
  readonly networkProxy?: RuntimePolicy['networkProxy'];
  readonly proxySecret?: string;
}

export interface HostOAuthCoordinatorInput {
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly nativeProvider: HostNativeProviderService;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly invalidateBackends: () => Promise<void>;
  readonly onFatal: (error: HostOAuthFatalError) => void;
  readonly now?: () => number;
  readonly refreshTokens?: typeof refreshOAuthSubscriptionTokens;
  readonly exchangeCode?: typeof exchangeOAuthAuthorizationCode;
}

interface ActiveLoginAttempt {
  readonly kind: 'active';
  readonly attemptId: string;
  readonly connectionId: string;
  readonly provider: OAuthLoginProvider;
  readonly verifier: string;
  readonly state: string;
  readonly authorizationUrl: string;
  readonly ticket: Awaited<
    ReturnType<RuntimePolicyStoresWriter['operations']['beginInteractiveOAuthLogin']>
  > & { readonly kind: 'ready' };
  readonly networkProxy: RuntimePolicy['networkProxy'];
  readonly proxySecret?: string;
  readonly invocation: HostNativeProviderInvocation;
  readonly abort: AbortController;
  readonly residency: RuntimeHostResidency;
  phase: OAuthLoginProjection['phase'];
  failure?: OAuthLoginFailureCode;
  postCut: boolean;
  settlement: Promise<void>;
}

interface TerminalLoginAttempt {
  readonly kind: 'terminal';
  readonly projection: OAuthLoginProjection;
}

type LoginAttemptRecord = ActiveLoginAttempt | TerminalLoginAttempt;

interface RefreshFlight {
  readonly abort: AbortController;
  readonly consumers: Set<RefreshConsumer>;
  readonly settlement: Promise<void>;
  readonly outcome: Promise<RefreshOutcome>;
  postCut: boolean;
}

interface RefreshConsumer {
  readonly kind: 'execution' | 'manual';
}

type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly credential: HostOAuthExecutionCredential }
  | { readonly kind: 'relogin_required' }
  | { readonly kind: 'superseded' };

/** Host-owned interactive login and stored OAuth mutation authority. */
export class HostOAuthCoordinator {
  readonly handlers: OAuthOperationHandlerMap = {
    'oauth.login.start': (input, context) => this.#start(input, context.connectionId),
    'oauth.login.query': (input) => this.#query(input.attemptId),
    'oauth.login.cancel': (input) => this.#cancel(input.attemptId),
    'oauth.credential.refresh': (input) => this.#manualRefresh(input.connectionId),
  };

  readonly #runtimePolicy: RuntimePolicyStoresWriter;
  readonly #nativeProvider: HostNativeProviderService;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #invalidateBackends: () => Promise<void>;
  readonly #onFatal: (error: HostOAuthFatalError) => void;
  readonly #now: () => number;
  readonly #refreshTokens: typeof refreshOAuthSubscriptionTokens;
  readonly #exchangeCode: typeof exchangeOAuthAuthorizationCode;
  readonly #attempts = new Map<string, LoginAttemptRecord>();
  readonly #connectionTails = new Map<string, Promise<void>>();
  readonly #refreshFlights = new Map<string, RefreshFlight>();
  readonly #fatalizedCommitUnknowns = new WeakSet<RuntimePolicyStoreError>();
  readonly #effectResidencies = new Set<RuntimeHostResidency>();
  #activeAttempt: ActiveLoginAttempt | undefined;
  #pendingStart:
    | {
        readonly attemptId: string;
        readonly connectionId: string;
        readonly result: Promise<OperationOutcome<'oauth.login.start'>>;
      }
    | undefined;
  #admissionClosed = false;
  #closeTask: Promise<void> | undefined;
  #failStop:
    | {
        readonly ownerIsolationBarrier: Promise<void>;
        readonly reclaimAfterOwnerIsolation: () => void;
      }
    | undefined;

  constructor(input: HostOAuthCoordinatorInput) {
    this.#runtimePolicy = input.runtimePolicy;
    this.#nativeProvider = input.nativeProvider;
    this.#acquireResidency = input.acquireResidency;
    this.#invalidateBackends = input.invalidateBackends;
    this.#onFatal = input.onFatal;
    this.#now = input.now ?? Date.now;
    this.#refreshTokens = input.refreshTokens ?? refreshOAuthSubscriptionTokens;
    this.#exchangeCode = input.exchangeCode ?? exchangeOAuthAuthorizationCode;
  }

  async resolveExecutionCredential(input: {
    readonly connectionId: string;
    readonly provider: OAuthSubscriptionProvider;
    readonly secret: string;
    readonly signal?: AbortSignal;
  }): Promise<HostOAuthExecutionCredential> {
    const current = parseOAuthSubscriptionTokens(input.secret);
    if (!current) throw new Error('Runtime Host stored OAuth credential is invalid');
    if (current.expires_at - this.#now() > TOKEN_REFRESH_SKEW_MS) return { tokens: current };
    input.signal?.throwIfAborted();
    let refreshed: RefreshOutcome;
    try {
      refreshed = await this.#refresh(input.connectionId, 'execution', input.signal);
    } catch (error) {
      if (
        error instanceof HostOAuthFatalError ||
        error instanceof RefreshCancelledError ||
        this.#isFatalizedCommitUnknown(error)
      ) {
        throw error;
      }
      const fatal = new HostOAuthFatalError('Runtime Host execution OAuth refresh failed', error);
      this.#onFatal(fatal);
      throw fatal;
    }
    if (refreshed.kind === 'refreshed') return refreshed.credential;
    if (refreshed.kind === 'relogin_required') {
      throw new Error('Runtime Host OAuth credential requires login');
    }
    throw new Error('Runtime Host OAuth credential changed during refresh');
  }

  whenCurrentEffectsSettled(): Promise<void> {
    return this.#whenEffectsSettled();
  }

  beginDrain(): void {
    if (this.#admissionClosed) return;
    this.#admissionClosed = true;
    if (this.#activeAttempt && !this.#activeAttempt.postCut) {
      this.#activeAttempt.phase = 'cancelled';
      this.#activeAttempt.abort.abort();
    }
    for (const flight of this.#refreshFlights.values()) {
      if (!flight.postCut) flight.abort.abort();
    }
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#closeOnce();
    return this.#closeTask;
  }

  prepareFailStop(): {
    readonly ownerIsolationBarrier: Promise<void>;
    readonly reclaimAfterOwnerIsolation: () => void;
  } {
    if (this.#failStop) return this.#failStop;
    this.beginDrain();
    let reclaimed = false;
    this.#failStop = Object.freeze({
      ownerIsolationBarrier: this.#whenEffectsSettled(),
      reclaimAfterOwnerIsolation: () => {
        if (reclaimed) return;
        reclaimed = true;
        this.#activeAttempt = undefined;
        this.#pendingStart = undefined;
        this.#attempts.clear();
        this.#refreshFlights.clear();
        this.#connectionTails.clear();
        for (const residency of this.#effectResidencies) residency.release();
        this.#effectResidencies.clear();
      },
    });
    return this.#failStop;
  }

  async #start(
    input: { readonly attemptId: string; readonly connectionId: string },
    initiatingConnectionId: string,
  ): Promise<OperationOutcome<'oauth.login.start'>> {
    const existing = this.#attempts.get(input.attemptId);
    if (existing) {
      if (projection(existing).connectionId !== input.connectionId) return invalidStartRetry();
      return { ok: true, result: projection(existing) };
    }
    if (this.#pendingStart) {
      if (
        this.#pendingStart.attemptId === input.attemptId &&
        this.#pendingStart.connectionId === input.connectionId
      ) {
        return this.#pendingStart.result;
      }
      return authorizationInProgress();
    }
    if (this.#activeAttempt) return authorizationInProgress();
    if (this.#admissionClosed) return hostDraining('oauth.login.start');

    const result = this.#prepareStart(input, initiatingConnectionId);
    this.#pendingStart = { ...input, result };
    try {
      return await result;
    } finally {
      if (this.#pendingStart?.result === result) this.#pendingStart = undefined;
    }
  }

  async #prepareStart(
    input: { readonly attemptId: string; readonly connectionId: string },
    initiatingConnectionId: string,
  ): Promise<OperationOutcome<'oauth.login.start'>> {
    let admitted: Awaited<
      ReturnType<RuntimePolicyStoresWriter['operations']['beginInteractiveOAuthLogin']>
    >;
    try {
      admitted = await this.#runtimePolicy.operations.beginInteractiveOAuthLogin(
        input.connectionId,
      );
    } catch (error) {
      return this.#storeStartFailure(error);
    }
    if (admitted.kind === 'connection_not_found') return notFound('OAuth connection was not found');
    if (admitted.kind !== 'ready') {
      return invalidRequest('Connection cannot start an interactive OAuth login');
    }
    const provider = admitted.catalogConnection.providerType;
    if (provider !== 'claude-subscription' && provider !== 'openai-codex') {
      return invalidRequest('Connection does not use an interactive OAuth provider');
    }
    if (this.#admissionClosed) return hostDraining('oauth.login.start');
    const invocationAcquisition = this.#nativeProvider.acquireHostOperationInvocation({
      operationId: `oauth:${input.attemptId}`,
      ownerId: OAUTH_OWNER_ID,
      attemptId: input.attemptId,
      initiatingClientConnectionId: initiatingConnectionId,
      capability: 'oauth_presentation',
    });
    if (!invocationAcquisition.ok) {
      return {
        ok: false,
        error: {
          code: 'capability_unavailable',
          message: 'Initiating Client cannot present this OAuth login',
        },
      };
    }
    const verifier = randomOpaqueValue();
    const state = randomOpaqueValue();
    const authorization = buildOAuthLoginAuthorization({
      provider,
      verifier,
      state,
      ...(provider === 'openai-codex' ? { redirectUri: CODEX_REDIRECT_URI } : {}),
    });
    const attempt: ActiveLoginAttempt = {
      kind: 'active',
      attemptId: input.attemptId,
      connectionId: input.connectionId,
      provider,
      verifier,
      state,
      authorizationUrl: authorization.authorizationUrl,
      ticket: admitted,
      networkProxy: admitted.networkProxy,
      ...(admitted.secretMaterial.networkProxy
        ? { proxySecret: admitted.secretMaterial.networkProxy.secret }
        : {}),
      invocation: invocationAcquisition.invocation,
      abort: new AbortController(),
      residency: this.#acquireResidency(),
      phase: 'awaiting_authorization',
      postCut: false,
      settlement: Promise.resolve(),
    };
    this.#attempts.set(attempt.attemptId, attempt);
    this.#effectResidencies.add(attempt.residency);
    this.#activeAttempt = attempt;
    attempt.settlement = this.#scheduleConnectionEffect(attempt.connectionId, () =>
      this.#runLogin(attempt),
    );
    observe(attempt.settlement);
    return { ok: true, result: projection(attempt) };
  }

  #query(attemptId: string): Promise<OperationOutcome<'oauth.login.query'>> {
    const attempt = this.#attempts.get(attemptId);
    return Promise.resolve(
      attempt ? { ok: true, result: projection(attempt) } : notFound('OAuth login was not found'),
    );
  }

  #cancel(attemptId: string): Promise<OperationOutcome<'oauth.login.cancel'>> {
    const attempt = this.#attempts.get(attemptId);
    if (!attempt) return Promise.resolve(notFound('OAuth login was not found'));
    if (attempt.kind === 'active' && !attempt.postCut) {
      attempt.phase = 'cancelled';
      attempt.abort.abort();
    }
    return Promise.resolve({ ok: true, result: projection(attempt) });
  }

  async #runLogin(attempt: ActiveLoginAttempt): Promise<void> {
    let loopback: LoopbackClaim | undefined;
    let transport: ReturnType<typeof createProxiedFetchTransport> | undefined;
    try {
      let code: string;
      if (attempt.provider === 'claude-subscription') {
        const outcome = await attempt.invocation.call({
          subcall: {
            kind: 'request_authorization_code',
            input: {
              url: attempt.authorizationUrl,
              stateHint: attempt.state.slice(0, 8),
            },
            context: { ownerId: OAUTH_OWNER_ID, attemptId: attempt.attemptId },
          },
          signal: attempt.abort.signal,
        });
        if (!outcome.ok || outcome.result.kind !== 'request_authorization_code') {
          throw new LoginFailure('capability_unavailable');
        }
        const pasted = parsePastedAuthorization(outcome.result.payload);
        if (!pasted || !constantTimeStringEqual(pasted.state, attempt.state)) {
          throw new LoginFailure('authorization_failed');
        }
        code = pasted.code;
      } else {
        loopback = await openCodexLoopback(attempt.state, attempt.abort.signal);
        const outcome = await attempt.invocation.call({
          subcall: {
            kind: 'open_external',
            input: { url: attempt.authorizationUrl },
            context: { ownerId: OAUTH_OWNER_ID, attemptId: attempt.attemptId },
          },
          signal: attempt.abort.signal,
        });
        if (!outcome.ok || outcome.result.kind !== 'open_external') {
          throw new LoginFailure('capability_unavailable');
        }
        const callback = await loopback.callback;
        if (callback.kind === 'rejected') throw new LoginFailure('provider_rejected');
        code = callback.code;
      }

      // Final cancellation cut: no caller or drain signal reaches exchange or Store completion.
      attempt.abort.signal.throwIfAborted();
      attempt.postCut = true;
      attempt.phase = 'exchanging';
      const freshSignal = new AbortController().signal;
      transport = createProxiedFetchTransport(
        toProxySettings(attempt.networkProxy, attempt.proxySecret),
      );
      const exchangedTokens = await this.#exchangeCode({
        provider: attempt.provider,
        code,
        verifier: attempt.verifier,
        state: attempt.state,
        ...(attempt.provider === 'openai-codex' ? { redirectUri: CODEX_REDIRECT_URI } : {}),
        signal: freshSignal,
        fetchFn: transport.fetch,
        now: this.#now,
      });
      if (
        attempt.provider === 'claude-subscription' &&
        exchangedTokens.account_uuid === undefined
      ) {
        throw new LoginFailure('authorization_failed');
      }
      const tokens =
        attempt.provider === 'claude-subscription'
          ? { ...exchangedTokens, device_id: randomBytes(32).toString('hex') }
          : exchangedTokens;
      await transport.close();
      transport = undefined;
      attempt.phase = 'committing';
      const completion = await this.#runtimePolicy.operations.completeInteractiveOAuthLogin(
        attempt.ticket.ticket,
        { secret: serializeOAuthSubscriptionTokens(tokens) },
      );
      if (completion.kind !== 'committed') throw new LoginFailure('credential_changed');
      await this.#invalidateAfterCredentialMutation(
        'OAuth login committed but backend invalidation failed',
      );
      attempt.phase = 'authenticated';
    } catch (error) {
      if (!attempt.postCut && attempt.abort.signal.aborted) {
        attempt.phase = 'cancelled';
      } else {
        attempt.phase = 'failed';
        attempt.failure = loginFailureCode(error);
        if (isCommitOutcomeUnknown(error)) {
          await this.#fatalAfterInvalidation('OAuth login commit outcome is unknown', error);
        }
      }
    } finally {
      await closeLoopback(loopback);
      if (transport) await transport.close().catch(() => undefined);
      attempt.invocation.release();
      if (this.#activeAttempt === attempt) this.#activeAttempt = undefined;
      if (!this.#failStop) {
        this.#effectResidencies.delete(attempt.residency);
        attempt.residency.release();
      }
      if (this.#attempts.get(attempt.attemptId) === attempt) {
        this.#attempts.set(attempt.attemptId, terminalAttempt(attempt));
      }
    }
  }

  async #manualRefresh(
    connectionId: string,
  ): Promise<OperationOutcome<'oauth.credential.refresh'>> {
    if (this.#admissionClosed) return hostDraining('oauth.credential.refresh');
    try {
      const result = await this.#refresh(connectionId, 'manual');
      const projected: OAuthCredentialRefreshResult = { kind: result.kind };
      return { ok: true, result: projected };
    } catch (error) {
      if (isCommitOutcomeUnknown(error)) {
        return {
          ok: false,
          error: {
            code: 'commit_outcome_unknown',
            message: 'OAuth credential commit outcome is unknown',
          },
        };
      }
      if (error instanceof RuntimePolicyStoreError) {
        return {
          ok: false,
          error: { code: 'persistence_failed', message: 'OAuth credential persistence failed' },
        };
      }
      if (error instanceof RefreshAdmissionError) return error.outcome;
      return {
        ok: false,
        error: { code: 'internal_failure', message: 'OAuth credential refresh failed' },
      };
    }
  }

  async #refresh(
    connectionId: string,
    consumerKind: RefreshConsumer['kind'],
    signal?: AbortSignal,
  ): Promise<RefreshOutcome> {
    let admitted: Awaited<
      ReturnType<RuntimePolicyStoresWriter['operations']['beginStoredOAuthRefresh']>
    >;
    try {
      admitted = await this.#runtimePolicy.operations.beginStoredOAuthRefresh(connectionId);
    } catch (error) {
      throw error;
    }
    if (admitted.kind !== 'ready') throw new RefreshAdmissionError(admitted.kind);
    const basis = admitted.secretMaterial.connection;
    const key = credentialFlightKey(basis);
    const existing = this.#refreshFlights.get(key);
    if (existing && !existing.abort.signal.aborted) {
      return this.#awaitRefreshFlight(existing, consumerKind, signal);
    }

    const abort = new AbortController();
    let flight!: RefreshFlight;
    const outcome = this.#scheduleConnectionEffect(connectionId, async () => {
      abort.signal.throwIfAborted();
      const revalidated =
        await this.#runtimePolicy.operations.beginStoredOAuthRefresh(connectionId);
      abort.signal.throwIfAborted();
      if (revalidated.kind !== 'ready') {
        return revalidated.kind === 'credential_not_configured'
          ? { kind: 'relogin_required' as const }
          : { kind: 'superseded' as const };
      }
      const currentBasis = revalidated.secretMaterial.connection;
      if (credentialFlightKey(currentBasis) !== key) return { kind: 'superseded' as const };
      flight.postCut = true;
      const residency = this.#acquireResidency();
      this.#effectResidencies.add(residency);
      try {
        try {
          return await this.#runRefresh(revalidated, currentBasis);
        } catch (error) {
          if (
            [...flight.consumers].some((consumer) => consumer.kind === 'execution') &&
            !(error instanceof HostOAuthFatalError) &&
            !(error instanceof RefreshCancelledError) &&
            !this.#isFatalizedCommitUnknown(error)
          ) {
            const fatal = new HostOAuthFatalError(
              'Runtime Host execution OAuth refresh failed',
              error,
            );
            this.#onFatal(fatal);
            throw fatal;
          }
          throw error;
        }
      } finally {
        if (!this.#failStop) {
          this.#effectResidencies.delete(residency);
          residency.release();
        }
      }
    });
    const observedOutcome = outcome
      .catch((error: unknown) => {
        if (!flight.postCut && abort.signal.aborted) throw new RefreshCancelledError(error);
        throw error;
      })
      .finally(() => {
        if (this.#refreshFlights.get(key) === flight) this.#refreshFlights.delete(key);
      });
    const settlement = observedOutcome.then(
      () => undefined,
      () => undefined,
    );
    flight = {
      abort,
      consumers: new Set(),
      outcome: observedOutcome,
      settlement,
      postCut: false,
    };
    this.#refreshFlights.set(key, flight);
    observe(observedOutcome);
    if (this.#admissionClosed) abort.abort();
    return this.#awaitRefreshFlight(flight, consumerKind, signal);
  }

  #awaitRefreshFlight(
    flight: RefreshFlight,
    kind: RefreshConsumer['kind'],
    signal?: AbortSignal,
  ): Promise<RefreshOutcome> {
    if (signal?.aborted) {
      if (!flight.postCut && flight.consumers.size === 0) flight.abort.abort(signal.reason);
      throw new RefreshCancelledError(signal.reason);
    }
    const consumer: RefreshConsumer = { kind };
    flight.consumers.add(consumer);

    return new Promise<RefreshOutcome>((resolve, reject) => {
      let detached = false;
      const detach = () => {
        if (detached) return;
        detached = true;
        signal?.removeEventListener('abort', onAbort);
        flight.consumers.delete(consumer);
        if (!flight.postCut && flight.consumers.size === 0) flight.abort.abort(signal?.reason);
      };
      const onAbort = () => {
        if (flight.postCut) {
          signal?.removeEventListener('abort', onAbort);
          return;
        }
        detach();
        reject(new RefreshCancelledError(signal?.reason));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      flight.outcome.then(
        (result) => {
          detach();
          resolve(result);
        },
        (error: unknown) => {
          detach();
          reject(error);
        },
      );
    });
  }

  async #runRefresh(
    admitted: Extract<
      Awaited<ReturnType<RuntimePolicyStoresWriter['operations']['beginStoredOAuthRefresh']>>,
      { readonly kind: 'ready' }
    >,
    basis: CredentialVersionBasis & { readonly secret: string },
  ): Promise<RefreshOutcome> {
    const provider = admitted.connection.providerType;
    if (
      provider !== 'claude-subscription' &&
      provider !== 'openai-codex' &&
      provider !== 'github-copilot'
    ) {
      throw new Error('Stored OAuth refresh admitted a non-OAuth provider');
    }
    const current = parseOAuthSubscriptionTokens(basis.secret);
    if (!current) throw new Error('Runtime Host stored OAuth credential is invalid');
    const transport = createProxiedFetchTransport(
      toProxySettings(admitted.networkProxy, admitted.secretMaterial.networkProxy?.secret),
    );
    let refreshed: OAuthSubscriptionTokens | undefined;
    let refreshError: unknown;
    try {
      refreshed = await this.#refreshTokens({
        providerType: provider,
        tokens: current,
        now: this.#now,
        fetchFn: transport.fetch,
      });
    } catch (error) {
      refreshError = error;
    } finally {
      await transport.close();
    }
    if (refreshError !== undefined) {
      if (!isDeterministicOAuthCredentialRejection(refreshError)) throw refreshError;
      let deleted: Awaited<ReturnType<RuntimePolicyStoresWriter['credentialVault']['delete']>>;
      try {
        deleted = await this.#runtimePolicy.credentialVault.delete({
          expected: credentialBasis(basis),
        });
      } catch (deleteError) {
        if (isCommitOutcomeUnknown(deleteError)) {
          await this.#fatalAfterInvalidation(
            'OAuth credential deletion outcome is unknown',
            deleteError,
          );
        }
        throw deleteError;
      }
      if (deleted.kind === 'committed') {
        await this.#invalidateAfterCredentialMutation(
          'OAuth credential deletion committed but backend invalidation failed',
        );
        return { kind: 'relogin_required' };
      }
      return { kind: 'superseded' };
    }
    if (!refreshed) throw new Error('OAuth refresh returned no credential');

    try {
      const completion = await this.#runtimePolicy.operations.completeStoredOAuthRefresh(
        admitted.ticket,
        { secret: serializeOAuthSubscriptionTokens(refreshed) },
      );
      if (completion.kind !== 'committed') return { kind: 'superseded' };
      await this.#invalidateAfterCredentialMutation(
        'OAuth refresh committed but backend invalidation failed',
      );
      return {
        kind: 'refreshed',
        credential: {
          tokens: refreshed,
          networkProxy: admitted.networkProxy,
          ...(admitted.secretMaterial.networkProxy
            ? { proxySecret: admitted.secretMaterial.networkProxy.secret }
            : {}),
        },
      };
    } catch (error) {
      if (isCommitOutcomeUnknown(error)) {
        await this.#fatalAfterInvalidation('OAuth refresh commit outcome is unknown', error);
      }
      throw error;
    }
  }

  #scheduleConnectionEffect<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#connectionTails.get(connectionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    this.#connectionTails.set(connectionId, tail);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.#connectionTails.get(connectionId) === tail)
          this.#connectionTails.delete(connectionId);
      });
  }

  async #invalidateAfterCredentialMutation(message: string): Promise<void> {
    try {
      await this.#invalidateBackends();
    } catch (error) {
      const fatal = new HostOAuthFatalError(message, error);
      this.#onFatal(fatal);
      throw fatal;
    }
  }

  async #fatalAfterInvalidation(message: string, cause: RuntimePolicyStoreError): Promise<never> {
    let fatalCause: unknown = cause;
    try {
      await this.#invalidateBackends();
    } catch (invalidationError) {
      fatalCause = new AggregateError([cause, invalidationError], message);
    }
    const fatal = new HostOAuthFatalError(message, fatalCause);
    this.#fatalizedCommitUnknowns.add(cause);
    this.#onFatal(fatal);
    throw cause;
  }

  #isFatalizedCommitUnknown(error: unknown): error is RuntimePolicyStoreError {
    return error instanceof RuntimePolicyStoreError && this.#fatalizedCommitUnknowns.has(error);
  }

  #storeStartFailure(error: unknown): OperationOutcome<'oauth.login.start'> {
    if (error instanceof RuntimePolicyStoreError) {
      return {
        ok: false,
        error: { code: 'persistence_failed', message: 'OAuth login admission failed' },
      };
    }
    throw error;
  }

  async #whenEffectsSettled(): Promise<void> {
    const attempts = [...this.#attempts.values()]
      .filter((attempt): attempt is ActiveLoginAttempt => attempt.kind === 'active')
      .map((attempt) => attempt.settlement);
    const refreshes = [...this.#refreshFlights.values()].map((flight) => flight.settlement);
    await allSettledOrThrow([...attempts, ...refreshes], 'OAuth effects did not settle cleanly');
  }

  async #closeOnce(): Promise<void> {
    this.beginDrain();
    await this.#whenEffectsSettled();
  }
}

class LoginFailure extends Error {
  constructor(readonly code: OAuthLoginFailureCode) {
    super(code);
  }
}

class RefreshAdmissionError extends Error {
  readonly outcome: OperationOutcome<'oauth.credential.refresh'>;

  constructor(kind: string) {
    super(kind);
    this.outcome =
      kind === 'connection_not_found'
        ? notFound('OAuth connection was not found')
        : kind === 'credential_not_configured'
          ? { ok: true, result: { kind: 'relogin_required' } }
          : invalidRequest('Connection cannot refresh an OAuth credential');
  }
}

class RefreshCancelledError extends Error {
  constructor(reason: unknown) {
    super('OAuth refresh was cancelled before dispatch', { cause: reason });
  }
}

interface LoopbackClaim {
  readonly callback: Promise<LoopbackCallback>;
  close(): Promise<void>;
}

type LoopbackCallback =
  | { readonly kind: 'authorized'; readonly code: string }
  | { readonly kind: 'rejected' };

async function openCodexLoopback(state: string, signal: AbortSignal): Promise<LoopbackClaim> {
  let claimed = false;
  let resolveCallback!: (result: LoopbackCallback) => void;
  let rejectCallback!: (error: unknown) => void;
  const callback = new Promise<LoopbackCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '', `http://${CODEX_CALLBACK_HOST}:${CODEX_CALLBACK_PORT}`);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const callbackState = url.searchParams.get('state');
    if (
      claimed ||
      url.pathname !== CODEX_CALLBACK_PATH ||
      !callbackState ||
      !constantTimeStringEqual(callbackState, state)
    ) {
      response.writeHead(400).end();
      return;
    }
    const parameters = url.searchParams;
    const keys = [...parameters.keys()];
    const callbackCode = url.searchParams.get('code');
    const authorized =
      keys.length === 2 &&
      hasSingleParameter(parameters, 'code') &&
      hasSingleParameter(parameters, 'state') &&
      callbackCode !== null &&
      callbackCode.length > 0 &&
      callbackCode.length <= CALLBACK_CODE_MAX_CHARS;
    const denialKeys = new Set(['error', 'state', 'error_description', 'error_uri']);
    const callbackError = parameters.get('error');
    const rejected =
      keys.every((key) => denialKeys.has(key)) &&
      hasSingleParameter(parameters, 'error') &&
      hasSingleParameter(parameters, 'state') &&
      callbackError !== null &&
      callbackError.length > 0 &&
      callbackError.length <= CALLBACK_ERROR_MAX_CHARS &&
      optionalBoundedParameter(
        parameters,
        'error_description',
        CALLBACK_ERROR_DESCRIPTION_MAX_CHARS,
      ) &&
      optionalBoundedParameter(parameters, 'error_uri', CALLBACK_ERROR_URI_MAX_CHARS);
    if (!authorized && !rejected) {
      response.writeHead(400).end();
      return;
    }
    claimed = true;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(authorized ? 'Authorization received.' : 'Authorization rejected.');
    if (authorized) {
      resolveCallback({ kind: 'authorized', code: callbackCode ?? '' });
    } else {
      resolveCallback({ kind: 'rejected' });
    }
  });
  server.setTimeout(10_000, (socket) => socket.destroy());
  let closeTask: Promise<void> | undefined;
  const close = () => {
    closeTask ??= closeLoopbackServer(server);
    return closeTask;
  };
  const onAbort = () => {
    rejectCallback(signal.reason ?? new Error('OAuth login cancelled'));
    observe(close());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  server.on('error', rejectCallback);
  callback.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(CODEX_CALLBACK_PORT, CODEX_CALLBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { callback, close };
}

function hasSingleParameter(parameters: URLSearchParams, name: string): boolean {
  return parameters.getAll(name).length === 1;
}

function optionalBoundedParameter(
  parameters: URLSearchParams,
  name: string,
  maxChars: number,
): boolean {
  const values = parameters.getAll(name);
  return values.length === 0 || (values.length === 1 && values[0]!.length <= maxChars);
}

async function closeLoopback(loopback: LoopbackClaim | undefined): Promise<void> {
  if (!loopback) return;
  await loopback.close();
}

async function closeLoopbackServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function projection(attempt: LoginAttemptRecord): OAuthLoginProjection {
  if (attempt.kind === 'terminal') return attempt.projection;
  return {
    attemptId: attempt.attemptId,
    connectionId: attempt.connectionId,
    provider: attempt.provider,
    phase: attempt.phase,
    ...(attempt.phase === 'failed' ? { failure: attempt.failure ?? 'internal_failure' } : {}),
  };
}

function terminalAttempt(attempt: ActiveLoginAttempt): TerminalLoginAttempt {
  return Object.freeze({
    kind: 'terminal',
    projection: Object.freeze(projection(attempt)),
  });
}

function loginFailureCode(error: unknown): OAuthLoginFailureCode {
  if (error instanceof LoginFailure) return error.code;
  if (error instanceof RuntimePolicyStoreError) return 'persistence_failed';
  if (error instanceof OAuthTokenEndpointError) {
    return error.category === 'invalid_grant' || error.category === 'invalid_token'
      ? 'provider_rejected'
      : 'authorization_failed';
  }
  return 'internal_failure';
}

function credentialFlightKey(basis: CredentialVersionBasis): string {
  return `${basis.locator.scope}:${basis.locator.kind}:${basis.credentialId}:${basis.revision}`;
}

function credentialBasis(
  material: CredentialVersionBasis & { readonly secret: string },
): CredentialVersionBasis {
  return {
    locator: material.locator,
    credentialId: material.credentialId,
    revision: material.revision,
  };
}

function randomOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

function isCommitOutcomeUnknown(error: unknown): error is RuntimePolicyStoreError {
  return error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown';
}

function toProxySettings(
  proxy: RuntimePolicy['networkProxy'],
  password: string | undefined,
): ProxiedFetchProxy | null {
  if (!proxy.enabled) return null;
  return {
    enabled: true,
    type: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.authEnabled ? { username: proxy.username, password: password ?? '' } : {}),
    bypassList: [...new Set([...proxy.bypassList, ...proxy.autoBypassDomains])],
  };
}

function authorizationInProgress(): OperationOutcome<'oauth.login.start'> {
  return {
    ok: false,
    error: {
      code: 'authorization_in_progress',
      message: 'Another OAuth authorization is already in progress',
    },
  };
}

function invalidStartRetry(): OperationOutcome<'oauth.login.start'> {
  return invalidRequest('OAuth attemptId is already bound to another connection');
}

function invalidRequest(message: string): {
  readonly ok: false;
  readonly error: { readonly code: 'invalid_request'; readonly message: string };
} {
  return { ok: false, error: { code: 'invalid_request', message } };
}

function notFound(message: string): {
  readonly ok: false;
  readonly error: { readonly code: 'not_found'; readonly message: string };
} {
  return { ok: false, error: { code: 'not_found', message } };
}

function hostDraining<K extends 'oauth.login.start' | 'oauth.credential.refresh'>(
  _operation: K,
): OperationOutcome<K> {
  return {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host is draining' },
  } as OperationOutcome<K>;
}

async function allSettledOrThrow(
  tasks: readonly Promise<unknown>[],
  message: string,
): Promise<void> {
  const outcomes = await Promise.allSettled(tasks);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function observe(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}
