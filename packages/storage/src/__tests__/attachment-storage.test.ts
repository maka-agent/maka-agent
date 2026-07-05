import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createArtifactStore } from '../artifact-store.js';
import { ingestAttachment, readAttachmentBytes } from '../attachment-storage.js';

describe('attachment storage', () => {
  test('ingest writes bytes and returns a session_file ref readable back', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-attach-'));
    try {
      const store = createArtifactStore(workspaceRoot);
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const ref = await ingestAttachment(store, {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        name: 'chart.png',
        mimeType: 'image/png',
        bytes,
      });
      assert.equal(ref.kind, 'session_file');
      assert.equal(ref.sessionId, 'sess-1');
      assert.ok(ref.relativePath.length > 0);

      const result = await readAttachmentBytes(ref, workspaceRoot);
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.bytes, bytes);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('readAttachmentBytes rejects external_file refs (no arbitrary path read)', async () => {
    const result = await readAttachmentBytes(
      { kind: 'external_file', absolutePath: '/etc/passwd' },
      '/tmp/whatever',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unsupported_ref_kind');
  });
});
