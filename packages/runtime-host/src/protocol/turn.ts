import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import {
  decodeMessageContent as decodeCanonicalMessageContent,
  type MessageContent,
} from '@maka/core/events';
import { invalidProtocolFrame } from './errors.js';
import {
  assertExactKeys,
  requireEntityId,
  requireId,
  requireRecord,
  requireString,
  requireUtf8BoundedString,
} from './codec.js';
import { defineOperation } from './operation-spec.js';

export type { MessageContent };

export interface TurnStartInput {
  sessionId: string;
  turnId: string;
  content: MessageContent;
}

export const TURN_MESSAGE_TEXT_MAX_BYTES = 48 * 1024;
export const TURN_MESSAGE_CONTENT_MAX_BYTES = 52 * 1024;
const ATTACHMENT_NAME_MAX_BYTES = 512;
const ATTACHMENT_MIME_TYPE_MAX_BYTES = 256;
const ATTACHMENT_PATH_MAX_BYTES = 4096;

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
    decodeInput: decodeTurnStartInput,
    decodeOutput: decodeTurnSnapshot,
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
    retry: 'semantic',
    admission: 'session',
  }),
  'turn.query': defineOperation({
    mode: 'query',
    decodeInput: decodeTurnQueryInput,
    decodeOutput: decodeTurnSnapshot,
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
  'turn.stop': defineOperation({
    mode: 'control',
    decodeInput: decodeTurnStopInput,
    decodeOutput: decodeTurnSnapshot,
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'operation_conflict',
      'internal_failure',
    ] as const,
    retry: 'semantic',
    admission: 'session',
  }),
} as const;

function decodeTurnStartInput(value: unknown): TurnStartInput {
  const record = requireExactTurnInput(value, 'turn.start input', [
    'sessionId',
    'turnId',
    'content',
  ]);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    content: decodeMessageContent(record.content),
  };
}

export function decodeMessageContent(value: unknown): MessageContent {
  let content: MessageContent;
  try {
    content = decodeCanonicalMessageContent(value);
  } catch {
    throw invalidProtocolFrame('Invalid Message content');
  }
  requireUtf8BoundedString(content.text, 'Message text', TURN_MESSAGE_TEXT_MAX_BYTES);
  if (content.displayText !== undefined) {
    requireUtf8ByteBoundedString(
      content.displayText,
      'Message displayText',
      TURN_MESSAGE_TEXT_MAX_BYTES,
    );
  }
  if ((content.attachments?.length ?? 0) > MAX_ATTACHMENT_COUNT) {
    throw invalidProtocolFrame('Invalid Message attachments');
  }
  for (const attachment of content.attachments ?? []) {
    requireUtf8BoundedString(attachment.name, 'AttachmentRef name', ATTACHMENT_NAME_MAX_BYTES);
    requireUtf8BoundedString(
      attachment.mimeType,
      'AttachmentRef mimeType',
      ATTACHMENT_MIME_TYPE_MAX_BYTES,
    );
    if (attachment.bytes > MAX_ATTACHMENT_BYTES) {
      throw invalidProtocolFrame('Invalid AttachmentRef bytes');
    }
    if (attachment.ref.kind === 'session_file') {
      requireEntityId(attachment.ref.sessionId, 'AttachmentRef sessionId');
    }
    const path =
      attachment.ref.kind === 'external_file'
        ? attachment.ref.absolutePath
        : attachment.ref.relativePath;
    requireUtf8BoundedString(path, 'AttachmentRef path', ATTACHMENT_PATH_MAX_BYTES);
  }
  requireEncodedByteLimit(content, 'Message content', TURN_MESSAGE_CONTENT_MAX_BYTES);
  return content;
}

function requireUtf8ByteBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
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

function decodeTurnQueryInput(value: unknown): TurnQueryInput {
  const record = requireExactTurnInput(value, 'turn.query input', ['sessionId', 'turnId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
  };
}

function decodeTurnStopInput(value: unknown): TurnStopInput {
  const record = requireExactTurnInput(value, 'turn.stop input', ['sessionId', 'turnId', 'runId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
}

export function decodeTurnSnapshot(value: unknown): TurnSnapshot {
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

function requireExactTurnInput(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  assertExactKeys(record, label, keys);
  return record;
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
