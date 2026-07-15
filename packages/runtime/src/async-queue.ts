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
 */

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiters: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: Error) => void;
  }> = [];
  private closed = false;
  private err: Error | null = null;

  push(item: T): void {
    if (this.closed || this.err) return;
    const w = this.waiters.shift();
    if (w) {
      w.resolve({ value: item, done: false });
    } else {
      this.buf.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.resolve({ value: undefined as unknown as T, done: true });
    }
  }

  error(err: Error): void {
    if (this.closed) return;
    this.err = err;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.reject(err);
    }
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
