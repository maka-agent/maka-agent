import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runBoundedSwarm, type SwarmItemResult } from '../bounded-swarm.js';

describe('runBoundedSwarm', () => {
  test('rejects invalid concurrency before starting work', async () => {
    let starts = 0;
    const worker = () => {
      starts += 1;
      return 'started';
    };
    const signal = new AbortController().signal;

    for (const maxConcurrency of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        runBoundedSwarm(['item'], worker, { maxConcurrency, signal }),
        /positive safe integer/,
      );
    }
    assert.equal(starts, 0);
  });

  test('returns an empty stable result without invoking the worker', async () => {
    let starts = 0;
    const results = await runBoundedSwarm(
      [],
      () => {
        starts += 1;
      },
      { maxConcurrency: 3, signal: new AbortController().signal },
    );

    assert.deepEqual(results, []);
    assert.equal(starts, 0);
  });

  test('enforces local concurrency and applies backpressure', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const pending = runBoundedSwarm(
      [0, 1, 2, 3, 4, 5],
      async (_item, { index }) => {
        started.push(index);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates[index]!.promise;
        active -= 1;
        return `value-${index}`;
      },
      { maxConcurrency: 2, signal: new AbortController().signal },
    );

    await waitFor(() => started.length === 2);
    assert.deepEqual(started, [0, 1]);
    assert.equal(maxActive, 2);

    gates[1]!.resolve();
    await waitFor(() => started.length === 3);
    assert.deepEqual(started, [0, 1, 2]);
    assert.equal(maxActive, 2);

    for (const gate of gates) gate.resolve();
    const results = await withTimeout(pending, 'bounded workers did not settle');

    assert.equal(active, 0);
    assert.equal(maxActive, 2);
    assert.deepEqual(
      results.map((result) => result.status),
      Array.from({ length: 6 }, () => 'fulfilled'),
    );
  });

  test('keeps result slots in input order when workers finish out of order', async () => {
    const gates = Array.from({ length: 3 }, () => deferred<string>());
    const completionOrder: number[] = [];
    const pending = runBoundedSwarm(
      ['first', 'second', 'third'],
      async (_item, { index }) => {
        const value = await gates[index]!.promise;
        completionOrder.push(index);
        return value;
      },
      { maxConcurrency: 3, signal: new AbortController().signal },
    );

    gates[2]!.resolve('third-value');
    await waitFor(() => completionOrder.length === 1);
    gates[0]!.resolve('first-value');
    await waitFor(() => completionOrder.length === 2);
    gates[1]!.resolve('second-value');

    const results = await pending;
    assert.deepEqual(completionOrder, [2, 0, 1]);
    assert.deepEqual(results, [
      { index: 0, status: 'fulfilled', value: 'first-value' },
      { index: 1, status: 'fulfilled', value: 'second-value' },
      { index: 2, status: 'fulfilled', value: 'third-value' },
    ]);
  });

  test('isolates synchronous throws and asynchronous rejections', async () => {
    const visited: number[] = [];
    const results = await runBoundedSwarm(
      [0, 1, 2, 3],
      (item) => {
        visited.push(item);
        if (item === 1) throw new Error('synchronous failure');
        if (item === 2) return Promise.reject(new Error('rejected promise'));
        return `value-${item}`;
      },
      { maxConcurrency: 2, signal: new AbortController().signal },
    );

    assert.deepEqual(
      visited.sort((left, right) => left - right),
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'rejected', 'rejected', 'fulfilled'],
    );
    assert.match(rejectionReason(results[1]), /synchronous failure/);
    assert.match(rejectionReason(results[2]), /rejected promise/);
  });

  test('cancels queued slots, signals active workers, and joins them', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const observedAbort: number[] = [];
    const pending = runBoundedSwarm(
      [0, 1, 2, 3, 4],
      async (_item, { index, signal }) => {
        started.push(index);
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort.push(index);
              resolve();
            },
            { once: true },
          );
        });
        return `late-${index}`;
      },
      { maxConcurrency: 2, signal: controller.signal },
    );

    await waitFor(() => started.length === 2);
    controller.abort(new Error('parent stopped'));
    const results = await withTimeout(pending, 'cancelled workers escaped the scope');

    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(
      observedAbort.sort((left, right) => left - right),
      [0, 1],
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled'],
    );
    for (const result of results) {
      assert.match(cancellationReason(result), /parent stopped/);
    }
  });

  test('does not start any item when the parent is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already stopped'));
    let starts = 0;

    const results = await runBoundedSwarm(
      [0, 1, 2],
      () => {
        starts += 1;
        return 'unreachable';
      },
      { maxConcurrency: 3, signal: controller.signal },
    );

    assert.equal(starts, 0);
    assert.deepEqual(
      results.map((result) => result.status),
      ['cancelled', 'cancelled', 'cancelled'],
    );
  });

  test('settles throw and abort races without starting another queued item', async () => {
    const controller = new AbortController();
    const secondStarted = deferred<void>();
    const started: number[] = [];
    const pending = runBoundedSwarm(
      [0, 1, 2],
      async (_item, { index, signal }) => {
        started.push(index);
        if (index === 0) throw new Error('first failed');
        secondStarted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'late success';
      },
      { maxConcurrency: 1, signal: controller.signal },
    );

    await secondStarted.promise;
    controller.abort(new Error('race cancelled'));
    const results = await withTimeout(pending, 'throw/abort race did not settle');

    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'cancelled', 'cancelled'],
    );
    assert.match(rejectionReason(results[0]), /first failed/);
  });

  test('handles single-item and 32-item batches deterministically', async () => {
    const signal = new AbortController().signal;
    const single = await runBoundedSwarm(['one'], (item) => item.toUpperCase(), {
      maxConcurrency: 1,
      signal,
    });
    const batch = await runBoundedSwarm(
      Array.from({ length: 32 }, (_, index) => index),
      (item, { index }) => item + index,
      { maxConcurrency: 5, signal },
    );

    assert.deepEqual(single, [{ index: 0, status: 'fulfilled', value: 'ONE' }]);
    assert.deepEqual(
      batch,
      Array.from({ length: 32 }, (_, index) => ({
        index,
        status: 'fulfilled',
        value: index * 2,
      })),
    );
  });
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise!(value),
  };
}

function rejectionReason<Output>(result: SwarmItemResult<Output> | undefined): string {
  assert.equal(result?.status, 'rejected');
  return String(result.reason);
}

function cancellationReason<Output>(result: SwarmItemResult<Output>): string {
  assert.equal(result.status, 'cancelled');
  return String(result.reason);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  message: string,
  timeoutMs = 1_000,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
