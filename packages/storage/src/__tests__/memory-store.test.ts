import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { defaultLocalMemoryMarkdown } from '@maka/core';
import {
  MEMORY_DOCUMENT_FILE,
  MEMORY_DOCUMENT_MAX_BYTES,
  MemoryRevisionConflictError,
  MemoryStoreError,
  MemoryStoreLifecycleError,
  authenticateInteractiveMemoryStoreReader,
  authenticateInteractiveMemoryStoreWriter,
  openInteractiveMemoryStoreForRead,
  openInteractiveMemoryStoreForWrite,
} from '../memory-store.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type InteractiveRootOwner,
  type StorageRootCapability,
} from '../root-authority.js';

const MEMORY_DOCUMENT_DIRECTORY = 'memory';

describe('interactive Memory storage authority', () => {
  test('queries missing, exact UTF-8 documents, and externally edited safe-mode states', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const store = await openInteractiveMemoryStoreForWrite(owner.lease);
      assert.deepEqual(await store.query(), { kind: 'missing', revision: null });

      const exact = Buffer.from('# Memory\r\n\r\nCaf\u00e9\r\n', 'utf8');
      await seedMemoryDocument(root, exact);
      const document = await store.query();
      assert.equal(document.kind, 'document');
      if (document.kind !== 'document') return;
      assert.deepEqual(Buffer.from(document.bytes), exact);
      assert.equal(document.revision, sha256(exact));

      const invalid = Buffer.from([0x23, 0x20, 0x4d, 0x0a, 0xc3, 0x28]);
      await writeFile(memoryDocumentPath(root), invalid);
      const invalidSnapshot = await store.query();
      assert.deepEqual(invalidSnapshot, {
        kind: 'safe_mode',
        reason: 'invalid_utf8',
        revision: sha256(invalid),
        byteLength: invalid.byteLength,
      });
      await assert.rejects(
        () => store.save({ expectedRevision: null, bytes: Buffer.from('# Must conflict\n') }),
        (error: unknown) =>
          error instanceof MemoryRevisionConflictError && error.actualRevision === sha256(invalid),
      );
      assert.equal(invalidSnapshot.kind, 'safe_mode');
      if (invalidSnapshot.kind !== 'safe_mode') return;
      const repaired = Buffer.from('# Explicit repair\n');
      await store.save({ expectedRevision: invalidSnapshot.revision, bytes: repaired });
      assert.deepEqual(await readFile(memoryDocumentPath(root)), repaired);

      const oversized = Buffer.alloc(MEMORY_DOCUMENT_MAX_BYTES + 1, 0x61);
      await writeFile(memoryDocumentPath(root), oversized);
      assert.deepEqual(await store.query(), {
        kind: 'safe_mode',
        reason: 'oversize',
        revision: sha256(oversized),
        byteLength: oversized.byteLength,
      });
    });
  });

  test('uses strict exact-byte CAS across external edits and same-content saves', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const store = await openInteractiveMemoryStoreForWrite(owner.lease);
      const first = Buffer.from('# First\n');
      const committed = await store.save({ expectedRevision: null, bytes: first });
      assert.equal(committed.changed, true);
      assert.equal(committed.document.revision, sha256(first));

      const unchanged = await store.save({
        expectedRevision: committed.document.revision,
        bytes: Uint8Array.from(first),
      });
      assert.equal(unchanged.changed, false);

      const external = Buffer.from('# External edit\r\n');
      await writeFile(memoryDocumentPath(root), external);
      await assert.rejects(
        () =>
          store.save({
            expectedRevision: committed.document.revision,
            bytes: external,
          }),
        (error: unknown) =>
          error instanceof MemoryRevisionConflictError &&
          error.expectedRevision === committed.document.revision &&
          error.actualRevision === sha256(external),
      );
      assert.deepEqual(await readFile(memoryDocumentPath(root)), external);

      const repaired = Buffer.from('# Repaired\n');
      const result = await store.save({ expectedRevision: sha256(external), bytes: repaired });
      assert.equal(result.changed, true);
      assert.deepEqual(await readFile(memoryDocumentPath(root)), repaired);
    });
  });

  test('serializes competing saves so only the matching expected revision commits', async () => {
    await withInteractiveOwner(async ({ owner }) => {
      const store = await openInteractiveMemoryStoreForWrite(owner.lease);
      const initial = await store.save({
        expectedRevision: null,
        bytes: Buffer.from('# Initial\n'),
      });
      const contenders = await Promise.allSettled([
        store.save({ expectedRevision: initial.document.revision, bytes: Buffer.from('# One\n') }),
        store.save({ expectedRevision: initial.document.revision, bytes: Buffer.from('# Two\n') }),
      ]);

      assert.equal(contenders.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = contenders.find((result) => result.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.ok(rejected.reason instanceof MemoryRevisionConflictError);
    });
  });

  test('recovers only strictly named orphan temps and can create the default before Ready', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const orphan = `${MEMORY_DOCUMENT_FILE}.${randomUUID()}.tmp`;
      const foreign = `${MEMORY_DOCUMENT_FILE}.manual.tmp`;
      await mkdir(memoryDirectoryPath(root), { mode: 0o700 });
      await writeFile(join(memoryDirectoryPath(root), orphan), 'orphan');
      await writeFile(join(memoryDirectoryPath(root), foreign), 'keep');

      const store = await openInteractiveMemoryStoreForWrite(owner.lease);
      assert.deepEqual(await store.recover(), { kind: 'missing', revision: null });
      await assert.rejects(() => lstat(join(memoryDirectoryPath(root), orphan)), {
        code: 'ENOENT',
      });
      assert.equal(await readFile(join(memoryDirectoryPath(root), foreign), 'utf8'), 'keep');

      await rm(memoryDirectoryPath(root), { recursive: true });
      const defaultBytes = Buffer.from(defaultLocalMemoryMarkdown(1_700_000_000_000), 'utf8');
      const recovered = await store.recover({ defaultDocument: defaultBytes });
      assert.equal(recovered.kind, 'document');
      assert.deepEqual(await readFile(memoryDocumentPath(root)), defaultBytes);
    });
  });

  test('ordinary readers neither create a missing memory directory nor change an existing one', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      if (!readerHandle) return;
      try {
        const reader = await openInteractiveMemoryStoreForRead(readerHandle.lease);
        assert.strictEqual(authenticateInteractiveMemoryStoreReader(reader), reader);
        const missingRoot = await rootSnapshot(root);
        assert.deepEqual(await reader.query(), { kind: 'missing', revision: null });
        await assert.rejects(() => lstat(memoryDirectoryPath(root)), { code: 'ENOENT' });
        assert.deepEqual(await rootSnapshot(root), missingRoot);

        const bytes = Buffer.from('# Reader visible\n');
        await seedMemoryDocument(root, bytes);
        const before = await rootSnapshot(root);
        const result = await reader.query();
        assert.equal(result.kind, 'document');
        assert.deepEqual(await rootSnapshot(root), before);
      } finally {
        await readerHandle.close();
      }
    });
  });

  test('rejects a symbolic-link memory parent without writing outside the storage root', {
    skip: process.platform === 'win32',
  }, async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-memory-outside-'));
      try {
        const outsideDocument = join(outside, MEMORY_DOCUMENT_FILE);
        await writeFile(outsideDocument, '# Outside\n');
        await symlink(outside, memoryDirectoryPath(root));
        const store = await openInteractiveMemoryStoreForWrite(owner.lease);

        await assert.rejects(
          () => store.query(),
          (error: unknown) =>
            error instanceof MemoryStoreError && error.code === 'invalid_document',
        );
        await assert.rejects(
          () => store.save({ expectedRevision: null, bytes: Buffer.from('# Escaped\n') }),
          (error: unknown) =>
            error instanceof MemoryStoreError && error.code === 'invalid_document',
        );
        assert.equal(await readFile(outsideDocument, 'utf8'), '# Outside\n');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('returns one terminal writer per lease and drains admitted mutations', async () => {
    await withInteractiveOwner(async ({ owner }) => {
      const [store, sameStore] = await Promise.all([
        openInteractiveMemoryStoreForWrite(owner.lease),
        openInteractiveMemoryStoreForWrite(owner.lease),
      ]);
      assert.strictEqual(store, sameStore);
      assert.strictEqual(authenticateInteractiveMemoryStoreWriter(store), store);

      const accepted = store.save({
        expectedRevision: null,
        bytes: Buffer.alloc(MEMORY_DOCUMENT_MAX_BYTES, 0x61),
      });
      const drained = store.beginDrain();
      await assert.rejects(
        () => store.save({ expectedRevision: null, bytes: Buffer.from('rejected') }),
        (error: unknown) => error instanceof MemoryStoreLifecycleError && error.code === 'draining',
      );
      await drained;
      assert.equal((await accepted).changed, true);
      await store.close();
      assert.strictEqual(await openInteractiveMemoryStoreForWrite(owner.lease), store);
      assert.throws(
        () => store.query(),
        (error: unknown) => error instanceof MemoryStoreLifecycleError && error.code === 'closed',
      );
    });
  });
});

async function withInteractiveOwner(
  run: (input: { root: string; owner: InteractiveRootOwner }) => Promise<void>,
): Promise<void> {
  await withInteractiveRoot(async ({ root, capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      await run({ root, owner });
    } finally {
      if (!owner.closed) await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: { root: string; capability: StorageRootCapability<'interactive'> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-memory-store-'));
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rootSnapshot(root: string): Promise<readonly unknown[]> {
  const entries = (await readdir(root)).sort();
  return Promise.all(
    entries.map(async (entry) => {
      const metadata = await stat(join(root, entry));
      return [entry, metadata.size, metadata.mtimeMs, metadata.mode];
    }),
  );
}

async function seedMemoryDocument(root: string, bytes: Uint8Array): Promise<void> {
  await mkdir(memoryDirectoryPath(root), { mode: 0o700 });
  await writeFile(memoryDocumentPath(root), bytes);
}

function memoryDirectoryPath(root: string): string {
  return join(root, MEMORY_DOCUMENT_DIRECTORY);
}

function memoryDocumentPath(root: string): string {
  return join(memoryDirectoryPath(root), MEMORY_DOCUMENT_FILE);
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
