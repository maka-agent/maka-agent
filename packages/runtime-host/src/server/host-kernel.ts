import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { prepareRuntimeHostEndpoint, type RuntimeHostEndpoint } from '../control/endpoint.js';
import {
  removeHostRegistration,
  writeHostRegistration,
} from '../control/registration.js';
import {
  decodeClientFrame,
  negotiateProtocol,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type ClientHello,
  type HostHandshakeResult,
  type HostLifecycleState,
  type HostRegistration,
  type HostStatusResponse,
} from '../protocol/index.js';
import { FramedTransport } from '../transport/framed-transport.js';

const DEFAULT_IDLE_GRACE_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const SHUTDOWN_HANDSHAKE_GRACE_MS = 1_000;
const SHUTDOWN_OPERATION_GRACE_MS = 1_000;
const HOST_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export interface NonServingRuntimeHostOptions {
  owner: InteractiveRootOwner;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
}

export class NonServingRuntimeHost {
  readonly hostEpoch = randomUUID();
  readonly closed: Promise<void>;
  readonly #options: NonServingRuntimeHostOptions;
  readonly #createdAt = new Date().toISOString();
  readonly #server: Server;
  readonly #handshakingTransports = new Set<FramedTransport>();
  readonly #acceptedTransports = new Set<FramedTransport>();
  readonly #operationDrainWaiters = new Set<() => void>();
  readonly #idleGraceMs: number;
  readonly #handshakeTimeoutMs: number;
  #endpoint: RuntimeHostEndpoint | undefined;
  #state: HostLifecycleState = 'starting';
  #activeOperations = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  #shutdownTask: Promise<void> | undefined;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: unknown) => void;

  private constructor(options: NonServingRuntimeHostOptions) {
    assertDuration(options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS, 'idleGraceMs', 0);
    assertDuration(options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS, 'handshakeTimeoutMs', 1);
    this.#idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#options = options;
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    this.#server = createServer((socket) => this.#accept(socket));
  }

  static async start(options: NonServingRuntimeHostOptions): Promise<NonServingRuntimeHost> {
    const owner = authenticateInteractiveRootOwner(options.owner);
    let host: NonServingRuntimeHost | undefined;
    try {
      host = new NonServingRuntimeHost({
        owner,
        idleGraceMs: options.idleGraceMs,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
      });
      await host.#start();
      return host;
    } catch (error) {
      if (host) await host.#abortStartup();
      else await owner.close();
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
    return this.#commitShutdown();
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
    this.#state = 'ready';
    await this.#publishRegistration();
    this.#scheduleIdleIfNeeded();
  }

  #accept(socket: Socket): void {
    const transport = new FramedTransport(socket);
    this.#handshakingTransports.add(transport);
    void this.#serveConnection(transport).finally(() => {
      this.#handshakingTransports.delete(transport);
    });
  }

  async #serveConnection(transport: FramedTransport): Promise<void> {
    let connectionAccepted = false;
    try {
      const frame = decodeClientFrame(await transport.read(this.#handshakeTimeoutMs));
      if (frame.kind !== 'hello') throw new Error('First Runtime Host frame must be a hello');
      const result = await this.#admitHandshake(frame, transport);
      connectionAccepted = result.kind === 'accepted';
      await transport.write(result);
      if (!connectionAccepted) {
        transport.destroyAfterFlush();
        return;
      }
      await this.#serveAcceptedConnection(transport);
    } catch {
      transport.destroy();
    } finally {
      if (connectionAccepted) this.#releaseConnection(transport);
    }
  }

  async #serveAcceptedConnection(transport: FramedTransport): Promise<void> {
    while (true) {
      const frame = decodeClientFrame(await transport.read(0));
      if (frame.kind !== 'status') throw new Error('Unexpected bootstrap frame after handshake');
      if (!await this.#beginStatusOperation()) {
        transport.destroy();
        return;
      }
      let response: HostStatusResponse;
      try {
        response = {
          kind: 'status',
          requestId: frame.requestId,
          hostEpoch: this.hostEpoch,
          state: this.#state,
          connections: this.#acceptedTransports.size,
          activeOperations: this.#activeOperations,
        };
        await transport.write(response);
      } finally {
        this.#finishOperation();
      }
    }
  }

  async #admitHandshake(
    hello: ClientHello,
    transport: FramedTransport,
  ): Promise<HostHandshakeResult> {
    if (!await this.#hasLiveOwnerOrDrain() || this.#state === 'draining') {
      return { kind: 'draining', hostEpoch: this.hostEpoch };
    }
    const admittedState = this.#state;
    const selectedProtocol = negotiateProtocol(
      { min: hello.protocolMin, max: hello.protocolMax },
      HOST_PROTOCOL,
    );
    if (selectedProtocol === undefined) {
      return {
        kind: 'incompatible',
        hostEpoch: this.hostEpoch,
        protocolMin: HOST_PROTOCOL.min,
        protocolMax: HOST_PROTOCOL.max,
        state: admittedState,
        replacement: this.#isTrueIdle()
          ? 'wait_for_idle_exit'
          : 'blocked_by_residency',
      };
    }
    this.#acceptedTransports.add(transport);
    this.#handshakingTransports.delete(transport);
    this.#cancelIdle();
    return {
      kind: 'accepted',
      hostEpoch: this.hostEpoch,
      connectionId: randomUUID(),
      selectedProtocol,
      state: admittedState,
    };
  }

  #releaseConnection(transport: FramedTransport): void {
    if (!this.#acceptedTransports.delete(transport)) {
      throw new Error('Runtime Host connection residency underflow');
    }
    this.#scheduleIdleIfNeeded();
  }

  async #beginStatusOperation(): Promise<boolean> {
    if (!await this.#hasLiveOwnerOrDrain() || this.#state === 'draining') return false;
    this.#activeOperations += 1;
    this.#cancelIdle();
    return true;
  }

  async #hasLiveOwnerOrDrain(): Promise<boolean> {
    if (this.#isDraining()) return false;
    try {
      await assertInteractiveRootOwner(this.#options.owner);
    } catch {
      void this.#commitShutdown().catch(() => undefined);
      return false;
    }
    return !this.#isDraining();
  }

  #isDraining(): boolean {
    return this.#state === 'draining';
  }

  #finishOperation(): void {
    if (this.#activeOperations === 0) throw new Error('Runtime Host operation residency underflow');
    this.#activeOperations -= 1;
    if (this.#activeOperations === 0) {
      for (const resolve of this.#operationDrainWaiters) resolve();
      this.#operationDrainWaiters.clear();
    }
    this.#scheduleIdleIfNeeded();
  }

  #waitForOperations(): Promise<void> {
    if (this.#activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.#operationDrainWaiters.add(resolve));
  }

  #scheduleIdleIfNeeded(): void {
    if (!this.#isTrueIdle() || this.#idleTimer) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (!this.#isTrueIdle()) return;
      void this.#commitShutdown().catch(() => undefined);
    }, this.#idleGraceMs);
  }

  #isTrueIdle(): boolean {
    return this.#state === 'ready'
      && this.#acceptedTransports.size === 0
      && this.#activeOperations === 0;
  }

  #cancelIdle(): void {
    if (!this.#idleTimer) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #commitShutdown(): Promise<void> {
    if (!this.#shutdownTask) {
      this.#state = 'draining';
      this.#cancelIdle();
      this.#shutdownTask = this.#closeResources();
      void this.#shutdownTask.then(this.#resolveClosed, this.#rejectClosed);
    }
    return this.closed;
  }

  async #closeResources(): Promise<void> {
    const errors: unknown[] = [];
    await this.#publishRegistration().catch((error: unknown) => errors.push(error));
    const serverClosed = closeServer(this.#server).catch((error: unknown) => errors.push(error));
    const accepted = [...this.#acceptedTransports];
    const handshaking = [...this.#handshakingTransports];
    const operationDrain = this.#waitForOperations();
    const [operationsDrained] = await Promise.all([
      waitForBoundedCompletion(operationDrain, SHUTDOWN_OPERATION_GRACE_MS),
      waitForTransportClose(handshaking, SHUTDOWN_HANDSHAKE_GRACE_MS),
    ]);
    if (!operationsDrained) {
      for (const transport of accepted) transport.destroy();
    }
    for (const transport of handshaking) transport.destroy();
    await operationDrain;
    for (const transport of accepted) transport.destroy();
    await serverClosed;
    await this.#endpoint?.cleanup().catch((error: unknown) => errors.push(error));
    await removeHostRegistration(this.#options.owner.controlDirectory, this.hostEpoch)
      .catch((error: unknown) => errors.push(error));
    await this.#options.owner.close().catch((error: unknown) => errors.push(error));
    if (errors.length > 0) throw new AggregateError(errors, 'Runtime Host shutdown did not cleanly close every resource');
  }

  async #abortStartup(): Promise<void> {
    this.#state = 'draining';
    for (const transport of this.#handshakingTransports) transport.destroy();
    for (const transport of this.#acceptedTransports) transport.destroy();
    await closeServer(this.#server).catch(() => undefined);
    await this.#endpoint?.cleanup().catch(() => undefined);
    await removeHostRegistration(this.#options.owner.controlDirectory, this.hostEpoch).catch(() => undefined);
    await this.#options.owner.close();
    this.#resolveClosed();
  }

  #publishRegistration(): Promise<void> {
    const registration: HostRegistration = {
      kind: 'maka-runtime-host',
      schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
      rootId: this.#options.owner.capability.rootId,
      hostEpoch: this.hostEpoch,
      endpoint: this.endpoint,
      protocolMin: HOST_PROTOCOL.min,
      protocolMax: HOST_PROTOCOL.max,
      state: this.#state,
      pid: process.pid,
      createdAt: this.#createdAt,
    };
    return writeHostRegistration(this.#options.owner.controlDirectory, registration);
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
  try {
    return await Promise.race([
      task.then(() => true),
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
