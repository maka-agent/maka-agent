import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { link, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
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
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
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
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
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
