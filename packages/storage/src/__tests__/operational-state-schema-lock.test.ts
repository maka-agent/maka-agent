import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { closeSync, constants as fsConstants, openSync } from 'node:fs';
import { access, link, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tryLock, unlock } from 'fs-native-extensions';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import {
  resolveOperationalStateSchemaLockPath,
  waitForOperationalStatePublicationLock,
} from '../operational-state-schema-lock.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from '../sqlite-runtime-schema.js';

const LEGACY_RUNTIME_SCHEMA_VERSION = 10;

test('reserving a publication lock does not create the destination root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'maka-operational-publication-lock-'));
  const destinationRoot = join(parent, 'missing', 'destination');
  const lock = waitForOperationalStatePublicationLock(join(destinationRoot, 'runtime.sqlite'));
  try {
    await assert.rejects(access(destinationRoot));
  } finally {
    lock.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test('a live operational database lease excludes schema migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-schema-lock-'));
  const databasePath = join(root, 'runtime.sqlite');
  let holder: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    holder = await spawnReady('./fixtures/operational-state-lease-holder.js', [root]);

    rewindRuntimeSchema(databasePath);

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /close other Maka processes before retrying/i,
    );
    assert.equal(readRuntimeVersion(databasePath), LEGACY_RUNTIME_SCHEMA_VERSION);

    holder.send('close');
    await waitForExit(holder);

    acquireOperationalStateDatabase(root).close();
    assert.equal(readRuntimeVersion(databasePath), SQLITE_RUNTIME_SCHEMA_VERSION);
  } finally {
    await stopChild(holder);
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a replaced owner lock while the registered owner is live', {
  skip:
    process.platform === 'win32'
      ? 'Windows cannot rename an open SQLite authority lock file'
      : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-lock-replaced-'));
  const databasePath = join(root, 'runtime.sqlite');
  const movedLockPath = join(root, 'owner.lock.moved');
  let holder: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    holder = await spawnReady('./fixtures/operational-state-lease-holder.js', [root]);
    await rename(resolveOperationalStateSchemaLockPath(databasePath, 'owner'), movedLockPath);
    rewindRuntimeSchema(databasePath);

    assert.throws(() => acquireOperationalStateDatabase(root), /lock authority changed/i);
    assert.equal(readRuntimeVersion(databasePath), LEGACY_RUNTIME_SCHEMA_VERSION);
  } finally {
    await stopChild(holder);
    await rm(movedLockPath, { force: true });
    await rm(resolveOperationalStateSchemaLockPath(databasePath, 'owner'), { force: true }).catch(
      () => {},
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects two paths hard-linked to one operational database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-hard-link-'));
  const aliasRoot = `${root}-alias`;
  const lease = acquireOperationalStateDatabase(root);
  try {
    await mkdir(aliasRoot);
    await link(join(root, 'runtime.sqlite'), join(aliasRoot, 'runtime.sqlite'));

    assert.throws(() => acquireOperationalStateDatabase(aliasRoot), /not one stable regular file/i);
  } finally {
    lease.close();
    await rm(root, { recursive: true, force: true });
    await rm(aliasRoot, { recursive: true, force: true });
  }
});

test('rejects another current database moved over a live owner path', {
  skip: process.platform === 'win32' ? 'Windows cannot replace an open SQLite database' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-database-replacement-'));
  const replacementRoot = `${root}-replacement`;
  const databasePath = join(root, 'runtime.sqlite');
  const movedDatabasePath = join(root, 'runtime.sqlite.moved');
  let holder: ChildProcess | undefined;
  try {
    await mkdir(replacementRoot);
    acquireOperationalStateDatabase(root).close();
    acquireOperationalStateDatabase(replacementRoot).close();
    holder = await spawnReady('./fixtures/operational-state-lease-holder.js', [root]);

    await rename(databasePath, movedDatabasePath);
    await rename(join(replacementRoot, 'runtime.sqlite'), databasePath);

    assert.throws(() => acquireOperationalStateDatabase(root), /lock authority changed/i);
  } finally {
    await stopChild(holder);
    await rm(root, { recursive: true, force: true });
    await rm(replacementRoot, { recursive: true, force: true });
  }
});

test('replacing the workspace root cannot detach a live owner from its database migration lock', {
  skip:
    process.platform === 'win32'
      ? 'Windows cannot rename a directory containing an open SQLite database'
      : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-root-replacement-'));
  const movedRoot = `${root}-moved`;
  const databasePath = join(root, 'runtime.sqlite');
  let holder: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    holder = await spawnReady('./fixtures/operational-state-lease-holder.js', [root]);

    await rename(root, movedRoot);
    await mkdir(root);
    await link(join(movedRoot, 'runtime.sqlite'), databasePath);

    rewindRuntimeSchema(databasePath);

    assert.throws(() => acquireOperationalStateDatabase(root), /not one stable regular file/i);
    assert.equal(readRuntimeVersion(databasePath), LEGACY_RUNTIME_SCHEMA_VERSION);
  } finally {
    await stopChild(holder);
    await rm(root, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
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
    holder = await spawnReady('./fixtures/operational-state-lease-holder.js', [root], {
      ...process.env,
      XDG_STATE_HOME: join(root, 'different-xdg-state'),
    });

    rewindRuntimeSchema(databasePath);

    let unexpectedLease: ReturnType<typeof acquireOperationalStateDatabase> | undefined;
    try {
      assert.throws(() => {
        unexpectedLease = acquireOperationalStateDatabase(root);
      }, /close other Maka processes before retrying/i);
    } finally {
      unexpectedLease?.close();
    }
    assert.equal(readRuntimeVersion(databasePath), LEGACY_RUNTIME_SCHEMA_VERSION);
  } finally {
    await stopChild(holder);
    await rm(root, { recursive: true, force: true });
  }
});

test('an operational opener waits for an in-progress migration turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-migration-turn-wait-'));
  const databasePath = join(root, 'runtime.sqlite');
  let migrationHolder: ChildProcess | undefined;
  let opener: ChildProcess | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    migrationHolder = await spawnReady('./fixtures/operational-state-migration-turn-holder.js', [
      databasePath,
    ]);
    opener = fork(
      new URL('./fixtures/operational-state-lease-holder.js', import.meta.url),
      [root, 'wait-for-open'],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    await waitForMessage(opener, 'waiting');
    const opening = waitForMessage(opener, 'opening');
    opener.send('open');
    await opening;
    const opened = waitForReady(opener);
    await assertPending(opened, 'operational opener');

    migrationHolder.send('close');
    await waitForExit(migrationHolder);
    await opened;

    opener.send('close');
    await waitForExit(opener);
  } finally {
    await stopChild(opener);
    await stopChild(migrationHolder);
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale migrator cannot overwrite lock authority after both sidecars are replaced', {
  skip:
    process.platform === 'win32'
      ? 'Windows cannot rename open SQLite authority lock files or suspend a process'
      : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-stale-migrator-'));
  const databasePath = join(root, 'runtime.sqlite');
  let blocker: DatabaseSync | undefined;
  let staleMigrator: ChildProcess | undefined;
  let winningMigrator: ChildProcess | undefined;
  let staleStopped = false;
  let ownerMovedPath: string | undefined;
  let turnMovedPath: string | undefined;
  try {
    acquireOperationalStateDatabase(root).close();
    rewindRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy
      .prepare(`UPDATE operational_schema_migrations SET version = 1 WHERE scope = 'operational'`)
      .run();
    legacy.close();

    blocker = new DatabaseSync(databasePath);
    blocker.exec('BEGIN IMMEDIATE');
    const ownerLockPath = resolveOperationalStateSchemaLockPath(databasePath, 'owner');
    const turnLockPath = resolveOperationalStateSchemaLockPath(databasePath, 'migration-turn');
    staleMigrator = fork(
      new URL('./fixtures/operational-state-lease-holder.js', import.meta.url),
      [root],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    await Promise.all([waitForHeldLock(ownerLockPath), waitForHeldLock(turnLockPath)]);
    staleMigrator.kill('SIGSTOP');
    staleStopped = true;

    ownerMovedPath = `${ownerLockPath}.${process.pid}.moved`;
    turnMovedPath = `${turnLockPath}.${process.pid}.moved`;
    await rename(ownerLockPath, ownerMovedPath);
    await rename(turnLockPath, turnMovedPath);

    winningMigrator = fork(
      new URL('./fixtures/operational-state-lease-holder.js', import.meta.url),
      [root],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    await Promise.all([waitForHeldLock(ownerLockPath), waitForHeldLock(turnLockPath)]);
    const winnerReady = waitForReady(winningMigrator);
    blocker.exec('COMMIT');
    blocker.close();
    blocker = undefined;
    await winnerReady;
    winningMigrator.send('close');
    await waitForExit(winningMigrator);

    staleMigrator.kill('SIGCONT');
    staleStopped = false;
    await waitForFailure(staleMigrator);

    acquireOperationalStateDatabase(root).close();
    assert.equal(readRuntimeVersion(databasePath), SQLITE_RUNTIME_SCHEMA_VERSION);
  } finally {
    if (staleStopped) staleMigrator?.kill('SIGCONT');
    try {
      blocker?.exec('ROLLBACK');
    } catch {}
    blocker?.close();
    await stopChild(staleMigrator);
    await stopChild(winningMigrator);
    if (ownerMovedPath) await rm(ownerMovedPath, { force: true });
    if (turnMovedPath) await rm(turnMovedPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

function rewindRuntimeSchema(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('DROP TRIGGER runtime_events_assign_session_ordinal');
    database.exec('DROP TABLE runtime_session_event_ordinals');
    database.exec(`PRAGMA user_version = ${LEGACY_RUNTIME_SCHEMA_VERSION}`);
    database
      .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'runtime'`)
      .run(LEGACY_RUNTIME_SCHEMA_VERSION);
  } finally {
    database.close();
  }
}

async function spawnReady(
  fixture: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChildProcess> {
  const child = fork(new URL(fixture, import.meta.url), [...args], {
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await waitForReady(child);
  return child;
}

async function assertPending(operation: Promise<void>, label: string): Promise<void> {
  await Promise.race([
    operation.then(() => assert.fail(`${label} completed before the migration turn was released`)),
    delay(100),
  ]);
}

function readRuntimeVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

function waitForReady(child: ChildProcess): Promise<void> {
  return waitForMessage(child, 'ready');
}

function waitForMessage(child: ChildProcess, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`operational lease holder exited before ready: ${code ?? signal}`));
    });
    child.once('message', (message) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === type) {
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

function waitForFailure(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode && child.exitCode !== 0
      ? Promise.resolve()
      : Promise.reject(new Error('stale migrator exited successfully'));
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code && code !== 0) resolve();
      else reject(new Error(`stale migrator unexpectedly succeeded: ${code ?? signal}`));
    });
  });
}

async function waitForHeldLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      if (!tryLock(fd)) return;
      unlock(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    await delay(5);
  }
  throw new Error(`operational lock was not acquired: ${lockPath}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForExit(child).catch(() => {});
}
