/**
 * Tests for AsyncEventQueue — single-producer / single-consumer FIFO.
 */

import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import { AsyncEventQueue } from '../async-queue.js';

describe('AsyncEventQueue', () => {
  test('buffered items emit in order, then done', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();

    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  test('consumer waits, then receives on push', async () => {
    const q = new AsyncEventQueue<string>();
    const result: string[] = [];

    const reader = (async () => {
      for await (const v of q) result.push(v);
    })();

    // Slightly delay producer; consumer is now parked on next() Promise.
    await Promise.resolve();
    q.push('a');
    q.push('b');
    q.close();

    await reader;
    expect(result).toEqual(['a', 'b']);
  });

  test('close before any push → consumer completes immediately', async () => {
    const q = new AsyncEventQueue<number>();
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([]);
  });

  test('push after close is dropped (no throw)', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.close();
    q.push(2); // silently dropped
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1]);
  });

  test('error rejects waiting consumer', async () => {
    const q = new AsyncEventQueue<number>();
    const failure = new Error('boom');

    const consumerErr = (async () => {
      try {
        for await (const _ of q) {
          // unreached
        }
        return null;
      } catch (e) {
        return e;
      }
    })();

    await Promise.resolve(); // let consumer park
    q.error(failure);
    expect(await consumerErr).toBe(failure);
  });

  test('return() from iterator closes the queue', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);

    const iter = q[Symbol.asyncIterator]();
    const r1 = await iter.next();
    expect(r1).toEqual({ value: 1, done: false });
    await iter.return?.();
    const r2 = await iter.next();
    expect(r2).toEqual({ value: 2, done: false });
  });

  test('interleaved push/next preserves FIFO', async () => {
    const q = new AsyncEventQueue<number>();
    const out: number[] = [];

    const reader = (async () => {
      for await (const v of q) out.push(v);
    })();

    q.push(10);
    await Promise.resolve();
    q.push(20);
    await Promise.resolve();
    q.push(30);
    q.close();
    await reader;

    expect(out).toEqual([10, 20, 30]);
  });
});

describe('AsyncEventQueue seq-ack counters', () => {
  test('pushedCount stamps enqueues; ackConsumed counts processed events', () => {
    const q = new AsyncEventQueue<number>();
    expect(q.pushedCount).toBe(0);
    q.push(1);
    q.push(2);
    expect(q.pushedCount).toBe(2);
    expect(q.consumedCount).toBe(0);
    q.ackConsumed();
    expect(q.consumedCount).toBe(1);
    // A dropped push (after close) is not stamped: the counter tracks events
    // a consumer can ever receive, or the boundary would be unreachable.
    q.close();
    q.push(3);
    expect(q.pushedCount).toBe(2);
  });

  test('waitForProgress resolves on push, ack, close, and detach — condition-variable, not a poll', async () => {
    const q = new AsyncEventQueue<number>();
    let wakes = 0;
    const arm = (): void => {
      void q.waitForProgress().then(() => {
        wakes += 1;
      });
    };

    arm();
    q.push(1);
    await Promise.resolve();
    expect(wakes).toBe(1);

    arm();
    q.ackConsumed();
    await Promise.resolve();
    expect(wakes).toBe(2);

    arm();
    q.noteConsumerDetached();
    await Promise.resolve();
    expect(wakes).toBe(3);
    expect(q.consumerDetached).toBe(true);

    arm();
    q.close();
    await Promise.resolve();
    expect(wakes).toBe(4);
  });

  test('a seq-ack boundary wait observes consumed >= pushed exactly when the consumer has processed everything', async () => {
    const q = new AsyncEventQueue<number>();
    const processed: number[] = [];

    // Producer-side boundary waiter: everything pushed so far must be processed.
    const boundary = q.pushedCount; // 0 — then push 3 events
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();
    expect(boundary).toBe(0);

    const waiter = (async () => {
      while (q.consumedCount < q.pushedCount) {
        await q.waitForProgress();
      }
      return [q.pushedCount, q.consumedCount];
    })();

    // Consumer acks after fully processing each event (the drain() pattern).
    for await (const v of q) {
      processed.push(v);
      q.ackConsumed();
    }
    expect(await waiter).toEqual([3, 3]);
    expect(processed).toEqual([1, 2, 3]);
  });

  test('a detached consumer wakes boundary waiters instead of deadlocking them', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    const waiter = (async () => {
      while (q.consumedCount < q.pushedCount) {
        if (q.consumerDetached) return 'detached';
        await q.waitForProgress();
      }
      return 'acked';
    })();
    // The consumer abandons the stream after one event without acking the rest.
    const iter = q[Symbol.asyncIterator]();
    await iter.next();
    q.noteConsumerDetached();
    expect(await waiter).toBe('detached');
  });
});
