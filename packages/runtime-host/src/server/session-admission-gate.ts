import { AsyncLocalStorage } from 'node:async_hooks';

const sessionAdmissionLeaseBrand: unique symbol = Symbol('SessionAdmissionLease');

export interface SessionAdmissionLease {
  readonly [sessionAdmissionLeaseBrand]: true;
}

export interface SessionLifecycleAdmission {
  release(): void;
}

interface SessionAdmissionContext {
  sessionId: string;
  active: boolean;
}

interface SessionAdmissionLeaseState {
  readonly sessionId: string;
  readonly context: SessionAdmissionContext;
  readonly tasks: Promise<SessionAdmissionTaskResult>[];
  readonly newWorkAdmitted: boolean;
  accepting: boolean;
}

type SessionAdmissionTaskResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

export class SessionAdmissionGate {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #closingSessions = new Map<string, number>();
  readonly #context = new AsyncLocalStorage<SessionAdmissionContext>();
  readonly #leases = new WeakMap<SessionAdmissionLease, SessionAdmissionLeaseState>();

  beginSessionLifecycle(sessionId: string): SessionLifecycleAdmission {
    this.#closingSessions.set(sessionId, (this.#closingSessions.get(sessionId) ?? 0) + 1);
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        const holders = this.#closingSessions.get(sessionId);
        if (holders === undefined) return;
        if (holders === 1) this.#closingSessions.delete(sessionId);
        else this.#closingSessions.set(sessionId, holders - 1);
      },
    });
  }

  isSessionClosing(sessionId: string): boolean {
    return this.#closingSessions.has(sessionId);
  }

  async run<T>(
    sessionId: string,
    operation: (lease: SessionAdmissionLease) => Promise<T> | T,
  ): Promise<T> {
    const inherited = this.#context.getStore();
    if (inherited?.active) {
      throw new Error(
        'Cannot call Session admission run from an active admission; use runAdmitted with its active lease',
      );
    }
    return this.#runQueued(sessionId, operation);
  }

  enqueueDetached(sessionId: string, operation: () => Promise<void> | void): void {
    const task = this.#runQueued(sessionId, operation);
    void task.then(
      () => undefined,
      () => undefined,
    );
  }

  async #runQueued<T>(
    sessionId: string,
    operation: (lease: SessionAdmissionLease) => Promise<T> | T,
  ): Promise<T> {
    // Capture before the first await: entering this method is the new-work admission cut.
    const newWorkAdmitted = !this.#closingSessions.has(sessionId);
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(sessionId, tail);
    await previous;
    const context: SessionAdmissionContext = { sessionId, active: true };
    const lease: SessionAdmissionLease = Object.freeze({
      [sessionAdmissionLeaseBrand]: true as const,
    });
    const leaseState: SessionAdmissionLeaseState = {
      sessionId,
      context,
      tasks: [],
      newWorkAdmitted,
      accepting: true,
    };
    this.#leases.set(lease, leaseState);
    try {
      let result!: T;
      let operationError: unknown;
      let operationFailed = false;
      try {
        result = await this.#context.run(context, () => operation(lease));
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        leaseState.accepting = false;
      }

      const taskResults = await Promise.all(leaseState.tasks);
      const errors: unknown[] = [];
      const collectError = (error: unknown) => {
        if (!errors.some((existing) => Object.is(existing, error))) {
          errors.push(error);
        }
      };
      if (operationFailed) collectError(operationError);
      for (const task of taskResults) {
        if (!task.ok) collectError(task.error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Session admission operation failed');
      }
      return result;
    } finally {
      context.active = false;
      this.#leases.delete(lease);
      release();
      if (this.#tails.get(sessionId) === tail) {
        this.#tails.delete(sessionId);
      }
    }
  }

  runAdmitted<T>(
    sessionId: string,
    lease: SessionAdmissionLease,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const leaseState = this.#requireLease(sessionId, lease);
    if (!leaseState.accepting) {
      throw new Error('Session admission lease no longer accepts tasks');
    }
    const inherited = this.#context.getStore();
    if (inherited?.active && inherited.sessionId !== sessionId) {
      throw new Error('Cannot nest Session admission across Sessions');
    }

    let task: Promise<T>;
    try {
      task = Promise.resolve(this.#context.run(leaseState.context, operation));
    } catch (error) {
      task = Promise.reject(error);
    }
    const observed: Promise<SessionAdmissionTaskResult> = task.then(
      (): SessionAdmissionTaskResult => ({ ok: true }),
      (error): SessionAdmissionTaskResult => ({ ok: false, error }),
    );
    leaseState.tasks.push(observed);
    return task;
  }

  isNewWorkAdmitted(sessionId: string, lease: SessionAdmissionLease): boolean {
    return this.#requireLease(sessionId, lease).newWorkAdmitted;
  }

  #requireLease(sessionId: string, lease: SessionAdmissionLease): SessionAdmissionLeaseState {
    const leaseState = this.#leases.get(lease);
    if (!leaseState) {
      throw new Error('Session admission lease was not issued by this gate');
    }
    if (leaseState.sessionId !== sessionId) {
      throw new Error('Session admission lease does not match the Session');
    }
    return leaseState;
  }
}
