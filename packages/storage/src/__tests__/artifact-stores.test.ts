import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  ArtifactStoreLifecycleError,
  authenticateInteractiveArtifactStoreReader,
  authenticateInteractiveArtifactStoreWriter,
  openInteractiveArtifactStoreForRead,
  openInteractiveArtifactStoreForWrite,
} from '../artifact-stores.js';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootLease,
} from '../root-authority.js';

describe('interactive artifact store authority', () => {
  test('requires an authentic interactive lease before opening a facade', async () => {
    await withTemporaryRoot('headless', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'headless' });
      const lease = createHeadlessRootLease(capability, 'write');

      await assert.rejects(
        () =>
          openInteractiveArtifactStoreForWrite(
            lease as unknown as StorageRootLease<'interactive', 'write'>,
          ),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
    });
  });

  test('returns one writer per lease and keeps a closed writer terminal', async () => {
    await withInteractiveOwner(async (owner) => {
      const [first, second] = await Promise.all([
        openInteractiveArtifactStoreForWrite(owner.lease),
        openInteractiveArtifactStoreForWrite(owner.lease),
      ]);

      assert.strictEqual(first, second);
      assert.strictEqual(authenticateInteractiveArtifactStoreWriter(first), first);
      await first.close();
      assert.strictEqual(await openInteractiveArtifactStoreForWrite(owner.lease), first);
      await assert.rejects(
        () => first.create(artifactInput('after-close', 'after close')),
        (error: unknown) => error instanceof ArtifactStoreLifecycleError && error.code === 'closed',
      );
    });
  });

  test('drain seals mutation admission and waits for an accepted filesystem write', async () => {
    await withInteractiveOwner(async (owner) => {
      const writer = await openInteractiveArtifactStoreForWrite(owner.lease);
      const accepted = writer.create(
        artifactInput('accepted', new Uint8Array(16 * 1024 * 1024).fill(0x61)),
      );
      const drained = writer.beginDrain();

      await assert.rejects(
        () => writer.create(artifactInput('rejected', 'must not be written')),
        (error: unknown) =>
          error instanceof ArtifactStoreLifecycleError && error.code === 'draining',
      );
      await drained;
      assert.equal((await writer.get('accepted'))?.sizeBytes, 16 * 1024 * 1024);
      const record = await accepted;
      assert.equal(record.sizeBytes, 16 * 1024 * 1024);
      const read = await writer.readText(record.id, { maxBytes: record.sizeBytes });
      assert.equal(read.ok, true);
      assert.equal(read.ok ? read.text.length : 0, record.sizeBytes);
      await writer.close();
    });
  });

  test('guards every facade operation with the live root lease', async () => {
    await withInteractiveOwner(async (owner) => {
      const writer = await openInteractiveArtifactStoreForWrite(owner.lease);
      await writer.create(artifactInput('before-close', 'published'));
      owner.beginClose();

      await assert.rejects(
        () => writer.list('session-1'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
    });
  });

  test('opens a read-only facade under a shared reader lease', async () => {
    await withTemporaryRoot('interactive', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const writer = await openInteractiveArtifactStoreForWrite(owner.lease);
      await writer.create(artifactInput('published', 'reader-visible'));
      const attachmentBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await writer.create({
        ...artifactInput('deleted-attachment', attachmentBytes),
        name: 'deleted-attachment.png',
        kind: 'image',
      });
      await writer.delete('deleted-attachment');
      assert.equal(
        (
          await writer.readDurableAttachmentBinary({
            artifactId: 'deleted-attachment',
            sessionId: 'session-1',
          })
        ).ok,
        true,
      );
      assert.deepEqual(
        await writer.readDurableAttachmentBinary({
          artifactId: 'deleted-attachment',
          sessionId: 'other-session',
        }),
        { ok: false, reason: 'session_mismatch' },
      );
      await writer.close();
      await owner.close();

      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      try {
        const reader = await openInteractiveArtifactStoreForRead(readerHandle.lease);
        assert.strictEqual(authenticateInteractiveArtifactStoreReader(reader), reader);
        assert.deepEqual(await reader.readText('published'), {
          ok: true,
          text: 'reader-visible',
        });
        assert.deepEqual(await reader.readBinary('deleted-attachment'), {
          ok: false,
          reason: 'deleted',
        });
      } finally {
        await readerHandle.close();
      }
    });
  });
});

function artifactInput(id: string, content: string | Uint8Array) {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    name: `${id}.txt`,
    kind: 'file' as const,
    content,
    now: 1,
  };
}

async function withInteractiveOwner(
  run: (
    owner: NonNullable<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>>,
  ) => Promise<void>,
): Promise<void> {
  await withTemporaryRoot('interactive', async (root) => {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      await run(owner);
    } finally {
      await owner.close();
    }
  });
}

async function withTemporaryRoot(
  kind: 'interactive' | 'headless',
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `maka-artifact-${kind}-`));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
