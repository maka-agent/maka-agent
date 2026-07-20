import type { SessionHeader } from '@maka/core/session';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  decodeSessionContinuitySnapshot,
  SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionMessageQueueProjection,
} from '../protocol/index.js';
import {
  readCanonicalTurnSnapshot,
  type CanonicalTurnSnapshotStores,
} from './canonical-turn-snapshot.js';
import { projectSessionInteractions } from './interaction-projection.js';
import { type RootAdmissionReader, sameRootAdmissionIdentity } from './root-admission-owner.js';
import type {
  CanonicalSessionProjection,
  ReadCanonicalSessionProjection,
} from './session-continuity-coordinator.js';

type CanonicalSessionProjectionStores = CanonicalTurnSnapshotStores & {
  readonly sessionStore: Pick<
    ExecutionStoresWriter<'interactive'>['sessionStore'],
    'readHeaderSnapshot'
  >;
  readonly agentRunStore: CanonicalTurnSnapshotStores['agentRunStore'] &
    Pick<ExecutionStoresWriter<'interactive'>['agentRunStore'], 'readRootTurnAdmission'>;
  readonly interactionStore: Pick<
    ExecutionStoresWriter<'interactive'>['interactionStore'],
    'listPending'
  >;
};

export interface CanonicalSessionProjectionReader {
  readonly read: ReadCanonicalSessionProjection;
  readonly validateMessageQueue: (
    sessionId: string,
    queue: SessionMessageQueueProjection,
  ) => Promise<boolean>;
}

export function createCanonicalSessionProjectionReader(
  stores: CanonicalSessionProjectionStores,
  rootAdmissionReader: RootAdmissionReader,
  readMessageQueue: (sessionId: string) => SessionMessageQueueProjection,
): CanonicalSessionProjectionReader {
  const read = (
    sessionId: string,
    queue: SessionMessageQueueProjection = readMessageQueue(sessionId),
  ) => readCanonicalSessionProjection(stores, rootAdmissionReader, sessionId, queue);
  return {
    read,
    validateMessageQueue: async (sessionId, queue) => {
      const canonical = await read(sessionId, queue);
      if (!canonical) throw new Error('Cannot validate a missing Session projection');
      const snapshot = {
        schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
        session: canonical.session,
        projectionRevision: Number.MAX_SAFE_INTEGER,
        rootTurn: canonical.rootTurn,
        interactions: canonical.interactions,
        queue: canonical.queue,
      };
      if (
        Buffer.byteLength(JSON.stringify(snapshot), 'utf8') >
        SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES
      ) {
        return false;
      }
      decodeSessionContinuitySnapshot(snapshot);
      return true;
    },
  };
}

async function readCanonicalSessionProjection(
  stores: CanonicalSessionProjectionStores,
  rootAdmissionReader: RootAdmissionReader,
  sessionId: string,
  queue: SessionMessageQueueProjection,
): Promise<CanonicalSessionProjection | null> {
  const session = await readSessionHeaderIfPresent(stores, sessionId);
  if (!session) return null;
  const pendingInteractions = await stores.interactionStore.listPending({ sessionId });
  const indexedAdmission = rootAdmissionReader.latestAdmission(sessionId);
  const latest = indexedAdmission
    ? await stores.agentRunStore.readRootTurnAdmission(sessionId, indexedAdmission.turnId)
    : undefined;
  if (indexedAdmission && !latest) {
    throw new Error('Indexed root Turn admission is not durable');
  }
  if (latest && !sameRootAdmissionIdentity(latest, indexedAdmission)) {
    throw new Error('Durable root Turn admission identity changed');
  }
  return {
    session: sessionIdentity(session),
    rootTurn: latest
      ? await readCanonicalTurnSnapshot(stores, latest.sessionId, latest.turnId, latest.runId)
      : null,
    interactions: projectSessionInteractions(pendingInteractions),
    queue,
  };
}

function sessionIdentity(header: SessionHeader): CanonicalSessionProjection['session'] {
  return {
    sessionId: header.id,
    status: header.status,
    createdAt: header.createdAt,
    lastUsedAt: header.lastUsedAt,
    isArchived: header.isArchived,
    ...(header.archivedAt === undefined ? {} : { archivedAt: header.archivedAt }),
  };
}

async function readSessionHeaderIfPresent(
  stores: CanonicalSessionProjectionStores,
  sessionId: string,
): Promise<SessionHeader | undefined> {
  try {
    return await stores.sessionStore.readHeaderSnapshot(sessionId);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
