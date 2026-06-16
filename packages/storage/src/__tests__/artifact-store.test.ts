import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import {
  ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES,
  createArtifactStore,
  isSafeRelativeArtifactPath,
  resolveArtifactPath,
  sanitizeArtifactName,
} from '../artifact-store.js';

describe('FileArtifactStore', () => {
  test('creates file-backed records and lists live artifacts newest first', async () => {
    await withStore(async (store) => {
      const first = await store.create({
        id: 'artifact-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'notes.md',
        kind: 'file',
        content: '# Notes',
        mimeType: 'text/markdown',
        source: 'fixture',
        now: 100,
      });
      const second = await store.create({
        id: 'artifact-2',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'patch.diff',
        kind: 'diff',
        content: 'diff --git a/a b/a',
        mimeType: 'text/x-diff',
        source: 'tool_result',
        now: 200,
      });

      assert.equal(first.relativePath, 'session-1/artifact-1-notes.md');
      assert.equal(first.sizeBytes, 7);
      assert.equal(second.relativePath, 'session-1/artifact-2-patch.diff');

      const rows = await store.list('session-1');
      assert.deepEqual(rows.map((record) => record.id), ['artifact-2', 'artifact-1']);
      assert.equal((await store.get('artifact-1'))?.name, 'notes.md');
      assert.deepEqual(await store.readText('artifact-1'), { ok: true, text: '# Notes' });
    });
  });

  test('persists records across store instances', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const first = createArtifactStore(workspaceRoot);
      await first.create({
        id: 'artifact-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'report.html',
        kind: 'html',
        content: '<h1>Report</h1>',
        now: 100,
      });

      const second = createArtifactStore(workspaceRoot);
      assert.equal((await second.get('artifact-1'))?.relativePath, 'session-1/artifact-1-report.html');
      assert.deepEqual(await second.readText('artifact-1'), { ok: true, text: '<h1>Report</h1>' });
    });
  });

  test('persists archived tool-result artifacts by id', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const first = createArtifactStore(workspaceRoot);
      await first.create({
        id: 'archive-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'tool-result-evt-1.json',
        kind: 'file',
        content: '{"kind":"json","value":{"ok":true}}',
        mimeType: 'application/json',
        source: 'tool_result_archive',
        now: 100,
      });

      const second = createArtifactStore(workspaceRoot);
      const record = await second.get('archive-1');
      assert.equal(record?.source, 'tool_result_archive');
      assert.equal(record?.sizeBytes, 35);
      assert.deepEqual(await second.readText('archive-1'), {
        ok: true,
        text: '{"kind":"json","value":{"ok":true}}',
      });
    });
  });

  test('soft delete hides rows and blocks reads without purging file bytes', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'artifact-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'report.html',
        kind: 'html',
        content: '<h1>Still on disk</h1>',
      });

      await store.delete('artifact-1');

      assert.deepEqual(await store.list('session-1'), []);
      const [deleted] = await store.list('session-1', { includeDeleted: true });
      assert.equal(deleted?.status, 'deleted');
      assert.deepEqual(await store.readText('artifact-1'), { ok: false, reason: 'deleted' });
      assert.deepEqual(await store.readBinary('artifact-1'), { ok: false, reason: 'deleted' });
    });
  });

  test('returns too_large for text previews over the configured limit', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'artifact-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'large.txt',
        kind: 'file',
        content: 'x'.repeat(ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES + 1),
      });

      assert.deepEqual(await store.readText('artifact-1'), { ok: false, reason: 'too_large' });
    });
  });

  test('readBinary only returns allowlisted sniffed MIME types', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'png',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'image.png',
        kind: 'image',
        content: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mimeType: 'application/octet-stream',
      });
      await store.create({
        id: 'unknown',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'binary.bin',
        kind: 'file',
        content: Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
        mimeType: 'image/png',
      });

      const png = await store.readBinary('png');
      assert.equal(png.ok, true);
      assert.equal(png.ok ? png.mimeType : '', 'image/png');
      assert.deepEqual(await store.readBinary('unknown'), { ok: false, reason: 'unsupported_mime' });
    });
  });

  test('rejects absolute, traversal, URL-like, and empty relative paths', () => {
    assert.equal(isSafeRelativeArtifactPath('session-1/artifact.txt'), true);
    for (const value of ['', '/tmp/file', '../file', 'session/../file', 'file:///tmp/a', 'http://example.test/a', 'session//file']) {
      assert.equal(isSafeRelativeArtifactPath(value), false, value);
    }
  });

  test('path guard rejects symlink escapes from artifact root', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-store-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-outside-'));
    try {
      const artifactRoot = join(workspaceRoot, 'artifacts');
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
      await symlink(outsideRoot, join(artifactRoot, 'session-1'));

      assert.deepEqual(
        await resolveArtifactPath({ artifactRoot, relativePath: 'session-1/secret.txt' }),
        { ok: false, reason: 'not_allowed' },
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('sanitizes unsafe artifact names for file-backed storage', () => {
    assert.equal(sanitizeArtifactName('../bad:name?.html'), 'bad-name-.html');
    assert.equal(sanitizeArtifactName('   '), 'artifact');
  });
});

async function withStore(
  fn: (store: ReturnType<typeof createArtifactStore>, workspaceRoot: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspaceRoot) => fn(createArtifactStore(workspaceRoot), workspaceRoot));
}

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-store-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
