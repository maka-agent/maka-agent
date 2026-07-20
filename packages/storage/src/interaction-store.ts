import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  interactionCanonicalOutcomesEquivalent,
  type InteractionCanonicalOutcome,
  type InteractionRequest as CoreInteractionRequest,
} from '@maka/core';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import {
  assertInteractionId,
  decodeInteractionOutcomeInput,
  decodePendingInteractionFilter,
  decodeStoredInteractionOutcome,
  decodeStoredInteractionRequest,
  encodeBoundedJson,
  INTERACTION_OUTCOME_MAX_BYTES,
  INTERACTION_REQUEST_MAX_BYTES,
} from './interaction/codec.js';
import { InteractionStoreError, invalidRecord, ioFailed } from './interaction/errors.js';
import {
  InteractionFilesystem,
  type InteractionLocatorInspection,
  type InteractionPublicationAttempt,
} from './interaction/filesystem.js';

export {
  INTERACTION_OUTCOME_MAX_BYTES,
  INTERACTION_REQUEST_MAX_BYTES,
} from './interaction/codec.js';
export {
  InteractionStoreError,
  type InteractionStoreErrorCode,
} from './interaction/errors.js';

export interface InteractionIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly requestId: string;
}

export interface StoredInteractionRequest extends InteractionIdentity {
  readonly createdAt: number;
  readonly request: CoreInteractionRequest;
  /** Host-private remember identity. It must never enter a wire/public projection. */
  readonly rememberScopeId?: string;
}

export interface StoredInteractionOutcome extends InteractionIdentity {
  readonly outcome: InteractionCanonicalOutcome;
}

export interface InteractionRecord {
  readonly request: StoredInteractionRequest;
  readonly outcome?: StoredInteractionOutcome;
}

export interface PendingInteractionFilter {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly kind?: CoreInteractionRequest['kind'];
}

export type InteractionMutationFailureResult =
  | { readonly status: 'definitely_not_published'; readonly failure: InteractionStoreError }
  | { readonly status: 'unresolved'; readonly failure: InteractionStoreError };

export type EstablishInteractionRequestResult =
  | {
      readonly status: 'stable';
      readonly matches: boolean;
      readonly record: InteractionRecord;
    }
  | InteractionMutationFailureResult;

export type CommitInteractionOutcomeResult =
  | {
      readonly status: 'stable';
      readonly matches: boolean;
      readonly record: InteractionRecord & { readonly outcome: StoredInteractionOutcome };
    }
  | InteractionMutationFailureResult;

export interface InteractionStoreReader {
  readInteraction(requestId: string): Promise<InteractionRecord | undefined>;
  listPending(filter?: PendingInteractionFilter): Promise<StoredInteractionRequest[]>;
}

export interface InteractionStoreWriter extends InteractionStoreReader {
  establishRequest(input: StoredInteractionRequest): Promise<EstablishInteractionRequestResult>;
  commitOutcome(
    requestId: string,
    outcome: InteractionCanonicalOutcome,
  ): Promise<CommitInteractionOutcomeResult>;
}

const readerBrand: unique symbol = Symbol('InteractionStoreReader');
const writerBrand: unique symbol = Symbol('InteractionStoreWriter');
const readers = new WeakSet<object>();
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractionStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractionStoreWriter>>();

export interface InteractiveInteractionStoreReaderFacade extends InteractionStoreReader {
  readonly kind: 'interactive';
  readonly access: 'read';
  readonly [readerBrand]: true;
}

export interface InteractiveInteractionStoreWriterFacade extends InteractionStoreWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
}

export function authenticateInteractionStoreReader(
  store: InteractiveInteractionStoreReaderFacade,
): InteractiveInteractionStoreReaderFacade {
  if (!readers.has(store)) throw invalidFacade('read');
  return store;
}

export function authenticateInteractionStoreWriter(
  store: InteractiveInteractionStoreWriterFacade,
): InteractiveInteractionStoreWriterFacade {
  if (!writers.has(store)) throw invalidFacade('write');
  return store;
}

export async function openInteractiveInteractionStoreForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveInteractionStoreReaderFacade> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const store = new FileInteractionStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'read', operation);
  await run(() => store.validateNamespaceForRead());
  const facade: InteractiveInteractionStoreReaderFacade = {
    kind: 'interactive',
    access: 'read',
    [readerBrand]: true,
    readInteraction: (requestId) => run(() => store.readInteraction(requestId)),
    listPending: (filter) => run(() => store.listPending(filter)),
  };
  Object.freeze(facade);
  readers.add(facade);
  return facade;
}

export async function openInteractiveInteractionStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveInteractionStoreWriterFacade> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease) as InteractiveInteractionStoreWriterFacade | undefined;
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease) as
    | Promise<InteractiveInteractionStoreWriterFacade>
    | undefined;
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    const store = new FileInteractionStore(lease.canonicalPath);
    const run = <T>(operation: () => Promise<T>) =>
      runWithStorageRootLease(lease, 'interactive', 'write', operation);
    await run(() => store.recoverNamespace());
    await assertStorageRootLease(lease, 'interactive', 'write');
    const recoveredExisting = writerByLease.get(lease) as
      | InteractiveInteractionStoreWriterFacade
      | undefined;
    if (recoveredExisting) return recoveredExisting;
    const facade: InteractiveInteractionStoreWriterFacade = {
      kind: 'interactive',
      access: 'write',
      [writerBrand]: true,
      readInteraction: (requestId) => run(() => store.readInteraction(requestId)),
      listPending: (filter) => run(() => store.listPending(filter)),
      establishRequest: (input) => run(() => store.establishRequest(input)),
      commitOutcome: (requestId, outcome) => run(() => store.commitOutcome(requestId, outcome)),
    };
    Object.freeze(facade);
    writers.add(facade);
    writerByLease.set(lease, facade);
    return facade;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

export function interactionLocator(requestId: string): string {
  return createHash('sha256').update(assertInteractionId(requestId), 'utf8').digest('hex');
}

type InspectedInteraction =
  | { readonly inspection: InteractionLocatorInspection; readonly record: InteractionRecord }
  | { readonly inspection: InteractionLocatorInspection; readonly record: undefined };

class FileInteractionStore {
  private readonly filesystem: InteractionFilesystem;
  private readonly locatorTails = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.filesystem = new InteractionFilesystem(root);
  }

  async recoverNamespace(): Promise<void> {
    const interactionsCreated = await this.filesystem.ensureInteractionsRootForWrite();
    const locators = await this.filesystem.listLocators();
    if (interactionsCreated && locators.length === 0) {
      await this.filesystem.syncInteractionsDirectory();
    }
    for (const locator of locators) {
      await this.withLocator(locator, async () => {
        const observed = await this.inspectMutationLocator(locator);
        if (!observed?.record) {
          await this.closeAbsentLocator(locator);
          return;
        }
        await this.stabilizeRecord(locator, observed);
      });
    }
  }

  async validateNamespaceForRead(): Promise<void> {
    for (const locator of await this.filesystem.listLocators()) {
      await this.withLocator(locator, () => this.readClosedLocator(locator));
    }
  }

  async establishRequest(
    input: StoredInteractionRequest,
  ): Promise<EstablishInteractionRequestResult> {
    const candidate = decodeStoredInteractionRequest(input, 'input');
    const locator = interactionLocator(candidate.requestId);
    const bytes = encodeBoundedJson(
      candidate,
      INTERACTION_REQUEST_MAX_BYTES,
      'Interaction request',
    );
    return this.withLocator(locator, async () => {
      let attempt: InteractionPublicationAttempt;
      try {
        await this.filesystem.prepareLocatorForWrite(locator);
        attempt = await this.filesystem.publishExclusive(locator, 'request.json', bytes);
      } catch (error) {
        attempt = {
          kind: 'link_not_attempted',
          failure: interactionFailure(error, 'Interaction request publication could not start'),
        };
      }
      return this.settleRequestPublication(locator, candidate, attempt);
    });
  }

  async commitOutcome(
    requestId: string,
    input: InteractionCanonicalOutcome,
  ): Promise<CommitInteractionOutcomeResult> {
    assertInteractionId(requestId);
    const locator = interactionLocator(requestId);
    return this.withLocator(locator, async () => {
      let observed: InspectedInteraction | undefined;
      try {
        observed = await this.inspectMutationLocator(locator, requestId);
      } catch (error) {
        return unresolved(error, 'Interaction request could not be read before outcome commit');
      }
      if (!observed?.record) {
        throw new InteractionStoreError(
          'request_not_found',
          `Interaction request '${requestId}' does not exist`,
        );
      }
      const { request } = observed.record;
      const candidate = decodeInteractionOutcomeInput(input, request);
      if (observed.record.outcome) {
        try {
          const canonical = await this.stabilizeRecord(locator, observed, requestId);
          if (!canonical.outcome) throw invalidRecord('Canonical Interaction outcome disappeared');
          return stableOutcome(
            canonical as InteractionRecord & { readonly outcome: StoredInteractionOutcome },
            interactionCanonicalOutcomesEquivalent(canonical.outcome.outcome, candidate.outcome),
          );
        } catch (error) {
          return unresolved(error, 'Existing Interaction outcome could not be stabilized');
        }
      }
      const bytes = encodeBoundedJson(
        candidate,
        INTERACTION_OUTCOME_MAX_BYTES,
        'Interaction outcome',
      );
      const attempt = await this.filesystem.publishExclusive(locator, 'outcome.json', bytes);
      return this.settleOutcomePublication(locator, request, candidate, attempt);
    });
  }

  private async settleRequestPublication(
    locator: string,
    candidate: StoredInteractionRequest,
    attempt: InteractionPublicationAttempt,
  ): Promise<EstablishInteractionRequestResult> {
    let observed: InspectedInteraction | undefined;
    try {
      observed = await this.inspectMutationLocator(locator, candidate.requestId);
      if (observed?.record) {
        const record = await this.stabilizeRecord(locator, observed, candidate.requestId);
        return {
          status: 'stable',
          matches: isDeepStrictEqual(record.request, candidate),
          record,
        };
      }
    } catch (error) {
      return unresolved(error, 'Interaction request publication could not be stabilized');
    }
    try {
      await this.closeAbsentLocator(locator);
    } catch (error) {
      return unresolved(error, 'Interaction request absence could not be closed');
    }
    return attempt.kind === 'link_not_attempted'
      ? { status: 'definitely_not_published', failure: attempt.failure }
      : unresolved(
          attempt.diagnostic ??
            invalidRecord('Canonical Interaction request is missing after publication'),
          'Interaction request publication could not be resolved',
        );
  }

  private async settleOutcomePublication(
    locator: string,
    expectedRequest: StoredInteractionRequest,
    candidate: StoredInteractionOutcome,
    attempt: InteractionPublicationAttempt,
  ): Promise<CommitInteractionOutcomeResult> {
    let observed: InspectedInteraction | undefined;
    try {
      observed = await this.inspectMutationLocator(locator, expectedRequest.requestId);
      if (!observed?.record) {
        throw invalidRecord('Canonical Interaction request is missing during outcome commit');
      }
      const record = await this.stabilizeRecord(locator, observed, expectedRequest.requestId);
      if (!isDeepStrictEqual(record.request, expectedRequest)) {
        throw invalidRecord('Canonical Interaction request changed during outcome commit');
      }
      if (record.outcome) {
        return stableOutcome(
          record as InteractionRecord & { readonly outcome: StoredInteractionOutcome },
          interactionCanonicalOutcomesEquivalent(record.outcome.outcome, candidate.outcome),
        );
      }
    } catch (error) {
      return unresolved(error, 'Interaction outcome publication could not be stabilized');
    }
    return attempt.kind === 'link_not_attempted'
      ? { status: 'definitely_not_published', failure: attempt.failure }
      : unresolved(
          attempt.diagnostic ??
            invalidRecord('Canonical Interaction outcome is missing after publication'),
          'Interaction outcome publication could not be resolved',
        );
  }

  async readInteraction(requestId: string): Promise<InteractionRecord | undefined> {
    assertInteractionId(requestId);
    const locator = interactionLocator(requestId);
    return this.withLocator(locator, () => this.readClosedLocator(locator, requestId));
  }

  async listPending(filter?: PendingInteractionFilter): Promise<StoredInteractionRequest[]> {
    const normalizedFilter = decodePendingInteractionFilter(filter);
    const pending: StoredInteractionRequest[] = [];
    for (const locator of await this.filesystem.listLocators()) {
      const record = await this.withLocator(locator, () => this.readClosedLocator(locator));
      if (!record || record.outcome) continue;
      if (matchesFilter(record.request, normalizedFilter)) pending.push(record.request);
    }
    return pending.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId),
    );
  }

  private async readClosedLocator(
    locator: string,
    expectedRequestId?: string,
  ): Promise<InteractionRecord | undefined> {
    const inspection = await this.filesystem.inspectLocator(locator);
    if (!inspection) return undefined;
    if (inspection.temporaryArtifacts.length > 0) {
      throw invalidRecord(`Interaction locator '${locator}' contains temporary artifacts`);
    }
    return this.readInspectedLocator(locator, inspection, expectedRequestId, true);
  }

  private async inspectMutationLocator(
    locator: string,
    expectedRequestId?: string,
  ): Promise<InspectedInteraction | undefined> {
    const inspection = await this.filesystem.inspectLocator(locator);
    if (!inspection) return undefined;
    return {
      inspection,
      record: await this.readInspectedLocator(locator, inspection, expectedRequestId, false),
    };
  }

  private async readInspectedLocator(
    locator: string,
    inspection: InteractionLocatorInspection,
    expectedRequestId: string | undefined,
    requireRequest: boolean,
  ): Promise<InteractionRecord | undefined> {
    if (!inspection.hasRequest) {
      if (inspection.hasOutcome)
        throw invalidRecord('Interaction outcome exists without its request');
      if (requireRequest)
        throw invalidRecord(`Interaction locator '${locator}' exists without a request`);
      return undefined;
    }
    const request = await this.readRequestAtLocator(locator, expectedRequestId);
    if (!request) throw invalidRecord('Interaction request disappeared while being read');
    const outcome = inspection.hasOutcome
      ? await this.readOutcomeForRequest(locator, request)
      : undefined;
    if (inspection.hasOutcome && !outcome) {
      throw invalidRecord('Interaction outcome disappeared while being read');
    }
    return deepFreeze({ request, ...(outcome === undefined ? {} : { outcome }) });
  }

  private async stabilizeRecord(
    locator: string,
    observed: Extract<InspectedInteraction, { readonly record: InteractionRecord }>,
    expectedRequestId?: string,
  ): Promise<InteractionRecord> {
    for (const artifact of observed.inspection.temporaryArtifacts) {
      await this.filesystem.removeTemporaryArtifact(locator, artifact);
    }
    await this.filesystem.syncLocatorDirectory(locator);
    const canonical = await this.readClosedLocator(locator, expectedRequestId);
    if (!canonical || !isDeepStrictEqual(canonical, observed.record)) {
      throw invalidRecord('Canonical Interaction record changed during stabilization');
    }
    return canonical;
  }

  private async closeAbsentLocator(locator: string): Promise<void> {
    let inspection = await this.filesystem.inspectLocator(locator);
    if (inspection) {
      if (inspection.hasRequest || inspection.hasOutcome) {
        throw invalidRecord(
          'Interaction locator gained a canonical document while closing absence',
        );
      }
      for (const artifact of inspection.temporaryArtifacts) {
        await this.filesystem.removeTemporaryArtifact(locator, artifact);
      }
      inspection = await this.filesystem.inspectLocator(locator);
      if (inspection) {
        if (
          inspection.hasRequest ||
          inspection.hasOutcome ||
          inspection.temporaryArtifacts.length > 0
        ) {
          throw invalidRecord('Interaction locator did not become empty while closing absence');
        }
        if ((await this.filesystem.removeLocator(locator)) === 'not_empty') {
          throw invalidRecord('Interaction locator could not be removed while closing absence');
        }
      }
    }
    await this.filesystem.syncInteractionsDirectory();
    if (await this.filesystem.inspectLocator(locator)) {
      throw invalidRecord('Interaction locator reappeared after absence closure');
    }
  }

  private async readRequestAtLocator(
    locator: string,
    expectedRequestId?: string,
  ): Promise<StoredInteractionRequest | undefined> {
    const value = await this.filesystem.readDocument(
      locator,
      'request.json',
      INTERACTION_REQUEST_MAX_BYTES,
    );
    if (value === undefined) return undefined;
    const request = decodeStoredInteractionRequest(value, 'record', expectedRequestId);
    if (interactionLocator(request.requestId) !== locator) {
      throw invalidRecord('Interaction request identity does not match its locator');
    }
    return deepFreeze(request);
  }

  private async readOutcomeForRequest(
    locator: string,
    request: StoredInteractionRequest,
  ): Promise<StoredInteractionOutcome | undefined> {
    const value = await this.filesystem.readDocument(
      locator,
      'outcome.json',
      INTERACTION_OUTCOME_MAX_BYTES,
    );
    return value === undefined
      ? undefined
      : deepFreeze(decodeStoredInteractionOutcome(value, request));
  }

  private async withLocator<T>(locator: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locatorTails.get(locator) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locatorTails.set(locator, tail);
    try {
      return await result;
    } finally {
      if (this.locatorTails.get(locator) === tail) this.locatorTails.delete(locator);
    }
  }
}

function stableOutcome(
  record: InteractionRecord & { readonly outcome: StoredInteractionOutcome },
  matches: boolean,
): CommitInteractionOutcomeResult {
  return {
    status: 'stable',
    matches,
    record,
  };
}

function unresolved(error: unknown, message: string): InteractionMutationFailureResult {
  return { status: 'unresolved', failure: interactionFailure(error, message) };
}

function interactionFailure(error: unknown, message: string): InteractionStoreError {
  return error instanceof InteractionStoreError ? error : ioFailed(message, error);
}

function matchesFilter(
  request: StoredInteractionRequest,
  filter: PendingInteractionFilter,
): boolean {
  return (
    (filter.sessionId === undefined || request.sessionId === filter.sessionId) &&
    (filter.turnId === undefined || request.turnId === filter.turnId) &&
    (filter.runId === undefined || request.runId === filter.runId) &&
    (filter.kind === undefined || request.request.kind === filter.kind)
  );
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function invalidFacade(access: 'read' | 'write'): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic interactive ${access} Interaction Store`,
  );
}
