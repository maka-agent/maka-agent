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
} from './agent-run-store.js';
import { createSessionStore, type SessionStore } from './session-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from './root-authority.js';

export type {
  RootTurnAdmission,
  RootTurnAdmissionInput,
} from './agent-run-store.js';

export type InteractiveExecutionSessionWriter = SessionStore;
export type InteractiveExecutionAgentRunWriter = DurableAgentRunStore;
export type InteractiveExecutionRuntimeEventWriter = DurableRuntimeEventStore;

export interface InteractiveExecutionStoresWriter {
  sessionStore: InteractiveExecutionSessionWriter;
  agentRunStore: InteractiveExecutionAgentRunWriter;
  runtimeEventStore: InteractiveExecutionRuntimeEventWriter;
}

export interface InteractiveExecutionSessionReader {
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
}

export interface InteractiveExecutionAgentRunReader {
  readRun(sessionId: string, runId: string): Promise<AgentRunHeader>;
  listSessionRuns(sessionId: string): Promise<AgentRunHeader[]>;
  readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined>;
  readRootTurnAdmission(sessionId: string, turnId: string): Promise<RootTurnAdmission | undefined>;
}

export interface InteractiveExecutionRuntimeEventReader {
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}

export interface InteractiveExecutionStoresReader {
  sessionStore: InteractiveExecutionSessionReader;
  agentRunStore: InteractiveExecutionAgentRunReader;
  runtimeEventStore: InteractiveExecutionRuntimeEventReader;
}

export async function openInteractiveExecutionStoresForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveExecutionStoresWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const sessionStore = createSessionStore(lease.canonicalPath);
  const agentRunStore = createAgentRunStore(lease.canonicalPath);
  const runtimeEventStore = createRuntimeEventStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'write', operation);

  return {
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
  };
}

export async function openInteractiveExecutionStoresForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveExecutionStoresReader> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const sessionStore = createSessionStore(lease.canonicalPath);
  const agentRunStore = createAgentRunStore(lease.canonicalPath);
  const runtimeEventStore = createRuntimeEventStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'read', operation);

  return {
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
    },
    runtimeEventStore: {
      readRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readRuntimeEvents(sessionId, runId)),
      readImmutableRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId)),
      readSessionRuntimeEvents: (sessionId) =>
        run(() => runtimeEventStore.readSessionRuntimeEvents(sessionId)),
    },
  };
}
