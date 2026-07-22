import type {
  PricingConfig,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import {
  createPricingStore,
  PricingRevisionConflictError,
  PricingValidationError,
  type PricingMutationResult,
  type PricingSnapshot,
  type PricingStore,
} from './pricing-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from './root-authority.js';
import {
  createTelemetryRepo,
  type PersistedLlmCallRecord,
  type PersistedToolInvocationRecord,
  type TelemetryRepo,
} from './telemetry-repo.js';

const readerBrand: unique symbol = Symbol('InteractiveUsageStoresReader');
const writerBrand: unique symbol = Symbol('InteractiveUsageStoresWriter');
const readers = new WeakSet<object>();
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveUsageStoresWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveUsageStoresWriter>>();

export interface TelemetryIndexReader {
  summary(query: UsageQuery): UsageSummaryV2;
  buckets(query: UsageQuery, groupBy: UsageGroupBy): UsageBucket[];
  logs(query: UsageQuery, offset?: number, limit?: number): { rows: UsageLogRow[]; total: number };
}

export interface TelemetryIndexWriter extends TelemetryIndexReader {
  recordLlmCall(record: PersistedLlmCallRecord): Promise<void>;
  recordToolInvocation(record: PersistedToolInvocationRecord): Promise<void>;
}

export interface PricingAuthorityReader {
  snapshot(): PricingSnapshot;
}

export interface PricingAuthorityWriter extends PricingAuthorityReader {
  upsert(expectedRevision: number, pricing: PricingConfig): Promise<PricingMutationResult>;
  delete(expectedRevision: number, modelKey: string): Promise<PricingMutationResult>;
}

export interface InteractiveUsageStoresReader {
  readonly kind: 'interactive';
  readonly access: 'read';
  readonly [readerBrand]: true;
  readonly telemetry: Readonly<TelemetryIndexReader>;
  readonly pricing: Readonly<PricingAuthorityReader>;
  close(): Promise<void>;
}

export interface InteractiveUsageStoresWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  readonly telemetry: Readonly<TelemetryIndexWriter>;
  readonly pricing: Readonly<PricingAuthorityWriter>;
  beginDrain(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class InteractiveUsageStoresClosedError extends Error {
  constructor() {
    super('Interactive usage stores are draining or closed');
    this.name = 'InteractiveUsageStoresClosedError';
  }
}

export function authenticateInteractiveUsageStoresReader(
  stores: InteractiveUsageStoresReader,
): InteractiveUsageStoresReader {
  if (!readers.has(stores)) throw new TypeError('Expected an authentic interactive usage reader');
  return stores;
}

export function authenticateInteractiveUsageStoresWriter(
  stores: InteractiveUsageStoresWriter,
): InteractiveUsageStoresWriter {
  if (!writers.has(stores)) throw new TypeError('Expected an authentic interactive usage writer');
  return stores;
}

export async function openInteractiveUsageStoresForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveUsageStoresReader> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const { telemetry, pricing } = await runWithStorageRootLease(
    lease,
    'interactive',
    'read',
    (root) => openRepos(root, false),
  );
  const stores: InteractiveUsageStoresReader = {
    kind: 'interactive',
    access: 'read',
    [readerBrand]: true,
    telemetry: telemetryReader(telemetry),
    pricing: pricingReader(pricing),
    close: () => closeRepos(telemetry, pricing),
  };
  freezeFacade(stores);
  readers.add(stores);
  return stores;
}

export async function openInteractiveUsageStoresForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveUsageStoresWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    const recoveredExisting = writerByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const repos = await runWithStorageRootLease(lease, 'interactive', 'write', (root) =>
      openRepos(root, true),
    );
    await assertStorageRootLease(lease, 'interactive', 'write');
    const stores = createWriterFacade(lease, repos.telemetry, repos.pricing);
    writers.add(stores);
    writerByLease.set(lease, stores);
    return stores;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

async function openRepos(
  root: string,
  createIfMissing: boolean,
): Promise<{ telemetry: TelemetryRepo; pricing: PricingStore }> {
  const telemetry = createTelemetryRepo(root, { createIfMissing });
  const pricing = createPricingStore(root, { createIfMissing });
  const loaded = await Promise.allSettled([telemetry.load(), pricing.load()]);
  const failures = rejectedReasons(loaded);
  if (failures.length > 0) {
    const closed = await Promise.allSettled([telemetry.close(), pricing.close()]);
    throwFailures('Unable to open interactive usage stores', [
      ...failures,
      ...rejectedReasons(closed),
    ]);
  }
  return { telemetry, pricing };
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  telemetryRepo: TelemetryRepo,
  pricingStore: PricingStore,
): InteractiveUsageStoresWriter {
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'write', operation);
  let state: 'open' | 'draining' | 'closed' = 'open';
  let telemetryBarrier: Promise<void> = Promise.resolve();
  let pricingBarrier: Promise<void> = Promise.resolve();
  const telemetryFailures: unknown[] = [];
  const pricingFailures: unknown[] = [];
  let drainPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const admit = <T>(domain: 'telemetry' | 'pricing', operation: () => Promise<T>): Promise<T> => {
    if (state !== 'open') throw new InteractiveUsageStoresClosedError();
    const admitted = Promise.resolve().then(operation);
    const observed = admitted.then(
      () => undefined,
      (error: unknown) => {
        if (domain === 'pricing' && isPricingCallResult(error)) return;
        (domain === 'telemetry' ? telemetryFailures : pricingFailures).push(error);
      },
    );
    if (domain === 'telemetry') {
      telemetryBarrier = Promise.all([telemetryBarrier, observed]).then(() => undefined);
    } else {
      pricingBarrier = Promise.all([pricingBarrier, observed]).then(() => undefined);
    }
    return admitted;
  };

  const beginDrain = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    state = 'draining';
    const acceptedTelemetry = telemetryBarrier;
    const acceptedPricing = pricingBarrier;
    drainPromise = Promise.all([acceptedTelemetry, acceptedPricing]).then(() => {
      throwFailures('Interactive usage store drain failed', [
        ...telemetryFailures,
        ...pricingFailures,
      ]);
    });
    return drainPromise;
  };

  const flush = async (): Promise<void> => {
    const acceptedTelemetry = telemetryBarrier;
    await acceptedTelemetry;
    const flushed = await Promise.allSettled([run(() => telemetryRepo.flush())]);
    throwFailures('Interactive telemetry flush failed', [
      ...telemetryFailures,
      ...rejectedReasons(flushed),
    ]);
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    state = 'draining';
    const accepted = Promise.all([telemetryBarrier, pricingBarrier]);
    closePromise = accepted
      .then(async () => {
        const closed = await Promise.allSettled([telemetryRepo.close(), pricingStore.close()]);
        throwFailures('Interactive usage stores close failed', [
          ...telemetryFailures,
          ...pricingFailures,
          ...rejectedReasons(closed),
        ]);
      })
      .finally(() => {
        state = 'closed';
      });
    return closePromise;
  };

  const stores: InteractiveUsageStoresWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    telemetry: {
      ...telemetryReader(telemetryRepo),
      recordLlmCall: (record) =>
        admit('telemetry', () => run(() => telemetryRepo.insertLlmCall(record))),
      recordToolInvocation: (record) =>
        admit('telemetry', () => run(() => telemetryRepo.insertToolInvocation(record))),
    },
    pricing: {
      ...pricingReader(pricingStore),
      upsert: (expectedRevision, pricing) =>
        admit('pricing', () => run(() => pricingStore.upsert(expectedRevision, pricing))),
      delete: (expectedRevision, modelKey) =>
        admit('pricing', () => run(() => pricingStore.delete(expectedRevision, modelKey))),
    },
    beginDrain,
    flush,
    close,
  };
  freezeFacade(stores);
  return stores;
}

function isPricingCallResult(error: unknown): boolean {
  return error instanceof PricingRevisionConflictError || error instanceof PricingValidationError;
}

function telemetryReader(repo: TelemetryRepo): Readonly<TelemetryIndexReader> {
  return Object.freeze({
    summary: (query: UsageQuery) => repo.summary(query),
    buckets: (query: UsageQuery, groupBy: UsageGroupBy) => repo.buckets(query, groupBy),
    logs: (query: UsageQuery, offset?: number, limit?: number) => repo.logs(query, offset, limit),
  });
}

function pricingReader(store: PricingStore): Readonly<PricingAuthorityReader> {
  return Object.freeze({ snapshot: () => store.snapshot() });
}

async function closeRepos(telemetry: TelemetryRepo, pricing: PricingStore): Promise<void> {
  const closed = await Promise.allSettled([telemetry.close(), pricing.close()]);
  throwFailures('Unable to close interactive usage stores', rejectedReasons(closed));
}

function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}

function throwFailures(message: string, failures: readonly unknown[]): void {
  const unique = [...new Set(failures)];
  if (unique.length === 0) return;
  if (unique.length === 1) throw unique[0];
  throw new AggregateError(unique, message);
}

function freezeFacade(stores: InteractiveUsageStoresReader | InteractiveUsageStoresWriter): void {
  Object.freeze(stores.telemetry);
  Object.freeze(stores.pricing);
  Object.freeze(stores);
}
