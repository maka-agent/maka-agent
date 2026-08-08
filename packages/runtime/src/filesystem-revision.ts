import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { realpathAllowMissing } from './path-containment.js';

export type FilesystemEntryType = 'file' | 'directory' | 'symlink' | 'other' | 'missing';

export interface FilesystemEntryRevision {
  readonly targetType: FilesystemEntryType;
  readonly token: string;
}

export async function snapshotFilesystemEntry(path: string): Promise<FilesystemEntryRevision> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await statOrMissing(path);
    if (!before) return await snapshotMissingEntry(path);
    const payload = before.isFile()
      ? await readFile(path)
      : before.isSymbolicLink()
        ? Buffer.from(await readlink(path), 'utf8')
        : Buffer.alloc(0);
    const after = await statOrMissing(path);
    if (after && identity(before) === identity(after)) {
      return {
        targetType: entryType(after),
        token: revisionToken(path, identity(after), payload),
      };
    }
  }
  throw Object.assign(new Error('Filesystem entry changed while it was being inspected.'), {
    code: 'ESTALE',
  });
}

export async function assertFilesystemEntryRevision(
  path: string,
  expectedToken: string,
): Promise<void> {
  if (expectedToken.startsWith('missing:')) {
    await assertMissingEntryRevision(path, expectedToken);
    return;
  }
  const current = await snapshotFilesystemEntry(path);
  if (current.token !== expectedToken) {
    throw Object.assign(new Error('The patch target changed after it was inspected.'), {
      code: 'ESTALE',
    });
  }
}

async function snapshotMissingEntry(path: string): Promise<FilesystemEntryRevision> {
  let ancestor = dirname(path);
  while (true) {
    const metadata = await statOrMissing(ancestor);
    if (metadata) {
      const canonicalAncestor = await realpath(ancestor);
      return {
        targetType: 'missing',
        token: missingRevisionToken(path, canonicalAncestor, ancestorIdentity(metadata)),
      };
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`No existing ancestor for patch target ${path}`);
    }
    ancestor = parent;
  }
}

async function assertMissingEntryRevision(path: string, expectedToken: string): Promise<void> {
  if (await statOrMissing(path)) throw staleRevision();
  const [, encodedAncestor, fingerprint] = expectedToken.split(':');
  if (!encodedAncestor || !fingerprint) throw staleRevision();
  const ancestor = Buffer.from(encodedAncestor, 'base64url').toString('utf8');
  const metadata = await statOrMissing(ancestor);
  if (!metadata || (await realpath(ancestor)) !== ancestor) throw staleRevision();
  const parent = await realpathAllowMissing(dirname(path));
  const fromAncestor = relative(ancestor, parent);
  if (
    fromAncestor === '..' ||
    fromAncestor.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromAncestor)
  ) {
    throw staleRevision();
  }
  if (missingRevisionFingerprint(path, ancestor, ancestorIdentity(metadata)) !== fingerprint) {
    throw staleRevision();
  }
}

async function statOrMissing(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function entryType(
  metadata: NonNullable<Awaited<ReturnType<typeof statOrMissing>>>,
): FilesystemEntryType {
  if (metadata.isSymbolicLink()) return 'symlink';
  if (metadata.isFile()) return 'file';
  if (metadata.isDirectory()) return 'directory';
  return 'other';
}

function identity(metadata: NonNullable<Awaited<ReturnType<typeof statOrMissing>>>): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.nlink,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(':');
}

function ancestorIdentity(
  metadata: NonNullable<Awaited<ReturnType<typeof statOrMissing>>>,
): string {
  return [metadata.dev, metadata.ino, metadata.mode].join(':');
}

function revisionToken(path: string, metadata: string, payload: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(path);
  hash.update('\0');
  hash.update(metadata);
  hash.update('\0');
  hash.update(payload);
  return `sha256:${hash.digest('hex')}`;
}

function missingRevisionToken(path: string, ancestor: string, metadata: string): string {
  return `missing:${Buffer.from(ancestor, 'utf8').toString('base64url')}:${missingRevisionFingerprint(path, ancestor, metadata)}`;
}

function missingRevisionFingerprint(path: string, ancestor: string, metadata: string): string {
  const hash = createHash('sha256');
  hash.update(path);
  hash.update('\0');
  hash.update(ancestor);
  hash.update('\0');
  hash.update(metadata);
  return hash.digest('hex');
}

function staleRevision(): Error {
  return Object.assign(new Error('The patch target changed after it was inspected.'), {
    code: 'ESTALE',
  });
}
