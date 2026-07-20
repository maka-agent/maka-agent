import type { PricingConfig, UsageBucket, UsageLogRow } from '@maka/core/usage-stats/types';
import {
  PricingRevisionConflictError,
  PricingStorePublicationError,
  PricingValidationError,
} from '@maka/storage/pricing-store';
import {
  authenticateInteractiveUsageStoresWriter,
  type InteractiveUsageStoresWriter,
} from '@maka/storage/usage-stores';
import {
  encodePricingQueryResult,
  encodeUsageQueryResult,
  PRICING_PAGE_MAX_BYTES,
  PRICING_PAGE_MAX_ITEMS,
  USAGE_PAGE_MAX_BYTES,
  USAGE_PAGE_MAX_ITEMS,
  USAGE_PROJECTION_TEXT_MAX_BYTES,
  type OperationOutcome,
  type PricingMutateInput,
  type PricingQueryInput,
  type PricingQueryResult,
  type UsageLogProjection,
  type UsageQueryInput,
  type UsageQueryResult,
} from '../protocol/index.js';
import type { UsagePricingOperationHandlerMap } from './operation-dispatcher.js';

/** Root-scoped Host projection over the existing telemetry and pricing authorities. */
export class HostUsagePricingCoordinator {
  readonly handlers: UsagePricingOperationHandlerMap = {
    'usage.query': (input) => this.#queryUsage(input),
    'pricing.query': (input) => this.#queryPricing(input),
    'pricing.mutate': (input) => this.#mutatePricing(input),
  };

  readonly #stores: InteractiveUsageStoresWriter;

  constructor(stores: InteractiveUsageStoresWriter) {
    this.#stores = authenticateInteractiveUsageStoresWriter(stores);
  }

  async #queryUsage(input: UsageQueryInput): Promise<OperationOutcome<'usage.query'>> {
    if (input.kind === 'summary') {
      return {
        ok: true,
        result: encodeUsageQueryResult({
          kind: 'summary',
          summary: this.#stores.telemetry.summary(input.query),
        }),
      };
    }
    if (input.kind === 'buckets') {
      const buckets = this.#stores.telemetry.buckets(input.query, input.groupBy);
      return {
        ok: true,
        result: encodeUsageQueryResult(
          usagePage(
            'buckets',
            buckets.map(projectUsageBucket),
            buckets.length,
            input.offset ?? 0,
            input.limit ?? USAGE_PAGE_MAX_ITEMS,
          ),
        ),
      };
    }
    const offset = input.offset ?? 0;
    const limit = input.limit ?? USAGE_PAGE_MAX_ITEMS;
    const page = this.#stores.telemetry.logs(input.query, offset, limit);
    return {
      ok: true,
      result: encodeUsageQueryResult(
        usagePage('logs', page.rows.map(projectUsageLog), page.total, offset, limit),
      ),
    };
  }

  async #queryPricing(input: PricingQueryInput): Promise<OperationOutcome<'pricing.query'>> {
    const snapshot = this.#stores.pricing.snapshot();
    if (input.kind === 'continue' && input.revision !== snapshot.revision) {
      return {
        ok: true,
        result: encodePricingQueryResult({
          kind: 'revision_changed',
          expectedRevision: input.revision,
          actualRevision: snapshot.revision,
        }),
      };
    }

    const offset = input.kind === 'start' ? 0 : decodePricingCursor(input.cursor);
    if (
      offset === undefined ||
      offset > snapshot.overrides.length ||
      (input.kind === 'continue' && offset === snapshot.overrides.length)
    ) {
      return invalidPricingRequest('Pricing cursor is invalid');
    }
    return {
      ok: true,
      result: createPricingPage(snapshot.revision, snapshot.overrides, offset),
    };
  }

  async #mutatePricing(input: PricingMutateInput): Promise<OperationOutcome<'pricing.mutate'>> {
    try {
      const stored =
        input.mutation.kind === 'upsert'
          ? await this.#stores.pricing.upsert(input.expectedRevision, input.mutation.pricing)
          : await this.#stores.pricing.delete(input.expectedRevision, input.mutation.modelKey);
      return {
        ok: true,
        result: {
          kind: stored.changed ? 'committed' : 'unchanged',
          revision: stored.snapshot.revision,
        },
      };
    } catch (error) {
      if (error instanceof PricingRevisionConflictError) {
        return {
          ok: true,
          result: {
            kind: 'revision_conflict',
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
          },
        };
      }
      if (error instanceof PricingValidationError) {
        return {
          ok: false,
          error: { code: 'invalid_request', message: 'Pricing mutation is invalid' },
        };
      }
      if (error instanceof PricingStorePublicationError) {
        return persistenceFailure('Pricing authority persistence failed');
      }
      throw error;
    }
  }
}

function createPricingPage(
  revision: number,
  overrides: readonly Readonly<PricingConfig>[],
  offset: number,
): PricingQueryResult {
  const pageOverrides: Readonly<PricingConfig>[] = [];
  for (let index = offset; index < overrides.length; index += 1) {
    if (pageOverrides.length >= PRICING_PAGE_MAX_ITEMS) break;
    const pricing = overrides[index];
    if (!pricing) break;
    const candidateOverrides = [...pageOverrides, pricing];
    const nextOffset = index + 1;
    const candidate: PricingQueryResult = {
      kind: 'page',
      revision,
      overrides: candidateOverrides,
      nextCursor: nextOffset < overrides.length ? encodePricingCursor(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PRICING_PAGE_MAX_BYTES) {
      if (pageOverrides.length === 0) {
        throw new Error('A canonical pricing override cannot fit in one pricing page');
      }
      break;
    }
    pageOverrides.push(pricing);
  }

  const nextOffset = offset + pageOverrides.length;
  return encodePricingQueryResult({
    kind: 'page',
    revision,
    overrides: pageOverrides,
    nextCursor: nextOffset < overrides.length ? encodePricingCursor(nextOffset) : null,
  });
}

function encodePricingCursor(offset: number): string {
  return String(offset);
}

function decodePricingCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function invalidPricingRequest(message: string): OperationOutcome<'pricing.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}

function usagePage(
  kind: 'buckets',
  allItems: readonly Extract<UsageQueryResult, { kind: 'buckets' }>['buckets'][number][],
  total: number,
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'buckets' }>;
function usagePage(
  kind: 'logs',
  allItems: readonly Extract<UsageQueryResult, { kind: 'logs' }>['rows'][number][],
  total: number,
  offset: number,
  limit: number,
): Extract<UsageQueryResult, { kind: 'logs' }>;
function usagePage(
  kind: 'buckets' | 'logs',
  allItems: readonly unknown[],
  total: number,
  offset: number,
  limit: number,
): UsageQueryResult {
  const items: unknown[] = [];
  for (const item of allItems.slice(
    kind === 'buckets' ? offset : 0,
    kind === 'buckets' ? offset + limit : limit,
  )) {
    const candidate = [...items, item];
    const nextOffset = offset + candidate.length;
    const result = pageResult(kind, candidate, total, nextOffset < total ? nextOffset : null);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > USAGE_PAGE_MAX_BYTES) break;
    items.push(item);
  }
  if (items.length === 0 && offset < total) {
    throw new Error('A canonical usage projection cannot fit in one page');
  }
  const nextOffset = offset + items.length;
  return pageResult(kind, items, total, nextOffset < total ? nextOffset : null);
}

function projectUsageBucket(bucket: UsageBucket): UsageBucket {
  return {
    ...bucket,
    key: projectText(bucket.key),
    label: projectText(bucket.label),
  };
}

function projectUsageLog(row: UsageLogRow): UsageLogProjection {
  return {
    id: projectText(row.id),
    ts: row.ts,
    ...(row.callKind === undefined ? {} : { callKind: row.callKind }),
    ...(row.callId === undefined ? {} : { callId: projectText(row.callId) }),
    ...(row.connectionSlug === undefined
      ? {}
      : { connectionSlug: projectText(row.connectionSlug) }),
    providerId: projectText(row.providerId),
    modelId: projectText(row.modelId),
    ...(row.toolName === undefined ? {} : { toolName: projectText(row.toolName) }),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheMissTokens: row.cacheMissTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    ...(row.cacheMissInputSource === undefined
      ? {}
      : { cacheMissInputSource: row.cacheMissInputSource }),
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    latencyMs: row.latencyMs,
    status: row.status,
    ...(row.errorClass === undefined ? {} : { errorClass: projectText(row.errorClass) }),
    ...(row.sessionId === undefined ? {} : { sessionId: projectText(row.sessionId) }),
    ...(row.turnId === undefined ? {} : { turnId: projectText(row.turnId) }),
  };
}

function projectText(value: string): string {
  let bytes = 0;
  let projected = '';
  for (const codePoint of value) {
    const scalar = codePoint.codePointAt(0)!;
    const canonical = scalar <= 0x1f || scalar === 0x7f ? '\ufffd' : codePoint;
    const codePointBytes = Buffer.byteLength(canonical, 'utf8');
    if (bytes + codePointBytes > USAGE_PROJECTION_TEXT_MAX_BYTES) break;
    projected += canonical;
    bytes += codePointBytes;
  }
  return projected;
}

function pageResult(
  kind: 'buckets' | 'logs',
  items: readonly unknown[],
  total: number,
  nextOffset: number | null,
): UsageQueryResult {
  return kind === 'buckets'
    ? {
        kind,
        buckets: items as Extract<UsageQueryResult, { kind: 'buckets' }>['buckets'],
        total,
        nextOffset,
      }
    : {
        kind,
        rows: items as Extract<UsageQueryResult, { kind: 'logs' }>['rows'],
        total,
        nextOffset,
      };
}

function persistenceFailure<Message extends string>(message: Message) {
  return {
    ok: false as const,
    error: { code: 'persistence_failed' as const, message },
  };
}
