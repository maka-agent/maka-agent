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
import { RuntimeHostTransportError } from '../transport/framed-transport.js';

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
  beginOperation(frame: RequestFrame): Promise<ConnectionOperationLease | HostOperationErrorCode>;
  onTeardown(): void;
}

export class RuntimeHostConnectionSession {
  readonly #options: RuntimeHostConnectionSessionOptions;
  readonly #writer: BoundedSerialOutboundWriter;
  readonly #requests = new Map<string, Promise<void>>();
  #closed = false;

  constructor(options: RuntimeHostConnectionSessionOptions) {
    this.#options = options;
    this.#writer = new BoundedSerialOutboundWriter(options.transport, () => this.#teardown());
  }

  async run(): Promise<void> {
    try {
      try {
        await this.#pumpInbound();
      } catch (error) {
        if (!isReadEof(error)) throw error;
        await this.#closeAfterDispatchedReplies();
      }
    } catch {
      this.#teardown();
    } finally {
      this.#teardown();
      await Promise.allSettled(this.#requests.values());
      await Promise.all([this.#writer.settled(), this.#options.transport.closed]);
    }
  }

  async #closeAfterDispatchedReplies(): Promise<void> {
    const outcome = await Promise.race([
      Promise.allSettled([...this.#requests.values()]).then(() => 'drained' as const),
      this.#options.transport.closed.then(() => 'closed' as const),
    ]);
    if (outcome === 'closed') {
      this.#teardown();
      return;
    }
    if (this.#closed) return;
    await this.#writer.settled();
    if (this.#closed) return;
    this.#closed = true;
    this.#writer.close();
    this.#options.transport.destroyAfterFlush();
    this.#options.onTeardown();
  }

  async #pumpInbound(): Promise<void> {
    while (!this.#closed) {
      const frame = decodeClientFrame(await this.#options.transport.read(0));
      if ('kind' in frame) throw new Error('Unexpected handshake frame after acceptance');
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
      const response = await dispatchOperation(frame, this.#options.resolveHandlers(), {
        ...this.#options.connection,
        acquireResidency: () => admission.acquireResidency(),
      });
      admission.seal();
      await this.#writer.enqueue(response).flushed;
    } finally {
      admission.finish();
    }
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#writer.close();
    this.#options.transport.destroy();
    this.#options.onTeardown();
  }
}

function isReadEof(error: unknown): boolean {
  return error instanceof RuntimeHostTransportError && error.code === 'read_eof';
}
