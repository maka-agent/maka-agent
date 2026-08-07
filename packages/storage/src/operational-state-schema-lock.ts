/// <reference path="./fs-native-extensions.d.ts" />

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tryLock, unlock } from 'fs-native-extensions';

const OPERATIONAL_STATE_SCHEMA_LOCK_FILE = 'runtime.sqlite.schema.lock';
const OPERATIONAL_STATE_SCHEMA_LOCK_WAIT_MS = 5_000;
const OPERATIONAL_STATE_SCHEMA_LOCK_RETRY_MS = 25;
const schemaLockRetryGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const MIGRATION_BLOCKED_MESSAGE =
  'Operational state requires a schema migration. The database was not modified; close other Maka processes before retrying.';

export interface OperationalStateSchemaLock {
  close(): void;
}

export function waitForOperationalStateSchemaUseLock(
  workspaceRoot: string,
): OperationalStateSchemaLock {
  const deadline = Date.now() + OPERATIONAL_STATE_SCHEMA_LOCK_WAIT_MS;
  while (true) {
    const lock = tryAcquireOperationalStateSchemaLock(workspaceRoot, true);
    if (lock) return lock;
    if (Date.now() >= deadline) throw new Error(MIGRATION_BLOCKED_MESSAGE);
    Atomics.wait(
      schemaLockRetryGate,
      0,
      0,
      Math.min(OPERATIONAL_STATE_SCHEMA_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())),
    );
  }
}

export function tryAcquireOperationalStateMigrationLock(
  workspaceRoot: string,
): OperationalStateSchemaLock | undefined {
  return tryAcquireOperationalStateSchemaLock(workspaceRoot, false);
}

export function operationalStateMigrationBlockedError(): Error {
  return new Error(MIGRATION_BLOCKED_MESSAGE);
}

function tryAcquireOperationalStateSchemaLock(
  workspaceRoot: string,
  shared: boolean,
): OperationalStateSchemaLock | undefined {
  const canonicalRoot = resolve(workspaceRoot);
  mkdirSync(canonicalRoot, { recursive: true });
  const path = join(canonicalRoot, OPERATIONAL_STATE_SCHEMA_LOCK_FILE);
  const fd = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let acquired = false;
  try {
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    assertStableRegularFile(fd, path);
    acquired = tryLock(fd, { shared });
    if (!acquired) {
      closeSync(fd);
      return undefined;
    }
    assertStableRegularFile(fd, path);
  } catch (error) {
    if (acquired) releaseLock(fd);
    closeSync(fd);
    throw error;
  }

  let closed = false;
  return Object.freeze({
    close: () => {
      if (closed) return;
      closed = true;
      releaseLock(fd);
      closeSync(fd);
    },
  });
}

function assertStableRegularFile(fd: number, path: string): void {
  const handleStat = fstatSync(fd, { bigint: true });
  const pathStat = lstatSync(path, { bigint: true });
  if (
    !handleStat.isFile() ||
    !pathStat.isFile() ||
    handleStat.dev !== pathStat.dev ||
    handleStat.ino !== pathStat.ino
  ) {
    throw new Error(`Operational schema lock is not one stable regular file: ${path}`);
  }
}

function releaseLock(fd: number): void {
  try {
    unlock(fd);
  } catch {
    // Closing the descriptor is the final OS-level release path.
  }
}
