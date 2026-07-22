import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function publishFileExclusively(path: string, contents: string): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    await syncDirectory(directory);
    return true;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function syncParentDirectory(path: string): Promise<void> {
  await syncDirectory(dirname(path));
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}
