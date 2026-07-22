import {
  decodeClientFrame,
  type HostOperationErrorCode,
  type RequestFrame,
} from '../protocol/index.js';
import type { FramedTransport } from '../transport/framed-transport.js';
import {
  dispatchOperation,
  operationFailureResponse,
  type ConnectionContext,
  type OperationHandlerMap,
  type OperationResidency,
} from './operation-dispatcher.js';
import { BoundedSerialOutboundWriter } from './serial-outbound-writer.js';
import type {
  SessionContinuityConnection,
  SessionContinuityService,
} from './session-continuity-coordinator.js';
import type {
  HostNativeProviderService,
  NativeProviderConnectionAttachment,
} from './native-provider-coordinator.js';

const MAX_IN_FLIGHT_REQUESTS = 64;

type AcceptedConnectionContext = Omit<ConnectionContext, 'acquireResidency'>;

export interface ConnectionOperationLease {
  acquireResidency(): OperationResidency;
  seal(): void;
  finish(): void;
}

export interface RuntimeHostConnectionSessionOptions {
  transport: FramedTransport;
  connection: AcceptedConnectionContext;
  resolveHandlers(): OperationHandlerMap;
  resolveContinuity(): SessionContinuityService | undefined;
  resolveNativeProvider?(): HostNativeProviderService | undefined;
  beginOperation(frame: RequestFrame): Promise<ConnectionOperationLease | HostOperationErrorCode>;
  onTeardown(): void;
  onConnectionSettled?(): Promise<void>;
}

export class RuntimeHostConnectionSession {
  readonly #options: RuntimeHostConnectionSessionOptions;
  readonly #writer: BoundedSerialOutboundWriter;
  readonly #requests = new Map<string, Promise<void>>();
  #continuityService: SessionContinuityService | undefined;
  #continuity: SessionContinuityConnection | undefined;
  #nativeProviderService: HostNativeProviderService | undefined;
  #nativeProvider: NativeProviderConnectionAttachment | undefined;
  #closed = false;
  #connectionSettled = false;

  constructor(options: RuntimeHostConnectionSessionOptions) {
    this.#options = options;
    this.#writer = new BoundedSerialOutboundWriter(options.transport, () => this.#teardown());
  }

  async run(): Promise<void> {
    try {
      await this.#pumpInbound();
    } catch {
      this.#teardown();
    } finally {
      this.#teardown();
      await Promise.allSettled(this.#requests.values());
      try {
        await this.#notifyConnectionSettled();
      } finally {
        await Promise.all([this.#writer.settled(), this.#options.transport.closed]);
      }
    }
  }

  async #notifyConnectionSettled(): Promise<void> {
    if (this.#connectionSettled) return;
    this.#connectionSettled = true;
    await this.#options.onConnectionSettled?.();
  }

  async #pumpInbound(): Promise<void> {
    while (!this.#closed) {
      const frame = decodeClientFrame(await this.#options.transport.read(0));
      if ('kind' in frame) {
        if (frame.kind === 'hello') {
          throw new Error('Unexpected handshake frame after acceptance');
        }
        const attachment = this.#nativeProvider;
        if (!attachment) {
          this.#teardown();
          return;
        }
        attachment.accept(frame);
        continue;
      }
      if (this.#requests.has(frame.requestId) || this.#requests.size >= MAX_IN_FLIGHT_REQUESTS) {
        this.#teardown();
        return;
      }
      this.#dispatch(frame);
    }
  }

  #dispatch(frame: RequestFrame): void {
    const task = this.#handleRequest(frame)
      .catch(() => this.#teardown())
      .finally(() => {
        if (this.#requests.get(frame.requestId) === task) {
          this.#requests.delete(frame.requestId);
        }
      });
    this.#requests.set(frame.requestId, task);
  }

  async #handleRequest(frame: RequestFrame): Promise<void> {
    const admission = await this.#options.beginOperation(frame);
    if (typeof admission === 'string') {
      if (this.#closed) return;
      await this.#writer.enqueue(
        operationFailureResponse(
          frame,
          admission,
          admission === 'host_draining' ? 'Runtime Host is draining' : 'Runtime Host is not ready',
        ),
      ).flushed;
      return;
    }

    try {
      if (this.#closed) return;
      if (
        frame.operation === 'native.provider.register' ||
        frame.operation === 'native.provider.unregister'
      ) {
        this.#ensureNativeProvider();
      }
      const continuity = frame.operation.startsWith('subscription.')
        ? this.#ensureContinuity()
        : undefined;
      const response = await dispatchOperation(frame, this.#options.resolveHandlers(), {
        ...this.#options.connection,
        acquireResidency: () => admission.acquireResidency(),
      });
      admission.seal();
      const receipt = this.#writer.enqueue(response);
      const openedSubscriptionId =
        response.ok && response.operation === 'subscription.open'
          ? response.result.subscriptionId
          : undefined;
      if (openedSubscriptionId) {
        continuity?.activate(openedSubscriptionId);
      }
      try {
        await receipt.flushed;
      } catch (error) {
        if (openedSubscriptionId) {
          continuity?.abort(openedSubscriptionId);
        }
        throw error;
      }
    } finally {
      admission.finish();
    }
  }

  #ensureContinuity(): SessionContinuityConnection | undefined {
    if (this.#closed) {
      throw new Error('Closed Runtime Host connection cannot attach continuity');
    }
    const service = this.#options.resolveContinuity();
    if (!service) return;
    if (this.#continuityService && this.#continuityService !== service) {
      throw new Error('Runtime Host continuity service changed within one connection');
    }
    if (!this.#continuity) {
      this.#continuityService = service;
      this.#continuity = service.attachConnection(this.#options.connection.connectionId, {
        send: (frame) => {
          try {
            return this.#writer.enqueue(frame).flushed;
          } catch (error) {
            return Promise.reject(error);
          }
        },
        close: () => this.#teardown(),
      });
    }
    return this.#continuity;
  }

  #ensureNativeProvider(): NativeProviderConnectionAttachment | undefined {
    if (this.#closed) {
      throw new Error('Closed Runtime Host connection cannot attach a Native Provider');
    }
    const service = this.#options.resolveNativeProvider?.();
    if (!service) return;
    if (this.#nativeProviderService && this.#nativeProviderService !== service) {
      throw new Error('Runtime Host Native Provider service changed within one connection');
    }
    if (!this.#nativeProvider) {
      this.#nativeProviderService = service;
      this.#nativeProvider = service.attachConnection(this.#options.connection.connectionId, {
        enqueue: (frame) => this.#writer.enqueue(frame),
        close: () => this.#teardown(),
      });
    }
    return this.#nativeProvider;
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#nativeProvider?.close();
    this.#continuity?.close();
    this.#writer.close();
    this.#options.transport.destroy();
    this.#options.onTeardown();
  }
}
