import type { Socket } from 'node:net';
import {
  encodeProtocolFrame,
  ProtocolFrameDecoder,
  RuntimeHostProtocolError,
  type ClientFrame,
  type HostFrame,
} from '../protocol/index.js';

const MAX_QUEUED_FRAMES = 32;

interface ReadWaiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export class RuntimeHostTransportError extends Error {
  constructor(
    readonly code: 'closed' | 'read_timeout' | 'concurrent_read' | 'inbound_queue_full',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostTransportError';
  }
}

export class FramedTransport {
  readonly closed: Promise<void>;
  readonly #decoder = new ProtocolFrameDecoder();
  readonly #queue: unknown[] = [];
  #waiter: ReadWaiter | undefined;
  #failure: Error | undefined;
  #resolveClosed!: () => void;

  constructor(readonly socket: Socket) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.on('data', (chunk) =>
      this.#receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    );
    socket.once('end', () => {
      try {
        this.#decoder.end();
      } catch (error) {
        this.#fail(asError(error));
      }
    });
    socket.once('error', (error) => this.#fail(error));
    socket.once('close', () => {
      this.#fail(new RuntimeHostTransportError('closed', 'Runtime Host transport closed'));
      this.#resolveClosed();
    });
  }

  async read(timeoutMs: number): Promise<unknown> {
    if (this.#queue.length > 0) return this.#queue.shift();
    if (this.#failure) throw this.#failure;
    if (this.#waiter) {
      throw new RuntimeHostTransportError(
        'concurrent_read',
        'Only one Runtime Host frame read may be pending',
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: ReadWaiter = { resolve, reject };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (this.#waiter !== waiter) return;
          const error = new RuntimeHostTransportError(
            'read_timeout',
            'Timed out waiting for Runtime Host frame',
          );
          this.#fail(error);
          this.socket.destroy();
        }, timeoutMs);
      }
      this.#waiter = waiter;
    });
  }

  write(frame: ClientFrame | HostFrame): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    const encoded = encodeProtocolFrame(frame);
    return new Promise((resolve, reject) => {
      this.socket.write(encoded, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  destroyAfterFlush(): void {
    this.socket.destroySoon();
  }

  destroy(error?: Error): void {
    this.socket.destroy(error);
  }

  #receive(chunk: Buffer): void {
    if (this.#failure) return;
    let frames: unknown[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#fail(asError(error));
      this.socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (this.#waiter) {
        const waiter = this.#waiter;
        this.#waiter = undefined;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.#queue.push(frame);
        if (this.#queue.length > MAX_QUEUED_FRAMES) {
          this.#fail(
            new RuntimeHostTransportError(
              'inbound_queue_full',
              'Runtime Host inbound frame queue is full',
            ),
          );
          this.socket.destroy();
          return;
        }
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    if (!this.#waiter) return;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new RuntimeHostProtocolError('invalid_frame', String(error));
}
