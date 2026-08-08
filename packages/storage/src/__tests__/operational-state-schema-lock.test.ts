import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { link, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { resolveOperationalStateSchemaLockPath } from '../operational-state-schema-lock.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from '../sqlite-runtime-schema.js';

test('a live operational database lease excludes schema migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-schema-lock-'));
  const databasePath = join(root, 'runtime.sqlite');
  let holder: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    holder = fork(
      new URL('./fixtures/operational-state-lease-holder.js', import.meta.url),
      [root],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    await waitForReady(holder);

    const database = new DatabaseSync(databasePath);
    database.exec('DROP TABLE runtime_session_event_ordinals');
    database.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION - 1}`);
    database
      .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'runtime'`)
      .run(SQLITE_RUNTIME_SCHEMA_VERSION - 1);
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /close other Maka processes before retrying/i,
    );
    assert.equal(readRuntimeVersion(databasePath), SQLITE_RUNTIME_SCHEMA_VERSION - 1);

    holder.send('close');
    await waitForExit(holder);

    acquireOperationalStateDatabase(root).close();
    assert.equal(readRuntimeVersion(databasePath), SQLITE_RUNTIME_SCHEMA_VERSION);
  } finally {
    await stopChild(holder);
    await rm(root, { recursive: true, force: true });
  }
});

test('replacing the workspace root cannot detach a live owner from its database migration lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-root-replacement-'));
  const movedRoot = `${root}-moved`;
  const databasePath = join(root, 'runtime.sqlite');
  let holder: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    holder = fork(
      new URL('./fixtures/operational-state-lease-holder.js', import.meta.url),
      [root],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    await waitForReady(holder);

    await rename(root, movedRoot);
    await mkdir(root);
    await link(join(movedRoot, 'runtime.sqlite'), databasePath);

    const database = new DatabaseSync(databasePath);
    database.exec('DROP TABLE runtime_session_event_ordinals');
    database.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION - 1}`);
    database
      .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'runtime'`)
      .run(SQLITE_RUNTIME_SCHEMA_VERSION - 1);
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /close other Maka processes before retrying/i,
    );
    assert.equal(readRuntimeVersion(databasePath), SQLITE_RUNTIME_SCHEMA_VERSION - 1);
  } finally {
    await stopChild(holder);
    await rm(root, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
  }
});

test('replacing the active owner lock cannot detach a live operational schema owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-lock-replacement-'));
  const databasePath = join(root, 'runtime.sqlite');
  let movedLockPath: string | undefined;
  let holder: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    holder = fork(
      new URL('./fixtures/operational-state-lease-holder.js', import.meta.url),
      [root],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    await waitForReady(holder);

    const lockPath = resolveOperationalStateSchemaLockPath(databasePath, 'owner');
    movedLockPath = `${lockPath}.${process.pid}.moved`;
    await rename(lockPath, movedLockPath);

    const database = new DatabaseSync(databasePath);
    database.exec('DROP TABLE runtime_session_event_ordinals');
    database.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION - 1}`);
    database
      .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'runtime'`)
      .run(SQLITE_RUNTIME_SCHEMA_VERSION - 1);
    database.close();

    let unexpectedLease: ReturnType<typeof acquireOperationalStateDatabase> | undefined;
    try {
      assert.throws(() => {
        unexpectedLease = acquireOperationalStateDatabase(root);
      }, /lock authority/i);
    } finally {
      unexpectedLease?.close();
    }
    assert.equal(readRuntimeVersion(databasePath), SQLITE_RUNTIME_SCHEMA_VERSION - 1);
  } finally {
    await stopChild(holder);
    if (movedLockPath) await rm(movedLockPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('different XDG state homes cannot split one operational lock domain', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-xdg-lock-domain-'));
  const databasePath = join(root, 'runtime.sqlite');
  let holder: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    holder = fork(
      new URL('./fixtures/operational-state-lease-holder.js', import.meta.url),
      [root],
      {
        env: { ...process.env, XDG_STATE_HOME: join(root, 'different-xdg-state') },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    await waitForReady(holder);

    const database = new DatabaseSync(databasePath);
    database.exec('DROP TABLE runtime_session_event_ordinals');
    database.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION - 1}`);
    database
      .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'runtime'`)
      .run(SQLITE_RUNTIME_SCHEMA_VERSION - 1);
    database.close();

    let unexpectedLease: ReturnType<typeof acquireOperationalStateDatabase> | undefined;
    try {
      assert.throws(() => {
        unexpectedLease = acquireOperationalStateDatabase(root);
      }, /close other Maka processes before retrying/i);
    } finally {
      unexpectedLease?.close();
    }
    assert.equal(readRuntimeVersion(databasePath), SQLITE_RUNTIME_SCHEMA_VERSION - 1);
  } finally {
    await stopChild(holder);
    await rm(root, { recursive: true, force: true });
  }
});

test('an operational opener waits for an in-progress migration turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-migration-turn-wait-'));
  const databasePath = join(root, 'runtime.sqlite');
  let holder: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    holder = fork(
      new URL('./fixtures/operational-state-migration-turn-holder.js', import.meta.url),
      [databasePath, '5200'],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    await waitForReady(holder);

    holder.send('start');
    const startedAt = performance.now();
    const lease = acquireOperationalStateDatabase(root);
    lease.close();
    assert.ok(
      performance.now() - startedAt >= 5_000,
      'the operational opener returned before the held migration turn was released',
    );
    await waitForExit(holder);
  } finally {
    await stopChild(holder);
    await rm(root, { recursive: true, force: true });
  }
});

function readRuntimeVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`operational lease holder exited before ready: ${code ?? signal}`));
    });
    child.once('message', (message) => {
      if (
        message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'ready'
      ) {
        resolve();
      } else {
        reject(new Error(`unexpected operational lease holder message: ${String(message)}`));
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`operational lease holder failed: ${code ?? signal}`));
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForExit(child).catch(() => {});
}
