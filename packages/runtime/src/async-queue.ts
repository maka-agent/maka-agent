/**
 * AsyncEventQueue — single-producer, single-consumer FIFO with async iteration.
 *
 * Use case: backends (AiSdkBackend / FakeBackend) need to surface
 * events from multiple internal callsites — the SDK stream loop AND the
 * `canUseTool` callback that fires in parallel from the SDK subprocess.
 * Both callsites push into the same queue; `send()` returns the queue's
 * async iterator so the SessionManager can drain in order.
 *
 * Semantics:
 * - `push(item)` is non-blocking; resolves the next waiter or buffers.
 * - `close()` signals end-of-stream; the iterator drains buffered items then
 *   completes.
 * - `error(err)` rejects the next/current waiter and marks the queue errored;
 *   subsequent `next()` calls re-throw.
 * - One consumer only. Multiple consumers will race on `next()`.
 *
 * Seq-ack counters: `pushedCount` stamps a monotonic sequence on the producer
 * side at enqueue; the consumer loop acks each event AFTER fully processing it
 * via `ackConsumed()` (see AiSdkBackend.drain — the generator's pull IS the
 * ack). A producer-side waiter can then await "everything enqueued before this
 * boundary has been processed" with `consumedCount >= pushedCount`, using
 * `waitForProgress()` as the condition-variable wake — no polling, and immune
 * to event-kind predicate drift because it counts the stream itself.
 */

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiters: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: Error) => void;
  }> = [];
  private closed = false;
  private err: Error | null = null;
  /** Monotonic count of events accepted by push(). */
  pushedCount = 0;
  /** Monotonic count of events the consumer has fully processed. */
  consumedCount = 0;
  /** Set when the consumer abandoned the stream; progress waiters must not block on it. */
  consumerDetached = false;
  private progressWaiters: Array<() => void> = [];

  push(item: T): void {
    if (this.closed || this.err) return;
    this.pushedCount += 1;
    const w = this.waiters.shift();
    if (w) {
      w.resolve({ value: item, done: false });
    } else {
      this.buf.push(item);
    }
    this.wake();
  }

  /** Consumer-side ack: one event has been fully processed (not just received). */
  ackConsumed(): void {
    this.consumedCount += 1;
    this.wake();
  }

  /** The consumer stopped pulling; wake waiters so they can observe it. */
  noteConsumerDetached(): void {
    this.consumerDetached = true;
    this.wake();
  }

  /** Resolves on the next push/ack/close/error/wake — a condition-variable wait. */
  waitForProgress(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.progressWaiters.push(resolve);
    });
  }

  /** Wake all progress waiters so they re-check their condition. */
  wake(): void {
    if (this.progressWaiters.length === 0) return;
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const resolve of waiters) resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.resolve({ value: undefined as unknown as T, done: true });
    }
    this.wake();
  }

  error(err: Error): void {
    if (this.closed) return;
    this.err = err;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.reject(err);
    }
    this.wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.err) return Promise.reject(this.err);
        const item = this.buf.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}
