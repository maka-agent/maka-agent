import type {
  AgentRunEvent,
  AgentRunEventType,
  AgentRunHeader,
  RuntimeEvent,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  TurnRecord,
} from '@maka/core';
import {
  createAgentRunStore,
  createRuntimeEventStore,
  type AdmitRootTurnInput,
  type AdmitRootTurnResult,
  type DurableAgentRunStore,
  type DurableRuntimeEventStore,
  type RootTurnAdmission,
  type RootTurnSourceMessageReceipt,
} from './agent-run-store.js';
import { createSessionStore, type SessionStore } from './session-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootKind,
  type StorageRootLease,
} from './root-authority.js';
import {
  openInteractiveInteractionStoreForRead,
  openInteractiveInteractionStoreForWrite,
  type InteractiveInteractionStoreReaderFacade,
  type InteractiveInteractionStoreWriterFacade,
} from './interaction-store.js';

const executionStoresWriterBrand: unique symbol = Symbol('ExecutionStoresWriter');
const executionStoresReaderBrand: unique symbol = Symbol('ExecutionStoresReader');
const executionStoresWriterKinds = new WeakMap<object, StorageRootKind>();
const executionStoresReaderKinds = new WeakMap<object, StorageRootKind>();

export type {
  RootTurnAdmission,
  RootTurnAdmissionInput,
  RootTurnSourceMessage,
  RootTurnSourceMessageReceipt,
} from './agent-run-store.js';

export type ExecutionSessionWriter = SessionStore;
export type ExecutionAgentRunWriter = DurableAgentRunStore;
export type ExecutionRuntimeEventWriter = DurableRuntimeEventStore;

interface ExecutionStoresWriterBase<K extends StorageRootKind> {
  readonly kind: K;
  readonly [executionStoresWriterBrand]: K;
  readonly sessionStore: Readonly<ExecutionSessionWriter>;
  readonly agentRunStore: Readonly<ExecutionAgentRunWriter>;
  readonly runtimeEventStore: Readonly<ExecutionRuntimeEventWriter>;
}

export type ExecutionStoresWriter<K extends StorageRootKind> = ExecutionStoresWriterBase<K> &
  (K extends 'interactive'
    ? { readonly interactionStore: InteractiveInteractionStoreWriterFacade }
    : object);

export interface ExecutionSessionReader {
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
}

export interface ExecutionAgentRunReader {
  readRun(sessionId: string, runId: string): Promise<AgentRunHeader>;
  listSessionRuns(sessionId: string): Promise<AgentRunHeader[]>;
  readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined>;
  readRootTurnAdmission(sessionId: string, turnId: string): Promise<RootTurnAdmission | undefined>;
  readRootTurnSourceMessageReceipt(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined>;
}

export interface ExecutionRuntimeEventReader {
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}

interface ExecutionStoresReaderBase<K extends StorageRootKind> {
  readonly kind: K;
  readonly [executionStoresReaderBrand]: K;
  readonly sessionStore: Readonly<ExecutionSessionReader>;
  readonly agentRunStore: Readonly<ExecutionAgentRunReader>;
  readonly runtimeEventStore: Readonly<ExecutionRuntimeEventReader>;
}

export type ExecutionStoresReader<K extends StorageRootKind> = ExecutionStoresReaderBase<K> &
  (K extends 'interactive'
    ? { readonly interactionStore: InteractiveInteractionStoreReaderFacade }
    : object);

export function authenticateExecutionStoresWriter<K extends StorageRootKind>(
  stores: ExecutionStoresWriter<K>,
  expectedKind: K,
): ExecutionStoresWriter<K> {
  if (executionStoresWriterKinds.get(stores) !== expectedKind) {
    throw invalidExecutionStores(expectedKind, 'write');
  }
  return stores;
}

export function authenticateExecutionStoresReader<K extends StorageRootKind>(
  stores: ExecutionStoresReader<K>,
  expectedKind: K,
): ExecutionStoresReader<K> {
  if (executionStoresReaderKinds.get(stores) !== expectedKind) {
    throw invalidExecutionStores(expectedKind, 'read');
  }
  return stores;
}

export async function openInteractiveExecutionStoresForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<ExecutionStoresWriter<'interactive'>> {
  const interactionStore = await openInteractiveInteractionStoreForWrite(lease);
  return openExecutionStoresForWrite(lease, 'interactive', interactionStore);
}

export async function openHeadlessExecutionStoresForWrite(
  lease: StorageRootLease<'headless', 'write'>,
): Promise<ExecutionStoresWriter<'headless'>> {
  return openExecutionStoresForWrite(lease, 'headless');
}

async function openExecutionStoresForWrite<K extends StorageRootKind>(
  lease: StorageRootLease<K, 'write'>,
  kind: K,
  interactionStore?: InteractiveInteractionStoreWriterFacade,
): Promise<ExecutionStoresWriter<K>> {
  assertInteractionStoreComposition(kind, interactionStore);
  await assertStorageRootLease(lease, kind, 'write');
  const sessionStore = createSessionStore(lease.canonicalPath);
  const agentRunStore = createAgentRunStore(lease.canonicalPath);
  const runtimeEventStore = createRuntimeEventStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, kind, 'write', operation);

  const stores = {
    kind,
    [executionStoresWriterBrand]: kind,
    ...(interactionStore === undefined ? {} : { interactionStore }),
    sessionStore: {
      create: (input) => run(() => sessionStore.create(input)),
      list: (filter) => run(() => sessionStore.list(filter)),
      listForRecovery: () => run(() => sessionStore.listForRecovery()),
      readHeaderSnapshot: (sessionId) => run(() => sessionStore.readHeaderSnapshot(sessionId)),
      readMessagesSnapshot: (sessionId) => run(() => sessionStore.readMessagesSnapshot(sessionId)),
      readMessagesForRecovery: (sessionId) =>
        run(() => sessionStore.readMessagesForRecovery(sessionId)),
      listTurnsSnapshot: (sessionId) => run(() => sessionStore.listTurnsSnapshot(sessionId)),
      readHeader: (sessionId) => run(() => sessionStore.readHeader(sessionId)),
      readMessages: (sessionId) => run(() => sessionStore.readMessages(sessionId)),
      listTurns: (sessionId) => run(() => sessionStore.listTurns(sessionId)),
      appendMessage: (sessionId, message) =>
        run(() => sessionStore.appendMessage(sessionId, message)),
      appendMessages: (sessionId, messages) =>
        run(() => sessionStore.appendMessages(sessionId, messages)),
      updateHeader: (sessionId, patch) => run(() => sessionStore.updateHeader(sessionId, patch)),
      markSessionReadThrough: (sessionId, readThroughTs) =>
        run(() => sessionStore.markSessionReadThrough(sessionId, readThroughTs)),
      archive: (sessionId) => run(() => sessionStore.archive(sessionId)),
      unarchive: (sessionId) => run(() => sessionStore.unarchive(sessionId)),
      setFlagged: (sessionId, isFlagged) =>
        run(() => sessionStore.setFlagged(sessionId, isFlagged)),
      rename: (sessionId, name) => run(() => sessionStore.rename(sessionId, name)),
      setGeneratedTitleIfAbsent: (sessionId, title) =>
        run(() => sessionStore.setGeneratedTitleIfAbsent(sessionId, title)),
      remove: (sessionId) => run(() => sessionStore.remove(sessionId)),
    },
    agentRunStore: {
      createRun: (header, options) => run(() => agentRunStore.createRun(header, options)),
      updateRun: (sessionId, runId, patch, options) =>
        run(() => agentRunStore.updateRun(sessionId, runId, patch, options)),
      readRun: (sessionId, runId) => run(() => agentRunStore.readRun(sessionId, runId)),
      listSessionRuns: (sessionId) => run(() => agentRunStore.listSessionRuns(sessionId)),
      listSessionRunsForRecovery: (sessionId) =>
        run(() => agentRunStore.listSessionRunsForRecovery(sessionId)),
      appendEvent: (sessionId, runId, event, options) =>
        run(() => agentRunStore.appendEvent(sessionId, runId, event, options)),
      readEvents: (sessionId, runId) => run(() => agentRunStore.readEvents(sessionId, runId)),
      readEventsForRecovery: (sessionId, runId) =>
        run(() => agentRunStore.readEventsForRecovery(sessionId, runId)),
      readEventProjection: (sessionId, type) =>
        run(() => agentRunStore.readEventProjection(sessionId, type)),
      repairEventProjection: (sessionId, type, event, options) =>
        run(() => agentRunStore.repairEventProjection(sessionId, type, event, options)),
      admitRootTurn: (input: AdmitRootTurnInput): Promise<AdmitRootTurnResult> =>
        run(() => agentRunStore.admitRootTurn(input)),
      readRootTurnAdmission: (sessionId, turnId) =>
        run(() => agentRunStore.readRootTurnAdmission(sessionId, turnId)),
      readRootTurnSourceMessageReceipt: (sessionId, sourceMessageId) =>
        run(() =>
          agentRunStore.readRootTurnSourceMessageReceipt(sessionId, sourceMessageId),
        ),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        run(() => agentRunStore.listRootTurnAdmissionsForRecovery(sessionId)),
    },
    runtimeEventStore: {
      appendRuntimeEvent: (sessionId, runId, event, options) =>
        run(() => runtimeEventStore.appendRuntimeEvent(sessionId, runId, event, options)),
      ensureTerminalRuntimeEventDurable: (sessionId, runId, event) =>
        run(() => runtimeEventStore.ensureTerminalRuntimeEventDurable(sessionId, runId, event)),
      readRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readRuntimeEvents(sessionId, runId)),
      readImmutableRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId)),
      readSessionRuntimeEvents: (sessionId) =>
        run(() => runtimeEventStore.readSessionRuntimeEvents(sessionId)),
    },
  } as ExecutionStoresWriter<K>;
  freezeExecutionStoresFacade(stores);
  executionStoresWriterKinds.set(stores, kind);
  return stores;
}

export async function openInteractiveExecutionStoresForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<ExecutionStoresReader<'interactive'>> {
  const interactionStore = await openInteractiveInteractionStoreForRead(lease);
  return openExecutionStoresForRead(lease, 'interactive', interactionStore);
}

export async function openHeadlessExecutionStoresForRead(
  lease: StorageRootLease<'headless', 'read'>,
): Promise<ExecutionStoresReader<'headless'>> {
  return openExecutionStoresForRead(lease, 'headless');
}

async function openExecutionStoresForRead<K extends StorageRootKind>(
  lease: StorageRootLease<K, 'read'>,
  kind: K,
  interactionStore?: InteractiveInteractionStoreReaderFacade,
): Promise<ExecutionStoresReader<K>> {
  assertInteractionStoreComposition(kind, interactionStore);
  await assertStorageRootLease(lease, kind, 'read');
  const sessionStore = createSessionStore(lease.canonicalPath);
  const agentRunStore = createAgentRunStore(lease.canonicalPath);
  const runtimeEventStore = createRuntimeEventStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, kind, 'read', operation);

  const stores = {
    kind,
    [executionStoresReaderBrand]: kind,
    ...(interactionStore === undefined ? {} : { interactionStore }),
    sessionStore: {
      list: (filter) => run(() => sessionStore.list(filter)),
      readHeader: (sessionId) => run(() => sessionStore.readHeaderSnapshot(sessionId)),
      readMessages: (sessionId) => run(() => sessionStore.readMessagesSnapshot(sessionId)),
      listTurns: (sessionId) => run(() => sessionStore.listTurnsSnapshot(sessionId)),
    },
    agentRunStore: {
      readRun: (sessionId, runId) => run(() => agentRunStore.readRun(sessionId, runId)),
      listSessionRuns: (sessionId) => run(() => agentRunStore.listSessionRuns(sessionId)),
      readEvents: (sessionId, runId) => run(() => agentRunStore.readEvents(sessionId, runId)),
      readEventProjection: (sessionId, type) =>
        run(() => agentRunStore.readEventProjection(sessionId, type)),
      readRootTurnAdmission: (sessionId, turnId) =>
        run(() => agentRunStore.readRootTurnAdmission(sessionId, turnId)),
      readRootTurnSourceMessageReceipt: (sessionId, sourceMessageId) =>
        run(() =>
          agentRunStore.readRootTurnSourceMessageReceipt(sessionId, sourceMessageId),
        ),
    },
    runtimeEventStore: {
      readRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readRuntimeEvents(sessionId, runId)),
      readImmutableRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId)),
      readSessionRuntimeEvents: (sessionId) =>
        run(() => runtimeEventStore.readSessionRuntimeEvents(sessionId)),
    },
  } as ExecutionStoresReader<K>;
  freezeExecutionStoresFacade(stores);
  executionStoresReaderKinds.set(stores, kind);
  return stores;
}

function freezeExecutionStoresFacade(stores: {
  readonly sessionStore: object;
  readonly agentRunStore: object;
  readonly runtimeEventStore: object;
  readonly interactionStore?: object;
}): void {
  Object.freeze(stores.sessionStore);
  Object.freeze(stores.agentRunStore);
  Object.freeze(stores.runtimeEventStore);
  if (stores.interactionStore) Object.freeze(stores.interactionStore);
  Object.freeze(stores);
}

function invalidExecutionStores(
  kind: StorageRootKind,
  access: 'read' | 'write',
): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic ${kind} ${access} execution stores`,
  );
}

function assertInteractionStoreComposition(
  kind: StorageRootKind,
  interactionStore?:
    | InteractiveInteractionStoreReaderFacade
    | InteractiveInteractionStoreWriterFacade,
): void {
  if ((kind === 'interactive') !== (interactionStore !== undefined)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Interactive execution stores require their lease-bound Interaction Store',
    );
  }
}
