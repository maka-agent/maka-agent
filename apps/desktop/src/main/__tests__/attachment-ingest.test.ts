import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createArtifactStore } from '@maka/storage';
import { ingestAttachments } from '../attachment-ingest.js';

describe('ingestAttachments', () => {
  test('image: resizes, snapshots to ArtifactStore, returns session_file ref', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-img-'));
    try {
      const store = createArtifactStore(dir);
      const imagePath = join(dir, 'screen.png');
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      await writeFile(imagePath, imageBytes);
      let resizeCalls = 0;
      const refs = await ingestAttachments({
        files: [{ path: imagePath, mimeType: 'image/png', size: imageBytes.length }],
        cwd: dir,
        sessionId: 's1',
        artifactStore: store,
        resizeImage: async (b) => {
          resizeCalls += 1;
          return b;
        },
      });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, 'image');
      assert.equal(refs[0].mimeType, 'image/png');
      assert.equal(refs[0].ref.kind, 'session_file');
      assert.equal(resizeCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('workspace non-image: returns workspace_file ref without copying or resizing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-ws-'));
    try {
      const store = createArtifactStore(dir);
      const codePath = join(dir, 'main.ts');
      const codeBytes = Buffer.from('const x = 1;');
      await writeFile(codePath, codeBytes);
      let resizeCalls = 0;
      let storeCreates = 0;
      const realCreate = store.create.bind(store);
      store.create = async (input) => {
        storeCreates += 1;
        return realCreate(input);
      };
      const refs = await ingestAttachments({
        files: [{ path: codePath, mimeType: 'text/typescript', size: codeBytes.length }],
        cwd: dir,
        sessionId: 's1',
        artifactStore: store,
        resizeImage: async (b) => {
          resizeCalls += 1;
          return b;
        },
      });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, 'other');
      assert.equal(refs[0].ref.kind, 'workspace_file');
      assert.equal((refs[0].ref as { relativePath: string }).relativePath, 'main.ts');
      assert.equal(resizeCalls, 0);
      assert.equal(storeCreates, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('external non-image: snapshots to ArtifactStore without resizing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-ext-'));
    try {
      const store = createArtifactStore(dir);
      const externalPath = join(tmpdir(), `external-${Date.now()}.pdf`);
      const pdfBytes = Buffer.from('%PDF-1.4 fake');
      await writeFile(externalPath, pdfBytes);
      let resizeCalls = 0;
      const refs = await ingestAttachments({
        files: [{ path: externalPath, mimeType: 'application/pdf', size: pdfBytes.length }],
        cwd: dir,
        sessionId: 's1',
        artifactStore: store,
        resizeImage: async (b) => {
          resizeCalls += 1;
          return b;
        },
      });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, 'pdf');
      assert.equal(refs[0].ref.kind, 'session_file');
      assert.equal(resizeCalls, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
