import {
  decodeInteractionAnswer as decodeCoreInteractionAnswer,
  decodeInteractionCanonicalOutcome as decodeCoreInteractionCanonicalOutcome,
  decodeInteractionRequest as decodeCoreInteractionRequest,
  isInteractionCanonicalOutcomeValidForRequest,
  type InteractionAnswer,
  type InteractionCanonicalOutcome,
  type InteractionClosureReason,
  type InteractionPermissionDecision,
  type InteractionPermissionPrompt,
  type InteractionPermissionReason,
  type InteractionQuestion,
  type InteractionQuestionOption,
  type InteractionRequest,
} from '@maka/core/interaction';
import { assertExactKeys, requireEntityId, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export type {
  InteractionAnswer,
  InteractionCanonicalOutcome,
  InteractionClosureReason,
  InteractionPermissionDecision,
  InteractionPermissionPrompt,
  InteractionPermissionReason,
  InteractionQuestion,
  InteractionQuestionOption,
  InteractionRequest,
};

export const INTERACTION_SCHEMA_VERSION = 1 as const;
export const INTERACTION_PENDING_REVISION = 1 as const;
export const INTERACTION_RESOLVED_REVISION = 2 as const;
export const INTERACTION_MAX_PENDING_PER_SESSION = 16;

export type InteractionRevision =
  | typeof INTERACTION_PENDING_REVISION
  | typeof INTERACTION_RESOLVED_REVISION;

const INTERACTION_SNAPSHOT_MAX_BYTES = 32 * 1024;
const SESSION_INTERACTION_PROJECTION_MAX_BYTES = 48 * 1024;

interface InteractionSnapshotBase {
  readonly schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  readonly interactionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly request: InteractionRequest;
}

export type InteractionPendingSnapshot = InteractionSnapshotBase & {
  readonly revision: typeof INTERACTION_PENDING_REVISION;
  readonly status: 'pending';
  readonly outcome: null;
};

export type InteractionAnsweredSnapshot = InteractionSnapshotBase & {
  readonly revision: typeof INTERACTION_RESOLVED_REVISION;
  readonly status: 'answered';
  readonly outcome: Exclude<InteractionCanonicalOutcome, { kind: 'closure' }>;
};

export type InteractionResolvedSnapshot =
  | InteractionAnsweredSnapshot
  | (InteractionSnapshotBase & {
      readonly revision: typeof INTERACTION_RESOLVED_REVISION;
      readonly status: 'closed';
      readonly outcome: Extract<InteractionCanonicalOutcome, { kind: 'closure' }>;
    });

export type InteractionSnapshot = InteractionPendingSnapshot | InteractionResolvedSnapshot;

export interface SessionInteractionProjection {
  readonly pending: readonly InteractionPendingSnapshot[];
}

export interface InteractionQueryInput {
  readonly sessionId: string;
  readonly interactionId: string;
}

export interface InteractionAnswerInput {
  /** Stable semantic identity; the operation frame requestId is correlation-only. */
  readonly interactionId: string;
  readonly answer: InteractionAnswer;
}

export const INTERACTION_OPERATION_SPECS = {
  'interaction.query': defineOperation({
    mode: 'query',
    decodeInput: decodeInteractionQueryInput,
    decodeOutput: decodeInteractionSnapshot,
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'internal_failure',
    ] as const,
    retry: 'safe',
    admission: 'ready',
  }),
  'interaction.answer': defineOperation({
    mode: 'command',
    decodeInput: decodeInteractionAnswerInput,
    decodeOutput: decodeInteractionAnsweredSnapshot,
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'operation_conflict',
      'already_resolved',
      'internal_failure',
    ] as const,
    retry: 'semantic',
    admission: 'session',
  }),
} as const;

export function decodeInteractionRequest(value: unknown): InteractionRequest {
  return decodeCoreInteraction(value, 'Interaction request', decodeCoreInteractionRequest);
}

export function decodeInteractionAnswer(value: unknown): InteractionAnswer {
  return decodeCoreInteraction(value, 'Interaction answer', decodeCoreInteractionAnswer);
}

export function decodeInteractionCanonicalOutcome(value: unknown): InteractionCanonicalOutcome {
  return decodeCoreInteraction(
    value,
    'Interaction canonical outcome',
    decodeCoreInteractionCanonicalOutcome,
  );
}

export function decodeInteractionSnapshot(value: unknown): InteractionSnapshot {
  requireEncodedByteLimit(value, 'Interaction snapshot', INTERACTION_SNAPSHOT_MAX_BYTES);
  const record = requireRecord(value, 'Interaction snapshot');
  assertExactKeys(record, 'Interaction snapshot', [
    'schemaVersion',
    'interactionId',
    'sessionId',
    'turnId',
    'runId',
    'revision',
    'request',
    'status',
    'outcome',
  ]);
  if (record.schemaVersion !== INTERACTION_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported Interaction snapshot schema');
  }

  const request = decodeInteractionRequest(record.request);
  const revision = requireInteractionRevision(record.revision);
  const base: InteractionSnapshotBase = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    interactionId: requireEntityId(record.interactionId, 'interactionId'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
    request,
  };

  if (record.status === 'pending') {
    if (revision !== INTERACTION_PENDING_REVISION) {
      throw invalidProtocolFrame('Invalid pending Interaction revision');
    }
    if (record.outcome !== null) {
      throw invalidProtocolFrame('Pending Interaction has a canonical outcome');
    }
    return { ...base, revision, status: 'pending', outcome: null };
  }

  if (record.status !== 'answered' && record.status !== 'closed') {
    throw invalidProtocolFrame('Invalid Interaction status');
  }
  if (revision !== INTERACTION_RESOLVED_REVISION) {
    throw invalidProtocolFrame('Invalid resolved Interaction revision');
  }
  const outcome = decodeInteractionCanonicalOutcome(record.outcome);
  if (!isInteractionCanonicalOutcomeValidForRequest(request, outcome)) {
    throw invalidProtocolFrame('Interaction outcome does not match its request');
  }

  if (record.status === 'answered') {
    if (outcome.kind === 'closure') {
      throw invalidProtocolFrame('Answered Interaction has a closure outcome');
    }
    return { ...base, revision, status: 'answered', outcome };
  }
  if (outcome.kind !== 'closure') {
    throw invalidProtocolFrame('Closed Interaction has an answer outcome');
  }
  return { ...base, revision, status: 'closed', outcome };
}

export function decodeInteractionAnsweredSnapshot(value: unknown): InteractionAnsweredSnapshot {
  const snapshot = decodeInteractionSnapshot(value);
  if (snapshot.status !== 'answered') {
    throw invalidProtocolFrame('Interaction answer output is not answered');
  }
  return snapshot;
}

export function decodeSessionInteractionProjection(
  value: unknown,
  sessionId: string,
): SessionInteractionProjection {
  requireEncodedByteLimit(
    value,
    'Session Interaction projection',
    SESSION_INTERACTION_PROJECTION_MAX_BYTES,
  );
  const record = requireRecord(value, 'Session Interaction projection');
  assertExactKeys(record, 'Session Interaction projection', ['pending']);
  const pending = requireBoundedArray(
    record.pending,
    'pending Interactions',
    INTERACTION_MAX_PENDING_PER_SESSION,
  ).map((candidate) => {
    const snapshot = decodeInteractionSnapshot(candidate);
    if (snapshot.status !== 'pending') {
      throw invalidProtocolFrame('Pending Interaction projection contains a resolved Interaction');
    }
    return snapshot;
  });

  const identities = new Set<string>();
  for (const snapshot of pending) {
    if (snapshot.sessionId !== sessionId) {
      throw invalidProtocolFrame('Interaction projection belongs to a different Session');
    }
    if (identities.has(snapshot.interactionId)) {
      throw invalidProtocolFrame('Session Interaction projection repeats an Interaction identity');
    }
    identities.add(snapshot.interactionId);
  }
  return { pending };
}

function decodeInteractionQueryInput(value: unknown): InteractionQueryInput {
  const record = requireRecord(value, 'interaction.query input');
  assertExactKeys(record, 'interaction.query input', ['sessionId', 'interactionId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    interactionId: requireEntityId(record.interactionId, 'interactionId'),
  };
}

function decodeInteractionAnswerInput(value: unknown): InteractionAnswerInput {
  const record = requireRecord(value, 'interaction.answer input');
  assertExactKeys(record, 'interaction.answer input', ['interactionId', 'answer']);
  return {
    interactionId: requireEntityId(record.interactionId, 'interactionId'),
    answer: decodeInteractionAnswer(record.answer),
  };
}

function decodeCoreInteraction<T>(
  value: unknown,
  label: string,
  decode: (candidate: unknown) => T,
): T {
  try {
    return decode(value);
  } catch {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
}

function requireInteractionRevision(value: unknown): InteractionRevision {
  if (value === INTERACTION_PENDING_REVISION || value === INTERACTION_RESOLVED_REVISION) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Interaction revision');
}

function requireBoundedArray(value: unknown, label: string, maxCount: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxCount) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireEncodedByteLimit(value: unknown, label: string, maxBytes: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
}
