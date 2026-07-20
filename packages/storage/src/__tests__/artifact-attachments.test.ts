import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { MAX_READ_IMAGE_BYTES, READ_IMAGE_TOO_LARGE_MESSAGE, type StorageRef } from '@maka/core';
import { createAttachmentByteReader, createReadImageSnapshotter } from '../artifact-attachments.js';
import { createArtifactStore } from '../artifact-store.js';

const pngBytes = (...payload: number[]): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...payload]);

const sessionFileRef = (relativePath: string, sessionId = 's1'): StorageRef => ({
  kind: 'session_file',
  sessionId,
  relativePath,
});

describe('createAttachmentByteReader', () => {
  test('reads live and soft-deleted artifacts through the durable attachment authority', async () => {
    await withStore(async (store) => {
      const liveBytes = pngBytes(1);
      const deletedBytes = pngBytes(2);
      await store.create({
        id: 'live-image',
        sessionId: 's1',
        turnId: 't1',
        name: 'live.png',
        kind: 'image',
        content: liveBytes,
        mimeType: 'image/png',
        source: 'fixture',
      });
      await store.create({
        id: 'deleted-image',
        sessionId: 's1',
        turnId: 't1',
        name: 'deleted.png',
        kind: 'image',
        content: deletedBytes,
        mimeType: 'image/png',
        source: 'fixture',
      });
      await store.delete('deleted-image');

      const reader = createAttachmentByteReader({ artifactStore: store, sessionId: 's1' });
      assert.deepEqual(await reader(sessionFileRef('live-image')), {
        ok: true,
        bytes: Buffer.from(liveBytes),
      });
      assert.deepEqual(await reader(sessionFileRef('deleted-image')), {
        ok: true,
        bytes: Buffer.from(deletedBytes),
      });
    });
  });

  test('rejects refs and artifacts from a different session', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'session-one-image',
        sessionId: 's1',
        turnId: 't1',
        name: 'one.png',
        kind: 'image',
        content: pngBytes(1),
        source: 'fixture',
      });
      await store.create({
        id: 'session-two-image',
        sessionId: 's2',
        turnId: 't2',
        name: 'two.png',
        kind: 'image',
        content: pngBytes(2),
        source: 'fixture',
      });

      const reader = createAttachmentByteReader({ artifactStore: store, sessionId: 's1' });
      assert.deepEqual(await reader(sessionFileRef('session-one-image', 's2')), {
        ok: false,
        reason: 'session_mismatch',
      });
      assert.deepEqual(await reader(sessionFileRef('session-two-image')), {
        ok: false,
        reason: 'session_mismatch',
      });
    });
  });

  test('rejects unsupported refs', async () => {
    await withStore(async (store) => {
      const reader = createAttachmentByteReader({ artifactStore: store, sessionId: 's1' });
      assert.deepEqual(await reader({ kind: 'workspace_file', relativePath: 'image.png' }), {
        ok: false,
        reason: 'unsupported_ref_kind',
      });
    });
  });

  test('passes through bounded durable read failures', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'bounded-image',
        sessionId: 's1',
        turnId: 't1',
        name: 'bounded.png',
        kind: 'image',
        content: pngBytes(1),
        source: 'fixture',
      });

      const reader = createAttachmentByteReader({
        artifactStore: store,
        sessionId: 's1',
        maxBytes: 1,
      });
      assert.deepEqual(await reader(sessionFileRef('bounded-image')), {
        ok: false,
        reason: 'too_large',
      });
    });
  });
});

test('createReadImageSnapshotter durably stores image metadata and bytes', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const bytes = pngBytes(1, 2, 3);
    const ref = await createReadImageSnapshotter(createArtifactStore(workspaceRoot))({
      sessionId: 's1',
      turnId: 't1',
      name: 'image.png',
      bytes,
      mimeType: 'image/png',
    });

    const reopened = createArtifactStore(workspaceRoot);
    const artifact = await reopened.get(ref.relativePath);
    assert.ok(artifact);
    assert.deepEqual(ref, {
      kind: 'session_file',
      sessionId: 's1',
      relativePath: artifact.id,
    });
    assert.deepEqual(
      {
        id: artifact.id,
        sessionId: artifact.sessionId,
        turnId: artifact.turnId,
        name: artifact.name,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        source: artifact.source,
        status: artifact.status,
        sizeBytes: artifact.sizeBytes,
        relativePath: artifact.relativePath,
      },
      {
        id: ref.relativePath,
        sessionId: 's1',
        turnId: 't1',
        name: 'image.png',
        kind: 'image',
        mimeType: 'image/png',
        source: 'tool_result',
        status: 'live',
        sizeBytes: bytes.byteLength,
        relativePath: `s1/${ref.relativePath}-image.png`,
      },
    );

    const payload = await reopened.readBinary(artifact.id);
    if (!payload.ok) assert.fail(`Expected image bytes, received ${payload.reason}`);
    assert.deepEqual(Buffer.from(payload.base64, 'base64'), Buffer.from(bytes));
  });
});

test('createReadImageSnapshotter rejects oversize images before writing to the store', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createArtifactStore(workspaceRoot);

    await assert.rejects(
      createReadImageSnapshotter(store)({
        sessionId: 's1',
        turnId: 't1',
        name: 'large.png',
        bytes: new Uint8Array(MAX_READ_IMAGE_BYTES + 1),
        mimeType: 'image/png',
      }),
      { message: READ_IMAGE_TOO_LARGE_MESSAGE },
    );
    assert.deepEqual(await store.list('s1'), []);
    assert.deepEqual(await readdir(workspaceRoot), []);
  });
});

async function withStore(
  fn: (store: ReturnType<typeof createArtifactStore>) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspaceRoot) => fn(createArtifactStore(workspaceRoot)));
}

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-attachments-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
