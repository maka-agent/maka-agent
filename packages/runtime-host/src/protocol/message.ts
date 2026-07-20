import { invalidProtocolFrame } from './errors.js';
import {
  assertExactKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { defineOperation } from './operation-spec.js';
import {
  decodeTurnSnapshot,
  TURN_MESSAGE_TEXT_MAX_BYTES,
  type TurnSnapshot,
} from './turn.js';

export const MESSAGE_QUEUE_MAX_ENTRIES = 64;
export const MESSAGE_QUEUE_PROJECTION_MAX_BYTES = 52 * 1024;
const MESSAGE_OPERATION_RESULT_MAX_BYTES = 56 * 1024;

export type MessagePlacement = 'current_turn' | 'next_turn';

interface MessageQueueEntrySnapshotBase {
  readonly entryId: string;
  readonly messageId: string;
  readonly text: string;
  readonly placement: MessagePlacement;
}

export interface QueuedMessageSnapshot extends MessageQueueEntrySnapshotBase {
  readonly state: 'queued';
}

export interface InFlightMessageSnapshot extends MessageQueueEntrySnapshotBase {
  readonly placement: 'current_turn';
  readonly state: 'in_flight';
}

export interface RetractedMessageSnapshot extends MessageQueueEntrySnapshotBase {
  readonly state: 'retracted';
}

export type MessageQueueEntrySnapshot =
  | QueuedMessageSnapshot
  | InFlightMessageSnapshot
  | RetractedMessageSnapshot;

export type SteeringMessageSnapshot =
  | (QueuedMessageSnapshot & { readonly placement: 'current_turn' })
  | InFlightMessageSnapshot;

export interface SessionMessageQueueProjection {
  readonly hostEpoch: string;
  readonly queueRevision: number;
  readonly steering: readonly SteeringMessageSnapshot[];
  readonly followup: readonly QueuedMessageSnapshot[];
}

export interface TurnMessageSubmitInput {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly text: string;
  readonly placement: MessagePlacement;
}

export type TurnMessageSubmitResult =
  | { readonly disposition: 'steering'; readonly queueRevision: number }
  | { readonly disposition: 'followup'; readonly queueRevision: number }
  | { readonly disposition: 'turn_started'; readonly turnId: string };

export interface QueueRetractInput {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly retractId: string;
}

export interface QueueRetractResult {
  readonly queueRevision: number;
  readonly retracted: readonly RetractedMessageSnapshot[];
}

export interface TurnInterruptInput {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly interruptId: string;
  readonly turnId: string;
  readonly runId: string;
}

export interface TurnInterruptResult {
  readonly queueRevision: number;
  readonly retracted: readonly RetractedMessageSnapshot[];
  readonly turn: TurnSnapshot;
}

const MESSAGE_OPERATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'session_busy',
  'operation_conflict',
  'outcome_unknown',
  'internal_failure',
] as const;

export const MESSAGE_OPERATION_SPECS = {
  'turn.message.submit': defineOperation({
    mode: 'command',
    decodeInput: decodeTurnMessageSubmitInput,
    decodeOutput: decodeTurnMessageSubmitResult,
    errors: MESSAGE_OPERATION_ERRORS,
    retry: 'semantic',
    admission: 'session',
  }),
  'queue.retract': defineOperation({
    mode: 'command',
    decodeInput: decodeQueueRetractInput,
    decodeOutput: decodeQueueRetractResult,
    errors: MESSAGE_OPERATION_ERRORS,
    retry: 'semantic',
    admission: 'session',
  }),
  'turn.interrupt': defineOperation({
    mode: 'control',
    decodeInput: decodeTurnInterruptInput,
    decodeOutput: decodeTurnInterruptResult,
    errors: MESSAGE_OPERATION_ERRORS,
    retry: 'semantic',
    admission: 'session',
  }),
} as const;

export function decodeSessionMessageQueueProjection(
  value: unknown,
): SessionMessageQueueProjection {
  requireEncodedByteLimit(
    value,
    'Session message queue projection',
    MESSAGE_QUEUE_PROJECTION_MAX_BYTES,
  );
  const record = requireExactRecord(value, 'Session message queue projection', [
    'hostEpoch',
    'queueRevision',
    'steering',
    'followup',
  ]);
  const steering = decodeSteeringMessages(record.steering);
  const followup = decodeFollowupMessages(record.followup);
  if (steering.length + followup.length > MESSAGE_QUEUE_MAX_ENTRIES) {
    throw invalidProtocolFrame('Invalid Session message queue projection');
  }
  assertUniqueQueueEntries([...steering, ...followup], 'Session message queue projection');
  return {
    hostEpoch: requireId(record.hostEpoch, 'queue hostEpoch'),
    queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    steering,
    followup,
  };
}

function decodeTurnMessageSubmitInput(value: unknown): TurnMessageSubmitInput {
  const record = requireExactRecord(value, 'turn.message.submit input', [
    'originHostEpoch',
    'sessionId',
    'messageId',
    'text',
    'placement',
  ]);
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    messageId: requireEntityId(record.messageId, 'messageId'),
    text: requireUtf8BoundedString(record.text, 'text', TURN_MESSAGE_TEXT_MAX_BYTES),
    placement: requireMessagePlacement(record.placement),
  };
}

function decodeTurnMessageSubmitResult(value: unknown): TurnMessageSubmitResult {
  const record = requireRecord(value, 'turn.message.submit result');
  if (record.disposition === 'turn_started') {
    assertExactKeys(record, 'turn.message.submit turn_started result', ['disposition', 'turnId']);
    return {
      disposition: record.disposition,
      turnId: requireEntityId(record.turnId, 'turnId'),
    };
  }
  if (record.disposition === 'steering' || record.disposition === 'followup') {
    assertExactKeys(record, 'turn.message.submit queued result', [
      'disposition',
      'queueRevision',
    ]);
    return {
      disposition: record.disposition,
      queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    };
  }
  throw invalidProtocolFrame('Invalid turn.message.submit disposition');
}

function decodeQueueRetractInput(value: unknown): QueueRetractInput {
  const record = requireExactRecord(value, 'queue.retract input', [
    'originHostEpoch',
    'sessionId',
    'retractId',
  ]);
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    retractId: requireEntityId(record.retractId, 'retractId'),
  };
}

function decodeQueueRetractResult(value: unknown): QueueRetractResult {
  requireEncodedByteLimit(value, 'queue.retract result', MESSAGE_OPERATION_RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'queue.retract result', [
    'queueRevision',
    'retracted',
  ]);
  return {
    queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    retracted: decodeRetractedMessages(record.retracted),
  };
}

function decodeTurnInterruptInput(value: unknown): TurnInterruptInput {
  const record = requireExactRecord(value, 'turn.interrupt input', [
    'originHostEpoch',
    'sessionId',
    'interruptId',
    'turnId',
    'runId',
  ]);
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    interruptId: requireEntityId(record.interruptId, 'interruptId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
}

function decodeTurnInterruptResult(value: unknown): TurnInterruptResult {
  requireEncodedByteLimit(value, 'turn.interrupt result', MESSAGE_OPERATION_RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'turn.interrupt result', [
    'queueRevision',
    'retracted',
    'turn',
  ]);
  return {
    queueRevision: requireCount(record.queueRevision, 'queueRevision'),
    retracted: decodeRetractedMessages(record.retracted),
    turn: decodeTurnSnapshot(record.turn),
  };
}

function decodeSteeringMessages(value: unknown): SteeringMessageSnapshot[] {
  const entries = requireBoundedArray(value, 'steering queue');
  return entries.map((entry) => {
    const decoded = decodeMessageQueueEntrySnapshot(entry);
    if (decoded.placement !== 'current_turn') {
      throw invalidProtocolFrame('Invalid steering queue entry');
    }
    if (decoded.state === 'queued') {
      return { ...decoded, placement: 'current_turn' };
    }
    if (decoded.state === 'in_flight') return decoded;
    throw invalidProtocolFrame('Invalid steering queue entry');
  });
}

function decodeFollowupMessages(value: unknown): QueuedMessageSnapshot[] {
  const entries = requireBoundedArray(value, 'followup queue');
  return entries.map((entry) => {
    const decoded = decodeMessageQueueEntrySnapshot(entry);
    if (decoded.state !== 'queued') {
      throw invalidProtocolFrame('Invalid followup queue entry');
    }
    return decoded;
  });
}

function decodeRetractedMessages(value: unknown): RetractedMessageSnapshot[] {
  const entries = requireBoundedArray(value, 'retracted messages').map((entry) => {
    const decoded = decodeMessageQueueEntrySnapshot(entry);
    if (decoded.state !== 'retracted') {
      throw invalidProtocolFrame('Invalid retracted message state');
    }
    return decoded;
  });
  assertUniqueQueueEntries(entries, 'retracted messages');
  return entries;
}

function decodeMessageQueueEntrySnapshot(value: unknown): MessageQueueEntrySnapshot {
  const record = requireExactRecord(value, 'message queue entry snapshot', [
    'entryId',
    'messageId',
    'text',
    'placement',
    'state',
  ]);
  const base = {
    entryId: requireEntityId(record.entryId, 'entryId'),
    messageId: requireEntityId(record.messageId, 'messageId'),
    text: requireUtf8BoundedString(record.text, 'queue message text', TURN_MESSAGE_TEXT_MAX_BYTES),
    placement: requireMessagePlacement(record.placement),
  };
  if (record.state === 'queued' || record.state === 'retracted') {
    return { ...base, state: record.state };
  }
  if (record.state === 'in_flight' && base.placement === 'current_turn') {
    return { ...base, placement: 'current_turn', state: record.state };
  }
  throw invalidProtocolFrame('Invalid message queue entry state');
}

function requireMessagePlacement(value: unknown): MessagePlacement {
  if (value === 'current_turn' || value === 'next_turn') return value;
  throw invalidProtocolFrame('Invalid message placement');
}

function requireBoundedArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MESSAGE_QUEUE_MAX_ENTRIES) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function assertUniqueQueueEntries(
  entries: readonly MessageQueueEntrySnapshot[],
  label: string,
): void {
  const entryIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.entryId) || messageIds.has(entry.messageId)) {
      throw invalidProtocolFrame(`${label} repeats a message identity`);
    }
    entryIds.add(entry.entryId);
    messageIds.add(entry.messageId);
  }
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
