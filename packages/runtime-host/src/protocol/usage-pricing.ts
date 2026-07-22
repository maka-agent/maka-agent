import { normalizePricingConfig, normalizePricingModelKey } from '@maka/core/usage-stats/pricing';
import type {
  PricingConfig,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import {
  assertAllowedKeys,
  requireCount,
  requireExactRecord,
  requirePositiveCount,
  requireRecord,
  requireUtf8BoundedString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const USAGE_PAGE_MAX_ITEMS = 100;
export const USAGE_PAGE_MAX_BYTES = 48 * 1024;
export const USAGE_PROJECTION_TEXT_MAX_BYTES = 1024;
export const PRICING_PAGE_MAX_ITEMS = 128;
export const PRICING_PAGE_MAX_BYTES = 48 * 1024;
export const PRICING_CURSOR_MAX_BYTES = 32;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'internal_failure',
] as const;
const MUTATION_ERRORS = [...QUERY_ERRORS, 'invalid_request', 'persistence_failed'] as const;
const PRICING_QUERY_ERRORS = [...QUERY_ERRORS, 'invalid_request'] as const;
const QUERY_FIELDS = [
  'range',
  'connectionSlug',
  'providerId',
  'modelId',
  'toolName',
  'status',
] as const;
const LOG_FIELDS = [
  'id',
  'ts',
  'callKind',
  'callId',
  'connectionSlug',
  'providerId',
  'modelId',
  'toolName',
  'inputTokens',
  'outputTokens',
  'cacheMissTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cacheMissInputSource',
  'reasoningTokens',
  'totalTokens',
  'costUsd',
  'latencyMs',
  'status',
  'errorClass',
  'sessionId',
  'turnId',
] as const;

export type UsageLogProjection = Pick<
  UsageLogRow,
  | 'id'
  | 'ts'
  | 'callKind'
  | 'callId'
  | 'connectionSlug'
  | 'providerId'
  | 'modelId'
  | 'toolName'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheMissTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'cacheMissInputSource'
  | 'reasoningTokens'
  | 'totalTokens'
  | 'costUsd'
  | 'latencyMs'
  | 'status'
  | 'errorClass'
  | 'sessionId'
  | 'turnId'
>;

export type UsageQueryInput =
  | { readonly kind: 'summary'; readonly query: UsageQuery }
  | {
      readonly kind: 'buckets';
      readonly query: UsageQuery;
      readonly groupBy: UsageGroupBy;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: 'logs';
      readonly query: UsageQuery;
      readonly offset?: number;
      readonly limit?: number;
    };

export type UsageQueryResult =
  | { readonly kind: 'summary'; readonly summary: UsageSummaryV2 }
  | {
      readonly kind: 'buckets';
      readonly buckets: readonly UsageBucket[];
      readonly total: number;
      readonly nextOffset: number | null;
    }
  | {
      readonly kind: 'logs';
      readonly rows: readonly UsageLogProjection[];
      readonly total: number;
      readonly nextOffset: number | null;
    };

export type PricingQueryInput =
  | { readonly kind: 'start' }
  | { readonly kind: 'continue'; readonly revision: number; readonly cursor: string };
export type PricingQueryResult =
  | {
      readonly kind: 'page';
      readonly revision: number;
      readonly overrides: readonly Readonly<PricingConfig>[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export type PricingMutation =
  | { readonly kind: 'upsert'; readonly pricing: PricingConfig }
  | { readonly kind: 'delete'; readonly modelKey: string };
export interface PricingMutateInput {
  readonly expectedRevision: number;
  readonly mutation: PricingMutation;
}
export type PricingMutateResult =
  | { readonly kind: 'committed' | 'unchanged'; readonly revision: number }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export const USAGE_PRICING_OPERATION_SPECS = {
  'usage.query': defineOperation<UsageQueryInput, UsageQueryResult, (typeof QUERY_ERRORS)[number]>({
    mode: 'query',
    retry: 'safe',
    admission: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeUsageQueryInput,
    decodeOutput: decodeUsageQueryResult,
  }),
  'pricing.query': defineOperation<
    PricingQueryInput,
    PricingQueryResult,
    (typeof PRICING_QUERY_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'ready',
    errors: PRICING_QUERY_ERRORS,
    decodeInput: decodePricingQueryInput,
    decodeOutput: decodePricingQueryResult,
  }),
  'pricing.mutate': defineOperation<
    PricingMutateInput,
    PricingMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'none',
    admission: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePricingMutateInput,
    decodeOutput: decodePricingMutateResult,
  }),
} as const;

export function decodeUsageQueryInput(value: unknown): UsageQueryInput {
  const input = requireRecord(value, 'usage query input');
  if (input.kind === 'summary') {
    const exact = requireExactRecord(input, 'usage summary input', ['kind', 'query']);
    return { kind: 'summary', query: decodeUsageQuery(exact.query) };
  }
  if (input.kind === 'buckets') {
    assertAllowedKeys(input, 'usage buckets input', [
      'kind',
      'query',
      'groupBy',
      'offset',
      'limit',
    ]);
    requireFields(input, 'usage buckets input', ['kind', 'query', 'groupBy']);
    return {
      kind: 'buckets',
      query: decodeUsageQuery(input.query),
      groupBy: usageGroupBy(input.groupBy),
      offset: optionalOffset(input.offset),
      limit: optionalLimit(input.limit),
    };
  }
  if (input.kind === 'logs') {
    assertAllowedKeys(input, 'usage logs input', ['kind', 'query', 'offset', 'limit']);
    requireFields(input, 'usage logs input', ['kind', 'query']);
    return {
      kind: 'logs',
      query: decodeUsageQuery(input.query),
      offset: optionalOffset(input.offset),
      limit: optionalLimit(input.limit),
    };
  }
  throw invalidProtocolFrame('Invalid usage query kind');
}

export function decodeUsageQueryResult(value: unknown): UsageQueryResult {
  const result = requireRecord(value, 'usage query result');
  if (result.kind === 'summary') {
    const exact = requireExactRecord(result, 'usage summary result', ['kind', 'summary']);
    return { kind: 'summary', summary: decodeUsageSummary(exact.summary) };
  }
  if (result.kind === 'buckets') {
    const exact = requireExactRecord(result, 'usage buckets result', [
      'kind',
      'buckets',
      'total',
      'nextOffset',
    ]);
    return decodeUsagePage('buckets', exact, decodeUsageBucket);
  }
  if (result.kind === 'logs') {
    const exact = requireExactRecord(result, 'usage logs result', [
      'kind',
      'rows',
      'total',
      'nextOffset',
    ]);
    return decodeUsagePage('logs', exact, decodeUsageLogRow);
  }
  throw invalidProtocolFrame('Invalid usage query result kind');
}

/** Validates producer output before it reaches the global frame encoder. */
export const encodeUsageQueryResult = decodeUsageQueryResult;

export function decodePricingQueryInput(value: unknown): PricingQueryInput {
  const input = requireRecord(value, 'pricing query input');
  if (input.kind === 'start') {
    requireExactRecord(input, 'pricing query start input', ['kind']);
    return { kind: 'start' };
  }
  if (input.kind === 'continue') {
    const continuation = requireExactRecord(input, 'pricing query continuation input', [
      'kind',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'continue',
      revision: requireCount(continuation.revision, 'pricing revision'),
      cursor: requireUtf8BoundedString(
        continuation.cursor,
        'pricing cursor',
        PRICING_CURSOR_MAX_BYTES,
      ),
    };
  }
  throw invalidProtocolFrame('Invalid pricing query kind');
}

export function decodePricingQueryResult(value: unknown): PricingQueryResult {
  const result = requireRecord(value, 'pricing query result');
  if (result.kind === 'revision_changed') {
    const changed = requireExactRecord(result, 'pricing revision changed result', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    return {
      kind: 'revision_changed',
      expectedRevision: requireCount(changed.expectedRevision, 'expectedRevision'),
      actualRevision: requireCount(changed.actualRevision, 'actualRevision'),
    };
  }
  if (result.kind !== 'page') throw invalidProtocolFrame('Invalid pricing query result kind');
  const page = requireExactRecord(result, 'pricing page result', [
    'kind',
    'revision',
    'overrides',
    'nextCursor',
  ]);
  const revision = requireCount(page.revision, 'pricing revision');
  if (!Array.isArray(page.overrides) || page.overrides.length > PRICING_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Pricing overrides exceed item limit');
  }
  const overrides = page.overrides.map((item) => decodePricingConfig(item, true));
  if (new Set(overrides.map((item) => item.modelKey)).size !== overrides.length) {
    throw invalidProtocolFrame('Pricing overrides contain duplicate model keys');
  }
  const decoded: PricingQueryResult = {
    kind: 'page',
    revision,
    overrides,
    nextCursor:
      page.nextCursor === null
        ? null
        : requireUtf8BoundedString(
            page.nextCursor,
            'pricing next cursor',
            PRICING_CURSOR_MAX_BYTES,
          ),
  };
  if (jsonBytes(decoded) > PRICING_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Pricing page exceeds byte limit');
  }
  return decoded;
}

/** Validates producer output before it reaches the global frame encoder. */
export const encodePricingQueryResult = decodePricingQueryResult;

export function decodePricingMutateInput(value: unknown): PricingMutateInput {
  const input = requireExactRecord(value, 'pricing mutation input', [
    'expectedRevision',
    'mutation',
  ]);
  const mutation = requireRecord(input.mutation, 'pricing mutation');
  if (mutation.kind === 'upsert') {
    const exact = requireExactRecord(mutation, 'pricing upsert mutation', ['kind', 'pricing']);
    return {
      expectedRevision: requireCount(input.expectedRevision, 'expectedRevision'),
      mutation: { kind: 'upsert', pricing: decodePricingConfig(exact.pricing, false) },
    };
  }
  if (mutation.kind === 'delete') {
    const exact = requireExactRecord(mutation, 'pricing delete mutation', ['kind', 'modelKey']);
    const normalized = normalizePricingModelKey(exact.modelKey);
    if (!normalized.ok) throw invalidProtocolFrame(`Invalid pricing mutation: ${normalized.error}`);
    return {
      expectedRevision: requireCount(input.expectedRevision, 'expectedRevision'),
      mutation: { kind: 'delete', modelKey: normalized.value },
    };
  }
  throw invalidProtocolFrame('Invalid pricing mutation kind');
}

export function decodePricingMutateResult(value: unknown): PricingMutateResult {
  const result = requireRecord(value, 'pricing mutation result');
  if (result.kind === 'committed' || result.kind === 'unchanged') {
    const exact = requireExactRecord(result, 'pricing mutation outcome', ['kind', 'revision']);
    return {
      kind: result.kind,
      revision: requireCount(exact.revision, 'pricing revision'),
    };
  }
  if (result.kind === 'revision_conflict') {
    const exact = requireExactRecord(result, 'pricing revision conflict', [
      'kind',
      'expectedRevision',
      'actualRevision',
    ]);
    return {
      kind: 'revision_conflict',
      expectedRevision: requireCount(exact.expectedRevision, 'expectedRevision'),
      actualRevision: requireCount(exact.actualRevision, 'actualRevision'),
    };
  }
  throw invalidProtocolFrame('Invalid pricing mutation result kind');
}

function decodeUsageQuery(value: unknown): UsageQuery {
  const query = requireRecord(value, 'usage query');
  assertAllowedKeys(query, 'usage query', QUERY_FIELDS);
  requireFields(query, 'usage query', ['range']);
  return {
    range: usageRange(query.range),
    ...optionalQueryString(query, 'connectionSlug'),
    ...optionalQueryString(query, 'providerId'),
    ...optionalQueryString(query, 'modelId'),
    ...optionalQueryString(query, 'toolName'),
    ...(query.status === undefined ? {} : { status: usageStatus(query.status) }),
  };
}

function usageRange(value: unknown): UsageQuery['range'] {
  if (value === '24h' || value === '7d' || value === '30d' || value === 'all') return value;
  const range = requireExactRecord(value, 'usage range', ['from', 'to']);
  const from = nonnegativeFinite(range.from, 'usage range from');
  const to = nonnegativeFinite(range.to, 'usage range to');
  if (from > to) throw invalidProtocolFrame('Invalid usage range');
  return { from, to };
}

function optionalQueryString<Field extends keyof UsageQuery>(
  query: Record<string, unknown>,
  field: Field,
): Partial<Pick<UsageQuery, Field>> {
  return query[field] === undefined
    ? {}
    : ({
        [field]: requireUtf8BoundedString(query[field], `usage query ${String(field)}`, 512),
      } as Partial<Pick<UsageQuery, Field>>);
}

function usageStatus(value: unknown): NonNullable<UsageQuery['status']> {
  if (value === 'success' || value === 'error' || value === 'aborted' || value === 'all') {
    return value;
  }
  throw invalidProtocolFrame('Invalid usage query status');
}

function usageGroupBy(value: unknown): UsageGroupBy {
  if (
    value === 'provider' ||
    value === 'model' ||
    value === 'tool' ||
    value === 'day' ||
    value === 'hour'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid usage groupBy');
}

function optionalOffset(value: unknown): number {
  return value === undefined ? 0 : requireCount(value, 'usage offset');
}

function optionalLimit(value: unknown): number {
  if (value === undefined) return USAGE_PAGE_MAX_ITEMS;
  const limit = requirePositiveCount(value, 'usage limit');
  if (limit > USAGE_PAGE_MAX_ITEMS) throw invalidProtocolFrame('Usage limit exceeds maximum');
  return limit;
}

function decodeUsagePage(
  kind: 'buckets',
  result: Record<string, unknown>,
  decodeItem: (value: unknown) => UsageBucket,
): Extract<UsageQueryResult, { kind: 'buckets' }>;
function decodeUsagePage(
  kind: 'logs',
  result: Record<string, unknown>,
  decodeItem: (value: unknown) => UsageLogProjection,
): Extract<UsageQueryResult, { kind: 'logs' }>;
function decodeUsagePage(
  kind: 'buckets' | 'logs',
  result: Record<string, unknown>,
  decodeItem: (value: unknown) => UsageBucket | UsageLogProjection,
): UsageQueryResult {
  const field = kind === 'buckets' ? 'buckets' : 'rows';
  const rawItems = result[field];
  if (!Array.isArray(rawItems) || rawItems.length > USAGE_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Usage page exceeds item limit');
  }
  const total = requireCount(result.total, 'usage result total');
  const nextOffset =
    result.nextOffset === null ? null : requireCount(result.nextOffset, 'usage nextOffset');
  if (nextOffset !== null && nextOffset > total) {
    throw invalidProtocolFrame('Invalid usage nextOffset');
  }
  const items = rawItems.map(decodeItem);
  const decoded =
    kind === 'buckets'
      ? { kind, buckets: items as UsageBucket[], total, nextOffset }
      : { kind, rows: items as UsageLogProjection[], total, nextOffset };
  if (jsonBytes(decoded) > USAGE_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Usage page exceeds byte limit');
  }
  return decoded;
}

function decodeUsageSummary(value: unknown): UsageSummaryV2 {
  const summary = requireExactRecord(value, 'usage summary', [
    'range',
    'totalRequests',
    'totalCostUsd',
    'totalTokens',
    'cacheHitRequests',
    'cacheCreateRequests',
    'errorRequests',
  ]);
  const range = requireExactRecord(summary.range, 'usage summary range', ['from', 'to']);
  const tokens = requireExactRecord(summary.totalTokens, 'usage summary tokens', [
    'input',
    'output',
    'cacheMiss',
    'cacheRead',
    'cacheWrite',
    'reasoning',
    'total',
  ]);
  return {
    range: {
      from: nonnegativeFinite(range.from, 'usage summary range from'),
      to: nonnegativeFinite(range.to, 'usage summary range to'),
    },
    totalRequests: nonnegativeFinite(summary.totalRequests, 'usage total requests'),
    totalCostUsd: nonnegativeFinite(summary.totalCostUsd, 'usage total cost'),
    totalTokens: {
      input: nonnegativeFinite(tokens.input, 'usage input tokens'),
      output: nonnegativeFinite(tokens.output, 'usage output tokens'),
      cacheMiss: nonnegativeFinite(tokens.cacheMiss, 'usage cache miss tokens'),
      cacheRead: nonnegativeFinite(tokens.cacheRead, 'usage cache read tokens'),
      cacheWrite: nonnegativeFinite(tokens.cacheWrite, 'usage cache write tokens'),
      reasoning: nonnegativeFinite(tokens.reasoning, 'usage reasoning tokens'),
      total: nonnegativeFinite(tokens.total, 'usage total tokens'),
    },
    cacheHitRequests: nonnegativeFinite(summary.cacheHitRequests, 'usage cache hit requests'),
    cacheCreateRequests: nonnegativeFinite(
      summary.cacheCreateRequests,
      'usage cache create requests',
    ),
    errorRequests: nonnegativeFinite(summary.errorRequests, 'usage error requests'),
  };
}

function decodeUsageBucket(value: unknown): UsageBucket {
  const bucket = requireRecord(value, 'usage bucket');
  assertAllowedKeys(bucket, 'usage bucket', [
    'key',
    'label',
    'requests',
    'inputTokens',
    'outputTokens',
    'cacheMissTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'cacheMissInputSource',
    'reasoningTokens',
    'totalTokens',
    'costUsd',
    'avgLatencyMs',
    'errorRate',
  ]);
  requireFields(bucket, 'usage bucket', [
    'key',
    'label',
    'requests',
    'inputTokens',
    'outputTokens',
    'cacheMissTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
    'costUsd',
    'avgLatencyMs',
    'errorRate',
  ]);
  const errorRate = nonnegativeFinite(bucket.errorRate, 'usage bucket error rate');
  if (errorRate > 1) throw invalidProtocolFrame('Invalid usage bucket error rate');
  return {
    key: projectionString(bucket.key, 'usage bucket key'),
    label: projectionString(bucket.label, 'usage bucket label'),
    requests: nonnegativeFinite(bucket.requests, 'usage bucket requests'),
    inputTokens: nonnegativeFinite(bucket.inputTokens, 'usage bucket input tokens'),
    outputTokens: nonnegativeFinite(bucket.outputTokens, 'usage bucket output tokens'),
    cacheMissTokens: nonnegativeFinite(bucket.cacheMissTokens, 'usage bucket cache miss tokens'),
    cacheReadTokens: nonnegativeFinite(bucket.cacheReadTokens, 'usage bucket cache read tokens'),
    cacheWriteTokens: nonnegativeFinite(bucket.cacheWriteTokens, 'usage bucket cache write tokens'),
    ...(bucket.cacheMissInputSource === undefined
      ? {}
      : { cacheMissInputSource: cacheMissInputSource(bucket.cacheMissInputSource) }),
    reasoningTokens: nonnegativeFinite(bucket.reasoningTokens, 'usage bucket reasoning tokens'),
    totalTokens: nonnegativeFinite(bucket.totalTokens, 'usage bucket total tokens'),
    costUsd: nonnegativeFinite(bucket.costUsd, 'usage bucket cost'),
    avgLatencyMs: nonnegativeFinite(bucket.avgLatencyMs, 'usage bucket average latency'),
    errorRate,
  };
}

function decodeUsageLogRow(value: unknown): UsageLogProjection {
  const row = requireRecord(value, 'usage log row');
  assertAllowedKeys(row, 'usage log row', LOG_FIELDS);
  requireFields(row, 'usage log row', [
    'id',
    'ts',
    'providerId',
    'modelId',
    'inputTokens',
    'outputTokens',
    'cacheMissTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
    'costUsd',
    'latencyMs',
    'status',
  ]);
  return {
    id: projectionString(row.id, 'usage log id'),
    ts: nonnegativeFinite(row.ts, 'usage log timestamp'),
    ...optionalEnumField(row, 'callKind', ['main', 'semantic_compact'] as const),
    ...optionalStringField(row, 'callId'),
    ...optionalStringField(row, 'connectionSlug'),
    providerId: projectionString(row.providerId, 'usage log providerId'),
    modelId: projectionString(row.modelId, 'usage log modelId'),
    ...optionalStringField(row, 'toolName'),
    inputTokens: nonnegativeFinite(row.inputTokens, 'usage log input tokens'),
    outputTokens: nonnegativeFinite(row.outputTokens, 'usage log output tokens'),
    cacheMissTokens: nonnegativeFinite(row.cacheMissTokens, 'usage log cache miss tokens'),
    cacheReadTokens: nonnegativeFinite(row.cacheReadTokens, 'usage log cache read tokens'),
    cacheWriteTokens: nonnegativeFinite(row.cacheWriteTokens, 'usage log cache write tokens'),
    ...(row.cacheMissInputSource === undefined
      ? {}
      : { cacheMissInputSource: cacheMissInputSource(row.cacheMissInputSource) }),
    reasoningTokens: nonnegativeFinite(row.reasoningTokens, 'usage log reasoning tokens'),
    totalTokens: nonnegativeFinite(row.totalTokens, 'usage log total tokens'),
    costUsd: nonnegativeFinite(row.costUsd, 'usage log cost'),
    latencyMs: nonnegativeFinite(row.latencyMs, 'usage log latency'),
    status: usageLogStatus(row.status),
    ...optionalStringField(row, 'errorClass'),
    ...optionalStringField(row, 'sessionId'),
    ...optionalStringField(row, 'turnId'),
  };
}

function decodePricingConfig(value: unknown, requireCanonical: boolean): PricingConfig {
  const pricing = requireRecord(value, 'pricing config');
  assertAllowedKeys(pricing, 'pricing config', [
    'modelKey',
    'inputUsdPer1M',
    'outputUsdPer1M',
    'cacheReadUsdPer1M',
    'cacheWriteUsdPer1M',
  ]);
  requireFields(pricing, 'pricing config', ['modelKey', 'inputUsdPer1M', 'outputUsdPer1M']);
  const normalized = normalizePricingConfig(pricing);
  if (!normalized.ok) throw invalidProtocolFrame(`Invalid pricing config: ${normalized.error}`);
  if (
    requireCanonical &&
    (normalized.value.modelKey !== pricing.modelKey ||
      normalized.value.inputUsdPer1M !== pricing.inputUsdPer1M ||
      normalized.value.outputUsdPer1M !== pricing.outputUsdPer1M ||
      normalized.value.cacheReadUsdPer1M !== pricing.cacheReadUsdPer1M ||
      normalized.value.cacheWriteUsdPer1M !== pricing.cacheWriteUsdPer1M)
  ) {
    throw invalidProtocolFrame('Pricing config is not canonical');
  }
  return normalized.value;
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

function nonnegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function projectionString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > USAGE_PROJECTION_TEXT_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function optionalStringField<Field extends string>(
  value: Record<string, unknown>,
  field: Field,
): Record<Field, string> | Record<string, never> {
  return value[field] === undefined
    ? {}
    : ({ [field]: projectionString(value[field], `usage ${field}`) } as Record<Field, string>);
}

function optionalEnumField<Field extends string, Value extends string>(
  record: Record<string, unknown>,
  field: Field,
  allowed: readonly Value[],
): Record<Field, Value> | Record<string, never> {
  if (record[field] === undefined) return {};
  if (typeof record[field] !== 'string' || !allowed.includes(record[field] as Value)) {
    throw invalidProtocolFrame(`Invalid usage ${field}`);
  }
  return { [field]: record[field] } as Record<Field, Value>;
}

function cacheMissInputSource(value: unknown): 'explicit' | 'derived' {
  if (value === 'explicit' || value === 'derived') return value;
  throw invalidProtocolFrame('Invalid cache miss input source');
}

function usageLogStatus(value: unknown): UsageLogProjection['status'] {
  if (value === 'success' || value === 'error' || value === 'aborted') return value;
  throw invalidProtocolFrame('Invalid usage log status');
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
