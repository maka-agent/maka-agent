import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSqliteArtifactStore } from '../artifact-store.js';
import { SQLITE_CORE_EXECUTION_SCHEMA_VERSION } from '../sqlite-core-execution-schema.js';
import { createProjectCatalog } from '../project-catalog.js';
import { resolveStorageRoot, type StorageRootKind } from '../root-authority.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from '../sqlite-runtime-schema.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from '../sqlite-session-metadata-schema.js';
import { createSessionStore } from '../session-store.js';
import { SQLITE_WORKFLOW_SCHEMA_VERSION } from '../sqlite-workflow-schema.js';
import { bindWorkspaceBaselineAuthorityStoreRootInternal } from '../workspace-version-authority-internal.js';
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
  const sourceCapability = await resolveStorageRoot({ path: stateRoot, kind: 'headless' });
  const sourceRuntime = createSqliteRuntimeStore(join(stateRoot, 'runtime.sqlite'));
  bindWorkspaceBaselineAuthorityStoreRootInternal(sourceRuntime, sourceCapability.rootId);
  sourceRuntime.close();
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
    await restoreOperationalStateBackup({
      backupRoot,
      destinationRoot: restoreRoot,
      kind: 'headless',
    });

    const restoredCapability = await assertRestoredRootBinding(restoreRoot, 'headless');
    assert.notEqual(restoredCapability.rootId, sourceCapability.rootId);

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

    await restoreOperationalStateBackup({
      backupRoot,
      destinationRoot: restoreRoot,
      kind: 'interactive',
    });
    await assertRestoredRootBinding(restoreRoot, 'interactive');

    assert.deepEqual(readSchemaVersions(join(restoreRoot, 'runtime.sqlite')), {
      runtime: SQLITE_RUNTIME_SCHEMA_VERSION,
      sessionMetadata: SQLITE_SESSION_METADATA_SCHEMA_VERSION,
      coreExecution: SQLITE_CORE_EXECUTION_SCHEMA_VERSION,
      workflow: SQLITE_WORKFLOW_SCHEMA_VERSION,
      operational: 1,
    });
    assert.deepEqual(readSchemaVersions(join(backupRoot, 'runtime.sqlite')), {
      runtime: 10,
      sessionMetadata: 21,
      coreExecution: 1,
      workflow: 3,
      operational: 1,
    });
    const restored = createSessionStore(restoreRoot);
    try {
      assert.equal((await restored.readMessages(session.id))[0]?.id, 'message-1');
      assert.equal((await restored.readHeaderSnapshot(session.id)).connectionLocked, true);
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

test('rejects a current backup missing a required runtime authority table', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-required-table-'));
  const stateRoot = join(base, 'state');
  try {
    const sessions = createSessionStore(stateRoot);
    await sessions.close?.();

    for (const table of ['runtime_session_event_ordinals', 'runtime_storage_root_binding']) {
      const backupRoot = join(base, `backup-${table}`);
      await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
      const database = new DatabaseSync(join(backupRoot, 'runtime.sqlite'));
      try {
        database.exec(`DROP TABLE ${table}`);
      } finally {
        database.close();
      }
      await refreshDatabaseInventory(backupRoot);

      await assert.rejects(
        validateOperationalStateBackup(backupRoot),
        (error: unknown) =>
          error instanceof OperationalBackupError &&
          error.code === 'corrupt_backup' &&
          error.message.includes(`required table is missing: ${table}`),
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects a v0.1.6 backup missing a table required by that release', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-legacy-table-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  try {
    const sessions = createSessionStore(stateRoot);
    await sessions.close?.();
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    await rewriteAsV016OperationalBackup(backupRoot);
    const database = new DatabaseSync(join(backupRoot, 'runtime.sqlite'));
    try {
      database.exec('DROP TABLE core_agent_runs');
    } finally {
      database.close();
    }
    await refreshDatabaseInventory(backupRoot);

    await assert.rejects(
      validateOperationalStateBackup(backupRoot),
      (error: unknown) =>
        error instanceof OperationalBackupError &&
        error.code === 'corrupt_backup' &&
        error.message.includes('required table is missing: core_agent_runs'),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('releases the operational database when restored runtime capabilities are invalid', {
  skip:
    process.platform === 'win32' ? 'Windows does not expose a process file-descriptor list' : false,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-invalid-capability-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  try {
    const sessions = createSessionStore(stateRoot);
    await sessions.close?.();
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    const database = new DatabaseSync(join(backupRoot, 'runtime.sqlite'));
    try {
      database.exec(`
        DELETE FROM runtime_capabilities
        WHERE capability = 'runtime_workspace_version_authority'
      `);
    } finally {
      database.close();
    }
    await refreshDatabaseInventory(backupRoot);

    const openFileDescriptors = await countOpenFileDescriptors();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const destinationRoot = join(base, `restore-${attempt}`);
      await assert.rejects(
        restoreOperationalStateBackup({
          backupRoot,
          destinationRoot,
          kind: 'headless',
        }),
        /runtime_workspace_version_authority/i,
      );
      assert.deepEqual(
        (await readdir(base)).filter((entry) => entry.startsWith(`restore-${attempt}`)),
        [],
      );
    }
    assert.equal(await countOpenFileDescriptors(), openFileDescriptors);
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
        WHEN 'core_execution' THEN 1
        WHEN 'workflow' THEN 3
        WHEN 'operational' THEN 1
        ELSE version
      END;
      DROP TABLE runtime_session_event_ordinals;
      DROP TABLE core_root_turn_start_rejections;
      ALTER TABLE workflow_quote_companion_cleanup DROP COLUMN record_json;
      PRAGMA user_version = 10;
      UPDATE session_metadata_schema SET version = 21 WHERE scope = 'session_metadata';
      UPDATE session_metadata
      SET payload_json = json_set(payload_json, '$.connectionLocked', json('false'));
      PRAGMA journal_mode = DELETE;
    `);
  } finally {
    database.close();
  }

  await refreshDatabaseInventory(backupRoot);
}

async function refreshDatabaseInventory(backupRoot: string): Promise<void> {
  const databasePath = join(backupRoot, 'runtime.sqlite');
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

async function assertRestoredRootBinding(root: string, kind: StorageRootKind) {
  const capability = await resolveStorageRoot({ path: root, kind });
  const runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  try {
    assert.doesNotThrow(() =>
      bindWorkspaceBaselineAuthorityStoreRootInternal(runtime, capability.rootId),
    );
  } finally {
    runtime.close();
  }
  return capability;
}

function readSchemaVersions(databasePath: string): {
  runtime: number;
  sessionMetadata: number;
  coreExecution: number;
  workflow: number;
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
    const coreExecution = (
      database
        .prepare(`SELECT version FROM operational_schema_migrations WHERE scope = 'core_execution'`)
        .get() as { version: number }
    ).version;
    const workflow = (
      database
        .prepare(`SELECT version FROM operational_schema_migrations WHERE scope = 'workflow'`)
        .get() as { version: number }
    ).version;
    return { runtime, sessionMetadata, coreExecution, workflow, operational };
  } finally {
    database.close();
  }
}

async function countOpenFileDescriptors(): Promise<number> {
  return (await readdir(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')).length;
}
