import {
  assertAllowedKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_MANAGEMENT_PAGE_DEFAULT_ITEMS = 32;
export const SESSION_MANAGEMENT_PAGE_MAX_ITEMS = 32;
export const SESSION_MANAGEMENT_RESULT_MAX_BYTES = 48 * 1024;
export const SESSION_MANAGEMENT_CURSOR_MAX_BYTES = 512;
export const SESSION_MANAGEMENT_CWD_MAX_BYTES = 4 * 1024;
export const SESSION_MANAGEMENT_NAME_MAX_BYTES = 256;
export const SESSION_MANAGEMENT_LABEL_MAX_ITEMS = 32;
export const SESSION_MANAGEMENT_LABEL_MAX_BYTES = 128;
export const SESSION_MANAGEMENT_PREVIEW_MAX_BYTES = 4 * 1024;
export const SESSION_MANAGEMENT_MODEL_MAX_BYTES = 512;
export const SESSION_MANAGEMENT_CONNECTION_SLUG_MAX_BYTES = 256;

const SESSION_STATUSES = [
  'active',
  'running',
  'waiting_for_user',
  'blocked',
  'review',
  'done',
  'archived',
  'aborted',
] as const;
const SESSION_BLOCKED_REASONS = [
  'NO_REAL_CONNECTION',
  'auth',
  'permission_required',
  'tool_failed',
  'unknown',
] as const;
const BACKENDS = ['ai-sdk', 'fake', 'pi-agent'] as const;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMISSION_MODES = ['explore', 'ask', 'execute', 'bypass'] as const;
const COLLABORATION_MODES = ['agent', 'plan'] as const;

const PROJECTION_REQUIRED_FIELDS = [
  'id',
  'cwd',
  'createdAt',
  'lastUsedAt',
  'name',
  'isFlagged',
  'isArchived',
  'labels',
  'hasUnread',
  'status',
  'backend',
  'llmConnectionSlug',
  'connectionLocked',
  'model',
  'permissionMode',
  'collaborationMode',
] as const;
const PROJECTION_FIELDS = [
  ...PROJECTION_REQUIRED_FIELDS,
  'pendingCwdReminder',
  'lastMessageAt',
  'lastMessagePreview',
  'blockedReason',
  'statusUpdatedAt',
  'parentSessionId',
  'branchOfTurnId',
  'thinkingLevel',
] as const;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'persistence_failed',
  'internal_failure',
] as const;
const CREATE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;
const MUTATE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'session_busy',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export type SessionManagementStatus = (typeof SESSION_STATUSES)[number];
export type SessionManagementBlockedReason = (typeof SESSION_BLOCKED_REASONS)[number];
export type SessionManagementBackend = (typeof BACKENDS)[number];
export type SessionManagementThinkingLevel = (typeof THINKING_LEVELS)[number];
export type SessionManagementPermissionMode = (typeof PERMISSION_MODES)[number];
export type SessionManagementCollaborationMode = (typeof COLLABORATION_MODES)[number];

export type SessionManagementModelTarget =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'explicit';
      readonly connectionSlug: string;
      readonly model: string;
    };

export interface SessionManagementFilter {
  readonly isArchived?: boolean;
  readonly isFlagged?: boolean;
  readonly labelSlug?: string;
}

export type SessionManagementQueryInput =
  | {
      readonly kind: 'list';
      readonly filter?: SessionManagementFilter;
      readonly cursor?: string;
    }
  | { readonly kind: 'get'; readonly sessionId: string };

export interface SessionManagementCreateInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly name?: string;
  readonly labels?: readonly string[];
  readonly modelTarget: SessionManagementModelTarget;
  readonly thinkingLevel?: SessionManagementThinkingLevel;
  readonly permissionMode?: SessionManagementPermissionMode;
  readonly collaborationMode?: SessionManagementCollaborationMode;
}

export type SessionManagementMutation =
  | {
      readonly kind: 'rename';
      readonly sessionId: string;
      readonly name: string;
    }
  | {
      readonly kind: 'set_flagged';
      readonly sessionId: string;
      readonly isFlagged: boolean;
    }
  | {
      readonly kind: 'mark_read';
      readonly sessionId: string;
      readonly readThroughTs: number;
    }
  | {
      readonly kind: 'set_permission_mode';
      readonly sessionId: string;
      readonly permissionMode: SessionManagementPermissionMode;
    }
  | {
      readonly kind: 'set_collaboration_mode';
      readonly sessionId: string;
      readonly collaborationMode: SessionManagementCollaborationMode;
    }
  | {
      readonly kind: 'set_model';
      readonly sessionId: string;
      readonly modelTarget: Extract<SessionManagementModelTarget, { kind: 'explicit' }>;
      /** Omission explicitly clears the current override. */
      readonly thinkingLevel?: SessionManagementThinkingLevel;
    }
  | {
      readonly kind: 'set_thinking_level';
      readonly sessionId: string;
      readonly thinkingLevel: SessionManagementThinkingLevel | null;
    }
  | {
      readonly kind: 'move_cwd';
      readonly sessionId: string;
      readonly cwd: string;
    }
  | { readonly kind: 'archive'; readonly sessionId: string }
  | { readonly kind: 'unarchive'; readonly sessionId: string }
  | { readonly kind: 'remove'; readonly sessionId: string };

export type SessionManagementMutateInput = SessionManagementMutation;

export interface SessionManagementProjection {
  readonly id: string;
  readonly cwd: string;
  readonly pendingCwdReminder?: { readonly from: string; readonly to: string };
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly name: string;
  readonly isFlagged: boolean;
  readonly isArchived: boolean;
  readonly labels: readonly string[];
  readonly hasUnread: boolean;
  readonly lastMessageAt?: number;
  readonly lastMessagePreview?: string;
  readonly status: SessionManagementStatus;
  readonly blockedReason?: SessionManagementBlockedReason;
  readonly statusUpdatedAt?: number;
  readonly parentSessionId?: string;
  readonly branchOfTurnId?: string;
  readonly backend: SessionManagementBackend;
  readonly llmConnectionSlug: string;
  readonly connectionLocked: boolean;
  readonly model: string;
  readonly thinkingLevel?: SessionManagementThinkingLevel;
  readonly permissionMode: SessionManagementPermissionMode;
  readonly collaborationMode: SessionManagementCollaborationMode;
}

export type SessionManagementQueryResult =
  | {
      readonly kind: 'page';
      readonly items: readonly SessionManagementProjection[];
      readonly nextCursor?: string;
    }
  | { readonly kind: 'item'; readonly session: SessionManagementProjection };

export type SessionManagementCreateResult = SessionManagementProjection;

export type SessionManagementMutateResult =
  | { readonly kind: 'session'; readonly session: SessionManagementProjection }
  | { readonly kind: 'removed'; readonly sessionId: string };

export const SESSION_MANAGEMENT_OPERATION_SPECS = {
  'session.query': defineOperation<
    SessionManagementQueryInput,
    SessionManagementQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionManagementQueryInput,
    decodeOutput: decodeSessionManagementQueryResult,
  }),
  'session.create': defineOperation<
    SessionManagementCreateInput,
    SessionManagementCreateResult,
    (typeof CREATE_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'semantic',
    admission: 'ready',
    errors: CREATE_ERRORS,
    decodeInput: decodeSessionManagementCreateInput,
    decodeOutput: decodeSessionManagementCreateResult,
  }),
  'session.mutate': defineOperation<
    SessionManagementMutation,
    SessionManagementMutateResult,
    (typeof MUTATE_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'safe',
    admission: 'session',
    errors: MUTATE_ERRORS,
    decodeInput: decodeSessionManagementMutation,
    decodeOutput: decodeSessionManagementMutateResult,
  }),
} as const;

export function decodeSessionManagementQueryInput(value: unknown): SessionManagementQueryInput {
  const record = requireRecord(value, 'session query input');
  if (record.kind === 'get') {
    const input = requireExactRecord(record, 'session get input', ['kind', 'sessionId']);
    return { kind: 'get', sessionId: sessionId(input.sessionId) };
  }
  if (record.kind !== 'list') throw invalidProtocolFrame('Invalid session query kind');
  const input = optionalExactRecord(record, 'session list input', ['kind'], ['filter', 'cursor']);
  return {
    kind: 'list',
    ...(Object.hasOwn(input, 'filter') ? { filter: decodeFilter(input.filter) } : {}),
    ...(Object.hasOwn(input, 'cursor') ? { cursor: sessionCursor(input.cursor) } : {}),
  };
}

export function decodeSessionManagementCreateInput(value: unknown): SessionManagementCreateInput {
  const input = optionalExactRecord(
    value,
    'session create input',
    ['sessionId', 'cwd', 'modelTarget'],
    ['name', 'labels', 'thinkingLevel', 'permissionMode', 'collaborationMode'],
  );
  return {
    sessionId: sessionId(input.sessionId),
    cwd: cwd(input.cwd, 'session cwd'),
    ...(Object.hasOwn(input, 'name') ? { name: sessionName(input.name) } : {}),
    ...(Object.hasOwn(input, 'labels') ? { labels: decodeLabels(input.labels) } : {}),
    modelTarget: decodeModelTarget(input.modelTarget, true),
    ...(Object.hasOwn(input, 'thinkingLevel')
      ? { thinkingLevel: thinkingLevel(input.thinkingLevel) }
      : {}),
    ...(Object.hasOwn(input, 'permissionMode')
      ? { permissionMode: permissionMode(input.permissionMode) }
      : {}),
    ...(Object.hasOwn(input, 'collaborationMode')
      ? { collaborationMode: collaborationMode(input.collaborationMode) }
      : {}),
  };
}

export function decodeSessionManagementMutation(value: unknown): SessionManagementMutation {
  const record = requireRecord(value, 'session mutation');
  switch (record.kind) {
    case 'rename': {
      const input = requireExactRecord(record, 'session rename mutation', [
        'kind',
        'sessionId',
        'name',
      ]);
      return {
        kind: 'rename',
        sessionId: sessionId(input.sessionId),
        name: sessionName(input.name),
      };
    }
    case 'set_flagged': {
      const input = requireExactRecord(record, 'session flagged mutation', [
        'kind',
        'sessionId',
        'isFlagged',
      ]);
      return {
        kind: 'set_flagged',
        sessionId: sessionId(input.sessionId),
        isFlagged: boolean(input.isFlagged, 'session isFlagged'),
      };
    }
    case 'mark_read': {
      const input = requireExactRecord(record, 'session mark read mutation', [
        'kind',
        'sessionId',
        'readThroughTs',
      ]);
      return {
        kind: 'mark_read',
        sessionId: sessionId(input.sessionId),
        readThroughTs: timestamp(input.readThroughTs, 'session readThroughTs'),
      };
    }
    case 'set_permission_mode': {
      const input = requireExactRecord(record, 'session permission mutation', [
        'kind',
        'sessionId',
        'permissionMode',
      ]);
      return {
        kind: 'set_permission_mode',
        sessionId: sessionId(input.sessionId),
        permissionMode: permissionMode(input.permissionMode),
      };
    }
    case 'set_collaboration_mode': {
      const input = requireExactRecord(record, 'session collaboration mutation', [
        'kind',
        'sessionId',
        'collaborationMode',
      ]);
      return {
        kind: 'set_collaboration_mode',
        sessionId: sessionId(input.sessionId),
        collaborationMode: collaborationMode(input.collaborationMode),
      };
    }
    case 'set_model': {
      const input = optionalExactRecord(
        record,
        'session model mutation',
        ['kind', 'sessionId', 'modelTarget'],
        ['thinkingLevel'],
      );
      return {
        kind: 'set_model',
        sessionId: sessionId(input.sessionId),
        modelTarget: decodeModelTarget(input.modelTarget, false),
        ...(Object.hasOwn(input, 'thinkingLevel')
          ? { thinkingLevel: thinkingLevel(input.thinkingLevel) }
          : {}),
      };
    }
    case 'set_thinking_level': {
      const input = requireExactRecord(record, 'session thinking mutation', [
        'kind',
        'sessionId',
        'thinkingLevel',
      ]);
      return {
        kind: 'set_thinking_level',
        sessionId: sessionId(input.sessionId),
        thinkingLevel: input.thinkingLevel === null ? null : thinkingLevel(input.thinkingLevel),
      };
    }
    case 'move_cwd': {
      const input = requireExactRecord(record, 'session cwd mutation', [
        'kind',
        'sessionId',
        'cwd',
      ]);
      return {
        kind: 'move_cwd',
        sessionId: sessionId(input.sessionId),
        cwd: cwd(input.cwd, 'session cwd'),
      };
    }
    case 'archive':
    case 'unarchive':
    case 'remove': {
      const input = requireExactRecord(record, `session ${record.kind} mutation`, [
        'kind',
        'sessionId',
      ]);
      return { kind: record.kind, sessionId: sessionId(input.sessionId) };
    }
    default:
      throw invalidProtocolFrame('Invalid session mutation kind');
  }
}

export const decodeSessionManagementMutateInput = decodeSessionManagementMutation;

export function decodeSessionManagementQueryResult(value: unknown): SessionManagementQueryResult {
  const record = requireRecord(value, 'session query result');
  if (record.kind === 'item') {
    const result = requireExactRecord(record, 'session item result', ['kind', 'session']);
    return boundedResult({
      kind: 'item',
      session: decodeSessionManagementProjection(result.session),
    });
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid session query result kind');
  const page = optionalExactRecord(
    record,
    'session page result',
    ['kind', 'items'],
    ['nextCursor'],
  );
  if (!Array.isArray(page.items) || page.items.length > SESSION_MANAGEMENT_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Session page exceeds item limit');
  }
  return boundedResult({
    kind: 'page',
    items: page.items.map(decodeSessionManagementProjection),
    ...(Object.hasOwn(page, 'nextCursor') ? { nextCursor: sessionCursor(page.nextCursor) } : {}),
  });
}

export function encodeSessionManagementQueryResult(value: unknown): SessionManagementQueryResult {
  return decodeSessionManagementQueryResult(value);
}

export function decodeSessionManagementCreateResult(value: unknown): SessionManagementCreateResult {
  return boundedResult(decodeSessionManagementProjection(value));
}

export function encodeSessionManagementCreateResult(value: unknown): SessionManagementCreateResult {
  return decodeSessionManagementCreateResult(value);
}

export function decodeSessionManagementMutateResult(value: unknown): SessionManagementMutateResult {
  const record = requireRecord(value, 'session mutate result');
  if (record.kind === 'removed') {
    const result = requireExactRecord(record, 'session removed result', ['kind', 'sessionId']);
    return boundedResult({
      kind: 'removed',
      sessionId: sessionId(result.sessionId),
    });
  }
  if (record.kind !== 'session') throw invalidProtocolFrame('Invalid session mutate result kind');
  const result = requireExactRecord(record, 'session mutation result', ['kind', 'session']);
  return boundedResult({
    kind: 'session',
    session: decodeSessionManagementProjection(result.session),
  });
}

export function encodeSessionManagementMutateResult(value: unknown): SessionManagementMutateResult {
  return decodeSessionManagementMutateResult(value);
}

export function decodeSessionManagementProjection(value: unknown): SessionManagementProjection {
  const record = optionalExactRecord(
    value,
    'session management projection',
    PROJECTION_REQUIRED_FIELDS,
    PROJECTION_FIELDS.filter(
      (
        field,
      ): field is Exclude<
        (typeof PROJECTION_FIELDS)[number],
        (typeof PROJECTION_REQUIRED_FIELDS)[number]
      > => !(PROJECTION_REQUIRED_FIELDS as readonly string[]).includes(field),
    ),
  );
  return {
    id: sessionId(record.id),
    cwd: cwd(record.cwd, 'session cwd'),
    ...(Object.hasOwn(record, 'pendingCwdReminder')
      ? { pendingCwdReminder: decodeCwdReminder(record.pendingCwdReminder) }
      : {}),
    createdAt: timestamp(record.createdAt, 'session createdAt'),
    lastUsedAt: timestamp(record.lastUsedAt, 'session lastUsedAt'),
    name: sessionName(record.name),
    isFlagged: boolean(record.isFlagged, 'session isFlagged'),
    isArchived: boolean(record.isArchived, 'session isArchived'),
    labels: decodeLabels(record.labels),
    hasUnread: boolean(record.hasUnread, 'session hasUnread'),
    ...(Object.hasOwn(record, 'lastMessageAt')
      ? {
          lastMessageAt: timestamp(record.lastMessageAt, 'session lastMessageAt'),
        }
      : {}),
    ...(Object.hasOwn(record, 'lastMessagePreview')
      ? {
          lastMessagePreview: requireUtf8BoundedString(
            record.lastMessagePreview,
            'session lastMessagePreview',
            SESSION_MANAGEMENT_PREVIEW_MAX_BYTES,
          ),
        }
      : {}),
    status: enumValue(record.status, 'session status', SESSION_STATUSES),
    ...(Object.hasOwn(record, 'blockedReason')
      ? {
          blockedReason: enumValue(
            record.blockedReason,
            'session blockedReason',
            SESSION_BLOCKED_REASONS,
          ),
        }
      : {}),
    ...(Object.hasOwn(record, 'statusUpdatedAt')
      ? {
          statusUpdatedAt: timestamp(record.statusUpdatedAt, 'session statusUpdatedAt'),
        }
      : {}),
    ...(Object.hasOwn(record, 'parentSessionId')
      ? { parentSessionId: sessionId(record.parentSessionId) }
      : {}),
    ...(Object.hasOwn(record, 'branchOfTurnId')
      ? {
          branchOfTurnId: requireEntityId(record.branchOfTurnId, 'branchOfTurnId'),
        }
      : {}),
    backend: enumValue(record.backend, 'session backend', BACKENDS),
    llmConnectionSlug: connectionSlug(record.llmConnectionSlug),
    connectionLocked: boolean(record.connectionLocked, 'session connectionLocked'),
    model: model(record.model),
    ...(Object.hasOwn(record, 'thinkingLevel')
      ? { thinkingLevel: thinkingLevel(record.thinkingLevel) }
      : {}),
    permissionMode: permissionMode(record.permissionMode),
    collaborationMode: collaborationMode(record.collaborationMode),
  };
}

function decodeFilter(value: unknown): SessionManagementFilter {
  const filter = optionalExactRecord(
    value,
    'session list filter',
    [],
    ['isArchived', 'isFlagged', 'labelSlug'],
  );
  return {
    ...(Object.hasOwn(filter, 'isArchived')
      ? { isArchived: boolean(filter.isArchived, 'session filter isArchived') }
      : {}),
    ...(Object.hasOwn(filter, 'isFlagged')
      ? { isFlagged: boolean(filter.isFlagged, 'session filter isFlagged') }
      : {}),
    ...(Object.hasOwn(filter, 'labelSlug')
      ? { labelSlug: label(filter.labelSlug, 'session filter labelSlug') }
      : {}),
  };
}

function decodeModelTarget(value: unknown, allowDefault: true): SessionManagementModelTarget;
function decodeModelTarget(
  value: unknown,
  allowDefault: false,
): Extract<SessionManagementModelTarget, { kind: 'explicit' }>;
function decodeModelTarget(value: unknown, allowDefault: boolean): SessionManagementModelTarget {
  const record = requireRecord(value, 'session model target');
  if (record.kind === 'default') {
    requireExactRecord(record, 'default session model target', ['kind']);
    if (!allowDefault)
      throw invalidProtocolFrame('Session model mutation requires explicit target');
    return { kind: 'default' };
  }
  if (record.kind !== 'explicit') throw invalidProtocolFrame('Invalid session model target kind');
  const target = requireExactRecord(record, 'explicit session model target', [
    'kind',
    'connectionSlug',
    'model',
  ]);
  return {
    kind: 'explicit',
    connectionSlug: connectionSlug(target.connectionSlug),
    model: model(target.model),
  };
}

function decodeLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > SESSION_MANAGEMENT_LABEL_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid session labels');
  }
  const labels = value.map((entry) => label(entry, 'session label'));
  if (new Set(labels).size !== labels.length) throw invalidProtocolFrame('Duplicate session label');
  return labels;
}

function decodeCwdReminder(value: unknown): {
  readonly from: string;
  readonly to: string;
} {
  const reminder = requireExactRecord(value, 'session pendingCwdReminder', ['from', 'to']);
  return {
    from: cwd(reminder.from, 'session pendingCwdReminder from'),
    to: cwd(reminder.to, 'session pendingCwdReminder to'),
  };
}

function optionalExactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  assertAllowedKeys(record, label, [...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
  return record;
}

function sessionId(value: unknown): string {
  return requireEntityId(value, 'sessionId');
}

function sessionCursor(value: unknown): string {
  return requireUtf8BoundedString(value, 'session cursor', SESSION_MANAGEMENT_CURSOR_MAX_BYTES);
}

function cwd(value: unknown, label: string): string {
  return requireUtf8BoundedString(value, label, SESSION_MANAGEMENT_CWD_MAX_BYTES);
}

function sessionName(value: unknown): string {
  return requireUtf8BoundedString(value, 'session name', SESSION_MANAGEMENT_NAME_MAX_BYTES);
}

function label(value: unknown, labelName: string): string {
  return requireUtf8BoundedString(value, labelName, SESSION_MANAGEMENT_LABEL_MAX_BYTES);
}

function connectionSlug(value: unknown): string {
  return requireUtf8BoundedString(
    value,
    'session connectionSlug',
    SESSION_MANAGEMENT_CONNECTION_SLUG_MAX_BYTES,
  );
}

function model(value: unknown): string {
  return requireUtf8BoundedString(value, 'session model', SESSION_MANAGEMENT_MODEL_MAX_BYTES);
}

function thinkingLevel(value: unknown): SessionManagementThinkingLevel {
  return enumValue(value, 'session thinkingLevel', THINKING_LEVELS);
}

function permissionMode(value: unknown): SessionManagementPermissionMode {
  return enumValue(value, 'session permissionMode', PERMISSION_MODES);
}

function collaborationMode(value: unknown): SessionManagementCollaborationMode {
  return enumValue(value, 'session collaborationMode', COLLABORATION_MODES);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as Values[number];
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  return requireCount(value, label);
}

function boundedResult<Value>(value: Value): Value {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > SESSION_MANAGEMENT_RESULT_MAX_BYTES) {
    throw invalidProtocolFrame('Session management result exceeds byte limit');
  }
  return value;
}
