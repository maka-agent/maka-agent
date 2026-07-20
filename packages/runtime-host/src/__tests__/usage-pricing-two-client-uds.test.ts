import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRICING_MODEL_KEY_MAX_BYTES } from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/index.js';
import {
  USAGE_PROJECTION_TEXT_MAX_BYTES,
  type PricingMutateResult,
  type PricingQueryResult,
} from '../protocol/index.js';
import { connectClient, withExecutionRoot } from './support/execution-root-fixture.js';

test('two UDS Clients read the same summary, bucket, and log from persisted telemetry', async () => {
  await withExecutionRoot(async (fixture) => {
    const oversizedErrorClass = `failure\u0000\u001f\u007f${'\\'.repeat(64)}`.repeat(800);
    assert.ok(Buffer.byteLength(oversizedErrorClass, 'utf8') > 48 * 1024);
    await fixture.seedUsageRecords([
      usageRecord('usage-a', 10, 'openai', 'gpt-a'),
      {
        ...usageRecord('usage-b', 20, 'anthropic', 'claude-b'),
        status: 'error',
        errorClass: oversizedErrorClass,
      },
    ]);
    const host = await fixture.startHost();
    let desktop: RuntimeHostConnection | undefined;
    let tui: RuntimeHostConnection | undefined;
    try {
      desktop = await connectClient(fixture.root, 'desktop');
      tui = await connectClient(fixture.root, 'tui');
      const [desktopProjection, tuiProjection] = await Promise.all([
        readUsageProjection(desktop),
        readUsageProjection(tui),
      ]);
      assert.deepEqual(tuiProjection, desktopProjection);
      assert.equal(desktopProjection.summary.kind, 'summary');
      assert.equal(desktopProjection.summary.summary.totalRequests, 2);
      assert.equal(desktopProjection.buckets.kind, 'buckets');
      assert.equal(desktopProjection.buckets.total, 2);
      assert.equal(desktopProjection.logs.kind, 'logs');
      assert.deepEqual(
        desktopProjection.logs.rows.map((row) => row.id),
        ['usage-b', 'usage-a'],
      );
      const projectedErrorClass = desktopProjection.logs.rows[0]?.errorClass;
      assert.ok(projectedErrorClass);
      assert.ok(Buffer.byteLength(projectedErrorClass, 'utf8') <= USAGE_PROJECTION_TEXT_MAX_BYTES);
      assert.doesNotMatch(projectedErrorClass, /[\u0000-\u001f\u007f]/u);
      assert.match(projectedErrorClass, /\ufffd/u);
      assert.equal(desktopProjection.logs.rows[0]?.cacheMissInputSource, 'explicit');
    } finally {
      await Promise.all([desktop?.close(), tui?.close()]);
      await fixture.stopHost(host);
    }
  });
});

test('two UDS Clients page pricing by revision, converge after mutation, and survive Host restart', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    let desktop: RuntimeHostConnection | undefined;
    let tui: RuntimeHostConnection | undefined;
    const allPricing = Array.from({ length: 21 }, (_, index) => exactLongPricing(index));
    const seededPricing = allPricing.slice(0, -1);
    const pricingAfterStart = allPricing.at(-1)!;
    const expectedOverrides = [...allPricing].sort((left, right) =>
      left.modelKey.localeCompare(right.modelKey),
    );
    const pricingA = seededPricing[0]!;
    const pricingB = seededPricing[1]!;
    try {
      desktop = await connectClient(fixture.root, 'desktop');
      tui = await connectClient(fixture.root, 'tui');
      const initial = await readPricingSnapshot(desktop);
      assert.deepEqual(initial, { revision: 0, overrides: [], pageCount: 1 });

      const outcomes = await Promise.all([
        desktop.request('pricing.mutate', {
          expectedRevision: initial.revision,
          mutation: { kind: 'upsert', pricing: pricingA },
        }),
        tui.request('pricing.mutate', {
          expectedRevision: initial.revision,
          mutation: { kind: 'upsert', pricing: pricingB },
        }),
      ]);
      const committedIndex = outcomes.findIndex((result) => result.kind === 'committed');
      const conflictIndex = outcomes.findIndex((result) => result.kind === 'revision_conflict');
      assert.notEqual(committedIndex, -1);
      assert.notEqual(conflictIndex, -1);
      const conflict = outcomes[conflictIndex];
      assert.ok(conflict?.kind === 'revision_conflict');
      if (!conflict || conflict.kind !== 'revision_conflict') return;
      assert.deepEqual(conflict, {
        kind: 'revision_conflict',
        expectedRevision: 0,
        actualRevision: 1,
      });

      const loser = conflictIndex === 0 ? desktop : tui;
      const loserPricing = conflictIndex === 0 ? pricingA : pricingB;
      const retried = await loser.request('pricing.mutate', {
        expectedRevision: conflict.actualRevision,
        mutation: { kind: 'upsert', pricing: loserPricing },
      });
      assert.deepEqual(retried, { kind: 'committed', revision: 2 });

      let revision = retried.revision;
      for (const override of seededPricing.slice(2)) {
        const result: PricingMutateResult = await desktop.request('pricing.mutate', {
          expectedRevision: revision,
          mutation: { kind: 'upsert', pricing: override },
        });
        assert.equal(result.kind, 'committed');
        if (result.kind !== 'committed') return;
        revision = result.revision;
      }

      const firstPage = await desktop.request('pricing.query', { kind: 'start' });
      assert.equal(firstPage.kind, 'page');
      if (firstPage.kind !== 'page') return;
      assert.equal(firstPage.revision, seededPricing.length);
      const staleCursor = firstPage.nextCursor;
      assert.ok(staleCursor);
      assert.ok(firstPage.overrides.length < seededPricing.length);
      await assert.rejects(
        desktop.request('pricing.query', {
          kind: 'continue',
          revision: firstPage.revision,
          cursor: '01',
        }),
        operationError('invalid_request'),
      );
      await assert.rejects(
        desktop.request('pricing.query', {
          kind: 'continue',
          revision: firstPage.revision,
          cursor: String(seededPricing.length),
        }),
        operationError('invalid_request'),
      );

      const changed = await tui.request('pricing.mutate', {
        expectedRevision: firstPage.revision,
        mutation: { kind: 'upsert', pricing: pricingAfterStart },
      });
      assert.deepEqual(changed, { kind: 'committed', revision: seededPricing.length + 1 });

      const stale = await desktop.request('pricing.query', {
        kind: 'continue',
        revision: firstPage.revision,
        cursor: staleCursor,
      });
      assert.deepEqual(stale, {
        kind: 'revision_changed',
        expectedRevision: seededPricing.length,
        actualRevision: seededPricing.length + 1,
      });

      const [desktopSettled, tuiSettled] = await Promise.all([
        readPricingSnapshot(desktop),
        readPricingSnapshot(tui),
      ]);
      assert.deepEqual(tuiSettled, desktopSettled);
      assert.equal(desktopSettled.revision, seededPricing.length + 1);
      assert.deepEqual(desktopSettled.overrides, expectedOverrides);
      assert.ok(desktopSettled.pageCount > 1);
    } finally {
      await Promise.all([desktop?.close(), tui?.close()]);
      await fixture.stopHost(firstHost);
    }

    const successor = await fixture.startHost();
    let desktopAfterRestart: RuntimeHostConnection | undefined;
    let tuiAfterRestart: RuntimeHostConnection | undefined;
    try {
      desktopAfterRestart = await connectClient(fixture.root, 'desktop');
      tuiAfterRestart = await connectClient(fixture.root, 'tui');
      const [desktopSnapshot, tuiSnapshot] = await Promise.all([
        readPricingSnapshot(desktopAfterRestart),
        readPricingSnapshot(tuiAfterRestart),
      ]);
      assert.deepEqual(tuiSnapshot, desktopSnapshot);
      assert.equal(desktopSnapshot.revision, seededPricing.length + 1);
      assert.deepEqual(desktopSnapshot.overrides, expectedOverrides);
      assert.ok(desktopSnapshot.pageCount > 1);
    } finally {
      await Promise.all([desktopAfterRestart?.close(), tuiAfterRestart?.close()]);
      await fixture.stopHost(successor);
    }
  });
});

async function readUsageProjection(client: RuntimeHostConnection) {
  const query = { range: { from: 0, to: 100 } } as const;
  const [summary, buckets, logs] = await Promise.all([
    client.request('usage.query', { kind: 'summary', query }),
    client.request('usage.query', {
      kind: 'buckets',
      query,
      groupBy: 'provider',
    }),
    client.request('usage.query', { kind: 'logs', query }),
  ]);
  return { summary, buckets, logs };
}

async function readPricingSnapshot(client: RuntimeHostConnection) {
  const first = await client.request('pricing.query', { kind: 'start' });
  assert.equal(first.kind, 'page');
  if (first.kind !== 'page') throw new Error('Pricing revision changed before paging started');

  const overrides = [...first.overrides];
  let nextCursor = first.nextCursor;
  let pageCount = 1;
  while (nextCursor !== null) {
    const result: PricingQueryResult = await client.request('pricing.query', {
      kind: 'continue',
      revision: first.revision,
      cursor: nextCursor,
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') throw new Error('Pricing revision changed during snapshot read');
    assert.equal(result.revision, first.revision);
    overrides.push(...result.overrides);
    nextCursor = result.nextCursor;
    pageCount += 1;
  }
  return { revision: first.revision, overrides, pageCount };
}

function usageRecord(id: string, ts: number, providerId: string, modelId: string) {
  return {
    id,
    providerId,
    modelId,
    inputTokens: 10,
    outputTokens: 5,
    cacheHitInputTokens: 2,
    cacheMissInputTokens: 8,
    cacheMissInputSource: 'explicit' as const,
    cacheWriteInputTokens: 1,
    reasoningTokens: 0,
    totalTokens: 15,
    latencyMs: 25,
    costUsd: 0.01,
    startedAt: ts,
    date: '2026-07-21',
    ts,
    status: 'success' as const,
  };
}

function pricing(modelKey: string, inputUsdPer1M: number, outputUsdPer1M: number): PricingConfig {
  return { modelKey, inputUsdPer1M, outputUsdPer1M };
}

function exactLongPricing(index: number): PricingConfig {
  const prefix = `provider:model-${index.toString().padStart(3, '0')}:`;
  const modelKey = `${prefix}${'\\'.repeat(PRICING_MODEL_KEY_MAX_BYTES - prefix.length)}`;
  assert.equal(Buffer.byteLength(modelKey, 'utf8'), PRICING_MODEL_KEY_MAX_BYTES);
  return pricing(modelKey, index + 1, index + 2);
}

function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
}
