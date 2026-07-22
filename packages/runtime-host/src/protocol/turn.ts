import { invalidProtocolFrame } from './errors.js';
import {
  assertExactKeys,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
  requireString,
} from './codec.js';
import { defineOperation } from './operation-spec.js';

export interface TurnStartInput {
  sessionId: string;
  turnId: string;
  text: string;
}

export interface TurnQueryInput {
  sessionId: string;
  turnId: string;
}

export interface TurnStopInput {
  sessionId: string;
  turnId: string;
  runId: string;
}

export type TurnRunStatus =
  | 'admitted'
  | 'created'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface TurnSnapshotBase {
  sessionId: string;
  turnId: string;
  runId: string;
}

export type TurnSnapshot =
  | (TurnSnapshotBase & {
      status: Exclude<TurnRunStatus, 'completed' | 'failed' | 'cancelled'>;
    })
  | (TurnSnapshotBase & { status: 'completed'; terminalEventId: string })
  | (TurnSnapshotBase & {
      status: 'failed';
      terminalEventId: string;
      failureClass: string;
    })
  | (TurnSnapshotBase & {
      status: 'cancelled';
      terminalEventId: string;
      abortSource: string;
    });

export const TURN_OPERATION_SPECS = {
  'turn.start': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnStartInput,
    decodeOutput: decodeTurnSnapshot,
  }),
  'turn.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnQueryInput,
    decodeOutput: decodeTurnSnapshot,
  }),
  'turn.stop': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'operation_conflict',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnStopInput,
    decodeOutput: decodeTurnSnapshot,
  }),
} as const;

function decodeTurnStartInput(value: unknown): TurnStartInput {
  const record = requireExactRecord(value, 'turn.start input', ['sessionId', 'turnId', 'text']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    text: requireString(record.text, 'text', 48 * 1024),
  };
}

function decodeTurnQueryInput(value: unknown): TurnQueryInput {
  const record = requireExactRecord(value, 'turn.query input', ['sessionId', 'turnId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
  };
}

function decodeTurnStopInput(value: unknown): TurnStopInput {
  const record = requireExactRecord(value, 'turn.stop input', ['sessionId', 'turnId', 'runId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
}

function decodeTurnSnapshot(value: unknown): TurnSnapshot {
  const record = requireRecord(value, 'Turn snapshot');
  const base = {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
  const status = requireTurnRunStatus(record.status);
  if (status === 'completed') {
    assertExactKeys(record, 'completed Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
    };
  }
  if (status === 'failed') {
    assertExactKeys(record, 'failed Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
      'failureClass',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
      failureClass: requireString(record.failureClass, 'failureClass', 128),
    };
  }
  if (status === 'cancelled') {
    assertExactKeys(record, 'cancelled Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
      'abortSource',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
      abortSource: requireString(record.abortSource, 'abortSource', 128),
    };
  }
  assertExactKeys(record, 'non-terminal Turn snapshot', ['sessionId', 'turnId', 'runId', 'status']);
  return { ...base, status };
}

function requireTurnRunStatus(value: unknown): TurnRunStatus {
  if (
    value === 'admitted' ||
    value === 'created' ||
    value === 'running' ||
    value === 'waiting_permission' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Turn run status');
}
