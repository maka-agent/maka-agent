import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_DIR_NAME = '.ab-run.lock';

export async function withAbRunLock<T>(runRoot: string, action: () => Promise<T>): Promise<T> {
  await mkdir(runRoot, { recursive: true });
  const lockPath = join(runRoot, LOCK_DIR_NAME);
  await acquireLock(lockPath);
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  try {
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
      'utf8',
    );
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  const ownerPid = await readOwnerPid(lockPath);
  if (ownerPid === undefined || isProcessAlive(ownerPid)) {
    throw new Error(
      `A/B run is already active (lock: ${lockPath}${ownerPid ? `, pid: ${ownerPid}` : ''})`,
    );
  }

  const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lockPath, stalePath);
  } catch {
    throw new Error(`A/B run is already active (lock changed while checking: ${lockPath})`);
  }
  await rm(stalePath, { recursive: true, force: true });
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
    'utf8',
  );
}

async function readOwnerPid(lockPath: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
      pid?: unknown;
    };
    return Number.isInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error, 'EEXIST');
}

function isNoSuchProcess(error: unknown): boolean {
  return isNodeError(error, 'ESRCH');
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
