import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ArtifactBinaryReadResult, StorageRef } from '@maka/core';
import type { ArtifactStore } from '@maka/storage';
import { createAttachmentByteReader } from '../attachment-reader.js';

function fakeArtifactStore(readBinary: ArtifactStore['readBinary']): ArtifactStore {
  return { readBinary } as unknown as ArtifactStore;
}

const sessionFileRef = (relativePath: string, sessionId = 's1'): StorageRef => ({
  kind: 'session_file',
  sessionId,
  relativePath,
});

describe('createAttachmentByteReader', () => {
  test('reads session_file attachment bytes and decodes base64', async () => {
    const store = fakeArtifactStore(
      async (): Promise<ArtifactBinaryReadResult> => ({
        ok: true,
        base64: Buffer.from('hello').toString('base64'),
        mimeType: 'image/png',
      }),
    );
    const reader = createAttachmentByteReader({ artifactStore: store, sessionId: 's1' });
    const result = await reader(sessionFileRef('art-1'));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(Array.from(result.bytes), Array.from(Buffer.from('hello')));
    }
  });

  test('rejects refs from a different session', async () => {
    const store = fakeArtifactStore(
      async (): Promise<ArtifactBinaryReadResult> => ({ ok: true, base64: '', mimeType: 'image/png' }),
    );
    const reader = createAttachmentByteReader({ artifactStore: store, sessionId: 's1' });
    const result = await reader(sessionFileRef('art-1', 'other'));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'session_mismatch');
  });

  test('rejects non-session_file refs', async () => {
    const store = fakeArtifactStore(
      async (): Promise<ArtifactBinaryReadResult> => ({ ok: true, base64: '', mimeType: 'image/png' }),
    );
    const reader = createAttachmentByteReader({ artifactStore: store, sessionId: 's1' });
    const result = await reader({ kind: 'workspace_file', relativePath: 'src/main.ts' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unsupported_ref_kind');
  });

  test('passes through ArtifactStore read failure reason', async () => {
    const store = fakeArtifactStore(
      async (): Promise<ArtifactBinaryReadResult> => ({ ok: false, reason: 'too_large' }),
    );
    const reader = createAttachmentByteReader({ artifactStore: store, sessionId: 's1' });
    const result = await reader(sessionFileRef('art-1'));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'too_large');
  });
});
