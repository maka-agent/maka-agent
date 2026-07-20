import {
  decodeInteractionCanonicalOutcome as decodeCoreInteractionCanonicalOutcome,
  decodeInteractionRequest as decodeCoreInteractionRequest,
  isInteractionCanonicalOutcomeValidForRequest,
  type InteractionCanonicalOutcome,
  type InteractionRequest,
} from '@maka/core';
import type {
  InteractionIdentity,
  PendingInteractionFilter,
  StoredInteractionOutcome,
  StoredInteractionRequest,
} from '../interaction-store.js';
import { invalidInput, invalidRecord } from './errors.js';

export const INTERACTION_REQUEST_MAX_BYTES = 16 * 1024;
export const INTERACTION_OUTCOME_MAX_BYTES = 16 * 1024;

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REMEMBER_SCOPE_ID_PATTERN = /^[0-9a-f]{64}$/;

type CodecSource = 'input' | 'record';

export function decodeStoredInteractionRequest(
  value: unknown,
  source: CodecSource,
  expectedRequestId?: string,
): StoredInteractionRequest {
  const item = exactRecord(
    value,
    'Stored Interaction request',
    ['sessionId', 'turnId', 'runId', 'requestId', 'createdAt', 'request'],
    ['rememberScopeId'],
    source,
  );
  const identity = decodeIdentity(item, 'Stored Interaction request', source);
  if (expectedRequestId !== undefined && identity.requestId !== expectedRequestId) {
    fail(source, 'Stored Interaction request identity does not match its locator');
  }
  const request = decodeCoreRequest(item.request, source);
  const rememberScopeId =
    item.rememberScopeId === undefined
      ? undefined
      : decodeRememberScopeId(item.rememberScopeId, source);
  if (rememberScopeId !== undefined && !isRememberScopeEligible(request)) {
    fail(source, 'rememberScopeId requires a rememberable tool permission request');
  }
  return {
    ...identity,
    createdAt: timestamp(item.createdAt, 'Stored Interaction request createdAt', source),
    request,
    ...(rememberScopeId === undefined ? {} : { rememberScopeId }),
  };
}

export function decodeInteractionOutcomeInput(
  value: unknown,
  request: StoredInteractionRequest,
): StoredInteractionOutcome {
  const outcome = decodeCoreOutcome(value, 'input');
  validateOutcomeForRequest(outcome, request, 'input');
  return {
    ...interactionIdentity(request),
    outcome,
  };
}

export function decodeStoredInteractionOutcome(
  value: unknown,
  request: StoredInteractionRequest,
): StoredInteractionOutcome {
  const item = exactRecord(
    value,
    'Stored Interaction outcome',
    ['sessionId', 'turnId', 'runId', 'requestId', 'outcome'],
    [],
    'record',
  );
  const identity = decodeIdentity(item, 'Stored Interaction outcome', 'record');
  assertSameIdentity(identity, request);
  const outcome = decodeCoreOutcome(item.outcome, 'record');
  validateOutcomeForRequest(outcome, request, 'record');
  return { ...identity, outcome };
}

export function decodePendingInteractionFilter(
  value: PendingInteractionFilter | undefined,
): PendingInteractionFilter {
  if (value === undefined) return {};
  const item = exactRecord(
    value,
    'Pending Interaction filter',
    [],
    ['sessionId', 'turnId', 'runId', 'kind'],
    'input',
  );
  const filter: {
    sessionId?: string;
    turnId?: string;
    runId?: string;
    kind?: InteractionRequest['kind'];
  } = {};
  for (const key of ['sessionId', 'turnId', 'runId'] as const) {
    if (item[key] !== undefined) {
      filter[key] = assertInteractionId(item[key], 'input', `Pending Interaction filter ${key}`);
    }
  }
  if (item.kind !== undefined) {
    if (item.kind !== 'permission' && item.kind !== 'question') {
      fail('input', 'Pending Interaction filter kind is invalid');
    }
    filter.kind = item.kind;
  }
  return filter;
}

export function encodeBoundedJson(value: unknown, maxBytes: number, context: string): Buffer {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value)}\n`;
  } catch (error) {
    throw invalidInput(`${context} is not JSON serializable`, error);
  }
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length > maxBytes) {
    throw invalidInput(`${context} exceeds its ${maxBytes} byte limit`);
  }
  return bytes;
}

export function assertInteractionId(
  value: unknown,
  source: CodecSource = 'input',
  context = 'Interaction identity',
): string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    fail(source, `${context} must match ${SAFE_ID_PATTERN.source}`);
  }
  return value;
}

function decodeIdentity(
  value: Record<string, unknown>,
  context: string,
  source: CodecSource,
): InteractionIdentity {
  return {
    sessionId: assertInteractionId(value.sessionId, source, `${context} sessionId`),
    turnId: assertInteractionId(value.turnId, source, `${context} turnId`),
    runId: assertInteractionId(value.runId, source, `${context} runId`),
    requestId: assertInteractionId(value.requestId, source, `${context} requestId`),
  };
}

function decodeCoreRequest(value: unknown, source: CodecSource): InteractionRequest {
  try {
    return decodeCoreInteractionRequest(value);
  } catch (error) {
    fail(source, 'Stored Interaction request contains an invalid Core request', error);
  }
}

function decodeCoreOutcome(value: unknown, source: CodecSource): InteractionCanonicalOutcome {
  try {
    return decodeCoreInteractionCanonicalOutcome(value);
  } catch (error) {
    fail(source, 'Stored Interaction outcome contains an invalid Core outcome', error);
  }
}

function validateOutcomeForRequest(
  outcome: InteractionCanonicalOutcome,
  request: StoredInteractionRequest,
  source: CodecSource,
): void {
  if (!isInteractionCanonicalOutcomeValidForRequest(request.request, outcome)) {
    fail(source, 'Interaction outcome is not valid for its request');
  }
}

function assertSameIdentity(actual: InteractionIdentity, expected: InteractionIdentity): void {
  if (
    actual.sessionId !== expected.sessionId ||
    actual.turnId !== expected.turnId ||
    actual.runId !== expected.runId ||
    actual.requestId !== expected.requestId
  ) {
    fail('record', 'Stored Interaction outcome identity does not match its request');
  }
}

function interactionIdentity(request: StoredInteractionRequest): InteractionIdentity {
  return {
    sessionId: request.sessionId,
    turnId: request.turnId,
    runId: request.runId,
    requestId: request.requestId,
  };
}

function isRememberScopeEligible(request: InteractionRequest): boolean {
  return (
    request.kind === 'permission' &&
    request.prompt.kind === 'tool_permission' &&
    request.prompt.rememberForTurnAllowed
  );
}

function decodeRememberScopeId(value: unknown, source: CodecSource): string {
  if (typeof value !== 'string' || !REMEMBER_SCOPE_ID_PATTERN.test(value)) {
    fail(source, 'rememberScopeId must be a lowercase 64-character SHA-256 digest');
  }
  return value;
}

function exactRecord(
  value: unknown,
  context: string,
  required: readonly string[],
  optional: readonly string[],
  source: CodecSource,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(source, `${context} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(source, `${context} must be a plain object`);
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(item);
  if (
    keys.some((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      return descriptor === undefined || !('value' in descriptor);
    }) ||
    required.some((key) => !Object.hasOwn(item, key))
  ) {
    fail(source, `${context} has invalid fields`);
  }
  return item;
}

function timestamp(value: unknown, context: string, source: CodecSource): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(source, `${context} must be a non-negative safe integer`);
  }
  return value as number;
}

function fail(source: CodecSource, message: string, cause?: unknown): never {
  throw source === 'input' ? invalidInput(message, cause) : invalidRecord(message, cause);
}
