import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ClaimMemoryExtractionOperationRequest,
  FailMemoryExtractionAttemptRequest,
  MemoryExtractionAttempt,
  MemoryExtractionOperation,
  RenewMemoryExtractionAttemptLeaseRequest,
} from '@maka/core/long-term-memory';
import {
  HostMemoryExtractionWorker,
  MemoryExtractionAttemptRunnerError,
  type MemoryExtractionAttemptRunner,
} from '../server/memory-extraction-worker.js';

test('notify asynchronously wakes one durable scan and duplicate hints do not duplicate execution', async () => {
  const fixture = workerFixture();
  await fixture.worker.recover();
  fixture.worker.start();
  fixture.store.add(operation('targeted-1', 'targeted'));
  fixture.worker.notify('targeted-1');
  fixture.worker.notify('targeted-1');

  await eventually(() => fixture.runs.length === 1);
  assert.ok(
    fixture.store.listCalls >= 2,
    'recovery and notification must both observe durable work',
  );
  fixture.store.commit('targeted-1');
  fixture.runs[0]!.resolve();
  await eventually(() => fixture.store.read('targeted-1')?.state === 'succeeded');
  await fixture.worker.close();

  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.store.claims.length, 1);
  assert.ok(fixture.residencies > 0);
  assert.equal(
    fixture.releases,
    fixture.residencies,
    'terminal success must release every Host residency',
  );
});

test('runs different parents concurrently while preserving targeted-first per-parent order', async () => {
  const fixture = workerFixture({ concurrency: 2 });
  fixture.store.add(operation('sweep-1', 'sweep', 'session-1'));
  fixture.store.add(operation('targeted-1', 'targeted', 'session-1'));
  fixture.store.add(operation('sweep-2', 'sweep', 'session-2'));

  await fixture.worker.recover();
  await eventually(() => fixture.runs.length === 2);
  assert.deepEqual(
    fixture.runs.map((run) => run.operationId),
    ['targeted-1', 'sweep-2'],
  );

  fixture.store.commit('targeted-1');
  fixture.runs[0]!.resolve();
  await eventually(() => fixture.runs.length === 3);
  assert.equal(fixture.runs[2]!.operationId, 'sweep-1');

  fixture.store.commit('sweep-2');
  fixture.runs[1]!.resolve();
  fixture.store.commit('sweep-1');
  fixture.runs[2]!.resolve();
  await fixture.worker.close();
});

test('a claimed attempt renews its lease until the runner commits', async () => {
  const fixture = workerFixture({ leaseDurationMs: 30, leaseRenewIntervalMs: 10 });
  fixture.store.add(operation('lease-1', 'targeted'));
  await fixture.worker.recover();
  await eventually(() => fixture.runs.length === 1);

  await fixture.clock.advance(10);
  await eventually(() => fixture.store.renewals.length === 1);
  assert.equal(fixture.store.renewals[0]!.leaseExpiresAt, 40);

  fixture.store.commit('lease-1');
  fixture.runs[0]!.resolve();
  await fixture.worker.close();
  assert.equal(fixture.store.failures.length, 0);
});

test('beginDrain aborts an active runner and persists a retryable stable failure', async () => {
  const fixture = workerFixture({ abortAwareRunner: true });
  fixture.store.add(operation('drain-1', 'targeted'));
  await fixture.worker.recover();
  await eventually(() => fixture.runs.length === 1);

  fixture.worker.beginDrain();
  fixture.worker.notify('ignored-after-drain');
  await fixture.worker.close();

  assert.equal(fixture.store.failures.length, 1);
  assert.equal(fixture.store.failures[0]!.failureCode, 'host_draining');
  assert.equal(fixture.store.failures[0]!.failureStage, 'recovery');
  assert.ok(fixture.store.failures[0]!.nextAttemptAt !== undefined);
  assert.equal(fixture.store.claims.length, 1);
});

test('close waits for an in-flight recovery scan before releasing the worker', async () => {
  const scanGate = controlledGate();
  const fixture = workerFixture({ scanGate: scanGate.promise });
  const recovery = fixture.worker.recover();
  await eventually(() => fixture.store.listCalls === 1);

  let closed = false;
  const closing = fixture.worker.close().then(() => {
    closed = true;
  });
  await flush();
  assert.equal(closed, false);

  scanGate.resolve();
  await Promise.all([recovery, closing]);
  assert.equal(closed, true);
});

test('runner failures retry with stable codes and stop at the configured attempt limit', async () => {
  const fixture = workerFixture({
    autoRunnerError: new MemoryExtractionAttemptRunnerError('provider_timeout', 'provider', true),
    maxAttempts: 2,
    retryBaseMs: 10,
    retryMaxMs: 10,
    pollIntervalMs: 5,
  });
  fixture.store.add(operation('retry-1', 'targeted'));
  await fixture.worker.recover();
  fixture.worker.start();
  await eventually(() => fixture.store.failures.length === 1);
  assert.equal(fixture.residencies, 1);
  assert.equal(fixture.releases, 0, 'future retry must keep Host residency');

  await fixture.clock.advance(10);
  await eventually(() => fixture.store.failures.length === 2);
  assert.deepEqual(
    fixture.store.failures.map((failure) => failure.failureCode),
    ['provider_timeout', 'provider_timeout'],
  );
  assert.ok(fixture.store.failures[0]!.nextAttemptAt !== undefined);
  assert.equal(fixture.store.failures[1]!.nextAttemptAt, undefined);
  assert.equal(fixture.store.failures[1]!.diagnosticRetentionUntil, 110);
  assert.equal(fixture.store.read('retry-1')?.state, 'failed');
  await fixture.worker.close();
  assert.equal(
    fixture.releases,
    fixture.residencies,
    'terminal failure must release every Host residency',
  );
});

test('runner resolution without a committed terminal Operation is failed and retried', async () => {
  const fixture = workerFixture({ autoRunnerResolve: true });
  fixture.store.add(operation('missing-commit', 'sweep'));
  await fixture.worker.recover();
  await eventually(() => fixture.store.failures.length === 1);

  assert.equal(fixture.store.failures[0]!.failureCode, 'runner_returned_without_commit');
  assert.equal(fixture.store.failures[0]!.failureStage, 'commit');
  await fixture.worker.close();
});

test('does not claim queued work while Memory execution is policy-blocked', async () => {
  const fixture = workerFixture({ policyAuthorized: false });
  fixture.store.add(operation('incognito-pending', 'targeted'));
  await fixture.worker.recover();
  await flush();
  assert.equal(fixture.store.claims.length, 0);
  assert.equal(fixture.runs.length, 0);
  assert.equal(fixture.store.listCalls, 1, 'policy blocking must not create a hot rescan loop');
  assert.equal(fixture.residencies, 1);
  assert.equal(fixture.releases, 1, 'policy-blocked work must release idle Host residency');
  await fixture.worker.close();
});

test('retires a terminal Operation internal Session after diagnostic retention', async () => {
  const cleaned: string[] = [];
  const fixture = workerFixture({
    cleanupInternalSession: async (value) => {
      cleaned.push(value.internalSessionId);
    },
  });
  fixture.store.add(operation('cleanup-1', 'targeted'));
  await fixture.worker.recover();
  fixture.worker.start();
  await eventually(() => fixture.runs.length === 1);
  fixture.store.commit('cleanup-1');
  fixture.runs[0]!.resolve();

  await fixture.clock.advance(100);
  await eventually(() => fixture.store.read('cleanup-1')?.cleanupState === 'completed');
  assert.deepEqual(cleaned, ['internal-cleanup-1']);
  await fixture.worker.close();
});

test('terminally cancels and aborts active extraction when its parent Session is retired', async () => {
  const fixture = workerFixture({ abortAwareRunner: true });
  fixture.store.add(operation('retired-parent', 'targeted'));
  await fixture.worker.recover();
  await eventually(() => fixture.runs.length === 1);

  await fixture.worker.retireSessions(['session-1']);
  await eventually(() => fixture.store.read('retired-parent')?.state === 'failed');
  assert.equal(fixture.store.read('retired-parent')?.lastErrorCode, 'source_evidence_deleted');
  await fixture.worker.close();
});

function workerFixture(
  options: {
    concurrency?: number;
    leaseDurationMs?: number;
    leaseRenewIntervalMs?: number;
    pollIntervalMs?: number;
    maxAttempts?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    abortAwareRunner?: boolean;
    autoRunnerError?: Error;
    autoRunnerResolve?: boolean;
    scanGate?: Promise<void>;
    policyAuthorized?: boolean;
    cleanupInternalSession?: (operation: MemoryExtractionOperation) => Promise<void>;
  } = {},
) {
  const clock = new FakeClock();
  const store = new FakeExtractionStore(() => clock.now, options.scanGate);
  const runs: ControlledRun[] = [];
  const runner: MemoryExtractionAttemptRunner = {
    run: (input) => {
      if (options.autoRunnerError) return Promise.reject(options.autoRunnerError);
      if (options.autoRunnerResolve) return Promise.resolve();
      const run = controlledRun(input.operation.operationId);
      runs.push(run);
      if (options.abortAwareRunner) {
        input.signal.addEventListener('abort', () => run.reject(input.signal.reason), {
          once: true,
        });
      }
      return run.promise;
    },
  };
  let nextId = 0;
  let residencies = 0;
  let releases = 0;
  let drainRequests = 0;
  const worker = new HostMemoryExtractionWorker({
    store,
    runner,
    acquireResidency: () => {
      residencies += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          releases += 1;
        },
      };
    },
    requestDrain: () => {
      drainRequests += 1;
    },
    runPolicyAuthorized: async (_operation, execute) => {
      if (options.policyAuthorized === false) return false;
      await execute();
      return true;
    },
    ...(options.cleanupInternalSession
      ? { cleanupInternalSession: options.cleanupInternalSession }
      : {}),
    concurrency: options.concurrency ?? 2,
    leaseDurationMs: options.leaseDurationMs ?? 30,
    leaseRenewIntervalMs: options.leaseRenewIntervalMs ?? 10,
    pollIntervalMs: options.pollIntervalMs ?? 5,
    maxAttempts: options.maxAttempts ?? 3,
    retryBaseMs: options.retryBaseMs ?? 10,
    retryMaxMs: options.retryMaxMs ?? 40,
    diagnosticRetentionMs: 100,
    now: () => clock.now,
    newId: () => `worker-id-${++nextId}`,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return {
    worker,
    store,
    clock,
    runs,
    get residencies() {
      return residencies;
    },
    get releases() {
      return releases;
    },
    get drainRequests() {
      return drainRequests;
    },
  };
}

class FakeExtractionStore {
  readonly operations = new Map<string, MemoryExtractionOperation>();
  readonly attempts = new Map<string, MemoryExtractionAttempt>();
  readonly claims: ClaimMemoryExtractionOperationRequest[] = [];
  readonly renewals: RenewMemoryExtractionAttemptLeaseRequest[] = [];
  readonly failures: FailMemoryExtractionAttemptRequest[] = [];
  listCalls = 0;

  constructor(
    readonly now: () => number,
    readonly scanGate?: Promise<void>,
  ) {}

  add(value: MemoryExtractionOperation): void {
    this.operations.set(value.operationId, value);
  }

  read(operationId: string): MemoryExtractionOperation | undefined {
    return this.operations.get(operationId);
  }

  async listRecoverableMemoryExtractions(input: { limit?: number } = {}) {
    this.listCalls += 1;
    await this.scanGate;
    return [...this.operations.values()]
      .filter(
        (operation) =>
          (operation.state === 'pending' &&
            (operation.nextAttemptAt === null || operation.nextAttemptAt <= this.now())) ||
          (operation.state === 'running' &&
            operation.leaseExpiresAt !== null &&
            operation.leaseExpiresAt <= this.now()),
      )
      .sort(
        (left, right) =>
          Number(left.mode === 'sweep') - Number(right.mode === 'sweep') ||
          left.createdAt - right.createdAt ||
          left.operationId.localeCompare(right.operationId),
      )
      .slice(0, input.limit);
  }

  async hasUnfinishedMemoryExtractions(): Promise<boolean> {
    return [...this.operations.values()].some(
      (operation) => operation.state === 'pending' || operation.state === 'running',
    );
  }

  async listRecoverableMemoryExtractionCleanups(input: { limit?: number } = {}) {
    return [...this.operations.values()]
      .filter(
        (operation) =>
          (operation.state === 'succeeded' || operation.state === 'failed') &&
          operation.diagnosticRetentionUntil !== null &&
          operation.diagnosticRetentionUntil <= this.now() &&
          (operation.cleanupState === 'pending' ||
            (operation.cleanupState === 'running' &&
              operation.cleanupLeaseExpiresAt !== null &&
              operation.cleanupLeaseExpiresAt <= this.now())),
      )
      .slice(0, input.limit);
  }

  async claimMemoryExtractionOperation(request: ClaimMemoryExtractionOperationRequest) {
    this.claims.push(request);
    const current = this.operations.get(request.operationId);
    if (!current || current.state !== 'pending') return undefined;
    const attempt: MemoryExtractionAttempt = {
      attemptId: request.attemptId,
      operationId: request.operationId,
      attemptOrdinal: current.attemptCount + 1,
      state: 'running',
      turnId: request.turnId,
      runId: request.runId,
      snapshotKind: request.snapshotKind,
      startedAt: this.now(),
      completedAt: null,
      failureCode: null,
      failureStage: null,
      metrics: null,
    };
    const claimed: MemoryExtractionOperation = {
      ...current,
      state: 'running',
      attemptCount: attempt.attemptOrdinal,
      activeAttemptId: attempt.attemptId,
      leaseExpiresAt: request.leaseExpiresAt,
      nextAttemptAt: null,
      startedAt: current.startedAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.attempts.set(attempt.attemptId, attempt);
    this.operations.set(current.operationId, claimed);
    return { operation: claimed, attempt, replayed: false };
  }

  async renewMemoryExtractionAttemptLease(request: RenewMemoryExtractionAttemptLeaseRequest) {
    this.renewals.push(request);
    const current = this.operations.get(request.operationId);
    assert.ok(current);
    assert.equal(current.activeAttemptId, request.attemptId);
    const renewed = { ...current, leaseExpiresAt: request.leaseExpiresAt };
    this.operations.set(current.operationId, renewed);
    return renewed;
  }

  async failMemoryExtractionAttempt(request: FailMemoryExtractionAttemptRequest) {
    this.failures.push(request);
    const current = this.operations.get(request.operationId);
    const attempt = this.attempts.get(request.attemptId);
    assert.ok(current && attempt);
    assert.equal(current.activeAttemptId, request.attemptId);
    this.attempts.set(request.attemptId, {
      ...attempt,
      state: 'failed',
      completedAt: this.now(),
      failureCode: request.failureCode,
      failureStage: request.failureStage,
      metrics: request.metrics ?? null,
    });
    const retrying = request.nextAttemptAt !== undefined && request.nextAttemptAt !== null;
    const failed: MemoryExtractionOperation = {
      ...current,
      state: retrying ? 'pending' : 'failed',
      activeAttemptId: null,
      leaseExpiresAt: null,
      nextAttemptAt: retrying ? request.nextAttemptAt! : null,
      lastErrorCode: request.failureCode,
      lastErrorStage: request.failureStage,
      lastErrorAt: this.now(),
      lastFailedAttemptId: request.attemptId,
      updatedAt: this.now(),
      completedAt: retrying ? null : this.now(),
      diagnosticRetentionUntil: retrying ? null : (request.diagnosticRetentionUntil ?? null),
      cleanupState: retrying ? null : 'pending',
    };
    this.operations.set(current.operationId, failed);
    return failed;
  }

  async readMemoryExtractionOperation(operationId: string) {
    return this.operations.get(operationId);
  }

  async readMemoryExtractionAttempt(attemptId: string) {
    return this.attempts.get(attemptId);
  }

  async claimMemoryExtractionCleanup(request: {
    operationId: string;
    claimId: string;
    leaseExpiresAt: number;
  }) {
    const current = this.operations.get(request.operationId);
    if (
      !current ||
      current.diagnosticRetentionUntil === null ||
      current.diagnosticRetentionUntil > this.now() ||
      (current.cleanupState !== 'pending' &&
        !(
          current.cleanupState === 'running' &&
          current.cleanupLeaseExpiresAt !== null &&
          current.cleanupLeaseExpiresAt <= this.now()
        ))
    ) {
      return undefined;
    }
    const claimed: MemoryExtractionOperation = {
      ...current,
      cleanupState: 'running',
      cleanupClaimId: request.claimId,
      cleanupLeaseExpiresAt: request.leaseExpiresAt,
      cleanupAttemptCount: current.cleanupAttemptCount + 1,
      cleanupErrorCode: null,
    };
    this.operations.set(current.operationId, claimed);
    return claimed;
  }

  async finishMemoryExtractionCleanup(request: {
    operationId: string;
    claimId: string;
    errorCode?: string;
  }) {
    const current = this.operations.get(request.operationId);
    assert.ok(current);
    assert.equal(current.cleanupClaimId, request.claimId);
    const completed: MemoryExtractionOperation = {
      ...current,
      cleanupState: request.errorCode ? 'pending' : 'completed',
      cleanupClaimId: null,
      cleanupLeaseExpiresAt: null,
      cleanupErrorCode: request.errorCode ?? null,
      cleanedAt: request.errorCode ? null : this.now(),
    };
    this.operations.set(current.operationId, completed);
    return completed;
  }

  async cancelMemoryExtractionsForSessions(request: {
    sessionIds: readonly string[];
    diagnosticRetentionUntil: number;
  }) {
    const sessionIds = new Set(request.sessionIds);
    const cancelled: string[] = [];
    for (const [operationId, current] of this.operations) {
      if (
        !sessionIds.has(current.sessionId) ||
        (current.state !== 'pending' && current.state !== 'running')
      ) {
        continue;
      }
      cancelled.push(operationId);
      if (current.activeAttemptId) {
        const attempt = this.attempts.get(current.activeAttemptId);
        if (attempt) {
          this.attempts.set(attempt.attemptId, {
            ...attempt,
            state: 'abandoned',
            completedAt: this.now(),
            failureCode: 'source_evidence_deleted',
            failureStage: 'admission',
          });
        }
      }
      this.operations.set(operationId, {
        ...current,
        state: 'failed',
        activeAttemptId: null,
        leaseExpiresAt: null,
        completedAt: this.now(),
        updatedAt: this.now(),
        lastErrorCode: 'source_evidence_deleted',
        lastErrorStage: 'admission',
        lastErrorAt: this.now(),
        diagnosticRetentionUntil: request.diagnosticRetentionUntil,
        cleanupState: 'pending',
      });
    }
    return cancelled;
  }

  commit(operationId: string): void {
    const current = this.operations.get(operationId);
    assert.ok(current?.activeAttemptId);
    const attempt = this.attempts.get(current.activeAttemptId);
    assert.ok(attempt);
    this.attempts.set(attempt.attemptId, {
      ...attempt,
      state: 'succeeded',
      completedAt: this.now(),
    });
    this.operations.set(operationId, {
      ...current,
      state: 'succeeded',
      activeAttemptId: null,
      leaseExpiresAt: null,
      completedAt: this.now(),
      updatedAt: this.now(),
      resultType: 'empty',
      diagnosticRetentionUntil: this.now() + 100,
      cleanupState: 'pending',
    });
  }
}

class FakeClock {
  now = 0;
  #nextId = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  readonly setTimeout = ((callback: () => void, delay?: number) => {
    const id = ++this.#nextId;
    this.#timers.set(id, { at: this.now + (delay ?? 0), callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  readonly clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    this.#timers.delete(handle as unknown as number);
  }) as typeof clearTimeout;

  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    let guard = 0;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      if (++guard > 1_000) throw new Error('Fake clock timer loop did not settle');
      this.now = next[1].at;
      this.#timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

function operation(
  operationId: string,
  mode: 'targeted' | 'sweep',
  sessionId = 'session-1',
): MemoryExtractionOperation {
  return {
    operationId,
    sessionId,
    mode,
    triggerKind: mode === 'targeted' ? 'user_requested' : 'agent_requested',
    internalSessionId: `internal-${operationId}`,
    sessionCreateFingerprint: `sha256:${'a'.repeat(64)}`,
    requestHash: `sha256:${'b'.repeat(64)}`,
    requestJson: '{}',
    triggerEpoch: null,
    state: 'pending',
    attemptCount: 0,
    activeAttemptId: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorStage: null,
    lastErrorAt: null,
    lastFailedAttemptId: null,
    startedAt: null,
    createdAt: mode === 'targeted' ? 1 : 2,
    updatedAt: 1,
    completedAt: null,
    resultType: null,
    commitHash: null,
    receipt: null,
    diagnosticRetentionUntil: null,
    cleanupState: null,
    cleanupClaimId: null,
    cleanupLeaseExpiresAt: null,
    cleanupAttemptCount: 0,
    cleanupErrorCode: null,
    cleanedAt: null,
    ranges: [],
  };
}

interface ControlledRun {
  readonly operationId: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function controlledRun(operationId: string): ControlledRun {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { operationId, promise, resolve, reject };
}

function controlledGate(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail('condition did not become true');
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
