/// <reference path="./fs-native-extensions.d.ts" />

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tryLock, unlock } from 'fs-native-extensions';

const OPERATIONAL_STATE_SCHEMA_LOCK_WAIT_MS = 60_000;
const OPERATIONAL_STATE_SCHEMA_LOCK_RETRY_MS = 25;
const schemaLockRetryGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const MIGRATION_BLOCKED_MESSAGE =
  'Operational state requires a schema migration. The database was not modified; close other Maka processes before retrying.';
const MIGRATION_WAIT_TIMEOUT_MESSAGE =
  'Timed out waiting for another Maka process to finish opening or upgrading operational state; retry after it completes.';

export interface OperationalStateSchemaLock {
  readonly identity: { readonly dev: string; readonly ino: string };
  assertCurrentDatabasePath(): void;
  close(): void;
}

export interface OperationalStatePublicationLock {
  readonly identity: { readonly dev: string; readonly ino: string };
  close(): void;
}

export function waitForOperationalStateSchemaUseLock(
  databasePath: string,
): OperationalStateSchemaLock {
  return waitForOperationalStateSchemaLock(databasePath, 'owner', true);
}

export function waitForOperationalStateMigrationTurn(
  databasePath: string,
): OperationalStateSchemaLock {
  return waitForOperationalStateSchemaLock(databasePath, 'migration-turn', false);
}

export function tryAcquireOperationalStateMigrationLock(
  databasePath: string,
): OperationalStateSchemaLock | undefined {
  return tryAcquireOperationalStateSchemaLock(databasePath, 'owner', false);
}

export function operationalStateMigrationBlockedError(): Error {
  return new Error(MIGRATION_BLOCKED_MESSAGE);
}

export function waitForOperationalStatePublicationLock(
  databasePath: string,
): OperationalStatePublicationLock {
  const canonicalDatabasePath = canonicalizeProspectiveDatabasePath(databasePath);
  const lockPath = resolveOperationalStateLockPath(canonicalDatabasePath, 'owner');
  const deadline = Date.now() + OPERATIONAL_STATE_SCHEMA_LOCK_WAIT_MS;
  while (true) {
    const lock = tryAcquirePublicationLock(lockPath);
    if (lock) return lock;
    if (Date.now() >= deadline) throw new Error(MIGRATION_WAIT_TIMEOUT_MESSAGE);
    Atomics.wait(
      schemaLockRetryGate,
      0,
      0,
      Math.min(OPERATIONAL_STATE_SCHEMA_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())),
    );
  }
}

function tryAcquirePublicationLock(lockPath: string): OperationalStatePublicationLock | undefined {
  const lockFd = openSync(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let acquired = false;
  try {
    if (process.platform !== 'win32') fchmodSync(lockFd, 0o600);
    const identity = assertStableRegularFile(lockFd, lockPath);
    acquired = tryLock(lockFd);
    if (!acquired) {
      closeSync(lockFd);
      return undefined;
    }
    assertStableRegularFile(lockFd, lockPath);
    let closed = false;
    return Object.freeze({
      identity: Object.freeze({ dev: identity.dev.toString(), ino: identity.ino.toString() }),
      close: () => {
        if (closed) return;
        closed = true;
        releaseLock(lockFd);
        closeSync(lockFd);
      },
    });
  } catch (error) {
    if (acquired) releaseLock(lockFd);
    closeSync(lockFd);
    throw error;
  }
}

function waitForOperationalStateSchemaLock(
  databasePath: string,
  role: 'owner' | 'migration-turn',
  shared: boolean,
): OperationalStateSchemaLock {
  const deadline = Date.now() + OPERATIONAL_STATE_SCHEMA_LOCK_WAIT_MS;
  while (true) {
    const lock = tryAcquireOperationalStateSchemaLock(databasePath, role, shared);
    if (lock) return lock;
    if (Date.now() >= deadline) throw new Error(MIGRATION_WAIT_TIMEOUT_MESSAGE);
    Atomics.wait(
      schemaLockRetryGate,
      0,
      0,
      Math.min(OPERATIONAL_STATE_SCHEMA_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())),
    );
  }
}

function tryAcquireOperationalStateSchemaLock(
  databasePath: string,
  role: 'owner' | 'migration-turn',
  shared: boolean,
): OperationalStateSchemaLock | undefined {
  const canonicalDatabasePath = canonicalizeDatabasePath(databasePath);
  const databaseFd = openSync(
    canonicalDatabasePath,
    fsConstants.O_CREAT | fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let lockFd: number | undefined;
  let acquired = false;
  try {
    assertStableRegularFile(databaseFd, canonicalDatabasePath);
    const lockPath = resolveOperationalStateLockPath(canonicalDatabasePath, role);
    lockFd = openSync(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    if (process.platform !== 'win32') fchmodSync(lockFd, 0o600);
    assertStableRegularFile(lockFd, lockPath);
    acquired = tryLock(lockFd, { shared });
    if (!acquired) {
      closeSync(lockFd);
      closeSync(databaseFd);
      return undefined;
    }
    const lockIdentity = assertStableRegularFile(lockFd, lockPath);
    assertStableRegularFile(databaseFd, canonicalDatabasePath);
    const acquiredLockFd = lockFd;

    let closed = false;
    return Object.freeze({
      identity: Object.freeze({
        dev: lockIdentity.dev.toString(),
        ino: lockIdentity.ino.toString(),
      }),
      assertCurrentDatabasePath: () => {
        if (closed) throw new Error('Operational schema lock is closed');
        assertStableRegularFile(databaseFd, canonicalDatabasePath);
      },
      close: () => {
        if (closed) return;
        closed = true;
        releaseLock(acquiredLockFd);
        closeSync(acquiredLockFd);
        closeSync(databaseFd);
      },
    });
  } catch (error) {
    if (lockFd !== undefined) {
      if (acquired) releaseLock(lockFd);
      closeSync(lockFd);
    }
    closeSync(databaseFd);
    throw error;
  }
}

function resolveOperationalStateLockPath(
  databasePath: string,
  role: 'owner' | 'migration-turn',
): string {
  const lockDirectory = resolveOperationalStateSchemaLockDirectory();
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(lockDirectory);
  const identity = createHash('sha256').update(databasePath).digest('hex');
  const suffix = role === 'owner' ? '' : '.migration-turn';
  return join(lockDirectory, `${identity}${suffix}.lock`);
}

export function resolveOperationalStateSchemaLockPath(
  databasePath: string,
  role: 'owner' | 'migration-turn',
): string {
  const canonicalDatabasePath = canonicalizeDatabasePath(databasePath);
  const identity = lstatSync(canonicalDatabasePath, { bigint: true });
  if (!identity.isFile())
    throw new Error(`Operational state is not a regular file: ${databasePath}`);
  return resolveOperationalStateLockPath(canonicalDatabasePath, role);
}

function canonicalizeDatabasePath(databasePath: string): string {
  const absolutePath = resolve(databasePath);
  const parentPath = dirname(absolutePath);
  mkdirSync(parentPath, { recursive: true });
  return join(realpathSync(parentPath), basename(absolutePath));
}

function canonicalizeProspectiveDatabasePath(databasePath: string): string {
  const absolutePath = resolve(databasePath);
  const missingSegments = [basename(absolutePath)];
  let ancestorPath = dirname(absolutePath);
  while (!existsSync(ancestorPath)) {
    const parentPath = dirname(ancestorPath);
    if (parentPath === ancestorPath) {
      throw new Error(`Operational state publication has no existing ancestor: ${databasePath}`);
    }
    missingSegments.unshift(basename(ancestorPath));
    ancestorPath = parentPath;
  }
  const canonicalAncestorPath = realpathSync(ancestorPath);
  if (!lstatSync(canonicalAncestorPath).isDirectory()) {
    throw new Error(
      `Operational state publication ancestor is not a directory: ${canonicalAncestorPath}`,
    );
  }
  return join(canonicalAncestorPath, ...missingSegments);
}

function resolveOperationalStateSchemaLockDirectory(): string {
  const accountHome = userInfo().homedir;
  if (!isAbsolute(accountHome)) throw new Error('OS account home must be an absolute path');
  if (process.platform === 'darwin') {
    return join(accountHome, 'Library', 'Application Support', 'Maka', 'operational-schema-locks');
  }
  if (process.platform === 'win32') {
    return join(accountHome, 'AppData', 'Local', 'Maka', 'operational-schema-locks');
  }
  return join(accountHome, '.local', 'state', 'maka', 'operational-schema-locks');
}

function assertPrivateDirectory(path: string): void {
  const status = lstatSync(path);
  if (!status.isDirectory())
    throw new Error(`Operational schema lock root is not a directory: ${path}`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
      throw new Error(`Operational schema lock root is not owned by the current user: ${path}`);
    }
    chmodSync(path, 0o700);
    if ((lstatSync(path).mode & 0o077) !== 0) {
      throw new Error(`Operational schema lock root is not private: ${path}`);
    }
  }
}

function assertStableRegularFile(fd: number, path: string): { dev: bigint; ino: bigint } {
  const handleStat = fstatSync(fd, { bigint: true });
  const pathStat = lstatSync(path, { bigint: true });
  if (
    !handleStat.isFile() ||
    !pathStat.isFile() ||
    handleStat.nlink !== 1n ||
    pathStat.nlink !== 1n ||
    handleStat.dev !== pathStat.dev ||
    handleStat.ino !== pathStat.ino
  ) {
    throw new Error(`Operational schema authority is not one stable regular file: ${path}`);
  }
  return { dev: handleStat.dev, ino: handleStat.ino };
}

function releaseLock(fd: number): void {
  try {
    unlock(fd);
  } catch {
    // Closing the descriptor is the final OS-level release path.
  }
}
