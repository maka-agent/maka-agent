export interface AdaptiveSwarmPolicy {
  readonly initialLaunchLimit: number;
  readonly initialLaunchIntervalMs: number;
  readonly rateLimitRetryBaseMs: number;
  readonly rateLimitRetryFactor: number;
  readonly capacityShrinkIntervalMs: number;
  readonly capacityRecoveryIntervalMs: number;
}

export const KIMI_STYLE_SWARM_POLICY: AdaptiveSwarmPolicy = {
  initialLaunchLimit: 5,
  initialLaunchIntervalMs: 700,
  rateLimitRetryBaseMs: 3_000,
  rateLimitRetryFactor: 2,
  capacityShrinkIntervalMs: 2_000,
  capacityRecoveryIntervalMs: 3 * 60 * 1_000,
};

export interface AdaptiveSwarmOptions {
  readonly maxConcurrency: number;
  readonly signal: AbortSignal;
  readonly policy?: AdaptiveSwarmPolicy;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly onRateLimit?: (event: AdaptiveSwarmRateLimitEvent) => void;
  readonly onCapacityChanged?: (event: AdaptiveSwarmCapacityEvent) => void;
}

export interface AdaptiveSwarmWorkerContext<Retry> {
  readonly index: number;
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly retry: Retry | undefined;
  markReady(): void;
}

export type AdaptiveSwarmAttemptResult<Output, Retry> =
  | { readonly status: 'fulfilled'; readonly value: Output }
  | { readonly status: 'rate_limited'; readonly retry: Retry; readonly reason: unknown };

export type AdaptiveSwarmItemResult<Output> =
  | { readonly index: number; readonly status: 'fulfilled'; readonly value: Output }
  | { readonly index: number; readonly status: 'rejected'; readonly reason: unknown }
  | { readonly index: number; readonly status: 'cancelled'; readonly reason: unknown };

export interface AdaptiveSwarmRateLimitEvent {
  readonly index: number;
  readonly attempt: number;
  readonly retryDelayMs: number;
  readonly capacity: number;
}

export interface AdaptiveSwarmCapacityEvent {
  readonly direction: 'decreased' | 'increased';
  readonly capacity: number;
}

interface ItemState<Input, Retry> {
  readonly index: number;
  readonly item: Input;
  attempt: number;
  retry: Retry | undefined;
  retryReadyAt: number;
  started: boolean;
}

interface ActiveAttempt<Input, Retry> {
  readonly state: ItemState<Input, Retry>;
  ready: boolean;
}

/**
 * Foreground all-settled scheduler with Kimi-style provider backpressure.
 *
 * Normal work launches in a five-item burst and then ramps one item at a time.
 * The first provider rate limit stops that ramp, requeues the affected item,
 * and switches to a capacity-controlled recovery phase. This scheduler owns
 * timing and ordering only; callers own child lifecycle and retry identity.
 */
export function runAdaptiveSwarm<Input, Output, Retry>(
  items: readonly Input[],
  worker: (
    item: Input,
    context: AdaptiveSwarmWorkerContext<Retry>,
  ) =>
    | AdaptiveSwarmAttemptResult<Output, Retry>
    | PromiseLike<AdaptiveSwarmAttemptResult<Output, Retry>>,
  options: AdaptiveSwarmOptions,
): Promise<readonly AdaptiveSwarmItemResult<Output>[]> {
  assertOptions(options);
  if (items.length === 0) return Promise.resolve([]);
  return new AdaptiveSwarmScheduler(items, worker, options).run();
}

class AdaptiveSwarmScheduler<Input, Output, Retry> {
  private readonly policy: AdaptiveSwarmPolicy;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly states: Array<ItemState<Input, Retry>>;
  private readonly pending: Array<ItemState<Input, Retry>>;
  private readonly active = new Set<ActiveAttempt<Input, Retry>>();
  private readonly results: Array<AdaptiveSwarmItemResult<Output> | undefined>;
  private normalLaunchCount = 0;
  private normalRampReady = false;
  private timer: unknown;
  private settled = false;
  private rateLimitMode = false;
  private readyNormalLaunches = 0;
  private rateLimitCapacity = 1;
  private lastRateLimitAt: number | undefined;
  private lastCapacityDecreaseAt: number | undefined;
  private lastCapacityIncreaseAt: number | undefined;
  private globalLaunchIntervalMs: number;
  private nextRateLimitLaunchAt = 0;
  private resolve: ((results: readonly AdaptiveSwarmItemResult<Output>[]) => void) | undefined;
  private readonly onAbort = () => this.schedule();

  constructor(
    items: readonly Input[],
    private readonly worker: (
      item: Input,
      context: AdaptiveSwarmWorkerContext<Retry>,
    ) =>
      | AdaptiveSwarmAttemptResult<Output, Retry>
      | PromiseLike<AdaptiveSwarmAttemptResult<Output, Retry>>,
    private readonly options: AdaptiveSwarmOptions,
  ) {
    this.policy = options.policy ?? KIMI_STYLE_SWARM_POLICY;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => setTimeout(callback, Math.max(0, delayMs)));
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.globalLaunchIntervalMs = this.policy.rateLimitRetryBaseMs;
    this.states = items.map((item, index) => ({
      index,
      item,
      attempt: 0,
      retry: undefined,
      retryReadyAt: 0,
      started: false,
    }));
    this.pending = [...this.states];
    this.results = Array.from({ length: items.length });
  }

  run(): Promise<readonly AdaptiveSwarmItemResult<Output>[]> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.options.signal.addEventListener('abort', this.onAbort, { once: true });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.settled) return;
    if (this.options.signal.aborted) {
      if (this.active.size > 0) return;
      this.finishCancelled();
      return;
    }
    if (this.results.every((result) => result !== undefined)) {
      this.finish(this.results as Array<AdaptiveSwarmItemResult<Output>>);
      return;
    }
    if (this.rateLimitMode) this.scheduleRateLimited();
    else this.scheduleNormal();
  }

  private scheduleNormal(): void {
    while (
      this.normalLaunchCount < this.policy.initialLaunchLimit &&
      this.pending.length > 0 &&
      this.active.size < this.options.maxConcurrency
    ) {
      this.start(this.pending.shift()!);
      this.normalLaunchCount += 1;
    }
    if (
      this.normalLaunchCount >= this.policy.initialLaunchLimit &&
      this.normalRampReady &&
      this.pending.length > 0 &&
      this.active.size < this.options.maxConcurrency
    ) {
      this.normalRampReady = false;
      this.start(this.pending.shift()!);
    }
    if (
      this.pending.length === 0 ||
      this.active.size >= this.options.maxConcurrency ||
      this.timer !== undefined
    )
      return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.normalRampReady = true;
      this.schedule();
    }, this.policy.initialLaunchIntervalMs);
  }

  private scheduleRateLimited(): void {
    this.clearWakeup();
    if (this.pending.length === 0) return;
    const now = this.now();
    this.recoverCapacity(now);
    if (this.active.size >= this.rateLimitCapacity) {
      this.wakeAt(this.nextCapacityRecoveryAt(), now);
      return;
    }

    const nextAllowedAt = Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt());
    const wakeupAt = Math.min(nextAllowedAt, this.nextCapacityRecoveryAt());
    if (wakeupAt > now) {
      this.wakeAt(wakeupAt, now);
      return;
    }
    const pendingIndex = this.pending.findIndex((state) => state.retryReadyAt <= now);
    if (pendingIndex < 0) return;
    const [state] = this.pending.splice(pendingIndex, 1);
    this.start(state!);
    this.nextRateLimitLaunchAt = now + this.globalLaunchIntervalMs;
    if (this.pending.length > 0) {
      const next =
        this.active.size >= this.rateLimitCapacity
          ? this.nextCapacityRecoveryAt()
          : Math.min(
              Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt()),
              this.nextCapacityRecoveryAt(),
            );
      this.wakeAt(next, now);
    }
  }

  private start(state: ItemState<Input, Retry>): void {
    if (this.settled || this.options.signal.aborted) return;
    state.attempt += 1;
    const active: ActiveAttempt<Input, Retry> = { state, ready: false };
    this.active.add(active);
    const markReady = () => {
      if (active.ready || !this.active.has(active) || this.settled) return;
      active.ready = true;
      state.started = true;
      if (!this.rateLimitMode) this.readyNormalLaunches += 1;
      else {
        this.globalLaunchIntervalMs = this.policy.rateLimitRetryBaseMs;
        this.nextRateLimitLaunchAt = this.now() + this.globalLaunchIntervalMs;
        this.schedule();
      }
    };
    let attempt: Promise<AdaptiveSwarmAttemptResult<Output, Retry>>;
    try {
      attempt = Promise.resolve(
        this.worker(state.item, {
          index: state.index,
          signal: this.options.signal,
          attempt: state.attempt,
          retry: state.retry,
          markReady,
        }),
      );
    } catch (error) {
      attempt = Promise.reject(error);
    }
    void attempt.then(
      (outcome) => this.handleOutcome(active, outcome),
      (reason) => this.handleRejected(active, reason),
    );
  }

  private handleOutcome(
    active: ActiveAttempt<Input, Retry>,
    outcome: AdaptiveSwarmAttemptResult<Output, Retry>,
  ): void {
    if (!this.active.delete(active) || this.settled) return;
    if (this.options.signal.aborted) {
      this.schedule();
      return;
    }
    if (outcome.status === 'fulfilled') {
      this.results[active.state.index] = {
        index: active.state.index,
        status: 'fulfilled',
        value: outcome.value,
      };
    } else if (this.isOnlyUnfinished(active.state.index)) {
      this.results[active.state.index] = {
        index: active.state.index,
        status: 'rejected',
        reason: outcome.reason,
      };
    } else {
      this.requeueRateLimited(active, outcome);
    }
    this.schedule();
  }

  private handleRejected(active: ActiveAttempt<Input, Retry>, reason: unknown): void {
    if (!this.active.delete(active) || this.settled) return;
    if (!this.options.signal.aborted) {
      this.results[active.state.index] = {
        index: active.state.index,
        status: 'rejected',
        reason,
      };
    }
    this.schedule();
  }

  private requeueRateLimited(
    active: ActiveAttempt<Input, Retry>,
    outcome: Extract<AdaptiveSwarmAttemptResult<Output, Retry>, { status: 'rate_limited' }>,
  ): void {
    const state = active.state;
    const now = this.now();
    state.retry = outcome.retry;
    const retryDelayMs =
      this.policy.rateLimitRetryBaseMs *
      this.policy.rateLimitRetryFactor ** Math.max(0, state.attempt - 1);
    state.retryReadyAt = now + retryDelayMs;
    this.pending.unshift(state);
    this.lastRateLimitAt = now;
    this.enterRateLimitMode(now);
    if (!active.ready) {
      this.globalLaunchIntervalMs = Math.max(this.globalLaunchIntervalMs * 2, retryDelayMs);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + this.globalLaunchIntervalMs,
      );
    } else {
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + this.policy.rateLimitRetryBaseMs,
      );
    }
    this.observe(() =>
      this.options.onRateLimit?.({
        index: state.index,
        attempt: state.attempt,
        retryDelayMs,
        capacity: this.rateLimitCapacity,
      }),
    );
  }

  private enterRateLimitMode(now: number): void {
    if (!this.rateLimitMode) {
      this.rateLimitMode = true;
      this.rateLimitCapacity = Math.max(
        1,
        Math.min(this.options.maxConcurrency, this.readyNormalLaunches),
      );
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + this.policy.rateLimitRetryBaseMs,
      );
      this.decreaseCapacity(now, true);
      return;
    }
    this.decreaseCapacity(now, false);
  }

  private decreaseCapacity(now: number, force: boolean): void {
    if (
      !force &&
      this.lastCapacityDecreaseAt !== undefined &&
      now - this.lastCapacityDecreaseAt < this.policy.capacityShrinkIntervalMs
    ) {
      return;
    }
    const previous = this.rateLimitCapacity;
    this.rateLimitCapacity = Math.max(1, previous - 1);
    this.lastCapacityDecreaseAt = now;
    if (this.rateLimitCapacity !== previous) {
      this.observe(() =>
        this.options.onCapacityChanged?.({
          direction: 'decreased',
          capacity: this.rateLimitCapacity,
        }),
      );
    }
  }

  private recoverCapacity(now: number): void {
    if (this.nextCapacityRecoveryAt() > now) return;
    const previous = this.rateLimitCapacity;
    this.rateLimitCapacity = Math.min(this.options.maxConcurrency, previous + 1);
    this.lastCapacityIncreaseAt = now;
    this.nextRateLimitLaunchAt = Math.min(this.nextRateLimitLaunchAt, now);
    if (this.rateLimitCapacity !== previous) {
      this.observe(() =>
        this.options.onCapacityChanged?.({
          direction: 'increased',
          capacity: this.rateLimitCapacity,
        }),
      );
    }
  }

  private nextCapacityRecoveryAt(): number {
    if (this.pending.length === 0 || this.lastRateLimitAt === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    return (
      Math.max(this.lastRateLimitAt, this.lastCapacityIncreaseAt ?? 0) +
      this.policy.capacityRecoveryIntervalMs
    );
  }

  private nextPendingReadyAt(): number {
    return this.pending.reduce(
      (next, state) => Math.min(next, state.retryReadyAt),
      Number.POSITIVE_INFINITY,
    );
  }

  private isOnlyUnfinished(index: number): boolean {
    return this.results.every(
      (result, resultIndex) => resultIndex === index || result !== undefined,
    );
  }

  private wakeAfter(delayMs: number): void {
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.schedule();
    }, delayMs);
  }

  private wakeAt(timestamp: number, now: number): void {
    if (!Number.isFinite(timestamp) || timestamp <= now) return;
    this.wakeAfter(timestamp - now);
  }

  private clearWakeup(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private finishCancelled(): void {
    const reason = this.options.signal.reason ?? new Error('Adaptive swarm cancelled');
    this.finish(
      this.results.map((result, index) => result ?? { index, status: 'cancelled', reason }),
    );
  }

  private finish(results: readonly AdaptiveSwarmItemResult<Output>[]): void {
    if (this.settled) return;
    this.settled = true;
    this.clearWakeup();
    this.options.signal.removeEventListener('abort', this.onAbort);
    this.resolve?.(results);
  }

  private observe(callback: () => void): void {
    try {
      callback();
    } catch {
      // Presentation and telemetry observers must not affect scheduling.
    }
  }
}

function assertOptions(options: AdaptiveSwarmOptions): void {
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new RangeError('Adaptive swarm maxConcurrency must be a positive safe integer');
  }
  const policy = options.policy ?? KIMI_STYLE_SWARM_POLICY;
  const positive = [
    policy.initialLaunchLimit,
    policy.initialLaunchIntervalMs,
    policy.rateLimitRetryBaseMs,
    policy.rateLimitRetryFactor,
    policy.capacityShrinkIntervalMs,
    policy.capacityRecoveryIntervalMs,
  ];
  if (positive.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('Adaptive swarm policy values must be positive finite numbers');
  }
}
