import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PRICING_MODEL_KEY_MAX_BYTES } from '@maka/core/usage-stats/pricing';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeUsageQueryInput,
  encodeProtocolFrame,
  encodePricingQueryResult,
  HOST_OPERATION_SPECS,
  PRICING_CURSOR_MAX_BYTES,
  PRICING_PAGE_MAX_BYTES,
  PRICING_PAGE_MAX_ITEMS,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RuntimeHostProtocolError,
  USAGE_PAGE_MAX_BYTES,
  USAGE_PAGE_MAX_ITEMS,
  USAGE_PROJECTION_TEXT_MAX_BYTES,
} from '../protocol/index.js';

describe('Usage/Pricing protocol', () => {
  test('registers exactly the three root-scoped operations and their metadata', () => {
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter(
        (key) => key.startsWith('usage.') || key.startsWith('pricing.'),
      ),
      ['usage.query', 'pricing.query', 'pricing.mutate'],
    );
    assert.deepEqual(operationMetadata('usage.query'), {
      mode: 'query',
      retry: 'safe',
      admission: 'ready',
    });
    assert.deepEqual(operationMetadata('pricing.query'), {
      mode: 'query',
      retry: 'safe',
      admission: 'ready',
    });
    assert.deepEqual(operationMetadata('pricing.mutate'), {
      mode: 'command',
      retry: 'none',
      admission: 'ready',
    });
  });

  test('decodes only the strict usage union with bounded defaults and filters', () => {
    assert.deepEqual(decodeUsageQueryInput({ kind: 'logs', query: { range: 'all' } }), {
      kind: 'logs',
      query: { range: 'all' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(
      decodeUsageQueryInput({
        kind: 'buckets',
        query: {
          range: { from: 1, to: 2 },
          connectionSlug: 'primary',
          providerId: 'provider',
          modelId: 'model',
          toolName: 'Read',
          status: 'success',
        },
        groupBy: 'model',
        offset: 2,
        limit: 3,
      }),
      {
        kind: 'buckets',
        query: {
          range: { from: 1, to: 2 },
          connectionSlug: 'primary',
          providerId: 'provider',
          modelId: 'model',
          toolName: 'Read',
          status: 'success',
        },
        groupBy: 'model',
        offset: 2,
        limit: 3,
      },
    );
    assert.doesNotThrow(() => usageRequest({ kind: 'summary', query: { range: '24h' } }));

    for (const input of [
      { kind: 'summary', query: { range: 'all' }, offset: 0 },
      { kind: 'logs', query: { range: 'all', unknown: true } },
      { kind: 'logs', query: { range: { from: 2, to: 1 } } },
      { kind: 'logs', query: { range: 'all' }, offset: -1 },
      { kind: 'logs', query: { range: 'all' }, limit: 0 },
      { kind: 'logs', query: { range: 'all' }, limit: USAGE_PAGE_MAX_ITEMS + 1 },
      { kind: 'buckets', query: { range: 'all' }, groupBy: 'week' },
      { kind: 'export', query: { range: 'all' } },
    ]) {
      assert.throws(() => usageRequest(input), isInvalidFrame);
    }
  });

  test('enforces strict usage results plus item and JSON-byte page caps', () => {
    assert.doesNotThrow(() => usageResponse({ kind: 'summary', summary: validSummary() }));
    assert.doesNotThrow(() =>
      usageResponse({ kind: 'buckets', buckets: [validBucket()], total: 2, nextOffset: 1 }),
    );
    assert.doesNotThrow(() =>
      usageResponse({ kind: 'logs', rows: [validLog()], total: 1, nextOffset: null }),
    );

    const tooMany = Array.from({ length: USAGE_PAGE_MAX_ITEMS + 1 }, () => validBucket());
    const byteHeavy = Array.from({ length: 30 }, (_, index) => ({
      ...validLog(index),
      errorClass: '\\'.repeat(USAGE_PROJECTION_TEXT_MAX_BYTES),
    }));
    const oversized = { kind: 'logs' as const, rows: byteHeavy, total: 30, nextOffset: null };
    const singleOversized = {
      kind: 'logs' as const,
      rows: [{ ...validLog(), errorClass: 'x'.repeat(USAGE_PROJECTION_TEXT_MAX_BYTES + 1) }],
      total: 1,
      nextOffset: null,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > USAGE_PAGE_MAX_BYTES);
    for (const result of [
      { kind: 'buckets', buckets: tooMany, total: tooMany.length, nextOffset: null },
      oversized,
      singleOversized,
      {
        kind: 'logs',
        rows: [{ ...validLog(), systemPromptHash: 'not-part-of-the-wire-projection' }],
        total: 1,
        nextOffset: null,
      },
      {
        kind: 'logs',
        rows: [{ ...validLog(), errorClass: 'failure\u0000class' }],
        total: 1,
        nextOffset: null,
      },
      { kind: 'buckets', buckets: [validBucket()], total: 1, nextOffset: 2 },
    ]) {
      assert.throws(() => usageResponse(result), isInvalidFrame);
    }
  });

  test('decodes the strict revision-pinned pricing query contract and unchanged mutation CAS', () => {
    assert.doesNotThrow(() => pricingRequest('pricing.query', { kind: 'start' }));
    assert.doesNotThrow(() =>
      pricingRequest('pricing.query', { kind: 'continue', revision: 3, cursor: '17' }),
    );
    for (const input of [
      {},
      { kind: 'start', cursor: '0' },
      { kind: 'continue', revision: -1, cursor: '1' },
      { kind: 'continue', revision: 0, cursor: '' },
      { kind: 'continue', revision: 0, cursor: 'x'.repeat(PRICING_CURSOR_MAX_BYTES + 1) },
    ]) {
      assert.throws(() => pricingRequest('pricing.query', input), isInvalidFrame);
    }
    assert.doesNotThrow(() =>
      pricingRequest('pricing.mutate', {
        expectedRevision: 0,
        mutation: { kind: 'upsert', pricing: validPricing('provider:model') },
      }),
    );
    assert.doesNotThrow(() =>
      pricingRequest('pricing.mutate', {
        expectedRevision: 1,
        mutation: { kind: 'delete', modelKey: 'provider:model' },
      }),
    );
    for (const input of [
      { expectedRevision: -1, mutation: { kind: 'delete', modelKey: 'model' } },
      { expectedRevision: 0, mutation: { kind: 'delete', modelKey: '', ticket: 'x' } },
      {
        expectedRevision: 0,
        mutation: { kind: 'upsert', pricing: { ...validPricing('model'), extra: true } },
      },
      { expectedRevision: 0, mutation: { kind: 'reset' } },
    ]) {
      assert.throws(() => pricingRequest('pricing.mutate', input), isInvalidFrame);
    }

    assert.deepEqual(
      encodePricingQueryResult({
        kind: 'page',
        revision: 3,
        overrides: [validPricing('m')],
        nextCursor: '1',
      }),
      {
        kind: 'page',
        revision: 3,
        overrides: [validPricing('m')],
        nextCursor: '1',
      },
    );
    assert.deepEqual(
      encodePricingQueryResult({
        kind: 'revision_changed',
        expectedRevision: 2,
        actualRevision: 3,
      }),
      { kind: 'revision_changed', expectedRevision: 2, actualRevision: 3 },
    );
    assert.throws(
      () =>
        encodePricingQueryResult({
          kind: 'page',
          revision: 0,
          overrides: Array.from({ length: PRICING_PAGE_MAX_ITEMS + 1 }, (_, index) =>
            validPricing(`model-${index}`),
          ),
          nextCursor: null,
        }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      pricingResponse('pricing.mutate', { kind: 'committed', revision: 1 }),
    );
    assert.doesNotThrow(() =>
      pricingResponse('pricing.mutate', { kind: 'unchanged', revision: 1 }),
    );
    assert.doesNotThrow(() =>
      pricingResponse('pricing.mutate', {
        kind: 'revision_conflict',
        expectedRevision: 0,
        actualRevision: 1,
      }),
    );
    assert.throws(
      () => pricingResponse('pricing.mutate', { kind: 'committed', revision: 1, snapshot: {} }),
      isInvalidFrame,
    );
  });

  test('bounds each pricing page by encoded bytes while one maximum override always advances', () => {
    const maximumOverride = maximumPricing('single:');
    const singlePage = encodePricingQueryResult({
      kind: 'page',
      revision: Number.MAX_SAFE_INTEGER,
      overrides: [maximumOverride],
      nextCursor: '1',
    });
    assert.ok(Buffer.byteLength(JSON.stringify(singlePage), 'utf8') <= PRICING_PAGE_MAX_BYTES);
    assert.ok(
      encodeProtocolFrame({
        requestId: 'maximum-pricing-page',
        operation: 'pricing.query',
        ok: true,
        result: singlePage,
      }).byteLength <= RUNTIME_HOST_MAX_FRAME_BYTES,
    );

    const oversizedPage = {
      kind: 'page' as const,
      revision: Number.MAX_SAFE_INTEGER,
      overrides: Array.from({ length: PRICING_PAGE_MAX_ITEMS }, (_, index) =>
        maximumPricing(`${index.toString(36)}:`),
      ),
      nextCursor: null,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(oversizedPage), 'utf8') > PRICING_PAGE_MAX_BYTES);
    assert.throws(() => encodePricingQueryResult(oversizedPage), isInvalidFrame);
  });
});

function operationMetadata(key: 'usage.query' | 'pricing.query' | 'pricing.mutate') {
  const { mode, retry, admission } = HOST_OPERATION_SPECS[key];
  return { mode, retry, admission };
}

function validSummary() {
  return {
    range: { from: 0, to: 1 },
    totalRequests: 1,
    totalCostUsd: 0.01,
    totalTokens: {
      input: 1,
      output: 2,
      cacheMiss: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 3,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
  };
}

function validBucket() {
  return {
    key: 'provider',
    label: 'provider',
    requests: 1,
    inputTokens: 1,
    outputTokens: 2,
    cacheMissTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissInputSource: 'explicit' as const,
    reasoningTokens: 0,
    totalTokens: 3,
    costUsd: 0.01,
    avgLatencyMs: 10,
    errorRate: 0,
  };
}

function validLog(index = 0) {
  return {
    id: `usage-${index}`,
    ts: index + 1,
    providerId: 'provider',
    modelId: 'model',
    inputTokens: 1,
    outputTokens: 2,
    cacheMissTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissInputSource: 'explicit' as const,
    reasoningTokens: 0,
    totalTokens: 3,
    costUsd: 0.01,
    latencyMs: 10,
    status: 'success' as const,
  };
}

function validPricing(modelKey: string) {
  return { modelKey, inputUsdPer1M: 1, outputUsdPer1M: 2 };
}

function maximumPricing(prefix: string) {
  const modelKey = `${prefix}${'"'.repeat(PRICING_MODEL_KEY_MAX_BYTES - prefix.length)}`;
  assert.equal(Buffer.byteLength(modelKey, 'utf8'), PRICING_MODEL_KEY_MAX_BYTES);
  return {
    modelKey,
    inputUsdPer1M: Number.MAX_VALUE,
    outputUsdPer1M: Number.MAX_VALUE,
    cacheReadUsdPer1M: Number.MAX_VALUE,
    cacheWriteUsdPer1M: Number.MAX_VALUE,
  };
}

function usageRequest(input: unknown): void {
  decodeClientFrame({ requestId: 'usage-request', operation: 'usage.query', input });
}

function usageResponse(result: unknown): void {
  decodeHostFrame({
    requestId: 'usage-response',
    operation: 'usage.query',
    ok: true,
    result,
  });
}

function pricingRequest(operation: 'pricing.query' | 'pricing.mutate', input: unknown): void {
  decodeClientFrame({ requestId: 'pricing-request', operation, input });
}

function pricingResponse(operation: 'pricing.query' | 'pricing.mutate', result: unknown): void {
  decodeHostFrame({ requestId: 'pricing-response', operation, ok: true, result });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
