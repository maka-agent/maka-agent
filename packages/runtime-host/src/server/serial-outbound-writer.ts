import { encodeProtocolFrame, type HostFrame } from '../protocol/index.js';
import type { FramedTransport } from '../transport/framed-transport.js';

const MAX_QUEUED_FRAMES = 64;
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

interface QueuedFrame {
  encoded: Buffer;
  resolve(): void;
  reject(error: Error): void;
}

export interface OutboundWriteReceipt {
  readonly flushed: Promise<void>;
}

export class BoundedSerialOutboundWriter {
  readonly #transport: FramedTransport;
  readonly #onFailure: () => void;
  readonly #queue: QueuedFrame[] = [];
  #queuedBytes = 0;
  #writing = false;
  #drainTask: Promise<void> | undefined;
  #closed = false;

  constructor(transport: FramedTransport, onFailure: () => void) {
    this.#transport = transport;
    this.#onFailure = onFailure;
  }

  enqueue(frame: HostFrame): OutboundWriteReceipt {
    if (this.#closed) {
      throw new Error('Runtime Host outbound writer is closed');
    }

    let encoded: Buffer;
    try {
      encoded = encodeProtocolFrame(frame);
    } catch (error) {
      const failure = asError(error);
      this.#fail(failure);
      throw failure;
    }
    if (
      this.#queue.length >= MAX_QUEUED_FRAMES ||
      this.#queuedBytes + encoded.byteLength > MAX_QUEUED_BYTES
    ) {
      const failure = new Error('Runtime Host outbound queue exceeded its bound');
      this.#fail(failure);
      throw failure;
    }

    const flushed = new Promise<void>((resolve, reject) => {
      this.#queue.push({ encoded, resolve, reject });
      this.#queuedBytes += encoded.byteLength;
      if (!this.#writing) {
        this.#writing = true;
        this.#drainTask = this.#drain();
      }
    });
    return { flushed };
  }

  settled(): Promise<void> {
    return this.#drainTask ?? Promise.resolve();
  }

  close(
    error = new Error('Runtime Host outbound writer closed before the frame was flushed'),
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const queued of this.#queue.splice(0)) queued.reject(error);
    this.#queuedBytes = 0;
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#closed) {
        const queued = this.#queue[0];
        if (!queued) return;
        try {
          await this.#transport.writeEncoded(queued.encoded);
        } catch (error) {
          this.#fail(asError(error));
          return;
        }
        if (this.#closed) return;
        this.#queue.shift();
        this.#queuedBytes -= queued.encoded.byteLength;
        queued.resolve();
      }
    } catch (error) {
      this.#fail(asError(error));
    } finally {
      this.#writing = false;
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.close(error);
    this.#onFailure();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
