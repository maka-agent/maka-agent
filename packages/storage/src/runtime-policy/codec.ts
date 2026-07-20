import type { EntityId, Revision } from '@maka/core/runtime-policy';
import { codecError, type CodecSource } from './errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function record(
  value: unknown,
  context: string,
  source: CodecSource,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw codecError(source, `${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw codecError(source, `${context} must be a plain object`);
  }
  const candidate = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(candidate)) {
    if (!allowedSet.has(key))
      throw codecError(source, `${context} contains unknown field '${key}'`);
  }
  for (const key of required) {
    if (!Object.hasOwn(candidate, key)) throw codecError(source, `${context} is missing '${key}'`);
  }
  return candidate;
}

export function revision(value: unknown, context: string, source: CodecSource): Revision {
  return integer(value, context, 0, Number.MAX_SAFE_INTEGER, source);
}

export function positiveRevision(value: unknown, context: string, source: CodecSource): Revision {
  return integer(value, context, 1, Number.MAX_SAFE_INTEGER, source);
}

export function integer(
  value: unknown,
  context: string,
  min: number,
  max: number,
  source: CodecSource,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw codecError(source, `${context} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

export function boolean(value: unknown, context: string, source: CodecSource): boolean {
  if (typeof value !== 'boolean') throw codecError(source, `${context} must be a boolean`);
  return value;
}

export function string(
  value: unknown,
  context: string,
  maxLength: number,
  source: CodecSource,
): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw codecError(source, `${context} must be a string no longer than ${maxLength} characters`);
  }
  return value;
}

export function nonEmptyString(
  value: unknown,
  context: string,
  maxLength: number,
  source: CodecSource,
): string {
  const parsed = string(value, context, maxLength, source);
  if (parsed.length === 0) throw codecError(source, `${context} must not be empty`);
  return parsed;
}

export function optionalString(
  value: unknown,
  context: string,
  maxLength: number,
  source: CodecSource,
): string | undefined {
  return value === undefined ? undefined : string(value, context, maxLength, source);
}

export function stringArray(
  value: unknown,
  context: string,
  maxEntries: number,
  source: CodecSource,
): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw codecError(source, `${context} must be a bounded string array`);
  }
  const parsed = value.map((item, index) =>
    nonEmptyString(item, `${context}[${index}]`, 512, source),
  );
  unique(parsed, context, source);
  return parsed;
}

export function entityId(value: unknown, context: string, source: CodecSource): EntityId {
  const parsed = nonEmptyString(value, context, 64, source);
  if (!UUID_PATTERN.test(parsed)) throw codecError(source, `${context} must be a UUID`);
  return parsed;
}

export function unique(values: readonly string[], context: string, source: CodecSource): void {
  if (new Set(values).size !== values.length) {
    throw codecError(source, `${context} values must be unique`);
  }
}

export function nextRevision(value: Revision): Revision {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw codecError('invalid_document', 'Revision space is exhausted');
  }
  return value + 1;
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
