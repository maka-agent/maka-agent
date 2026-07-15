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
