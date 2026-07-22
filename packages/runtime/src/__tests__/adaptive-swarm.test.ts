import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  KIMI_STYLE_SWARM_POLICY,
  runAdaptiveSwarm,
  type AdaptiveSwarmPolicy,
} from '../adaptive-swarm.js';

const FAST_POLICY: AdaptiveSwarmPolicy = {
  initialLaunchLimit: 2,
  initialLaunchIntervalMs: 10,
  rateLimitRetryBaseMs: 10,
  rateLimitRetryFactor: 2,
  capacityShrinkIntervalMs: 5,
  capacityRecoveryIntervalMs: 30,
};

describe('runAdaptiveSwarm', () => {
  test('keeps the Kimi-compatible production timing policy explicit', () => {
    assert.deepEqual(KIMI_STYLE_SWARM_POLICY, {
      initialLaunchLimit: 5,
      initialLaunchIntervalMs: 700,
      rateLimitRetryBaseMs: 3_000,
      rateLimitRetryFactor: 2,
      capacityShrinkIntervalMs: 2_000,
      capacityRecoveryIntervalMs: 180_000,
    });
  });

  test('launches an initial burst and then ramps pending work', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const starts: number[] = [];
    const pending = runAdaptiveSwarm(
      [0, 1, 2, 3],
      async (_item, context) => {
        starts.push(context.index);
        context.markReady();
        await gates[context.index]!.promise;
        return { status: 'fulfilled', value: context.index };
      },
      {
        maxConcurrency: 4,
        signal: new AbortController().signal,
        policy: FAST_POLICY,
      },
    );

    await waitFor(() => starts.length === 2);
    assert.deepEqual(starts, [0, 1]);
    await waitFor(() => starts.length === 3);
    assert.deepEqual(starts, [0, 1, 2]);
    await waitFor(() => starts.length === 4);
    for (const gate of gates) gate.resolve();
    assert.deepEqual(
      (await pending).map((result) => result.status),
      ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
    );
  });

  test('requeues a rate-limited item with its retry token and preserves order', async () => {
    const attempts: Array<{ index: number; attempt: number; retry?: string }> = [];
    const rateLimits: Array<{ attempt: number; retryDelayMs: number }> = [];
    const siblingGate = deferred<void>();
    const pending = runAdaptiveSwarm<number, string, string>(
      [0, 1],
      async (_item, context) => {
        attempts.push({
          index: context.index,
          attempt: context.attempt,
          ...(context.retry ? { retry: context.retry } : {}),
        });
        context.markReady();
        if (context.index === 0 && context.attempt === 1) {
          return { status: 'rate_limited', retry: 'run-rate-limited', reason: new Error('429') };
        }
        if (context.index === 1) await siblingGate.promise;
        return { status: 'fulfilled', value: `value-${context.index}` };
      },
      {
        maxConcurrency: 2,
        signal: new AbortController().signal,
        policy: FAST_POLICY,
        onRateLimit: ({ attempt, retryDelayMs }) => rateLimits.push({ attempt, retryDelayMs }),
      },
    );

    await waitFor(() => rateLimits.length === 1);
    siblingGate.resolve();
    await waitFor(() => attempts.some((attempt) => attempt.index === 0 && attempt.attempt === 2));
    const results = await pending;
    assert.deepEqual(attempts[2], { index: 0, attempt: 2, retry: 'run-rate-limited' });
    assert.deepEqual(rateLimits, [{ attempt: 1, retryDelayMs: 10 }]);
    assert.deepEqual(results, [
      { index: 0, status: 'fulfilled', value: 'value-0' },
      { index: 1, status: 'fulfilled', value: 'value-1' },
    ]);
  });

  test('fails the last unfinished item instead of suspending forever', async () => {
    let attempts = 0;
    const results = await runAdaptiveSwarm<number, string, string>(
      [0],
      (_item, context) => {
        attempts += 1;
        context.markReady();
        return { status: 'rate_limited', retry: 'run-0', reason: new Error('still 429') };
      },
      {
        maxConcurrency: 1,
        signal: new AbortController().signal,
        policy: FAST_POLICY,
      },
    );

    assert.equal(attempts, 1);
    assert.equal(results[0]?.status, 'rejected');
    assert.match(String(results[0]?.status === 'rejected' && results[0].reason), /still 429/);
  });

  test('shrinks capacity on rate limit and recovers after a quiet interval', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const starts: Array<{ index: number; attempt: number }> = [];
    const capacity: Array<{ direction: 'decreased' | 'increased'; capacity: number }> = [];
    const pending = runAdaptiveSwarm<number, number, string>(
      [0, 1, 2, 3],
      async (_item, context) => {
        starts.push({ index: context.index, attempt: context.attempt });
        context.markReady();
        if (context.index === 0 && context.attempt === 1) {
          return { status: 'rate_limited', retry: 'run-0', reason: new Error('429') };
        }
        await gates[context.index]!.promise;
        return { status: 'fulfilled', value: context.index };
      },
      {
        maxConcurrency: 3,
        signal: new AbortController().signal,
        policy: FAST_POLICY,
        onCapacityChanged: (event) => capacity.push(event),
      },
    );

    await waitFor(() => capacity.some((event) => event.direction === 'decreased'));
    gates[1]!.resolve();
    await waitFor(() => starts.some((start) => start.index === 0 && start.attempt === 2));
    await waitFor(() => capacity.some((event) => event.direction === 'increased'));
    for (const gate of gates) gate.resolve();
    await pending;

    assert.deepEqual(capacity.slice(0, 2), [
      { direction: 'decreased', capacity: 1 },
      { direction: 'increased', capacity: 2 },
    ]);
  });

  test('joins active work and cancels pending work with its parent', async () => {
    const controller = new AbortController();
    const starts: number[] = [];
    const pending = runAdaptiveSwarm(
      [0, 1, 2],
      async (_item, context) => {
        starts.push(context.index);
        await onceAborted(context.signal);
        return { status: 'fulfilled', value: context.index };
      },
      { maxConcurrency: 2, signal: controller.signal, policy: FAST_POLICY },
    );
    await waitFor(() => starts.length === 2);
    controller.abort(new Error('parent stopped'));

    const results = await pending;
    assert.deepEqual(starts, [0, 1]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['cancelled', 'cancelled', 'cancelled'],
    );
  });
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  return {
    promise: new Promise<Value>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: (value) => resolvePromise!(value),
  };
}

function onceAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
