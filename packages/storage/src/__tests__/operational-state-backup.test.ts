import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSqliteArtifactStore } from '../artifact-store.js';
import { createProjectCatalog } from '../project-catalog.js';
import { createSessionStore } from '../session-store.js';
import {
  createOperationalStateBackup,
  OPERATIONAL_BACKUP_MANIFEST_FILE,
  type OperationalBackupManifest,
  OperationalBackupError,
  restoreOperationalStateBackup,
  validateOperationalStateBackup,
} from '../operational-state-backup.js';

test('backs up and restores runtime.sqlite plus artifact bytes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  const projectPath = join(base, 'project');
  await mkdir(projectPath);
  const sessions = createSessionStore(stateRoot);
  try {
    // The project catalog decides how every session is grouped, and its name,
    // relink aliases and archive state exist nowhere else. Restoring sessions
    // without it would silently reorganize the user's whole sidebar.
    const catalog = createProjectCatalog(stateRoot, { now: () => 5 });
    const project = await catalog.register(projectPath);
    await catalog.rename(project.id, 'Renamed Project');
    await catalog.archive(project.id);
    catalog.close();

    const session = await sessions.create({
      projectId: project.id,
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Backup',
      labels: [],
    });
    await sessions.appendMessage(session.id, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'durable',
    });
    await sessions.close?.();
    const artifacts = createSqliteArtifactStore(stateRoot);
    const artifact = await artifacts.create({
      id: 'artifact-1',
      sessionId: session.id,
      turnId: 'turn-1',
      name: 'note.txt',
      kind: 'file',
      content: 'artifact',
      source: 'fixture',
      now: 2,
    });
    artifacts.close?.();

    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot, now: () => 10 });
    assert.equal((await validateOperationalStateBackup(backupRoot)).createdAt, 10);
    await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });

    const restored = createSessionStore(restoreRoot);
    const restoredCatalog = createProjectCatalog(restoreRoot);
    try {
      assert.equal((await restored.readMessages(session.id))[0]?.id, 'message-1');
      assert.equal(
        await readFile(join(restoreRoot, 'artifacts', artifact.relativePath), 'utf8'),
        'artifact',
      );
      assert.equal(
        (await restored.readHeaderSnapshot(session.id)).projectId,
        project.id,
        'a restored session still belongs to the project it was grouped under',
      );
      assert.deepEqual(await restoredCatalog.list(), [
        {
          id: project.id,
          name: 'Renamed Project',
          locations: [{ path: await realpath(projectPath), isWorktree: false }],
          archivedAt: 5,
          available: true,
          preferredPath: await realpath(projectPath),
        },
      ]);
    } finally {
      await restored.close?.();
      restoredCatalog.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('restores a v0.1.6 backup as current operational state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-upgrade-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  try {
    const sessions = createSessionStore(stateRoot);
    const session = await sessions.create({
      projectId: 'project-1',
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Legacy backup',
      labels: [],
    });
    await sessions.appendMessage(session.id, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'survives migration',
    });
    await sessions.close?.();
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    await rewriteAsV016OperationalBackup(backupRoot);

    await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });

    assert.deepEqual(readSchemaVersions(join(restoreRoot, 'runtime.sqlite')), {
      runtime: 11,
      sessionMetadata: 22,
      operational: 1,
    });
    assert.deepEqual(readSchemaVersions(join(backupRoot, 'runtime.sqlite')), {
      runtime: 10,
      sessionMetadata: 21,
      operational: 1,
    });
    const restored = createSessionStore(restoreRoot);
    try {
      assert.equal((await restored.readMessages(session.id))[0]?.id, 'message-1');
    } finally {
      await restored.close?.();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects a backup whose SQLite Artifact metadata has no matching payload', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-artifact-'));
  const stateRoot = join(base, 'state');
  try {
    const artifacts = createSqliteArtifactStore(stateRoot);
    const artifact = await artifacts.create({
      id: 'artifact-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'note.txt',
      kind: 'file',
      content: 'artifact',
      source: 'fixture',
      now: 2,
    });
    artifacts.close?.();
    await rm(join(stateRoot, 'artifacts', artifact.relativePath));

    await assert.rejects(
      createOperationalStateBackup({
        stateRoot,
        destinationRoot: join(base, 'backup'),
        now: () => 10,
      }),
      (error: unknown) =>
        error instanceof OperationalBackupError &&
        error.code === 'corrupt_backup' &&
        /artifact payload/i.test(error.message),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function rewriteAsV016OperationalBackup(backupRoot: string): Promise<void> {
  const databasePath = join(backupRoot, 'runtime.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      UPDATE operational_schema_migrations
      SET version = CASE scope
        WHEN 'runtime' THEN 10
        WHEN 'session_metadata' THEN 21
        WHEN 'operational' THEN 1
        ELSE version
      END;
      DROP TABLE runtime_session_event_ordinals;
      PRAGMA user_version = 10;
      UPDATE session_metadata_schema SET version = 21 WHERE scope = 'session_metadata';
      PRAGMA journal_mode = DELETE;
    `);
  } finally {
    database.close();
  }

  const manifestPath = join(backupRoot, OPERATIONAL_BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as OperationalBackupManifest;
  const bytes = await readFile(databasePath);
  const files = manifest.files.map((file) =>
    file.path === 'runtime.sqlite'
      ? {
          ...file,
          size: bytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
        }
      : file,
  );
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`);
}

function readSchemaVersions(databasePath: string): {
  runtime: number;
  sessionMetadata: number;
  operational: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const runtime = (database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    const sessionMetadata = (
      database
        .prepare(`SELECT version FROM session_metadata_schema WHERE scope = 'session_metadata'`)
        .get() as { version: number }
    ).version;
    const operational = (
      database
        .prepare(`SELECT version FROM operational_schema_migrations WHERE scope = 'operational'`)
        .get() as { version: number }
    ).version;
    return { runtime, sessionMetadata, operational };
  } finally {
    database.close();
  }
}
