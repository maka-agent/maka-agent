import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '../root-authority.js';
import {
  PricingRevisionConflictError,
  PricingStorePublicationError,
  PricingValidationError,
} from '../pricing-store.js';
import { TelemetryRepoPublicationError } from '../telemetry-repo.js';
import {
  openInteractiveUsageStoresForRead,
  openInteractiveUsageStoresForWrite,
  InteractiveUsageStoresClosedError,
  type InteractiveUsageStoresWriter,
} from '../usage-stores.js';

describe('interactive usage stores', () => {
  test('opens one writer per lease and publishes separate telemetry and pricing documents', async () => {
    await withInteractiveUsageWriter(async ({ root, owner, stores }) => {
      assert.equal(await openInteractiveUsageStoresForWrite(owner.lease), stores);

      await stores.telemetry.recordLlmCall(llmRecord({ id: 'usage_guarded' }));
      const committed = await stores.pricing.upsert(0, pricing('openai:gpt-5'));
      await stores.flush();

      const telemetry = JSON.parse(await readFile(join(root, 'telemetry.json'), 'utf8')) as {
        version: number;
        usageRecords: Array<{ id: string }>;
      };
      const pricingDocument = JSON.parse(await readFile(join(root, 'pricing.json'), 'utf8')) as {
        revision: number;
        overrides: Array<{ modelKey: string }>;
      };
      assert.equal(telemetry.version, 1);
      assert.equal(telemetry.usageRecords[0]?.id, 'usage_guarded');
      assert.equal(committed.snapshot.revision, 1);
      assert.equal(pricingDocument.revision, 1);
      assert.equal(pricingDocument.overrides[0]?.modelKey, 'openai:gpt-5');
    });
  });

  test('pricing mutation does not touch telemetry and telemetry record does not touch pricing', async () => {
    await withInteractiveUsageWriter(async ({ root, stores }) => {
      const telemetryPath = join(root, 'telemetry.json');
      const pricingPath = join(root, 'pricing.json');
      const telemetryBefore = await fileIdentity(telemetryPath);

      await stores.pricing.upsert(0, pricing('openai:gpt-5'));
      assert.deepEqual(await fileIdentity(telemetryPath), telemetryBefore);
      const pricingBefore = await fileIdentity(pricingPath);

      await stores.telemetry.recordLlmCall(llmRecord({ id: 'usage_isolated' }));
      assert.deepEqual(await fileIdentity(pricingPath), pricingBefore);
    });
  });

  test('read lease observes empty snapshots without creating either document', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      if (!readerHandle) return;
      try {
        const stores = await openInteractiveUsageStoresForRead(readerHandle.lease);
        assert.deepEqual(stores.telemetry.logs({ range: 'all' }), { rows: [], total: 0 });
        assert.deepEqual(stores.pricing.snapshot(), { revision: 0, overrides: [] });
        await assert.rejects(() => readFile(join(root, 'telemetry.json')), isEnoent);
        await assert.rejects(() => readFile(join(root, 'pricing.json')), isEnoent);
        await stores.close();
      } finally {
        if (!readerHandle.closed) await readerHandle.close();
      }
    });
  });

  test('drain and close preserve accepted operations in both domains', async () => {
    await withInteractiveUsageWriter(async ({ root, stores }) => {
      const telemetry = stores.telemetry.recordLlmCall(llmRecord({ id: 'usage_before_drain' }));
      const pricingMutation = stores.pricing.upsert(0, pricing('openai:gpt-5'));
      const drained = stores.beginDrain();
      const closed = stores.close();

      assert.equal(stores.close(), closed);
      assert.throws(
        () => stores.telemetry.recordLlmCall(llmRecord({ id: 'usage_after_drain' })),
        InteractiveUsageStoresClosedError,
      );
      assert.throws(
        () => stores.pricing.delete(0, 'openai:gpt-5'),
        InteractiveUsageStoresClosedError,
      );
      await Promise.all([telemetry, pricingMutation, drained, closed]);

      const telemetryDocument = JSON.parse(
        await readFile(join(root, 'telemetry.json'), 'utf8'),
      ) as { usageRecords: Array<{ id: string }> };
      const pricingDocument = JSON.parse(await readFile(join(root, 'pricing.json'), 'utf8')) as {
        revision: number;
      };
      assert.deepEqual(
        telemetryDocument.usageRecords.map((record) => record.id),
        ['usage_before_drain'],
      );
      assert.equal(pricingDocument.revision, 1);
    });
  });

  test('pricing conflict is a call result and does not poison close', async () => {
    await withInteractiveUsageWriter(async ({ root, stores }) => {
      const outcomes = await Promise.allSettled([
        stores.pricing.upsert(0, pricing('openai:gpt-5')),
        stores.pricing.upsert(0, pricing('anthropic:claude')),
      ]);
      const winner = outcomes.find(
        (
          outcome,
        ): outcome is PromiseFulfilledResult<
          Awaited<ReturnType<InteractiveUsageStoresWriter['pricing']['upsert']>>
        > => outcome.status === 'fulfilled',
      );
      const conflict = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );

      assert.ok(winner);
      assert.ok(conflict?.reason instanceof PricingRevisionConflictError);
      await assert.rejects(
        () => stores.pricing.upsert(1, { ...pricing('invalid:model'), inputUsdPer1M: -1 }),
        PricingValidationError,
      );
      await stores.beginDrain();
      await stores.close();

      const persisted = JSON.parse(await readFile(join(root, 'pricing.json'), 'utf8')) as {
        revision: number;
        overrides: Array<{ modelKey: string }>;
      };
      assert.equal(persisted.revision, 1);
      assert.deepEqual(persisted.overrides, winner.value.snapshot.overrides);
    });
  });

  test('telemetry failure does not block pricing mutation or pricing-independent flush', async () => {
    await withInteractiveUsageWriter(async ({ root, stores }) => {
      const telemetryPath = join(root, 'telemetry.json');
      await rm(telemetryPath);
      await mkdir(telemetryPath);

      await assert.rejects(
        () => stores.telemetry.recordLlmCall(llmRecord({ id: 'usage_write_error' })),
        TelemetryRepoPublicationError,
      );
      const pricingResult = await stores.pricing.upsert(0, pricing('openai:gpt-5'));
      assert.equal(pricingResult.changed, true);
      assert.equal(stores.pricing.snapshot().revision, 1);
      await assert.rejects(() => stores.flush(), TelemetryRepoPublicationError);
    }, true);
  });

  test('pricing failure does not block telemetry mutation or telemetry flush', async () => {
    await withInteractiveUsageWriter(async ({ root, stores }) => {
      const pricingPath = join(root, 'pricing.json');
      await rm(pricingPath);
      await mkdir(pricingPath);

      await assert.rejects(
        () => stores.pricing.upsert(0, pricing('openai:gpt-5')),
        PricingStorePublicationError,
      );
      await stores.telemetry.recordLlmCall(llmRecord({ id: 'usage_after_pricing_failure' }));
      await stores.flush();
      assert.equal(stores.telemetry.logs({ range: 'all' }).total, 1);
    }, true);
  });

  test('revoked writer lease rejects a new record before filesystem mutation', async () => {
    await withInteractiveUsageWriter(async ({ root, owner, stores }) => {
      owner.beginClose();

      await assert.rejects(
        () => stores.telemetry.recordLlmCall(llmRecord({ id: 'usage_after_owner_close' })),
        isInvalidLease,
      );
      const persisted = JSON.parse(await readFile(join(root, 'telemetry.json'), 'utf8')) as {
        usageRecords: unknown[];
      };
      assert.deepEqual(persisted.usageRecords, []);
    }, true);
  });
});

async function withInteractiveUsageWriter(
  run: (input: {
    root: string;
    owner: NonNullable<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>>;
    stores: InteractiveUsageStoresWriter;
  }) => Promise<void>,
  expectCloseFailure = false,
): Promise<void> {
  await withInteractiveRoot(async ({ root, capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);
    try {
      await run({ root, owner, stores });
    } finally {
      const closing = stores.close();
      if (expectCloseFailure) await assert.rejects(() => closing);
      else await closing;
      if (!owner.closed) await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-usage-stores-'));
  try {
    const root = join(base, 'interactive');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function fileIdentity(path: string) {
  const [bytes, metadata] = await Promise.all([
    readFile(path, 'utf8'),
    stat(path, { bigint: true }),
  ]);
  return { bytes, ino: metadata.ino, mtimeNs: metadata.mtimeNs };
}

function llmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage_1',
    providerId: 'openai',
    modelId: 'gpt-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 100,
    ...overrides,
  } as Parameters<InteractiveUsageStoresWriter['telemetry']['recordLlmCall']>[0];
}

function pricing(modelKey: string) {
  return { modelKey, inputUsdPer1M: 1.25, outputUsdPer1M: 10 };
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
