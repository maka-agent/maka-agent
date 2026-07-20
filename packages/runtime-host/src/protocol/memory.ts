import { LOCAL_MEMORY_MAX_BYTES } from '@maka/core/local-memory';
import { TextDecoder } from 'node:util';
import {
  assertAllowedKeys,
  requireExactRecord,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const MEMORY_TITLE_MAX_BYTES = 512;
export const MEMORY_ENTRY_CONTENT_MAX_BYTES = 8 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'internal_failure',
  'invalid_request',
  'persistence_failed',
] as const;
const MUTATION_ERRORS = [...QUERY_ERRORS, 'commit_outcome_unknown'] as const;

export type MemoryRevision = `sha256:${string}`;
export type MemoryExpectedRevision = MemoryRevision | null;
export type MemoryScope = 'workspace' | 'session';
export type MemoryEntryStatus = 'active' | 'archived';
export type MemoryBlockedReason = 'disabled' | 'incognito_active';
export type MemorySafeModeReason = 'empty' | 'invalid_utf8' | 'oversize';

export type MemoryQueryInput = Record<string, never>;

export type MemoryQueryResult =
  | { readonly kind: 'blocked'; readonly reason: MemoryBlockedReason }
  | { readonly kind: 'missing'; readonly revision: null }
  | {
      readonly kind: 'safe_mode';
      readonly revision: MemoryRevision;
      readonly reason: MemorySafeModeReason;
    }
  | {
      readonly kind: 'document';
      readonly revision: MemoryRevision;
      readonly contentBase64: string;
    };

export type MemoryMutation =
  | { readonly kind: 'save'; readonly contentBase64: string }
  | {
      readonly kind: 'propose';
      readonly title: string;
      readonly content: string;
      readonly scope: MemoryScope;
      readonly sourceTurnId?: string;
    }
  | {
      readonly kind: 'remember';
      readonly title: string;
      readonly content: string;
      readonly scope: MemoryScope;
    }
  | { readonly kind: 'approve'; readonly entryId: string }
  | { readonly kind: 'reject'; readonly entryId: string }
  | {
      readonly kind: 'set_status';
      readonly entryId: string;
      readonly target: MemoryEntryStatus;
    };

export interface MemoryMutateInput {
  readonly expectedRevision: MemoryExpectedRevision;
  readonly mutation: MemoryMutation;
}

export type MemoryMutationRejectedReason =
  | MemoryBlockedReason
  | 'empty_title'
  | 'invalid_content'
  | 'invalid_id'
  | 'invalid_document'
  | 'not_found'
  | 'not_pending'
  | 'invalid_transition'
  | 'document_too_large';

export type MemoryMutateResult =
  | { readonly kind: 'committed' | 'unchanged'; readonly revision: MemoryRevision }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: MemoryExpectedRevision;
      readonly actualRevision: MemoryExpectedRevision;
    }
  | { readonly kind: 'rejected'; readonly reason: MemoryMutationRejectedReason };

export const MEMORY_OPERATION_SPECS = {
  'memory.query': defineOperation<
    MemoryQueryInput,
    MemoryQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeMemoryQueryInput,
    decodeOutput: decodeMemoryQueryResult,
  }),
  'memory.mutate': defineOperation<
    MemoryMutateInput,
    MemoryMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'none',
    admission: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeMemoryMutateInput,
    decodeOutput: decodeMemoryMutateResult,
  }),
} as const;

export function decodeMemoryQueryInput(value: unknown): MemoryQueryInput {
  requireExactRecord(value, 'memory query input', []);
  return {};
}

export function decodeMemoryQueryResult(value: unknown): MemoryQueryResult {
  const result = requireRecord(value, 'memory query result');
  if (result.kind === 'blocked') {
    const blocked = requireExactRecord(result, 'memory blocked result', ['kind', 'reason']);
    return { kind: 'blocked', reason: blockedReason(blocked.reason) };
  }
  if (result.kind === 'missing') {
    const missing = requireExactRecord(result, 'memory missing result', ['kind', 'revision']);
    if (missing.revision !== null) throw invalidProtocolFrame('Invalid missing memory revision');
    return { kind: 'missing', revision: null };
  }
  if (result.kind === 'safe_mode') {
    const safeMode = requireExactRecord(result, 'memory safe mode result', [
      'kind',
      'revision',
      'reason',
    ]);
    return {
      kind: 'safe_mode',
      revision: memoryRevision(safeMode.revision, 'memory revision'),
      reason: safeModeReason(safeMode.reason),
    };
  }
  if (result.kind === 'document') {
    const document = requireExactRecord(result, 'memory document result', [
      'kind',
      'revision',
      'contentBase64',
    ]);
    return {
      kind: 'document',
      revision: memoryRevision(document.revision, 'memory revision'),
      contentBase64: memoryDocumentBase64(document.contentBase64),
    };
  }
  throw invalidProtocolFrame('Invalid memory query result kind');
}

export const encodeMemoryQueryResult = decodeMemoryQueryResult;

export function decodeMemoryMutateInput(value: unknown): MemoryMutateInput {
  const input = requireExactRecord(value, 'memory mutate input', ['expectedRevision', 'mutation']);
  return {
    expectedRevision: expectedRevision(input.expectedRevision, 'expected memory revision'),
    mutation: decodeMemoryMutation(input.mutation),
  };
}

export function decodeMemoryMutateResult(value: unknown): MemoryMutateResult {
  const result = requireRecord(value, 'memory mutate result');
  if (result.kind === 'committed' || result.kind === 'unchanged') {
    const outcome = requireExactRecord(result, 'memory mutation outcome', ['kind', 'revision']);
    return {
      kind: result.kind,
      revision: memoryRevision(outcome.revision, 'memory revision'),
    };
  }
  if (result.kind === 'revision_conflict') {
    const conflict = requireExactRecord(result, 'memory revision conflict', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    return {
      kind: 'revision_conflict',
      expectedRevision: expectedRevision(conflict.expectedRevision, 'expected memory revision'),
      actualRevision: expectedRevision(conflict.actualRevision, 'actual memory revision'),
    };
  }
  if (result.kind === 'rejected') {
    const rejected = requireExactRecord(result, 'memory mutation rejected result', [
      'kind',
      'reason',
    ]);
    return { kind: 'rejected', reason: mutationRejectedReason(rejected.reason) };
  }
  throw invalidProtocolFrame('Invalid memory mutate result kind');
}

export const encodeMemoryMutateResult = decodeMemoryMutateResult;

function decodeMemoryMutation(value: unknown): MemoryMutation {
  const mutation = requireRecord(value, 'memory mutation');
  if (mutation.kind === 'save') {
    const save = requireExactRecord(mutation, 'memory save mutation', ['kind', 'contentBase64']);
    return { kind: 'save', contentBase64: memoryDocumentBase64(save.contentBase64) };
  }
  if (mutation.kind === 'propose') {
    assertAllowedKeys(mutation, 'memory propose mutation', [
      'kind',
      'title',
      'content',
      'scope',
      'sourceTurnId',
    ]);
    requireFields(mutation, 'memory propose mutation', ['kind', 'title', 'content', 'scope']);
    return {
      kind: 'propose',
      title: boundedText(mutation.title, 'memory proposal title', MEMORY_TITLE_MAX_BYTES),
      content: boundedText(
        mutation.content,
        'memory proposal content',
        MEMORY_ENTRY_CONTENT_MAX_BYTES,
      ),
      scope: memoryScope(mutation.scope),
      ...(mutation.sourceTurnId === undefined
        ? {}
        : {
            sourceTurnId: requireUtf8BoundedString(mutation.sourceTurnId, 'sourceTurnId', 128),
          }),
    };
  }
  if (mutation.kind === 'remember') {
    const remember = requireExactRecord(mutation, 'memory remember mutation', [
      'kind',
      'title',
      'content',
      'scope',
    ]);
    return {
      kind: 'remember',
      title: boundedText(remember.title, 'memory title', MEMORY_TITLE_MAX_BYTES),
      content: boundedText(remember.content, 'memory content', MEMORY_ENTRY_CONTENT_MAX_BYTES),
      scope: memoryScope(remember.scope),
    };
  }
  if (mutation.kind === 'approve' || mutation.kind === 'reject') {
    const decision = requireExactRecord(mutation, `memory ${mutation.kind} mutation`, [
      'kind',
      'entryId',
    ]);
    return {
      kind: mutation.kind,
      entryId: memoryEntryId(decision.entryId),
    };
  }
  if (mutation.kind === 'set_status') {
    const status = requireExactRecord(mutation, 'memory set status mutation', [
      'kind',
      'entryId',
      'target',
    ]);
    return {
      kind: 'set_status',
      entryId: memoryEntryId(status.entryId),
      target: entryStatus(status.target),
    };
  }
  throw invalidProtocolFrame('Invalid memory mutation kind');
}

function memoryDocumentBase64(value: unknown): string {
  if (typeof value !== 'string' || !isCanonicalBase64(value)) {
    throw invalidProtocolFrame('Invalid memory document base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw invalidProtocolFrame('Invalid memory document base64');
  }
  if (bytes.byteLength > LOCAL_MEMORY_MAX_BYTES) {
    throw invalidProtocolFrame('Memory document exceeds byte limit');
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidProtocolFrame('Memory document is not valid UTF-8');
  }
  return value;
}

function isCanonicalBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function memoryRevision(value: unknown, label: string): MemoryRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as MemoryRevision;
}

function expectedRevision(value: unknown, label: string): MemoryExpectedRevision {
  return value === null ? null : memoryRevision(value, label);
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  return requireUtf8BoundedString(value, label, maxBytes);
}

function memoryEntryId(value: unknown): string {
  return requireUtf8BoundedString(value, 'memory entry id', LOCAL_MEMORY_MAX_BYTES);
}

function memoryScope(value: unknown): MemoryScope {
  if (value === 'workspace' || value === 'session') return value;
  throw invalidProtocolFrame('Invalid memory scope');
}

function entryStatus(value: unknown): MemoryEntryStatus {
  if (value === 'active' || value === 'archived') return value;
  throw invalidProtocolFrame('Invalid memory target status');
}

function blockedReason(value: unknown): MemoryBlockedReason {
  if (value === 'disabled' || value === 'incognito_active') return value;
  throw invalidProtocolFrame('Invalid memory blocked reason');
}

function safeModeReason(value: unknown): MemorySafeModeReason {
  if (value === 'empty' || value === 'invalid_utf8' || value === 'oversize') return value;
  throw invalidProtocolFrame('Invalid memory safe mode reason');
}

function mutationRejectedReason(value: unknown): MemoryMutationRejectedReason {
  if (
    value === 'disabled' ||
    value === 'incognito_active' ||
    value === 'empty_title' ||
    value === 'invalid_content' ||
    value === 'invalid_id' ||
    value === 'invalid_document' ||
    value === 'not_found' ||
    value === 'not_pending' ||
    value === 'invalid_transition' ||
    value === 'document_too_large'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid memory mutation rejected reason');
}

function requireFields(
  value: Record<string, unknown>,
  label: string,
  fields: readonly string[],
): void {
  if (fields.some((field) => !Object.hasOwn(value, field))) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
}
