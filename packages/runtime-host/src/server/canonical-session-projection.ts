import type { SessionHeader } from '@maka/core/session';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
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
}

export function createCanonicalSessionProjectionReader(
  stores: CanonicalSessionProjectionStores,
  rootAdmissionReader: RootAdmissionReader,
): CanonicalSessionProjectionReader {
  return {
    read: async (sessionId) => {
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
      };
    },
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
