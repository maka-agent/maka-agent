export interface BoundedSwarmOptions {
  readonly maxConcurrency: number;
  readonly signal: AbortSignal;
}

export interface SwarmWorkerContext {
  readonly index: number;
  readonly signal: AbortSignal;
}

export type SwarmItemResult<Output> =
  | {
      readonly index: number;
      readonly status: 'fulfilled';
      readonly value: Output;
    }
  | {
      readonly index: number;
      readonly status: 'rejected';
      readonly reason: unknown;
    }
  | {
      readonly index: number;
      readonly status: 'cancelled';
      readonly reason: unknown;
    };

type WorkerSettlement<Output> =
  | {
      readonly status: 'fulfilled';
      readonly value: Output;
    }
  | {
      readonly status: 'rejected';
      readonly reason: unknown;
    };

interface CancelledSettlement {
  readonly status: 'cancelled';
  readonly reason: unknown;
}

/**
 * Runs a finite, ordered collection through an all-settled worker pool.
 *
 * The returned slots always match input order. Parent cancellation prevents
 * queued items from starting, signals active workers, and joins those workers
 * before returning so work cannot escape the scope.
 */
export async function runBoundedSwarm<Input, Output>(
  items: readonly Input[],
  worker: (item: Input, context: SwarmWorkerContext) => Output | PromiseLike<Output>,
  options: BoundedSwarmOptions,
): Promise<readonly SwarmItemResult<Output>[]> {
  assertMaxConcurrency(options.maxConcurrency);
  if (items.length === 0) return [];

  const results = Array.from<SwarmItemResult<Output> | undefined>({
    length: items.length,
  });
  let nextIndex = 0;

  const claimNextIndex = (): number | undefined => {
    if (options.signal.aborted || nextIndex >= items.length) return undefined;
    const index = nextIndex;
    nextIndex += 1;
    return index;
  };

  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = claimNextIndex();
      if (index === undefined) return;

      const settlement = invokeWorker(worker, items[index]!, {
        index,
        signal: options.signal,
      });
      const outcome = await joinWorkerOrCancellation(settlement, options.signal);
      results[index] = { index, ...outcome };
    }
  };

  const workerCount = Math.min(options.maxConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return results.map((result, index): SwarmItemResult<Output> => {
    if (result) return result;
    if (!options.signal.aborted) {
      throw new Error(`Bounded swarm left item ${index} unsettled`);
    }
    return {
      index,
      status: 'cancelled',
      reason: cancellationReason(options.signal),
    };
  });
}

function invokeWorker<Input, Output>(
  worker: (item: Input, context: SwarmWorkerContext) => Output | PromiseLike<Output>,
  item: Input,
  context: SwarmWorkerContext,
): Promise<WorkerSettlement<Output>> {
  try {
    return Promise.resolve(worker(item, context)).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason: unknown) => ({ status: 'rejected', reason }),
    );
  } catch (reason) {
    return Promise.resolve({ status: 'rejected', reason });
  }
}

async function joinWorkerOrCancellation<Output>(
  settlement: Promise<WorkerSettlement<Output>>,
  signal: AbortSignal,
): Promise<WorkerSettlement<Output> | CancelledSettlement> {
  if (signal.aborted) {
    await settlement;
    return { status: 'cancelled', reason: cancellationReason(signal) };
  }

  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<CancelledSettlement>((resolve) => {
    onAbort = () => {
      resolve({ status: 'cancelled', reason: cancellationReason(signal) });
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const outcome = await Promise.race([settlement, cancelled]);
  if (onAbort) signal.removeEventListener('abort', onAbort);

  if (signal.aborted) {
    await settlement;
    return { status: 'cancelled', reason: cancellationReason(signal) };
  }
  return outcome;
}

function assertMaxConcurrency(maxConcurrency: number): void {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError('Swarm maxConcurrency must be a positive safe integer');
  }
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Bounded swarm cancelled');
}
