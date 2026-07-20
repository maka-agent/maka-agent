import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { createAttachmentByteReader } from '../artifact-attachments.js';
import {
  ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES,
  createArtifactStore,
  isSafeRelativeArtifactPath,
  resolveArtifactPath,
  sanitizeArtifactName,
} from '../artifact-store.js';

describe('FileArtifactStore', () => {
  test('creates file-backed records and lists live artifacts newest first', async () => {
    await withStore(async (store, workspaceRoot) => {
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
      assert.deepEqual(
        rows.map((record) => record.id),
        ['artifact-2', 'artifact-1'],
      );
      assert.equal((await store.get('artifact-1'))?.name, 'notes.md');
      assert.deepEqual(await store.readText('artifact-1'), { ok: true, text: '# Notes' });
      const entries = await readdir(join(workspaceRoot, 'artifacts', 'session-1'));
      assert.equal(
        entries.some((entry) => entry.endsWith('.tmp')),
        false,
      );
      const metadata = await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8');
      assert.match(metadata, /"id":"artifact-2"/);
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
        source: 'deep_research',
        deepResearchRole: 'report',
        now: 100,
      });

      const second = createArtifactStore(workspaceRoot);
      assert.equal(
        (await second.get('artifact-1'))?.relativePath,
        'session-1/artifact-1-report.html',
      );
      assert.equal((await second.get('artifact-1'))?.deepResearchRole, 'report');
      assert.deepEqual(await second.readText('artifact-1'), { ok: true, text: '<h1>Report</h1>' });
    });
  });

  test('missing metadata reads and no-op mutations leave the manifest and mtimes unchanged', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const before = await recursiveManifest(workspaceRoot);
      const store = createArtifactStore(workspaceRoot);

      assert.deepEqual(await store.list('session-1'), []);
      assert.equal(await store.get('missing'), null);
      assert.deepEqual(await store.readText('missing'), { ok: false, reason: 'not_found' });
      assert.deepEqual(await store.readBinary('missing'), { ok: false, reason: 'not_found' });
      await store.delete('missing');
      await store.purge(['missing']);
      assert.deepEqual(await recursiveManifest(workspaceRoot), before);

      await store.create({
        id: 'first-mutation',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'created.txt',
        kind: 'file',
        content: 'created',
      });
      assert.match(
        await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8'),
        /"id":"first-mutation"/,
      );
    });
  });

  test('serializes concurrent first-load creates without dropping metadata', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const seed = createArtifactStore(workspaceRoot);
      await seed.create({
        id: 'seed',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'seed.txt',
        kind: 'file',
        content: 'seed',
        now: 1,
      });

      const store = createArtifactStore(workspaceRoot);
      const ids = Array.from({ length: 12 }, (_, index) => `artifact-${index}`);
      await Promise.all(
        ids.map((id, index) =>
          store.create({
            id,
            sessionId: 'session-1',
            turnId: 'turn-1',
            name: `${id}.txt`,
            kind: 'file',
            content: id,
            now: 10 + index,
          }),
        ),
      );

      const reloaded = createArtifactStore(workspaceRoot);
      const rows = await reloaded.list('session-1', { includeDeleted: true });
      assert.deepEqual(rows.map((record) => record.id).sort(), ['seed', ...ids].sort());

      const metadata = await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8');
      for (const id of ['seed', ...ids]) {
        assert.match(metadata, new RegExp(`"id":"${id}"`));
      }
    });
  });

  test('does not publish or return a create whose metadata publication fails', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const store = createArtifactStore(workspaceRoot);
      await store.create({
        id: 'seed',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'seed.txt',
        kind: 'file',
        content: 'seed',
      });
      const metadataPath = join(workspaceRoot, 'artifacts', 'metadata.jsonl');
      const published = await readFile(metadataPath, 'utf8');
      await rm(metadataPath);
      await mkdir(metadataPath);

      await assert.rejects(() =>
        store.create({
          id: 'unpublished',
          sessionId: 'session-1',
          turnId: 'turn-1',
          name: 'unpublished.txt',
          kind: 'file',
          content: 'payload reached its final path',
        }),
      );
      assert.equal(await store.get('unpublished'), null);
      await assert.rejects(
        () =>
          readFile(
            join(workspaceRoot, 'artifacts', 'session-1', 'unpublished-unpublished.txt'),
            'utf8',
          ),
        { code: 'ENOENT' },
      );

      await rm(metadataPath, { recursive: true });
      await writeFile(metadataPath, published, 'utf8');
      assert.equal(await createArtifactStore(workspaceRoot).get('unpublished'), null);
      assert.deepEqual(await store.readText('seed'), { ok: true, text: 'seed' });
      const entries = await readdir(join(workspaceRoot, 'artifacts', 'session-1'));
      assert.equal(
        entries.some((entry) => entry.endsWith('.tmp')),
        false,
      );
    });
  });

  test('recovers a pre-metadata publication residue on the first mutation and permits stable-id retry', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const residue = await createPublicationResidue(workspaceRoot, {
        id: 'stable-retry',
        sessionId: 'session-1',
        name: 'retry.txt',
        content: 'interrupted payload',
      });
      const beforeRead = await recursiveManifest(workspaceRoot);
      const store = createArtifactStore(workspaceRoot);

      assert.equal(await store.get('stable-retry'), null);
      assert.deepEqual(await recursiveManifest(workspaceRoot), beforeRead);

      await store.delete('missing');
      await assert.rejects(() => lstat(residue.stagingPath), { code: 'ENOENT' });
      await assert.rejects(() => lstat(residue.targetPath), { code: 'ENOENT' });

      const retried = await store.create({
        id: 'stable-retry',
        sessionId: 'session-1',
        turnId: 'turn-2',
        name: 'retry.txt',
        kind: 'file',
        content: 'retried payload',
      });
      assert.equal(retried.id, 'stable-retry');
      assert.deepEqual(await store.readText('stable-retry'), {
        ok: true,
        text: 'retried payload',
      });
    });
  });

  test('recovers a post-metadata publication residue by removing only staging', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const writer = createArtifactStore(workspaceRoot);
      const record = await writer.create({
        id: 'committed',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'committed.txt',
        kind: 'file',
        content: 'committed payload',
      });
      const targetPath = join(workspaceRoot, 'artifacts', record.relativePath);
      const stagingPath = publicationStagingPath(targetPath);
      await link(targetPath, stagingPath);

      const store = createArtifactStore(workspaceRoot);
      assert.deepEqual(await store.readText('committed'), {
        ok: true,
        text: 'committed payload',
      });
      assert.equal((await lstat(stagingPath)).isFile(), true);

      await store.delete('missing');
      await assert.rejects(() => lstat(stagingPath), { code: 'ENOENT' });
      assert.equal(await readFile(targetPath, 'utf8'), 'committed payload');
      assert.equal((await store.get('committed'))?.status, 'live');
    });
  });

  test('fails closed without altering mismatched publication residue', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const artifactDirectory = join(workspaceRoot, 'artifacts', 'session-1');
      await mkdir(artifactDirectory, { recursive: true });
      const targetPath = join(artifactDirectory, 'mismatch-payload.txt');
      const stagingPath = publicationStagingPath(targetPath);
      await writeFile(targetPath, 'canonical bytes');
      await writeFile(stagingPath, 'different staging bytes');

      const before = await recursiveManifest(workspaceRoot);
      const store = createArtifactStore(workspaceRoot);
      await assert.rejects(
        () => store.delete('missing'),
        /Artifact publication residue does not match canonical state/,
      );
      assert.deepEqual(await recursiveManifest(workspaceRoot), before);
      assert.equal(await readFile(targetPath, 'utf8'), 'canonical bytes');
      assert.equal(await readFile(stagingPath, 'utf8'), 'different staging bytes');
    });
  });

  test('rejects duplicate ids and exclusive target collisions without replacing payloads', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const store = createArtifactStore(workspaceRoot);
      const first = await store.create({
        id: 'stable-id',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'stable.txt',
        kind: 'file',
        content: 'original',
      });
      const metadataPath = join(workspaceRoot, 'artifacts', 'metadata.jsonl');
      const metadataBefore = await readFile(metadataPath, 'utf8');

      await assert.rejects(
        () =>
          store.create({
            id: 'stable-id',
            sessionId: 'session-1',
            turnId: 'turn-2',
            name: 'replacement.txt',
            kind: 'file',
            content: 'replacement',
          }),
        /Artifact stable-id already exists/,
      );
      assert.equal(
        await readFile(join(workspaceRoot, 'artifacts', first.relativePath), 'utf8'),
        'original',
      );
      assert.equal(await readFile(metadataPath, 'utf8'), metadataBefore);

      const collisionPath = join(workspaceRoot, 'artifacts', 'session-1', 'orphan-existing.txt');
      await writeFile(collisionPath, 'pre-existing', 'utf8');
      await assert.rejects(
        () =>
          store.create({
            id: 'orphan',
            sessionId: 'session-1',
            turnId: 'turn-2',
            name: 'existing.txt',
            kind: 'file',
            content: 'must not replace',
          }),
        /Artifact target already exists: orphan/,
      );
      assert.equal(await readFile(collisionPath, 'utf8'), 'pre-existing');
      assert.equal(await store.get('orphan'), null);
      assert.equal(await readFile(metadataPath, 'utf8'), metadataBefore);
    });
  });

  test('rejects malformed and incomplete metadata rows instead of silently dropping them', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const seed = createArtifactStore(workspaceRoot);
      await seed.create({
        id: 'artifact-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'one.txt',
        kind: 'file',
        content: 'one',
        now: 100,
      });
      await seed.create({
        id: 'artifact-2',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'two.txt',
        kind: 'file',
        content: 'two',
        now: 200,
      });

      const metadataPath = join(workspaceRoot, 'artifacts', 'metadata.jsonl');
      const validRows = (await readFile(metadataPath, 'utf8')).trimEnd();
      await writeFile(metadataPath, `${validRows}\n{not valid json}\n`, 'utf8');
      await assert.rejects(
        () => createArtifactStore(workspaceRoot).list('session-1'),
        /Invalid artifact metadata line 3/,
      );
      await writeFile(metadataPath, `${JSON.stringify({ id: 'incomplete', status: 'live' })}\n`);
      await assert.rejects(
        () => createArtifactStore(workspaceRoot).list('session-1'),
        /Invalid artifact metadata line 1/,
      );
      const canonical = JSON.parse(validRows.split('\n')[0]!) as Record<string, unknown>;
      await writeFile(
        metadataPath,
        `${JSON.stringify({ ...canonical, name: '../one.txt' })}\n`,
        'utf8',
      );
      await assert.rejects(
        () => createArtifactStore(workspaceRoot).list('session-1'),
        /Invalid artifact metadata line 1/,
      );
      await writeFile(
        metadataPath,
        `${JSON.stringify({ ...canonical, relativePath: 'session-1/alias-one.txt' })}\n`,
        'utf8',
      );
      await assert.rejects(
        () => createArtifactStore(workspaceRoot).list('session-1'),
        /Invalid artifact metadata line 1/,
      );
      const unknownField = {
        ...canonical,
        legacyStatus: 'available',
      };
      await writeFile(metadataPath, `${JSON.stringify(unknownField)}\n`, 'utf8');
      await assert.rejects(
        () => createArtifactStore(workspaceRoot).list('session-1'),
        /Invalid artifact metadata line 1/,
      );
      await writeFile(
        metadataPath,
        `${JSON.stringify(canonical)}\n${JSON.stringify(canonical)}\n`,
        'utf8',
      );
      await assert.rejects(
        () => createArtifactStore(workspaceRoot).list('session-1'),
        /Invalid artifact metadata line 2/,
      );
    });
  });

  test('fails loud on metadata read I/O errors instead of treating the index as empty', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const metadataPath = join(workspaceRoot, 'artifacts', 'metadata.jsonl');
      await mkdir(metadataPath, { recursive: true });

      const store = createArtifactStore(workspaceRoot);
      await assert.rejects(() => store.list('session-1'), { code: 'EISDIR' });
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
      assert.deepEqual(await store.readText('artifact-1', { includeDeleted: true }), {
        ok: true,
        text: '<h1>Still on disk</h1>',
      });
      assert.deepEqual(await store.readBinary('artifact-1'), { ok: false, reason: 'deleted' });
    });
  });

  test('failed delete never reaches memory, a later mutation, or a reopened store', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const store = createArtifactStore(workspaceRoot);
      await store.create({
        id: 'kept-live',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'kept.txt',
        kind: 'file',
        content: 'kept',
      });
      await store.create({
        id: 'later-delete',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'later.txt',
        kind: 'file',
        content: 'later',
      });
      const metadataPath = join(workspaceRoot, 'artifacts', 'metadata.jsonl');
      const published = await readFile(metadataPath, 'utf8');
      await rm(metadataPath);
      await mkdir(metadataPath);

      await assert.rejects(() => store.delete('kept-live'));
      assert.equal((await store.get('kept-live'))?.status, 'live');

      await rm(metadataPath, { recursive: true });
      await writeFile(metadataPath, published, 'utf8');
      await store.delete('later-delete');
      assert.equal((await store.get('kept-live'))?.status, 'live');
      assert.equal((await store.get('later-delete'))?.status, 'deleted');

      const reopened = createArtifactStore(workspaceRoot);
      assert.equal((await reopened.get('kept-live'))?.status, 'live');
      assert.equal((await reopened.get('later-delete'))?.status, 'deleted');
      assert.deepEqual(await reopened.readText('kept-live'), { ok: true, text: 'kept' });
    });
  });

  test('reads a soft-deleted artifact through the durable attachment path only', async () => {
    await withStore(async (store) => {
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await store.create({
        id: 'attachment-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'image.png',
        kind: 'image',
        content: bytes,
      });
      await store.delete('attachment-1');

      assert.deepEqual(await store.list('session-1'), []);
      assert.deepEqual(await store.readBinary('attachment-1'), {
        ok: false,
        reason: 'deleted',
      });
      assert.deepEqual(
        await store.readDurableAttachmentBinary({
          artifactId: 'attachment-1',
          sessionId: 'session-1',
        }),
        {
          ok: true,
          base64: Buffer.from(bytes).toString('base64'),
          mimeType: 'image/png',
        },
      );
      assert.deepEqual(
        await createAttachmentByteReader({ artifactStore: store, sessionId: 'session-1' })({
          kind: 'session_file',
          sessionId: 'session-1',
          relativePath: 'attachment-1',
        }),
        { ok: true, bytes: Buffer.from(bytes) },
      );
      assert.deepEqual(
        await store.readDurableAttachmentBinary({
          artifactId: 'attachment-1',
          sessionId: 'session-2',
        }),
        { ok: false, reason: 'session_mismatch' },
      );
    });
  });

  test('batch purge removes file bytes and metadata records idempotently', async () => {
    await withStore(async (store, workspaceRoot) => {
      const first = await store.create({
        id: 'artifact-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'one.txt',
        kind: 'file',
        content: 'one',
      });
      const second = await store.create({
        id: 'artifact-2',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'two.txt',
        kind: 'file',
        content: 'two',
      });
      await store.create({
        id: 'artifact-kept',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'kept.txt',
        kind: 'file',
        content: 'kept',
      });
      await store.purge([first.id, second.id]);
      await store.purge([first.id, second.id]);

      assert.deepEqual(
        (await store.list('session-1', { includeDeleted: true })).map((record) => record.id),
        ['artifact-kept'],
      );
      await assert.rejects(
        () => readFile(join(workspaceRoot, 'artifacts', first.relativePath), 'utf8'),
        { code: 'ENOENT' },
      );
      await assert.rejects(
        () => readFile(join(workspaceRoot, 'artifacts', second.relativePath), 'utf8'),
        { code: 'ENOENT' },
      );
      const metadata = await readFile(join(workspaceRoot, 'artifacts', 'metadata.jsonl'), 'utf8');
      assert.doesNotMatch(metadata, /artifact-1|artifact-2/);
      assert.match(metadata, /artifact-kept/);
    });
  });

  test('retries purge after file removal is interrupted before metadata commit', async () => {
    await withStore(async (store, workspaceRoot) => {
      const record = await store.create({
        id: 'artifact-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'one.txt',
        kind: 'file',
        content: 'one',
      });
      const metadataPath = join(workspaceRoot, 'artifacts', 'metadata.jsonl');
      const metadata = await readFile(metadataPath, 'utf8');
      await rm(metadataPath);
      await mkdir(metadataPath);

      await assert.rejects(() => store.purge([record.id]));

      assert.equal((await store.get(record.id))?.id, record.id);
      await assert.rejects(
        () => readFile(join(workspaceRoot, 'artifacts', record.relativePath), 'utf8'),
        { code: 'ENOENT' },
      );

      await rm(metadataPath, { recursive: true });
      await writeFile(metadataPath, metadata, 'utf8');
      const reopened = createArtifactStore(workspaceRoot);
      await reopened.purge([record.id]);

      assert.equal(await reopened.get(record.id), null);
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
      assert.deepEqual(await store.readBinary('unknown'), {
        ok: false,
        reason: 'unsupported_mime',
      });
    });
  });

  test('rejects absolute, traversal, URL-like, and empty relative paths', () => {
    assert.equal(isSafeRelativeArtifactPath('session-1/artifact.txt'), true);
    for (const value of [
      '',
      '/tmp/file',
      '../file',
      'session/../file',
      'file:///tmp/a',
      'http://example.test/a',
      'session//file',
    ]) {
      assert.equal(isSafeRelativeArtifactPath(value), false, value);
    }
  });

  test('path guard rejects symlink escapes from artifact root', async (t) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-store-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-outside-'));
    try {
      const artifactRoot = join(workspaceRoot, 'artifacts');
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
      try {
        await symlink(outsideRoot, join(artifactRoot, 'session-1'));
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
          t.skip('Windows symlink creation requires elevated privileges or Developer Mode');
          return;
        }
        throw error;
      }

      assert.deepEqual(
        await resolveArtifactPath({ artifactRoot, relativePath: 'session-1/secret.txt' }),
        { ok: false, reason: 'not_allowed' },
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('create validates generated relative path before writing file bytes', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const store = createArtifactStore(workspaceRoot);

      await assert.rejects(
        () =>
          store.create({
            id: 'escaped',
            sessionId: '../escape',
            turnId: 'turn-1',
            name: 'bad.txt',
            kind: 'file',
            content: 'should not write',
          }),
        /Artifact sessionId must be one safe path segment/,
      );
      await assert.rejects(
        () => readFile(join(workspaceRoot, 'escape', 'escaped-bad.txt'), 'utf8'),
        { code: 'ENOENT' },
      );

      await assert.rejects(
        () =>
          store.create({
            id: '../escaped',
            sessionId: 'session-1',
            turnId: 'turn-1',
            name: 'bad.txt',
            kind: 'file',
            content: 'should not write either',
          }),
        /Artifact id must be one safe path segment/,
      );
      await assert.rejects(
        () => readFile(join(workspaceRoot, 'artifacts', 'escaped-bad.txt'), 'utf8'),
        { code: 'ENOENT' },
      );

      await assert.rejects(
        () =>
          store.create({
            id: 'empty-turn',
            sessionId: 'session-1',
            turnId: '',
            name: 'bad.txt',
            kind: 'file',
            content: 'must not publish invalid metadata',
          }),
        /Artifact turnId must be non-empty/,
      );
      assert.deepEqual(await createArtifactStore(workspaceRoot).list('session-1'), []);

      await assert.rejects(
        () =>
          store.create({
            id: 'nested/id',
            sessionId: 'session-1',
            turnId: 'turn-1',
            name: 'bad.txt',
            kind: 'file',
            content: 'must stay in one managed directory',
          }),
        /Artifact id must be one safe path segment/,
      );
    });
  });

  test('sanitizes unsafe artifact names for file-backed storage', () => {
    assert.equal(sanitizeArtifactName('../bad:name?.html'), 'bad-name-.html');
    assert.equal(sanitizeArtifactName('   '), 'artifact');
  });
});

async function withStore(
  fn: (store: ReturnType<typeof createArtifactStore>, workspaceRoot: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspaceRoot) =>
    fn(createArtifactStore(workspaceRoot), workspaceRoot),
  );
}

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-store-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function createPublicationResidue(
  workspaceRoot: string,
  input: { id: string; sessionId: string; name: string; content: string },
): Promise<{ stagingPath: string; targetPath: string }> {
  const artifactDirectory = join(workspaceRoot, 'artifacts', input.sessionId);
  const targetPath = join(artifactDirectory, `${input.id}-${input.name}`);
  const stagingPath = publicationStagingPath(targetPath);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(stagingPath, input.content, { flag: 'wx' });
  await link(stagingPath, targetPath);
  return { stagingPath, targetPath };
}

function publicationStagingPath(targetPath: string): string {
  const targetName = basename(targetPath);
  const targetHash = createHash('sha256').update(targetName).digest('hex');
  return join(
    dirname(targetPath),
    `.artifact-publish.${targetHash}.00000000-0000-4000-8000-000000000000.tmp`,
  );
}

interface ManifestEntry {
  path: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
  size: bigint;
  mtimeNs: bigint;
}

async function recursiveManifest(root: string): Promise<ManifestEntry[]> {
  const manifest: ManifestEntry[] = [];
  await visit(root, '.');
  return manifest.sort((left, right) => left.path.localeCompare(right.path));

  async function visit(path: string, relativePath: string): Promise<void> {
    const entry = await lstat(path, { bigint: true });
    let kind: ManifestEntry['kind'] = 'other';
    if (entry.isDirectory()) kind = 'directory';
    else if (entry.isFile()) kind = 'file';
    else if (entry.isSymbolicLink()) kind = 'symlink';
    manifest.push({
      path: relativePath,
      kind,
      size: entry.size,
      mtimeNs: entry.mtimeNs,
    });
    if (!entry.isDirectory()) return;
    const children = await readdir(path);
    for (const child of children) {
      await visit(join(path, child), relativePath === '.' ? child : `${relativePath}/${child}`);
    }
  }
}
