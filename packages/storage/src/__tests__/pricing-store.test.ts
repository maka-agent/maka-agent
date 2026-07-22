import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  createPricingStore,
  PricingRevisionConflictError,
  PricingStorePublicationError,
  PricingValidationError,
} from '../pricing-store.js';

describe('FilePricingStore', () => {
  test('serializes same-revision CAS and persists exactly one winner', async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);
      await store.load();

      const outcomes = await Promise.allSettled([
        store.upsert(0, pricing('openai:gpt-5', 1)),
        store.upsert(0, pricing('anthropic:claude', 2)),
      ]);
      const committed = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof store.upsert>>> =>
          outcome.status === 'fulfilled',
      );
      const conflicts = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      assert.equal(committed.length, 1);
      assert.equal(committed[0]?.value.changed, true);
      assert.equal(committed[0]?.value.snapshot.revision, 1);
      assert.equal(conflicts.length, 1);
      assert.ok(conflicts[0]?.reason instanceof PricingRevisionConflictError);
      const winner = committed[0]!.value.snapshot.overrides[0];
      await store.close();

      const reopened = createPricingStore(root, { createIfMissing: false });
      await reopened.load();
      assert.deepEqual(reopened.snapshot(), { revision: 1, overrides: [winner] });
      await reopened.close();
    });
  });

  test('returns deeply frozen snapshots', async () => {
    await withStore(async (store) => {
      await store.upsert(0, pricing('openai:gpt-5', 1));
      const snapshot = store.snapshot();

      assert.ok(Object.isFrozen(snapshot));
      assert.ok(Object.isFrozen(snapshot.overrides));
      assert.ok(Object.isFrozen(snapshot.overrides[0]));
    });
  });

  test('no-op upsert and delete preserve revision, bytes, inode, and mtime', async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);
      await store.load();
      await store.upsert(0, pricing('openai:gpt-5', 1));
      const path = join(root, 'pricing.json');
      const beforeBytes = await readFile(path, 'utf8');
      const before = await stat(path, { bigint: true });

      const same = await store.upsert(1, pricing('  openai:gpt-5  ', 1));
      const missing = await store.delete(1, 'missing:model');

      assert.deepEqual(
        [same.committed, same.changed, missing.committed, missing.changed],
        [false, false, false, false],
      );
      assert.equal(store.snapshot().revision, 1);
      assert.equal(await readFile(path, 'utf8'), beforeBytes);
      const after = await stat(path, { bigint: true });
      assert.equal(after.ino, before.ino);
      assert.equal(after.mtimeNs, before.mtimeNs);
      await store.close();
    });
  });

  test('pre-commit failure preserves memory and permits same-revision retry after repair', async () => {
    await withRoot(async (root) => {
      const store = createPricingStore(root);
      await store.load();
      const path = join(root, 'pricing.json');
      await rm(path);
      await mkdir(path);

      await assert.rejects(
        () => store.upsert(0, pricing('openai:gpt-5', 1)),
        PricingStorePublicationError,
      );
      assert.deepEqual(store.snapshot(), { revision: 0, overrides: [] });

      await rm(path, { recursive: true });
      const retried = await store.upsert(0, pricing('openai:gpt-5', 1));
      assert.equal(retried.changed, true);
      assert.equal(retried.snapshot.revision, 1);
      await store.close();
    });
  });

  test('fails closed on malformed or noncanonical documents', async () => {
    const documents: Array<[string, string]> = [
      ['corrupt', '{"version":1'],
      ['wrong-version', JSON.stringify({ version: 2, revision: 0, overrides: [] })],
      ['unknown-field', JSON.stringify({ version: 1, revision: 0, overrides: [], legacy: true })],
      [
        'unknown-override-field',
        JSON.stringify({
          version: 1,
          revision: 0,
          overrides: [{ ...pricing('openai:gpt-5', 1), legacy: true }],
        }),
      ],
      [
        'duplicate-key',
        JSON.stringify({
          version: 1,
          revision: 0,
          overrides: [pricing('openai:gpt-5', 1), pricing('  openai:gpt-5  ', 2)],
        }),
      ],
      [
        'invalid-rate',
        JSON.stringify({
          version: 1,
          revision: 0,
          overrides: [{ ...pricing('openai:gpt-5', 1), inputUsdPer1M: -1 }],
        }),
      ],
      [
        'over-cap',
        JSON.stringify({
          version: 1,
          revision: 0,
          overrides: Array.from({ length: 129 }, (_, index) => pricing(`model:${index}`, 1)),
        }),
      ],
    ];

    for (const [label, bytes] of documents) {
      await withRoot(async (root) => {
        const path = join(root, 'pricing.json');
        await writeFile(path, bytes, 'utf8');
        const store = createPricingStore(root, { createIfMissing: false });
        await assert.rejects(
          () => store.load(),
          label === 'corrupt' ? SyntaxError : PricingValidationError,
          label,
        );
        assert.equal(await readFile(path, 'utf8'), bytes);
        await store.close();
      });
    }
  });

  test('rejects an out-of-range revision', async () => {
    await withRoot(async (root) => {
      const path = join(root, 'pricing.json');
      const invalid = JSON.stringify({
        version: 1,
        revision: Number.MAX_SAFE_INTEGER + 1,
        overrides: [],
      });
      await writeFile(path, invalid, 'utf8');
      const store = createPricingStore(root, { createIfMissing: false });
      await assert.rejects(() => store.load(), PricingValidationError);
      assert.equal(await readFile(path, 'utf8'), invalid);
      await store.close();
    });
  });
});

async function withStore(run: (store: ReturnType<typeof createPricingStore>) => Promise<void>) {
  await withRoot(async (root) => {
    const store = createPricingStore(root);
    await store.load();
    try {
      await run(store);
    } finally {
      await store.close();
    }
  });
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-pricing-store-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function pricing(modelKey: string, rate: number) {
  return { modelKey, inputUsdPer1M: rate, outputUsdPer1M: rate * 2 };
}
