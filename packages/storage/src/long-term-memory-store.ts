import { join } from 'node:path';
import type {
  ApplyMemoryMutationsRequest,
  ClaimMemoryExtractionCleanupRequest,
  CancelMemoryExtractionsForSessionsRequest,
  ClaimMemoryExtractionOperationRequest,
  CommitMemoryExtractionRequest,
  CreateMemoryExtractionOperationRequest,
  CreateMemoryExtractionSweepFollowupRequest,
  FailMemoryExtractionAttemptRequest,
  FinishMemoryExtractionCleanupRequest,
  ListRecoverableMemoryExtractionsRequest,
  ListUnassignedMemoryExtractionSweepDebtsRequest,
  MemoryItemStore,
  MemoryItemWrite,
  RaiseMemoryExtractionRequestedBoundaryRequest,
  RenewMemoryExtractionAttemptLeaseRequest,
  SearchMemoryExtractionCandidatesRequest,
  SearchMemoryItemsByKeyRequest,
} from '@maka/core/long-term-memory';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { SqliteMemoryItemStore } from './sqlite-long-term-memory-store.js';

export { SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION } from './sqlite-long-term-memory-schema.js';

export const LONG_TERM_MEMORY_DATABASE_NAME = 'memory.sqlite';

const writerBrand: unique symbol = Symbol('InteractiveLongTermMemoryWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveLongTermMemoryWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveLongTermMemoryWriter>>();

export interface InteractiveLongTermMemoryWriter extends MemoryItemStore {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  close(): void;
}

export function authenticateInteractiveLongTermMemoryWriter(
  writer: InteractiveLongTermMemoryWriter,
): InteractiveLongTermMemoryWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive long-term memory writer',
    );
  }
  return writer;
}

/**
 * Open the dedicated memory.sqlite through an authenticated Storage Root lease.
 * Production code must use this facade rather than opening the low-level Store.
 */
export function openInteractiveLongTermMemoryStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveLongTermMemoryWriter> {
  return openLongTermMemoryStoreForWrite(lease);
}

async function openLongTermMemoryStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveLongTermMemoryWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteMemoryItemStore | undefined;
    try {
      store = await runWithStorageRootLease(
        lease,
        'interactive',
        'write',
        async (root) => new SqliteMemoryItemStore(join(root, LONG_TERM_MEMORY_DATABASE_NAME)),
      );
      await assertStorageRootLease(lease, 'interactive', 'write');
      const recoveredExisting = writerByLease.get(lease);
      if (recoveredExisting) {
        store.close();
        return recoveredExisting;
      }
      const writer = createWriterFacade(lease, store);
      writers.add(writer);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      store?.close();
      throw error;
    }
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: SqliteMemoryItemStore,
): InteractiveLongTermMemoryWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Long-term memory writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const writer: InteractiveLongTermMemoryWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    applyMutations: (request) => {
      const snapshot = snapshotApplyRequest(request);
      return run(() => store.applyMutations(snapshot));
    },
    readItem: (itemId) => run(() => store.readItem(itemId)),
    searchByKeys: (request) => {
      const snapshot = snapshotSearchRequest(request);
      return run(() => store.searchByKeys(snapshot));
    },
    readOperation: (operationId) => run(() => store.readOperation(operationId)),
    createMemoryExtractionOperation: (request) => {
      const snapshot = snapshotCreateExtractionRequest(request);
      return run(() => store.createMemoryExtractionOperation(snapshot));
    },
    claimMemoryExtractionOperation: (request) => {
      const snapshot = Object.freeze({ ...request }) as ClaimMemoryExtractionOperationRequest;
      return run(() => store.claimMemoryExtractionOperation(snapshot));
    },
    listRecoverableMemoryExtractions: (request) => {
      const snapshot = Object.freeze(
        request?.limit === undefined ? {} : { limit: request.limit },
      ) as ListRecoverableMemoryExtractionsRequest;
      return run(() => store.listRecoverableMemoryExtractions(snapshot));
    },
    listRecoverableMemoryExtractionCleanups: (request) => {
      const snapshot = Object.freeze(
        request?.limit === undefined ? {} : { limit: request.limit },
      ) as ListRecoverableMemoryExtractionsRequest;
      return run(() => store.listRecoverableMemoryExtractionCleanups(snapshot));
    },
    hasUnfinishedMemoryExtractions: () => run(() => store.hasUnfinishedMemoryExtractions()),
    listUnassignedMemoryExtractionSweepDebts: (request) => {
      const snapshot = Object.freeze(
        request?.limit === undefined ? {} : { limit: request.limit },
      ) as ListUnassignedMemoryExtractionSweepDebtsRequest;
      return run(() => store.listUnassignedMemoryExtractionSweepDebts(snapshot));
    },
    createMemoryExtractionSweepFollowup: (request) => {
      const snapshot = Object.freeze({
        operation: snapshotCreateExtractionRequest(request.operation),
        expectedCursorVersion: request.expectedCursorVersion,
      }) as CreateMemoryExtractionSweepFollowupRequest;
      return run(() => store.createMemoryExtractionSweepFollowup(snapshot));
    },
    renewMemoryExtractionAttemptLease: (request) => {
      const snapshot = Object.freeze({
        operationId: request.operationId,
        attemptId: request.attemptId,
        runId: request.runId,
        leaseExpiresAt: request.leaseExpiresAt,
      }) as RenewMemoryExtractionAttemptLeaseRequest;
      return run(() => store.renewMemoryExtractionAttemptLease(snapshot));
    },
    failMemoryExtractionAttempt: (request) => {
      const snapshot = Object.freeze({
        ...request,
        ...(request.metrics === undefined || request.metrics === null
          ? {}
          : { metrics: Object.freeze({ ...request.metrics }) }),
      }) as FailMemoryExtractionAttemptRequest;
      return run(() => store.failMemoryExtractionAttempt(snapshot));
    },
    readMemoryExtractionOperation: (operationId) =>
      run(() => store.readMemoryExtractionOperation(operationId)),
    readMemoryExtractionAttempt: (attemptId) =>
      run(() => store.readMemoryExtractionAttempt(attemptId)),
    readMemoryExtractionCursor: (sessionId, runId) =>
      run(() => store.readMemoryExtractionCursor(sessionId, runId)),
    raiseMemoryExtractionRequestedBoundary: (request) => {
      const snapshot = Object.freeze({
        ...request,
      }) as RaiseMemoryExtractionRequestedBoundaryRequest;
      return run(() => store.raiseMemoryExtractionRequestedBoundary(snapshot));
    },
    searchMemoryExtractionCandidates: (request) => {
      const snapshot = Object.freeze({
        ...request,
        keys: Object.freeze([...request.keys]),
        ...(request.sourceEventIds === undefined
          ? {}
          : { sourceEventIds: Object.freeze([...request.sourceEventIds]) }),
      }) as SearchMemoryExtractionCandidatesRequest;
      return run(() => store.searchMemoryExtractionCandidates(snapshot));
    },
    commitMemoryExtraction: (request) => {
      const snapshot = Object.freeze({
        ...request,
        mutations: snapshotMutations(request.mutations),
      }) as CommitMemoryExtractionRequest;
      return run(() => store.commitMemoryExtraction(snapshot));
    },
    claimMemoryExtractionCleanup: (request) => {
      const snapshot = Object.freeze({ ...request }) as ClaimMemoryExtractionCleanupRequest;
      return run(() => store.claimMemoryExtractionCleanup(snapshot));
    },
    finishMemoryExtractionCleanup: (request) => {
      const snapshot = Object.freeze({ ...request }) as FinishMemoryExtractionCleanupRequest;
      return run(() => store.finishMemoryExtractionCleanup(snapshot));
    },
    cancelMemoryExtractionsForSessions: (request) => {
      const snapshot = Object.freeze({
        sessionIds: Object.freeze([...request.sessionIds]),
        diagnosticRetentionUntil: request.diagnosticRetentionUntil,
      }) as CancelMemoryExtractionsForSessionsRequest;
      return run(() => store.cancelMemoryExtractionsForSessions(snapshot));
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
      store.close();
    },
  };
  return Object.freeze(writer);
}

function snapshotApplyRequest(request: ApplyMemoryMutationsRequest): ApplyMemoryMutationsRequest {
  return Object.freeze({
    operationId: request.operationId,
    mutations: snapshotMutations(request.mutations),
  });
}

function snapshotMutations(
  mutations: ApplyMemoryMutationsRequest['mutations'],
): ApplyMemoryMutationsRequest['mutations'] {
  return Object.freeze(
    mutations.map((mutation) => {
      if (mutation.type === 'create') {
        return Object.freeze({ type: mutation.type, item: snapshotItemWrite(mutation.item) });
      }
      if (mutation.type === 'update') {
        return Object.freeze({
          type: mutation.type,
          itemId: mutation.itemId,
          expectedVersion: mutation.expectedVersion,
          item: snapshotItemWrite(mutation.item),
        });
      }
      return Object.freeze({
        type: mutation.type,
        itemId: mutation.itemId,
        expectedVersion: mutation.expectedVersion,
      });
    }),
  );
}

function snapshotCreateExtractionRequest(
  request: CreateMemoryExtractionOperationRequest,
): CreateMemoryExtractionOperationRequest {
  return Object.freeze({
    ...request,
    ...(request.ranges === undefined
      ? {}
      : { ranges: Object.freeze(request.ranges.map((range) => Object.freeze({ ...range }))) }),
  });
}

function snapshotItemWrite(item: MemoryItemWrite): MemoryItemWrite {
  return Object.freeze({
    ...item,
    keys: Object.freeze(item.keys.map((key) => Object.freeze({ ...key }))),
    sources: Object.freeze(item.sources.map((source) => Object.freeze({ ...source }))),
  });
}

function snapshotSearchRequest(
  request: SearchMemoryItemsByKeyRequest,
): SearchMemoryItemsByKeyRequest {
  return Object.freeze({ ...request, terms: Object.freeze([...request.terms]) });
}
