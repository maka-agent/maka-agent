export interface ChildAgentRunPermit {
  release(): void;
}

interface ChildAgentRunWaiter {
  signal: AbortSignal;
  resolve: (permit: ChildAgentRunPermit) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

/**
 * Abort-aware FIFO permits for real child-agent executions.
 *
 * Tool-call admission and child-run capacity are separate boundaries: one
 * admitted tool may eventually spawn multiple children. This limiter belongs at
 * the narrow spawn capability so every caller shares the same real-run budget.
 */
export class ChildAgentRunLimiter {
  private active = 0;
  private readonly waiters: ChildAgentRunWaiter[] = [];
  private closedError: Error | undefined;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Child agent run capacity must be a positive safe integer');
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  acquire(signal: AbortSignal): Promise<ChildAgentRunPermit> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.capacity && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.createPermit());
    }
    return new Promise<ChildAgentRunPermit>((resolve, reject) => {
      const waiter: ChildAgentRunWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(abortReason(signal));
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(error);
    }
  }

  private createPermit(): ChildAgentRunPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.grantWaiting();
      },
    };
  }

  private grantWaiting(): void {
    if (this.closedError) return;
    while (this.active < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createPermit());
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Child agent run cancelled while waiting for runtime capacity');
}
