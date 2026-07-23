const POISONED_MESSAGE = 'Runtime policy activation is poisoned';

/**
 * Coordinates runtime-policy mutation/invalidation with the short backend
 * activation window that selects a backend and starts a run.
 */
export class RuntimePolicyActivationGate {
  readonly #backendActivations = new Set<Promise<void>>();
  #mutationTail = Promise.resolve();
  #poisoned = false;

  runBackendActivation<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#poisoned) return Promise.reject(poisonedError());

    const precedingMutations = this.#mutationTail;
    const completion = deferred();
    this.#backendActivations.add(completion.promise);

    return this.#executeBackendActivation(precedingMutations, completion, operation);
  }

  runMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#poisoned) return Promise.reject(poisonedError());

    const precedingMutation = this.#mutationTail;
    const precedingBackendActivations = [...this.#backendActivations];
    const completion = deferred();

    // This tail never rejects, so later registrations cannot create an
    // unhandled rejection from an operation failure.
    this.#mutationTail = precedingMutation.then(() => completion.promise);

    return this.#executeMutation(
      precedingMutation,
      precedingBackendActivations,
      completion,
      operation,
    );
  }

  poison(): void {
    this.#poisoned = true;
  }

  async #executeBackendActivation<T>(
    precedingMutations: Promise<void>,
    completion: Deferred,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    try {
      await precedingMutations;
      this.#assertOpen();
      return await operation();
    } finally {
      completion.resolve();
      this.#backendActivations.delete(completion.promise);
    }
  }

  async #executeMutation<T>(
    precedingMutation: Promise<void>,
    precedingBackendActivations: readonly Promise<void>[],
    completion: Deferred,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    try {
      await Promise.all([precedingMutation, ...precedingBackendActivations]);
      this.#assertOpen();
      return await operation();
    } finally {
      completion.resolve();
    }
  }

  #assertOpen(): void {
    if (this.#poisoned) throw poisonedError();
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function poisonedError(): Error {
  return new Error(POISONED_MESSAGE);
}
