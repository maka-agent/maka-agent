import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ATTACHMENT_BYTES, type ArtifactBinaryReadResult, type StorageRef } from '@maka/core';
import type { ArtifactStore } from '../artifact-store.js';
import { createAttachmentByteReader, createReadImageSnapshotter } from '../artifact-attachments.js';

function fakeArtifactStore(
  readBinary: ArtifactStore['readBinary'],
  artifactSessionId = 's1',
): ArtifactStore {
  return {
    readBinary,
    get: async (id: string) => ({ id, sessionId: artifactSessionId }),
  } as unknown as ArtifactStore;
}

const sessionFileRef = (relativePath: string, sessionId = 's1'): StorageRef => ({
  kind: 'session_file',
  sessionId,
  relativePath,
});

describe('createAttachmentByteReader', () => {
  test('reads session_file bytes with the shared attachment limit', async () => {
    let maxBytes: number | undefined;
    const store = fakeArtifactStore(async (_id, options): Promise<ArtifactBinaryReadResult> => {
      maxBytes = options?.maxBytes;
      return { ok: true, base64: Buffer.from('hello').toString('base64'), mimeType: 'image/png' };
    });

    const result = await createAttachmentByteReader({ artifactStore: store, sessionId: 's1' })(
      sessionFileRef('art-1'),
    );

    assert.deepEqual(result, { ok: true, bytes: Buffer.from('hello') });
    assert.equal(maxBytes, MAX_ATTACHMENT_BYTES);
  });

  test('rejects refs and artifacts from a different session', async () => {
    const readBinary = async (): Promise<ArtifactBinaryReadResult> => ({
      ok: true,
      base64: '',
      mimeType: 'image/png',
    });
    const reader = createAttachmentByteReader({
      artifactStore: fakeArtifactStore(readBinary),
      sessionId: 's1',
    });
    assert.deepEqual(await reader(sessionFileRef('art-1', 'other')), {
      ok: false,
      reason: 'session_mismatch',
    });

    const otherArtifactReader = createAttachmentByteReader({
      artifactStore: fakeArtifactStore(readBinary, 'other'),
      sessionId: 's1',
    });
    assert.deepEqual(await otherArtifactReader(sessionFileRef('art-1')), {
      ok: false,
      reason: 'session_mismatch',
    });
  });

  test('rejects unsupported refs and passes through store failures', async () => {
    const reader = createAttachmentByteReader({
      artifactStore: fakeArtifactStore(async () => ({ ok: false, reason: 'too_large' })),
      sessionId: 's1',
    });
    assert.deepEqual(await reader({ kind: 'workspace_file', relativePath: 'image.png' }), {
      ok: false,
      reason: 'unsupported_ref_kind',
    });
    assert.deepEqual(await reader(sessionFileRef('art-1')), { ok: false, reason: 'too_large' });
  });
});

test('createReadImageSnapshotter stores a tool-result image and returns its session ref', async () => {
  let created: unknown;
  const store = {
    create: async (input: unknown) => {
      created = input;
      return { id: 'artifact-1' };
    },
  } as unknown as ArtifactStore;
  const bytes = new Uint8Array([1, 2, 3]);

  const ref = await createReadImageSnapshotter(store)({
    sessionId: 's1',
    turnId: 't1',
    name: 'image.png',
    bytes,
    mimeType: 'image/png',
  });

  assert.deepEqual(ref, { kind: 'session_file', sessionId: 's1', relativePath: 'artifact-1' });
  assert.deepEqual(created, {
    sessionId: 's1',
    turnId: 't1',
    name: 'image.png',
    kind: 'image',
    content: bytes,
    mimeType: 'image/png',
    source: 'tool_result',
  });
});

test('createReadImageSnapshotter rejects images above the provider-safe limit before storing', async () => {
  let creates = 0;
  const store = {
    create: async () => {
      creates += 1;
      return { id: 'artifact-1' };
    },
  } as unknown as ArtifactStore;

  await assert.rejects(
    createReadImageSnapshotter(store)({
      sessionId: 's1',
      turnId: 't1',
      name: 'large.png',
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
      mimeType: 'image/png',
    }),
    /Image exceeds the 5MB model input limit; downscale it and try again/,
  );
  assert.equal(creates, 0);
});
