import { randomUUID } from 'node:crypto';
import type {
  MemoryExtractionAttempt,
  MemoryExtractionAttemptMetrics,
  MemoryExtractionFailureStage,
  MemoryExtractionOperation,
  MemoryExtractionSnapshotKind,
  MemoryItemStore,
} from '@maka/core/long-term-memory';
import type { RuntimeHostResidency } from './host-kernel.js';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const RECOVERABLE_SCAN_LIMIT = 100;

type TimerHandle = ReturnType<typeof setTimeout>;

type MemoryExtractionWorkerStore = Pick<
  MemoryItemStore,
  | 'listRecoverableMemoryExtractions'
  | 'listRecoverableMemoryExtractionCleanups'
  | 'hasUnfinishedMemoryExtractions'
  | 'claimMemoryExtractionOperation'
  | 'renewMemoryExtractionAttemptLease'
  | 'failMemoryExtractionAttempt'
  | 'readMemoryExtractionOperation'
  | 'readMemoryExtractionAttempt'
  | 'claimMemoryExtractionCleanup'
  | 'finishMemoryExtractionCleanup'
  | 'cancelMemoryExtractionsForSessions'
>;

export interface MemoryExtractionAttemptRunnerInput {
  readonly operation: MemoryExtractionOperation;
  readonly attempt: MemoryExtractionAttempt;
  readonly signal: AbortSignal;
}

/** The runner owns the Child/commit path; resolving only means it claims commit completed. */
export interface MemoryExtractionAttemptRunner {
  run(input: MemoryExtractionAttemptRunnerInput): Promise<void>;
}

export class MemoryExtractionAttemptRunnerError extends Error {
  readonly name = 'MemoryExtractionAttemptRunnerError';

  constructor(
    readonly code: string,
    readonly stage: MemoryExtractionFailureStage,
    readonly retryable = true,
    readonly metrics?: MemoryExtractionAttemptMetrics,
  ) {
    super(code);
    if (!/^[a-z][a-z0-9_]{0,127}$/u.test(code)) {
      throw new Error('Memory Extraction runner error code must be stable lowercase text');
    }
  }
}

export interface HostMemoryExtractionWorkerInput {
  readonly store: MemoryExtractionWorkerStore;
  readonly runner: MemoryExtractionAttemptRunner;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly requestDrain: () => void;
  /** Retires the hidden diagnostic Session after the Operation retention window. */
  readonly cleanupInternalSession?: (operation: MemoryExtractionOperation) => Promise<void>;
  /** Durable Cursor-debt repair, invoked on recovery and every poll/notification scan. */
  readonly reconcileSweepDebts?: () => Promise<unknown>;
  /** Linearizes policy-dependent execution with privacy/memory policy mutation. */
  readonly runPolicyAuthorized?: (
    operation: MemoryExtractionOperation,
    execute: () => Promise<void>,
  ) => Promise<boolean>;
  readonly concurrency?: number;
  readonly leaseDurationMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly diagnosticRetentionMs?: number;
  readonly snapshotKind?: MemoryExtractionSnapshotKind;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

interface ActiveAttempt {
  readonly operationId: string;
  readonly sessionId: string;
  readonly controller: AbortController;
  done: Promise<void>;
  attempt?: MemoryExtractionAttempt;
  leaseTimer?: TimerHandle;
  leaseTask?: Promise<void>;
  leaseFailure?: unknown;
  policyBlocked?: boolean;
}

/** Durable, detached execution scheduler for Memory Extraction Operations. */
export class HostMemoryExtractionWorker {
  readonly #store: MemoryExtractionWorkerStore;
  readonly #runner: MemoryExtractionAttemptRunner;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #requestDrain: () => void;
  readonly #cleanupInternalSession: (operation: MemoryExtractionOperation) => Promise<void>;
  readonly #reconcileSweepDebts: () => Promise<unknown>;
  readonly #runPolicyAuthorized: NonNullable<
    HostMemoryExtractionWorkerInput['runPolicyAuthorized']
  >;
  readonly #concurrency: number;
  readonly #leaseDurationMs: number;
  readonly #leaseRenewIntervalMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #diagnosticRetentionMs: number;
  readonly #snapshotKind: MemoryExtractionSnapshotKind;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  readonly #notifiedOperationIds = new Set<string>();
  readonly #policyBlockedOperationIds = new Set<string>();
  readonly #cleanupFailures = new Set<string>();
  readonly #active = new Map<string, ActiveAttempt>();
  #residency: RuntimeHostResidency | undefined;
  #recoverTask: Promise<void> | undefined;
  #scanTask: Promise<void> | undefined;
  #scanRequested = false;
  #pollTimer: TimerHandle | undefined;
  #recovered = false;
  #started = false;
  #draining = false;
  #closed = false;
  #durableWorkPresent = false;

  constructor(input: HostMemoryExtractionWorkerInput) {
    this.#store = input.store;
    this.#runner = input.runner;
    this.#acquireResidency = input.acquireResidency;
    this.#requestDrain = input.requestDrain;
    this.#cleanupInternalSession = input.cleanupInternalSession ?? (() => Promise.resolve());
    this.#reconcileSweepDebts = input.reconcileSweepDebts ?? (() => Promise.resolve());
    this.#runPolicyAuthorized =
      input.runPolicyAuthorized ??
      (async (_operation, execute) => {
        await execute();
        return true;
      });
    this.#concurrency = positiveInteger(input.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency');
    this.#leaseDurationMs = positiveInteger(
      input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      'leaseDurationMs',
    );
    this.#leaseRenewIntervalMs = positiveInteger(
      input.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS,
      'leaseRenewIntervalMs',
    );
    if (this.#leaseRenewIntervalMs >= this.#leaseDurationMs) {
      throw new Error('leaseRenewIntervalMs must be shorter than leaseDurationMs');
    }
    this.#pollIntervalMs = positiveInteger(
      input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
    );
    this.#maxAttempts = positiveInteger(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
    this.#retryBaseMs = positiveInteger(input.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, 'retryBaseMs');
    this.#retryMaxMs = positiveInteger(input.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, 'retryMaxMs');
    if (this.#retryMaxMs < this.#retryBaseMs) {
      throw new Error('retryMaxMs must be at least retryBaseMs');
    }
    this.#diagnosticRetentionMs = positiveInteger(
      input.diagnosticRetentionMs ?? DEFAULT_DIAGNOSTIC_RETENTION_MS,
      'diagnosticRetentionMs',
    );
    this.#snapshotKind = input.snapshotKind ?? 'reconstructed_full';
    this.#now = input.now ?? Date.now;
    this.#newId = input.newId ?? randomUUID;
    this.#setTimeout = input.setTimeout ?? setTimeout;
    this.#clearTimeout = input.clearTimeout ?? clearTimeout;
  }

  get isDraining(): boolean {
    return this.#draining || this.#closed;
  }

  /** Process-local hint only. The durable Store remains the task authority. */
  notify(operationId: string): void {
    if (this.isDraining) return;
    if (operationId.trim() === '') return;
    this.#policyBlockedOperationIds.delete(operationId);
    this.#notifiedOperationIds.add(operationId);
    this.#durableWorkPresent = true;
    this.#refreshResidency();
    this.#requestScan();
  }

  /** Reconsiders Operations paused by the previous privacy/memory policy snapshot. */
  notifyPolicyChanged(): void {
    if (this.isDraining) return;
    this.#policyBlockedOperationIds.clear();
    this.#requestScan();
  }

  recover(): Promise<void> {
    this.#recoverTask ??= (async () => {
      if (this.isDraining) return;
      this.#recovered = true;
      const notifications = [...this.#notifiedOperationIds];
      this.#scanRequested = false;
      await this.#scanAndLaunch();
      for (const operationId of notifications) this.#notifiedOperationIds.delete(operationId);
      this.#refreshResidency();
      if (this.#scanRequested) this.#requestScan();
    })();
    return this.#recoverTask;
  }

  start(): void {
    if (this.isDraining) return;
    if (!this.#recovered) throw new Error('Memory Extraction Worker started before recovery');
    if (this.#started) return;
    this.#started = true;
    this.#requestScan();
    this.#schedulePoll();
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#stopPoll();
    this.#notifiedOperationIds.clear();
    this.#policyBlockedOperationIds.clear();
    const reason = new MemoryExtractionWorkerDrainError();
    for (const active of this.#active.values()) active.controller.abort(reason);
    this.#refreshResidency();
  }

  async retireSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const retiredSessionIds = new Set(sessionIds);
    const cancelled = new Set(
      await this.#store.cancelMemoryExtractionsForSessions({
        sessionIds,
        diagnosticRetentionUntil: this.#now() + this.#diagnosticRetentionMs,
      }),
    );
    for (const operationId of cancelled) this.#notifiedOperationIds.delete(operationId);
    const reason = new ParentSessionRemovedError();
    for (const active of this.#active.values()) {
      if (retiredSessionIds.has(active.sessionId)) active.controller.abort(reason);
    }
    this.#refreshResidency();
    if (!this.isDraining) this.#requestScan();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.beginDrain();
    if (this.#recoverTask) await Promise.allSettled([this.#recoverTask]);
    while (this.#scanTask || this.#active.size > 0) {
      await Promise.allSettled([
        ...(this.#scanTask ? [this.#scanTask] : []),
        ...[...this.#active.values()].map((active) => active.done),
      ]);
    }
    this.#closed = true;
    this.#residency?.release();
    this.#residency = undefined;
  }

  #requestScan(): void {
    if (this.isDraining) return;
    this.#scanRequested = true;
    if (!this.#recovered || this.#scanTask) return;
    this.#scanRequested = false;
    const notifications = [...this.#notifiedOperationIds];
    const task = Promise.resolve().then(() => this.#scanAndLaunch());
    this.#scanTask = task;
    void task
      .catch(() => this.#requestDrain())
      .finally(() => {
        if (this.#scanTask === task) this.#scanTask = undefined;
        for (const operationId of notifications) this.#notifiedOperationIds.delete(operationId);
        this.#refreshResidency();
        if (this.#scanRequested) this.#requestScan();
      });
  }

  async #scanAndLaunch(): Promise<void> {
    if (this.isDraining) return;
    await this.#reconcileSweepDebts();
    if (this.isDraining) return;
    const available = this.#concurrency - this.#active.size;
    if (available <= 0) return;
    const operations = await this.#store.listRecoverableMemoryExtractions({
      limit: RECOVERABLE_SCAN_LIMIT,
    });
    const runnableOperations = operations.filter(
      (operation) => !this.#policyBlockedOperationIds.has(operation.operationId),
    );
    const unfinished = await this.#store.hasUnfinishedMemoryExtractions();
    this.#durableWorkPresent =
      runnableOperations.length > 0 || (unfinished && this.#policyBlockedOperationIds.size === 0);
    this.#refreshResidency();
    if (this.isDraining) return;
    await this.#runDueCleanups();
    if (this.isDraining) return;
    let launched = 0;
    for (const operation of runnableOperations) {
      if (launched >= available || this.isDraining) break;
      if (this.#active.has(operation.operationId)) continue;
      if ([...this.#active.values()].some((active) => active.sessionId === operation.sessionId)) {
        continue;
      }
      this.#launch(operation);
      launched += 1;
    }
  }

  #launch(operation: MemoryExtractionOperation): void {
    if (this.isDraining || this.#active.has(operation.operationId)) return;
    const active: ActiveAttempt = {
      operationId: operation.operationId,
      sessionId: operation.sessionId,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.#active.set(operation.operationId, active);
    this.#notifiedOperationIds.delete(operation.operationId);
    this.#refreshResidency();
    const done = this.#runOperation(operation, active).finally(() => {
      this.#stopLeaseRenewal(active);
      if (this.#active.get(operation.operationId) === active) {
        this.#active.delete(operation.operationId);
      }
      this.#refreshResidency();
      if (!this.isDraining && !active.policyBlocked) this.#requestScan();
    });
    active.done = done;
    void done.catch(() => this.#requestDrain());
  }

  async #runOperation(operation: MemoryExtractionOperation, active: ActiveAttempt): Promise<void> {
    const authorized = await this.#runPolicyAuthorized(operation, () =>
      this.#runAuthorizedOperation(operation, active),
    );
    active.policyBlocked = !authorized;
    if (authorized) {
      this.#policyBlockedOperationIds.delete(operation.operationId);
      return;
    }
    this.#policyBlockedOperationIds.add(operation.operationId);
    // Paused policy work is durable but not runnable. It must not keep an idle
    // Runtime Host resident or relaunch on every poll.
    this.#durableWorkPresent = false;
  }

  async #runDueCleanups(): Promise<void> {
    const cleanups = await this.#store.listRecoverableMemoryExtractionCleanups({
      limit: RECOVERABLE_SCAN_LIMIT,
    });
    for (const operation of cleanups) {
      if (this.isDraining) return;
      if (this.#cleanupFailures.has(operation.operationId)) continue;
      const claimId = this.#newId();
      const claimed = await this.#store.claimMemoryExtractionCleanup({
        operationId: operation.operationId,
        claimId,
        leaseExpiresAt: this.#now() + this.#leaseDurationMs,
      });
      if (!claimed) continue;
      try {
        await this.#cleanupInternalSession(claimed);
        await this.#store.finishMemoryExtractionCleanup({
          operationId: claimed.operationId,
          claimId,
        });
      } catch {
        this.#cleanupFailures.add(claimed.operationId);
        await this.#store.finishMemoryExtractionCleanup({
          operationId: claimed.operationId,
          claimId,
          errorCode: 'internal_session_cleanup_failed',
        });
      }
    }
  }

  async #runAuthorizedOperation(
    operation: MemoryExtractionOperation,
    active: ActiveAttempt,
  ): Promise<void> {
    if (this.isDraining) return;
    const attemptId = this.#newId();
    const turnId = this.#newId();
    const runId = this.#newId();
    const claimed = await this.#store.claimMemoryExtractionOperation({
      operationId: operation.operationId,
      attemptId,
      turnId,
      runId,
      snapshotKind: this.#snapshotKind,
      leaseExpiresAt: this.#now() + this.#leaseDurationMs,
      maxAttempts: this.#maxAttempts,
      diagnosticRetentionUntil: this.#now() + this.#diagnosticRetentionMs,
    });
    if (!claimed) return;
    active.attempt = claimed.attempt;
    this.#scheduleLeaseRenewal(active);

    let runnerError: unknown;
    if (active.controller.signal.aborted) {
      runnerError = active.controller.signal.reason;
    } else {
      try {
        await this.#runner.run({
          operation: claimed.operation,
          attempt: claimed.attempt,
          signal: active.controller.signal,
        });
      } catch (error) {
        runnerError = error;
      }
    }
    if (active.controller.signal.aborted) {
      runnerError = active.controller.signal.reason ?? runnerError;
    }
    this.#stopLeaseRenewal(active);
    if (active.leaseTask) await active.leaseTask.catch(() => undefined);

    const current = await this.#store.readMemoryExtractionOperation(operation.operationId);
    if (current?.state === 'succeeded') return;
    const attempt = await this.#store.readMemoryExtractionAttempt(attemptId);
    if (
      !current ||
      current.state !== 'running' ||
      current.activeAttemptId !== attemptId ||
      !attempt ||
      attempt.state !== 'running' ||
      attempt.runId !== runId
    ) {
      // Another durable authority already settled or superseded this Attempt.
      return;
    }

    const failure = classifyFailure(
      active.leaseFailure ?? runnerError ?? new RunnerReturnedWithoutCommitError(),
    );
    const mayRetry = failure.retryable && current.attemptCount < this.#maxAttempts;
    const now = this.#now();
    await this.#store.failMemoryExtractionAttempt({
      operationId: current.operationId,
      attemptId,
      runId,
      failureCode: failure.code,
      failureStage: failure.stage,
      ...(failure.metrics ? { metrics: failure.metrics } : {}),
      ...(mayRetry
        ? {
            nextAttemptAt:
              now + retryDelay(current.attemptCount, this.#retryBaseMs, this.#retryMaxMs),
          }
        : { diagnosticRetentionUntil: now + this.#diagnosticRetentionMs }),
    });
  }

  #scheduleLeaseRenewal(active: ActiveAttempt): void {
    if (this.isDraining || !active.attempt || active.leaseTimer !== undefined) return;
    active.leaseTimer = this.#setTimeout(() => {
      active.leaseTimer = undefined;
      const attempt = active.attempt;
      if (!attempt || this.isDraining) return;
      const task = this.#store
        .renewMemoryExtractionAttemptLease({
          operationId: attempt.operationId,
          attemptId: attempt.attemptId,
          runId: attempt.runId,
          leaseExpiresAt: this.#now() + this.#leaseDurationMs,
        })
        .then(() => {
          if (!this.isDraining && this.#active.get(active.operationId) === active) {
            this.#scheduleLeaseRenewal(active);
          }
        })
        .catch((error) => {
          active.leaseFailure = new LeaseRenewalFailedError(error);
          active.controller.abort(active.leaseFailure);
        })
        .finally(() => {
          if (active.leaseTask === task) active.leaseTask = undefined;
        });
      active.leaseTask = task;
      void task.catch(() => undefined);
    }, this.#leaseRenewIntervalMs);
  }

  #stopLeaseRenewal(active: ActiveAttempt): void {
    if (active.leaseTimer === undefined) return;
    this.#clearTimeout(active.leaseTimer);
    active.leaseTimer = undefined;
  }

  #schedulePoll(): void {
    if (!this.#started || this.isDraining || this.#pollTimer !== undefined) return;
    this.#pollTimer = this.#setTimeout(() => {
      this.#pollTimer = undefined;
      this.#requestScan();
      this.#schedulePoll();
    }, this.#pollIntervalMs);
  }

  #stopPoll(): void {
    if (this.#pollTimer === undefined) return;
    this.#clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  #refreshResidency(): void {
    const shouldHold =
      !this.#closed &&
      (this.#durableWorkPresent ||
        this.#active.size > 0 ||
        this.#scanTask !== undefined ||
        this.#notifiedOperationIds.size > 0);
    if (shouldHold && !this.#residency) this.#residency = this.#acquireResidency();
    if (!shouldHold && this.#residency) {
      this.#residency.release();
      this.#residency = undefined;
    }
  }
}

export class MemoryExtractionWorkerDrainError extends Error {
  readonly name = 'MemoryExtractionWorkerDrainError';
  constructor() {
    super('Memory Extraction Worker is draining');
  }
}

class RunnerReturnedWithoutCommitError extends Error {
  readonly name = 'RunnerReturnedWithoutCommitError';
}

class LeaseRenewalFailedError extends Error {
  readonly name = 'LeaseRenewalFailedError';
  constructor(readonly leaseCause: unknown) {
    super('Memory Extraction Attempt lease renewal failed');
  }
}

class ParentSessionRemovedError extends Error {
  readonly name = 'ParentSessionRemovedError';
  constructor() {
    super('Parent Session was removed during Memory Extraction');
  }
}

function classifyFailure(error: unknown): {
  readonly code: string;
  readonly stage: MemoryExtractionFailureStage;
  readonly retryable: boolean;
  readonly metrics?: MemoryExtractionAttemptMetrics;
} {
  if (error instanceof MemoryExtractionAttemptRunnerError) {
    return {
      code: error.code,
      stage: error.stage,
      retryable: error.retryable,
      ...(error.metrics ? { metrics: error.metrics } : {}),
    };
  }
  if (error instanceof MemoryExtractionWorkerDrainError) {
    return { code: 'host_draining', stage: 'recovery', retryable: true };
  }
  if (error instanceof LeaseRenewalFailedError) {
    return { code: 'lease_renewal_failed', stage: 'recovery', retryable: true };
  }
  if (error instanceof RunnerReturnedWithoutCommitError) {
    return { code: 'runner_returned_without_commit', stage: 'commit', retryable: true };
  }
  return { code: 'runner_failed', stage: 'provider', retryable: true };
}

function retryDelay(attemptCount: number, baseMs: number, maximumMs: number): number {
  return Math.min(maximumMs, baseMs * 2 ** Math.max(0, attemptCount - 1));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
