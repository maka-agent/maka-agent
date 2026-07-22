import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { prepareRuntimeHostEndpoint, type RuntimeHostEndpoint } from '../control/endpoint.js';
import { removeHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  decodeClientFrame,
  HOST_OPERATION_SPECS,
  negotiateProtocol,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type ClientHello,
  type HostOperationErrorCode,
  type HostHandshakeResult,
  type HostLifecycleState,
  type HostRegistration,
  type RequestFrame,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';
import {
  RuntimeHostConnectionSession,
  type ConnectionOperationLease,
} from './connection-session.js';
import {
  type AllDomainOperationHandlerMap,
  createUnavailableDomainOperationHandlers,
  type OperationResidency,
  type OperationHandlerMap,
} from './operation-dispatcher.js';
import type { SessionContinuityService } from './session-continuity-coordinator.js';
import type { HostNativeProviderService } from './native-provider-coordinator.js';

const DEFAULT_IDLE_GRACE_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const SHUTDOWN_HANDSHAKE_GRACE_MS = 1_000;
const SHUTDOWN_OPERATION_GRACE_MS = 1_000;
const HOST_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

interface KernelOperationToken {
  readonly command: boolean;
  sealed: boolean;
  finished: boolean;
}

interface KernelResidencyToken {
  released: boolean;
}

interface AcceptedConnectionSettlement {
  notify(): Promise<void>;
  finish(): void;
}

interface HandshakeAdmission {
  readonly result: HostHandshakeResult;
  readonly connectionSettlement?: AcceptedConnectionSettlement;
}

/** Kernel-issued residency whose release is synchronous, idempotent, and no-throw. */
export type RuntimeHostResidency = OperationResidency;

export interface RuntimeHostFailStopDisposition {
  readonly kind: 'fail_stop';
  readonly cause: unknown;
  /** Must settle before the root owner may begin isolation. */
  readonly ownerIsolationBarrier: Promise<void>;
  readonly reclaimAfterOwnerIsolation: () => void;
}

export type RuntimeHostCompositionCloseResult =
  | { readonly kind: 'clean' }
  | RuntimeHostFailStopDisposition;

export interface RuntimeHostCompositionContext {
  owner: InteractiveRootOwner;
  hostEpoch: string;
  acquireResidency(): RuntimeHostResidency;
  requestDrain(): void;
  requestFailStop(disposition: RuntimeHostFailStopDisposition): void;
}

export interface RuntimeHostComposition {
  readonly handlers: AllDomainOperationHandlerMap;
  readonly continuity?: SessionContinuityService;
  readonly nativeProvider?: HostNativeProviderService;
  onConnectionSettled?(connectionId: string): Promise<void>;
  /** Synchronously closes domain admission without residency or I/O. */
  beginDrain?(): void;
  recover(): Promise<void>;
  close(): Promise<RuntimeHostCompositionCloseResult>;
}

export type RuntimeHostCompositionFactory = (
  context: RuntimeHostCompositionContext,
) => Promise<RuntimeHostComposition>;

export interface RuntimeHostKernelOptions {
  owner: InteractiveRootOwner;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  compositionFactory?: RuntimeHostCompositionFactory;
}

export class RuntimeHostKernel {
  readonly hostEpoch = randomUUID();
  readonly closed: Promise<void>;
  readonly #options: RuntimeHostKernelOptions;
  readonly #createdAt = new Date().toISOString();
  readonly #server: Server;
  readonly #handshakingTransports = new Set<FramedTransport>();
  readonly #acceptedTransports = new Set<FramedTransport>();
  readonly #acceptedConnectionSettlements = new Set<Promise<void>>();
  readonly #connectionSettlementFailures: unknown[] = [];
  readonly #operationDrainWaiters = new Set<() => void>();
  readonly #operationTokens = new Set<KernelOperationToken>();
  readonly #commandTokens = new Set<KernelOperationToken>();
  readonly #residencyTokens = new Set<KernelResidencyToken>();
  readonly #registrationWriteFailures: unknown[] = [];
  readonly #idleGraceMs: number;
  readonly #handshakeTimeoutMs: number;
  #endpoint: RuntimeHostEndpoint | undefined;
  #state: HostLifecycleState = 'starting';
  #operationAdmissionOpen = true;
  #readyAdmissionOpen = false;
  #composition: RuntimeHostComposition | undefined;
  #compositionOutcomeSettled = false;
  readonly #compositionOutcome: Promise<RuntimeHostComposition | undefined>;
  #resolveCompositionOutcome!: (composition: RuntimeHostComposition | undefined) => void;
  #compositionDrainStarted = false;
  #compositionDrainFailure: { error: unknown } | undefined;
  #operationHandlers: OperationHandlerMap;
  #idleTimer: NodeJS.Timeout | undefined;
  #shutdownRequested = false;
  #shutdownTask: Promise<void> | undefined;
  #forcedCleanupTask: Promise<void> | undefined;
  #failStopDisposition: RuntimeHostFailStopDisposition | undefined;
  #resolveFailStopSignal!: () => void;
  #failStopSignal: Promise<void>;
  #ownerBeginCloseStarted = false;
  #ownerBeginCloseFailure: { error: unknown } | undefined;
  #compositionCloseTask: Promise<RuntimeHostCompositionCloseResult> | undefined;
  #serverCloseTask: Promise<void> | undefined;
  #endpointCleanupTask: Promise<void> | undefined;
  #registrationRemovalTask: Promise<void> | undefined;
  #ownerCloseTask: Promise<void> | undefined;
  #registrationWriteTail: Promise<void> = Promise.resolve();
  #closedSettled = false;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: unknown) => void;

  private constructor(options: RuntimeHostKernelOptions) {
    assertDuration(options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS, 'idleGraceMs', 0);
    assertDuration(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
      1,
    );
    this.#idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#options = options;
    this.#operationHandlers = this.#createOperationHandlers(
      createUnavailableDomainOperationHandlers(),
    );
    this.#compositionOutcome = new Promise((resolve) => {
      this.#resolveCompositionOutcome = resolve;
    });
    if (!options.compositionFactory) this.#settleCompositionOutcome(undefined);
    this.#failStopSignal = new Promise((resolve) => {
      this.#resolveFailStopSignal = resolve;
    });
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    void this.closed.catch(() => undefined);
    this.#server = createServer((socket) => this.#accept(socket));
  }

  static async start(options: RuntimeHostKernelOptions): Promise<RuntimeHostKernel> {
    const owner = authenticateInteractiveRootOwner(options.owner);
    let host: RuntimeHostKernel | undefined;
    try {
      host = new RuntimeHostKernel({
        owner,
        idleGraceMs: options.idleGraceMs,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
        compositionFactory: options.compositionFactory,
      });
      await host.#start();
      return host;
    } catch (error) {
      if (host) {
        try {
          await host.#abortStartup();
        } catch (cleanupError) {
          if (host.#failStopDisposition) throw cleanupError;
          const failure = aggregateFailure(
            [error, cleanupError],
            'Runtime Host startup and cleanup both failed',
          );
          host.#settleClosedFailure(failure);
          throw failure;
        }
        host.#settleClosedFailure(error);
        throw error;
      }
      try {
        await owner.close();
      } catch (cleanupError) {
        throw aggregateFailure(
          [error, cleanupError],
          'Runtime Host owner cleanup failed after startup construction failed',
        );
      }
      throw error;
    }
  }

  get state(): HostLifecycleState {
    return this.#state;
  }

  get endpoint(): string {
    if (!this.#endpoint) throw new Error('Runtime Host has not started listening');
    return this.#endpoint.path;
  }

  get connectionCount(): number {
    return this.#acceptedTransports.size;
  }

  close(): Promise<void> {
    this.#requestDrain();
    return this.closed;
  }

  #requestDrain(): void {
    if (this.#failStopDisposition) return;
    this.#sealOperationAdmission();
    this.#shutdownRequested = true;
    this.#beginCompositionDrain();
    this.#cancelIdle();
    this.#commitRequestedShutdownIfQuiescent();
  }

  #requestFailStop(disposition: RuntimeHostFailStopDisposition): void {
    if (this.#failStopDisposition) return;
    const synchronousFailures: unknown[] = [];
    this.#sealOperationAdmission();
    this.#failStopDisposition = disposition;
    this.#shutdownRequested = true;
    this.#state = 'draining';
    this.#cancelIdle();
    this.#beginCompositionDrain();
    this.#resolveFailStopSignal();
    this.#startCompositionClose();
    this.#closeServerOnce();
    destroyTransports(this.#handshakingTransports, synchronousFailures);
    destroyTransports(this.#acceptedTransports, synchronousFailures);
    const forced = this.#forceOwnerIsolation(disposition, synchronousFailures);
    this.#forcedCleanupTask = forced;
    void forced.then(
      () => this.#settleClosedFailure(disposition.cause),
      (error) => this.#settleClosedFailure(error),
    );
  }

  async #start(): Promise<void> {
    await assertInteractiveRootOwner(this.#options.owner);
    this.#endpoint = await prepareRuntimeHostEndpoint({
      rootId: this.#options.owner.capability.rootId,
      hostEpoch: this.hostEpoch,
    });
    await listen(this.#server, this.#endpoint.path);
    await this.#endpoint.prepareAfterListen();
    await this.#publishRegistration();
    if (this.#options.compositionFactory) {
      this.#state = 'recovering';
      await this.#publishRegistration();
      this.#composition = await this.#options.compositionFactory({
        owner: this.#options.owner,
        hostEpoch: this.hostEpoch,
        acquireResidency: () => this.#acquireResidency(),
        requestDrain: () => this.#requestDrain(),
        requestFailStop: (disposition) => this.#requestFailStop(disposition),
      });
      this.#settleCompositionOutcome(this.#composition);
      if (this.#shutdownRequested) this.#beginCompositionDrain();
      if (this.#failStopDisposition) {
        this.#startCompositionClose();
        this.#throwIfFailStopRequested();
      }
      this.#operationHandlers = this.#createOperationHandlers(this.#composition.handlers);
      await this.#raceFailStop(this.#composition.recover());
    }
    this.#throwIfFailStopRequested();
    if (this.#shutdownRequested) {
      void this.#commitShutdown().catch(() => undefined);
      return;
    }
    await this.#publishRegistration('ready');
    this.#throwIfFailStopRequested();
    if (!this.#openReadyAdmission()) {
      void this.#commitShutdown().catch(() => undefined);
      return;
    }
    this.#scheduleIdleIfNeeded();
  }

  #accept(socket: Socket): void {
    if (this.#state === 'draining' || this.#failStopDisposition) {
      socket.destroy();
      return;
    }
    const transport = new FramedTransport(socket);
    this.#handshakingTransports.add(transport);
    void this.#serveConnection(transport).finally(() => {
      this.#handshakingTransports.delete(transport);
    });
  }

  async #serveConnection(transport: FramedTransport): Promise<void> {
    let connectionAccepted = false;
    let connectionReleased = false;
    let sessionStarted = false;
    let connectionSettlement: AcceptedConnectionSettlement | undefined;
    const releaseConnection = () => {
      if (!connectionAccepted || connectionReleased) return;
      connectionReleased = true;
      this.#releaseConnection(transport);
    };
    try {
      const frame = decodeClientFrame(await transport.read(this.#handshakeTimeoutMs));
      if (!('kind' in frame) || frame.kind !== 'hello') {
        throw new Error('First Runtime Host frame must be a hello');
      }
      const admission = await this.#admitHandshake(frame, transport);
      const { result } = admission;
      connectionAccepted = result.kind === 'accepted';
      connectionSettlement = admission.connectionSettlement;
      await transport.write(result);
      if (result.kind !== 'accepted') {
        transport.destroyAfterFlush();
        return;
      }
      const session = new RuntimeHostConnectionSession({
        transport,
        connection: {
          hostEpoch: this.hostEpoch,
          connectionId: result.connectionId,
          surface: frame.surface,
          principal: 'local_os_user',
        },
        resolveHandlers: () => this.#operationHandlers,
        resolveContinuity: () => this.#composition?.continuity,
        resolveNativeProvider: () => this.#composition?.nativeProvider,
        beginOperation: (request) => this.#beginOperation(request),
        onTeardown: releaseConnection,
        onConnectionSettled: () => connectionSettlement!.notify(),
      });
      sessionStarted = true;
      await session.run();
    } catch {
      transport.destroy();
    } finally {
      releaseConnection();
      if (connectionSettlement) {
        try {
          if (!sessionStarted) await connectionSettlement.notify();
        } catch {
          transport.destroy();
        } finally {
          if (!sessionStarted) await transport.closed;
          connectionSettlement.finish();
        }
      }
    }
  }

  #trackAcceptedConnection(connectionId: string): AcceptedConnectionSettlement {
    let resolveSettlement!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    this.#acceptedConnectionSettlements.add(settled);
    let notification: Promise<void> | undefined;
    let finished = false;
    return {
      notify: () => {
        if (!notification) {
          notification = this.#compositionOutcome
            .then(async (composition) => {
              await composition?.onConnectionSettled?.(connectionId);
            })
            .catch((error: unknown) => {
              pushUniqueError(this.#connectionSettlementFailures, error);
              throw error;
            });
          observePromise(notification);
        }
        return notification;
      },
      finish: () => {
        if (finished) return;
        finished = true;
        this.#acceptedConnectionSettlements.delete(settled);
        resolveSettlement();
      },
    };
  }

  #settleCompositionOutcome(composition: RuntimeHostComposition | undefined): void {
    if (this.#compositionOutcomeSettled) return;
    this.#compositionOutcomeSettled = true;
    this.#resolveCompositionOutcome(composition);
  }

  async #admitHandshake(
    hello: ClientHello,
    transport: FramedTransport,
  ): Promise<HandshakeAdmission> {
    if (!(await this.#hasLiveOwnerOrDrain()) || this.#state === 'draining') {
      return { result: { kind: 'draining', hostEpoch: this.hostEpoch } };
    }
    const admittedState = this.#state;
    const selectedProtocol = negotiateProtocol(
      { min: hello.protocolMin, max: hello.protocolMax },
      HOST_PROTOCOL,
    );
    if (selectedProtocol === undefined) {
      return {
        result: {
          kind: 'incompatible',
          hostEpoch: this.hostEpoch,
          protocolMin: HOST_PROTOCOL.min,
          protocolMax: HOST_PROTOCOL.max,
          state: admittedState,
          replacement: this.#isTrueIdle() ? 'wait_for_idle_exit' : 'blocked_by_residency',
        },
      };
    }
    const connectionId = randomUUID();
    const connectionSettlement = this.#trackAcceptedConnection(connectionId);
    this.#acceptedTransports.add(transport);
    this.#handshakingTransports.delete(transport);
    this.#cancelIdle();
    return {
      result: {
        kind: 'accepted',
        hostEpoch: this.hostEpoch,
        connectionId,
        selectedProtocol,
        state: admittedState,
      },
      connectionSettlement,
    };
  }

  #releaseConnection(transport: FramedTransport): void {
    if (!this.#acceptedTransports.delete(transport)) {
      throw new Error('Runtime Host connection residency underflow');
    }
    this.#settleLifecycleAfterWork();
  }

  async #beginOperation(
    frame: RequestFrame,
  ): Promise<ConnectionOperationLease | HostOperationErrorCode> {
    if (!(await this.#hasLiveOwnerOrDrain()) || this.#state === 'draining') return 'host_draining';
    if (this.#failStopDisposition) return 'host_draining';
    if (!this.#operationAdmissionOpen) return 'host_draining';
    const operationSpec = HOST_OPERATION_SPECS[frame.operation];
    if (operationSpec.admission !== 'bootstrap' && !this.#readyAdmissionOpen) {
      return 'host_not_ready';
    }
    const command = operationSpec.mode === 'command';
    const token: KernelOperationToken = {
      command,
      sealed: false,
      finished: false,
    };
    this.#operationTokens.add(token);
    if (command) this.#commandTokens.add(token);
    this.#cancelIdle();
    const seal = () => {
      if (token.sealed) return;
      token.sealed = true;
      if (token.command) this.#commandTokens.delete(token);
      this.#settleLifecycleAfterWork();
    };
    return {
      acquireResidency: () => {
        if (token.sealed || token.finished)
          throw new Error('Runtime Host operation lease has ended');
        return this.#acquireResidency();
      },
      seal,
      finish: () => {
        if (token.finished) return;
        token.finished = true;
        seal();
        if (this.#operationTokens.delete(token) && this.#operationTokens.size === 0) {
          for (const resolve of this.#operationDrainWaiters) resolve();
          this.#operationDrainWaiters.clear();
        }
        this.#settleLifecycleAfterWork();
      },
    };
  }

  async #hasLiveOwnerOrDrain(): Promise<boolean> {
    if (this.#isDraining()) return false;
    try {
      await assertInteractiveRootOwner(this.#options.owner);
    } catch {
      this.#requestDrain();
      return false;
    }
    return !this.#isDraining();
  }

  #isDraining(): boolean {
    return this.#state === 'draining';
  }

  #acquireResidency(): RuntimeHostResidency {
    this.#throwIfFailStopRequested();
    const token: KernelResidencyToken = { released: false };
    this.#residencyTokens.add(token);
    this.#cancelIdle();
    return {
      release: () => {
        if (token.released) return;
        token.released = true;
        this.#residencyTokens.delete(token);
        this.#settleLifecycleAfterWork();
      },
    };
  }

  #createOperationHandlers(domainHandlers: AllDomainOperationHandlerMap): OperationHandlerMap {
    return {
      'host.status': async () => ({
        ok: true,
        result: {
          hostEpoch: this.hostEpoch,
          state: this.#state,
          connections: this.#acceptedTransports.size,
          activeOperations: this.#operationTokens.size,
          activeResidencies: this.#residencyTokens.size,
        },
      }),
      ...domainHandlers,
    };
  }

  #waitForOperations(): Promise<void> {
    if (this.#operationTokens.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#operationDrainWaiters.add(resolve));
  }

  async #waitForAcceptedConnectionSettlements(): Promise<void> {
    while (this.#acceptedConnectionSettlements.size > 0) {
      await Promise.all(this.#acceptedConnectionSettlements);
    }
  }

  #scheduleIdleIfNeeded(): void {
    if (this.#shutdownRequested) return;
    if (!this.#isTrueIdle() || this.#idleTimer) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (!this.#isTrueIdle()) return;
      void this.#commitShutdown().catch(() => undefined);
    }, this.#idleGraceMs);
  }

  #isTrueIdle(): boolean {
    return (
      this.#state === 'ready' &&
      this.#acceptedTransports.size === 0 &&
      this.#operationTokens.size === 0 &&
      this.#residencyTokens.size === 0
    );
  }

  #cancelIdle(): void {
    if (!this.#idleTimer) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #settleLifecycleAfterWork(): void {
    if (this.#failStopDisposition) return;
    if (this.#shutdownRequested) {
      this.#commitRequestedShutdownIfQuiescent();
      return;
    }
    this.#scheduleIdleIfNeeded();
  }

  #commitRequestedShutdownIfQuiescent(): void {
    if (
      this.#commandTokens.size !== 0 ||
      this.#state === 'starting' ||
      this.#state === 'recovering'
    )
      return;
    void this.#commitShutdown().catch(() => undefined);
  }

  #commitShutdown(): Promise<void> {
    if (this.#forcedCleanupTask) return this.closed;
    if (!this.#shutdownTask) {
      this.#sealOperationAdmission();
      this.#shutdownRequested = true;
      this.#beginCompositionDrain();
      this.#state = 'draining';
      this.#cancelIdle();
      this.#shutdownTask = this.#closeResources();
      void this.#shutdownTask.then(
        () => this.#settleClosedClean(),
        (error) => this.#settleClosedFailure(error),
      );
    }
    return this.closed;
  }

  async #closeResources(): Promise<void> {
    const errors: unknown[] = [];
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    await this.#publishRegistration().catch((error: unknown) => pushUniqueError(errors, error));
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    const serverClosed = this.#closeServerOnce();
    const accepted = [...this.#acceptedTransports];
    const handshaking = [...this.#handshakingTransports];
    const operationDrain = this.#waitForOperations();
    const nativeProvider = this.#composition?.nativeProvider;
    const nativeProviderDrain = nativeProvider
      ? invokeAsync(() => nativeProvider.close())
      : Promise.resolve();
    const nativeProviderDrainSettled = nativeProviderDrain.catch((error: unknown) =>
      pushUniqueError(errors, error),
    );
    const [operationsDrained, nativeProviderDrained] = await Promise.all([
      waitForBoundedCompletion(operationDrain, SHUTDOWN_OPERATION_GRACE_MS),
      waitForBoundedCompletion(nativeProviderDrainSettled, SHUTDOWN_OPERATION_GRACE_MS),
      waitForTransportClose(handshaking, SHUTDOWN_HANDSHAKE_GRACE_MS),
    ]);
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    if (!operationsDrained || !nativeProviderDrained) {
      destroyTransports(accepted, errors);
    }
    destroyTransports(handshaking, errors);
    try {
      await this.#raceFailStop(Promise.all([operationDrain, nativeProviderDrainSettled]));
    } catch (error) {
      if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
      throw error;
    }
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    destroyTransports(this.#acceptedTransports, errors);
    try {
      await this.#raceFailStop(this.#waitForAcceptedConnectionSettlements());
    } catch (error) {
      if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
      throw error;
    }
    for (const error of this.#connectionSettlementFailures) pushUniqueError(errors, error);
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    this.#beginCompositionDrain();
    const compositionClose = this.#startCompositionClose();
    if (compositionClose) {
      let result: RuntimeHostCompositionCloseResult | undefined;
      try {
        result = await this.#raceFailStop(compositionClose);
      } catch (error) {
        if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
        pushUniqueError(errors, error);
      }
      if (result?.kind === 'fail_stop') {
        this.#requestFailStop(result);
        return this.#forcedCleanupTask!;
      }
    }
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    return this.#finalizeControlPlaneAndOwner(
      errors,
      'Runtime Host composition',
      'Runtime Host shutdown did not cleanly close every resource',
      () => {
        destroyTransports(accepted, errors);
        return serverClosed.catch((error: unknown) => pushUniqueError(errors, error));
      },
      true,
    );
  }

  async #abortStartup(): Promise<void> {
    this.#settleCompositionOutcome(this.#composition);
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    this.#sealOperationAdmission();
    this.#shutdownRequested = true;
    this.#state = 'draining';
    this.#cancelIdle();
    this.#beginCompositionDrain();
    const errors: unknown[] = [];
    destroyTransports(this.#handshakingTransports, errors);
    destroyTransports(this.#acceptedTransports, errors);
    const serverClosed = this.#closeServerOnce();
    try {
      await this.#raceFailStop(this.#waitForOperations());
    } catch (error) {
      if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
      throw error;
    }
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    await serverClosed.catch((error: unknown) => pushUniqueError(errors, error));
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    try {
      await this.#raceFailStop(this.#waitForAcceptedConnectionSettlements());
    } catch (error) {
      if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
      throw error;
    }
    for (const error of this.#connectionSettlementFailures) pushUniqueError(errors, error);
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    const compositionClose = this.#startCompositionClose();
    if (compositionClose) {
      try {
        const result = await this.#raceFailStop(compositionClose);
        if (result.kind === 'fail_stop') {
          this.#requestFailStop(result);
          return this.#forcedCleanupTask!;
        }
      } catch (error) {
        if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
        pushUniqueError(errors, error);
      }
    }
    return this.#finalizeControlPlaneAndOwner(
      errors,
      'Runtime Host startup composition',
      'Runtime Host startup cleanup did not cleanly close every resource',
    );
  }

  async #finalizeControlPlaneAndOwner(
    errors: unknown[],
    residencyOwner: string,
    aggregateMessage: string,
    beforeControlPlane?: () => Promise<void>,
    alwaysAggregate = false,
  ): Promise<void> {
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    if (this.#residencyTokens.size !== 0) {
      pushUniqueError(
        errors,
        new Error(
          `${residencyOwner} settled with ${this.#residencyTokens.size} unreleased residencies`,
        ),
      );
      this.#beginOwnerClose();
      if (this.#ownerBeginCloseFailure) {
        pushUniqueError(errors, this.#ownerBeginCloseFailure.error);
      }
      if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    }
    if (beforeControlPlane) {
      const controlPlaneReady = beforeControlPlane();
      if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
      await controlPlaneReady;
      if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    }
    await this.#cleanupEndpointOnce().catch((error: unknown) => pushUniqueError(errors, error));
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    await this.#waitForRegistrationWrites();
    for (const error of this.#registrationWriteFailures) pushUniqueError(errors, error);
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    await this.#removeRegistrationOnce().catch((error: unknown) => pushUniqueError(errors, error));
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    await this.#closeOwnerOnce().catch((error: unknown) => pushUniqueError(errors, error));
    if (this.#forcedCleanupTask) return this.#forcedCleanupTask;
    if (this.#compositionDrainFailure) errors.unshift(this.#compositionDrainFailure.error);
    if (errors.length > 0) {
      throw alwaysAggregate
        ? new AggregateError(errors, aggregateMessage)
        : aggregateFailure(errors, aggregateMessage);
    }
  }

  async #forceOwnerIsolation(
    disposition: RuntimeHostFailStopDisposition,
    synchronousFailures: readonly unknown[],
  ): Promise<void> {
    const errors: unknown[] = [disposition.cause];
    for (const error of synchronousFailures) pushUniqueError(errors, error);
    if (this.#compositionDrainFailure) {
      pushUniqueError(errors, this.#compositionDrainFailure.error);
    }
    this.#startCompositionClose();
    await this.#closeServerOnce().catch((error: unknown) => pushUniqueError(errors, error));
    await this.#cleanupEndpointOnce().catch((error: unknown) => pushUniqueError(errors, error));
    await this.#waitForRegistrationWrites();
    for (const error of this.#registrationWriteFailures) pushUniqueError(errors, error);
    await this.#removeRegistrationOnce().catch((error: unknown) => pushUniqueError(errors, error));
    await disposition.ownerIsolationBarrier.catch((error: unknown) =>
      pushUniqueError(errors, error),
    );
    this.#beginOwnerClose();
    if (this.#ownerBeginCloseFailure) {
      pushUniqueError(errors, this.#ownerBeginCloseFailure.error);
    }
    let ownerIsolated = false;
    const ownerClose = this.#closeOwnerOnce();
    try {
      if (await waitForBoundedCompletion(ownerClose, SHUTDOWN_OPERATION_GRACE_MS)) {
        ownerIsolated = true;
      } else {
        pushUniqueError(
          errors,
          new Error(
            `Runtime Host root owner close exceeded the ${SHUTDOWN_OPERATION_GRACE_MS}ms shutdown grace`,
          ),
        );
      }
    } catch (error) {
      pushUniqueError(errors, error);
    }
    if (ownerIsolated) {
      try {
        disposition.reclaimAfterOwnerIsolation();
      } catch (error) {
        pushUniqueError(errors, error);
      }
    }
    throw aggregateFailure(
      errors,
      'Runtime Host fail-stop owner isolation completed with failures',
    );
  }

  #beginCompositionDrain(): void {
    if (!this.#composition || this.#compositionDrainStarted) return;
    this.#compositionDrainStarted = true;
    const errors: unknown[] = [];
    try {
      this.#composition.nativeProvider?.beginDrain();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#composition.beginDrain?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length !== 0) {
      this.#compositionDrainFailure = {
        error: aggregateFailure(errors, 'Runtime Host composition drain failed'),
      };
    }
  }

  #beginOwnerClose(): void {
    if (this.#ownerBeginCloseStarted) return;
    this.#ownerBeginCloseStarted = true;
    try {
      this.#options.owner.beginClose();
    } catch (error) {
      this.#ownerBeginCloseFailure = { error };
    }
  }

  #sealOperationAdmission(): void {
    this.#operationAdmissionOpen = false;
    this.#readyAdmissionOpen = false;
  }

  #openReadyAdmission(): boolean {
    if (
      !this.#operationAdmissionOpen ||
      this.#shutdownRequested ||
      this.#failStopDisposition ||
      this.#state === 'draining'
    )
      return false;
    this.#state = 'ready';
    this.#readyAdmissionOpen = true;
    return true;
  }

  #publishRegistration(state: HostLifecycleState = this.#state): Promise<void> {
    if (this.#failStopDisposition) {
      const rejected = Promise.reject<void>(this.#failStopDisposition.cause);
      observePromise(rejected);
      return rejected;
    }
    const registration: HostRegistration = {
      kind: 'maka-runtime-host',
      schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
      rootId: this.#options.owner.capability.rootId,
      hostEpoch: this.hostEpoch,
      endpoint: this.endpoint,
      protocolMin: HOST_PROTOCOL.min,
      protocolMax: HOST_PROTOCOL.max,
      state,
      pid: process.pid,
      createdAt: this.#createdAt,
    };
    const task = this.#registrationWriteTail.then(() =>
      writeHostRegistration(this.#options.owner.controlDirectory, registration),
    );
    void task.catch((error) => pushUniqueError(this.#registrationWriteFailures, error));
    this.#registrationWriteTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  #startCompositionClose(): Promise<RuntimeHostCompositionCloseResult> | undefined {
    if (!this.#composition) return;
    if (!this.#compositionCloseTask) {
      this.#compositionCloseTask = closeComposition(this.#composition);
      observePromise(this.#compositionCloseTask);
    }
    return this.#compositionCloseTask;
  }

  #closeServerOnce(): Promise<void> {
    if (!this.#serverCloseTask) {
      try {
        this.#serverCloseTask = closeServer(this.#server);
      } catch (error) {
        this.#serverCloseTask = Promise.reject(error);
      }
      observePromise(this.#serverCloseTask);
    }
    return this.#serverCloseTask;
  }

  #cleanupEndpointOnce(): Promise<void> {
    if (!this.#endpointCleanupTask) {
      this.#endpointCleanupTask = this.#endpoint?.cleanup() ?? Promise.resolve();
      observePromise(this.#endpointCleanupTask);
    }
    return this.#endpointCleanupTask;
  }

  #removeRegistrationOnce(): Promise<void> {
    if (!this.#registrationRemovalTask) {
      this.#registrationRemovalTask = removeHostRegistration(
        this.#options.owner.controlDirectory,
        this.hostEpoch,
      );
      observePromise(this.#registrationRemovalTask);
    }
    return this.#registrationRemovalTask;
  }

  #closeOwnerOnce(): Promise<void> {
    if (!this.#ownerCloseTask) {
      try {
        this.#ownerCloseTask = this.#options.owner.close();
      } catch (error) {
        this.#ownerCloseTask = Promise.reject(error);
      }
      observePromise(this.#ownerCloseTask);
    }
    return this.#ownerCloseTask;
  }

  #waitForRegistrationWrites(): Promise<void> {
    return this.#registrationWriteTail;
  }

  async #raceFailStop<T>(task: Promise<T>): Promise<T> {
    this.#throwIfFailStopRequested();
    return Promise.race([
      task,
      this.#failStopSignal.then(() => {
        throw this.#failStopDisposition!.cause;
      }),
    ]);
  }

  #throwIfFailStopRequested(): void {
    if (this.#failStopDisposition) throw this.#failStopDisposition.cause;
  }

  #settleClosedClean(): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#resolveClosed();
  }

  #settleClosedFailure(error: unknown): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#rejectClosed(error);
  }
}

async function closeComposition(
  composition: RuntimeHostComposition,
): Promise<RuntimeHostCompositionCloseResult> {
  const compositionClose = invokeAsync(() => composition.close());
  const nativeProvider = composition.nativeProvider;
  const nativeProviderClose = nativeProvider
    ? invokeAsync(() => nativeProvider.close())
    : Promise.resolve();
  const [compositionResult, nativeProviderResult] = await Promise.allSettled([
    compositionClose,
    nativeProviderClose,
  ]);
  if (
    compositionResult.status === 'fulfilled' &&
    compositionResult.value.kind === 'fail_stop' &&
    nativeProviderResult.status === 'rejected'
  ) {
    const disposition = compositionResult.value;
    return {
      kind: 'fail_stop',
      cause: aggregateFailure(
        [disposition.cause, nativeProviderResult.reason],
        'Runtime Host fail-stop composition close failed',
      ),
      ownerIsolationBarrier: disposition.ownerIsolationBarrier,
      reclaimAfterOwnerIsolation: disposition.reclaimAfterOwnerIsolation,
    };
  }
  const errors: unknown[] = [];
  if (compositionResult.status === 'rejected') errors.push(compositionResult.reason);
  if (nativeProviderResult.status === 'rejected') errors.push(nativeProviderResult.reason);
  if (errors.length !== 0) {
    throw aggregateFailure(errors, 'Runtime Host composition close failed');
  }
  if (compositionResult.status !== 'fulfilled') throw compositionResult.reason;
  return compositionResult.value;
}

function invokeAsync<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForTransportClose(
  transports: readonly FramedTransport[],
  timeoutMs: number,
): Promise<void> {
  if (transports.length === 0) return;
  await waitForBoundedCompletion(
    Promise.all(transports.map((transport) => transport.closed)),
    timeoutMs,
  );
}

async function waitForBoundedCompletion(
  task: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const completion = task.then(() => true);
  observePromise(completion);
  try {
    return await Promise.race([
      completion,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertDuration(value: number, label: string, minimum: 0 | 1): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 120_000) {
    throw new RangeError(`${label} must be an integer between ${minimum} and 120000`);
  }
}

function observePromise(task: Promise<unknown>): void {
  void task.then(
    () => undefined,
    () => undefined,
  );
}

function pushUniqueError(errors: unknown[], error: unknown): void {
  if (!errors.some((existing) => Object.is(existing, error))) errors.push(error);
}

function destroyTransports(transports: Iterable<FramedTransport>, errors: unknown[]): void {
  for (const transport of transports) {
    try {
      transport.destroy();
    } catch (error) {
      pushUniqueError(errors, error);
    }
  }
}

function aggregateFailure(errors: readonly unknown[], message: string): unknown {
  const unique: unknown[] = [];
  for (const error of errors) pushUniqueError(unique, error);
  if (unique.length === 1) return unique[0];
  return new AggregateError(unique, message);
}
