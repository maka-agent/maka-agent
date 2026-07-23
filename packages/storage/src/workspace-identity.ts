import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { link, lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, resolve } from 'node:path';
import { promisify } from 'node:util';

export const WORKSPACE_MARKER_FILE = '.maka-workspace.json';
export const WORKSPACE_MARKER_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_IDENTITY_PREFIX = 'workspace:v1:' as const;
const MAX_WORKSPACE_MARKER_BYTES = 4_096;
const MAX_GIT_EXCLUDE_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

interface WorkspaceMarker {
  schemaVersion: typeof WORKSPACE_MARKER_SCHEMA_VERSION;
  workspaceId: string;
}

export interface WorkspaceIdentityResolution {
  workspaceIdentity: string;
  canonicalPath: string;
}

export interface ResolveWorkspaceIdentityInput {
  path: string;
}

export type WorkspaceIdentityErrorCode =
  | 'workspace_not_found'
  | 'invalid_workspace'
  | 'workspace_unmarked'
  | 'invalid_workspace_marker'
  | 'workspace_identity_changed'
  | 'workspace_io_failed';

export class WorkspaceIdentityError extends Error {
  constructor(
    readonly code: WorkspaceIdentityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkspaceIdentityError';
  }
}

/**
 * Resolves the intrinsic workspace identity, creating a marker only when the
 * workspace has never been marked. Existing markers are authoritative and are
 * never rebound based on path or inode.
 */
export async function resolveWorkspaceIdentity(
  input: ResolveWorkspaceIdentityInput,
): Promise<WorkspaceIdentityResolution> {
  return withWorkspaceFailure(async () => {
    const snapshot = await resolveWorkspaceSnapshot(input.path);
    const marker = await ensureWorkspaceMarker(snapshot);
    return toResolution(snapshot.canonicalPath, marker);
  });
}

interface WorkspaceSnapshot {
  canonicalPath: string;
  workspaceStat: BigIntStats;
}

async function resolveWorkspaceSnapshot(path: string): Promise<WorkspaceSnapshot> {
  let canonicalPath: string;
  try {
    canonicalPath = canonicalizePath(await realpath(resolve(path)));
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new WorkspaceIdentityError(
        'workspace_not_found',
        `Workspace does not exist: ${resolve(path)}`,
      );
    }
    throw error;
  }
  const workspaceStat = await stat(canonicalPath, { bigint: true });
  if (!workspaceStat.isDirectory()) {
    throw new WorkspaceIdentityError(
      'invalid_workspace',
      `Workspace is not a directory: ${canonicalPath}`,
    );
  }
  return { canonicalPath, workspaceStat };
}

async function ensureWorkspaceMarker(snapshot: WorkspaceSnapshot): Promise<WorkspaceMarker> {
  try {
    const marker = await readWorkspaceMarker(snapshot.canonicalPath);
    await ensureWorkspaceMarkerIgnored(snapshot.canonicalPath);
    return marker;
  } catch (error) {
    if (!(error instanceof WorkspaceIdentityError) || error.code !== 'workspace_unmarked') {
      throw error;
    }
  }
  return createWorkspaceMarker(snapshot, randomUUID());
}

async function createWorkspaceMarker(
  snapshot: WorkspaceSnapshot,
  workspaceId: string,
): Promise<WorkspaceMarker> {
  await ensureWorkspaceMarkerIgnored(snapshot.canonicalPath);
  const marker: WorkspaceMarker = {
    schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
    workspaceId,
  };
  const markerPath = join(snapshot.canonicalPath, WORKSPACE_MARKER_FILE);
  const tempPath = temporaryMarkerPath(snapshot.canonicalPath);
  let tempCreated = false;
  try {
    await writeMarkerFile(tempPath, marker);
    tempCreated = true;
    await assertWorkspaceSnapshot(snapshot);
    try {
      await link(tempPath, markerPath);
      await syncDirectory(snapshot.canonicalPath);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
  } finally {
    if (tempCreated) await unlinkIfPresent(tempPath);
  }
  await assertWorkspaceSnapshot(snapshot);
  return readWorkspaceMarker(snapshot.canonicalPath);
}

async function ensureWorkspaceMarkerIgnored(workspacePath: string): Promise<void> {
  if (!(await hasEnclosingGitEntry(workspacePath))) return;

  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  const { stdout } = await execFileAsync(
    'git',
    ['-C', workspacePath, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
    {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 3_000,
      windowsHide: true,
    },
  );
  const excludePath = stdout.trim();
  if (!isAbsolute(excludePath)) {
    throw new Error(`Git returned a non-absolute exclude path: ${excludePath}`);
  }

  const handle = await open(
    excludePath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const [handleStat, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(excludePath, { bigint: true }),
    ]);
    if (
      !handleStat.isFile() ||
      !pathStat.isFile() ||
      handleStat.size > BigInt(MAX_GIT_EXCLUDE_BYTES) ||
      handleStat.dev !== pathStat.dev ||
      handleStat.ino !== pathStat.ino
    ) {
      throw new Error(`Git exclude must be one bounded regular file: ${excludePath}`);
    }
    const contents = await handle.readFile('utf8');
    if (contents.split(/\r?\n/).includes(WORKSPACE_MARKER_FILE)) return;
    const separator = contents.length === 0 || contents.endsWith('\n') ? '' : '\n';
    const addition = `${separator}${WORKSPACE_MARKER_FILE}\n`;
    if (
      handleStat.size + BigInt(Buffer.byteLength(addition, 'utf8')) >
      BigInt(MAX_GIT_EXCLUDE_BYTES)
    ) {
      throw new Error(`Git exclude must be one bounded regular file: ${excludePath}`);
    }
    await handle.writeFile(addition, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hasEnclosingGitEntry(workspacePath: string): Promise<boolean> {
  let currentPath = workspacePath;
  while (true) {
    try {
      await lstat(join(currentPath, '.git'));
      return true;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parentPath = parse(currentPath).dir;
    if (parentPath === currentPath) return false;
    currentPath = parentPath;
  }
}

async function writeMarkerFile(path: string, marker: WorkspaceMarker): Promise<void> {
  const serializedMarker = serializeWorkspaceMarker(marker);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(serializedMarker, 'utf8');
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlinkIfPresent(path);
    throw error;
  }
}

function serializeWorkspaceMarker(marker: WorkspaceMarker): string {
  if (!isWorkspaceMarker(marker)) {
    throw new WorkspaceIdentityError(
      'invalid_workspace_marker',
      'Workspace marker candidate has invalid fields',
    );
  }
  const serializedMarker = `${JSON.stringify(marker)}\n`;
  if (Buffer.byteLength(serializedMarker, 'utf8') > MAX_WORKSPACE_MARKER_BYTES) {
    throw new WorkspaceIdentityError(
      'invalid_workspace_marker',
      'Workspace marker candidate exceeds the size limit',
    );
  }
  return serializedMarker;
}

async function readWorkspaceMarker(root: string): Promise<WorkspaceMarker> {
  const markerPath = join(root, WORKSPACE_MARKER_FILE);
  let marker: unknown;
  try {
    const handle = await open(markerPath, markerReadFlags());
    try {
      const [handleStat, pathStat] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(markerPath, { bigint: true }),
      ]);
      if (
        !handleStat.isFile() ||
        !pathStat.isFile() ||
        handleStat.size > BigInt(MAX_WORKSPACE_MARKER_BYTES) ||
        handleStat.dev !== pathStat.dev ||
        handleStat.ino !== pathStat.ino
      ) {
        throw new WorkspaceIdentityError(
          'invalid_workspace_marker',
          `Workspace marker must be one bounded regular file: ${markerPath}`,
        );
      }
      marker = JSON.parse(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceIdentityError) throw error;
    if (isMissingPathError(error)) {
      throw new WorkspaceIdentityError('workspace_unmarked', `Workspace is not marked: ${root}`);
    }
    if (error instanceof SyntaxError || isInvalidMarkerPathError(error)) {
      throw new WorkspaceIdentityError(
        'invalid_workspace_marker',
        `Invalid workspace marker at ${markerPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!isWorkspaceMarker(marker)) {
    throw new WorkspaceIdentityError(
      'invalid_workspace_marker',
      `Invalid workspace marker at ${markerPath}`,
    );
  }
  return marker;
}

function isWorkspaceMarker(value: unknown): value is WorkspaceMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  return (
    keys.length === 2 &&
    keys[0] === 'schemaVersion' &&
    keys[1] === 'workspaceId' &&
    marker.schemaVersion === WORKSPACE_MARKER_SCHEMA_VERSION &&
    typeof marker.workspaceId === 'string' &&
    isUuid(marker.workspaceId)
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toResolution(canonicalPath: string, marker: WorkspaceMarker): WorkspaceIdentityResolution {
  return {
    workspaceIdentity: `${WORKSPACE_IDENTITY_PREFIX}${marker.workspaceId}`,
    canonicalPath,
  };
}

async function assertWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
  const current = await statWorkspaceIfPresent(snapshot.canonicalPath);
  if (
    !current?.isDirectory() ||
    current.dev !== snapshot.workspaceStat.dev ||
    current.ino !== snapshot.workspaceStat.ino
  ) {
    throw new WorkspaceIdentityError(
      'workspace_identity_changed',
      `Workspace changed while validating its marker: ${snapshot.canonicalPath}`,
    );
  }
}

function temporaryMarkerPath(root: string): string {
  return join(root, `${WORKSPACE_MARKER_FILE}.${process.pid}.${randomUUID()}.tmp`);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function canonicalizePath(path: string): string {
  const normalized = normalize(path);
  const root = parse(normalized).root;
  return normalized === root ? normalized : normalized.replace(/[\\/]+$/, '');
}

function markerReadFlags(): string | number {
  if (process.platform === 'win32') return 'r';
  return fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
}

async function statWorkspaceIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR');
}

function isInvalidMarkerPathError(error: unknown): boolean {
  return isMissingPathError(error) || isNodeError(error, 'ELOOP') || isNodeError(error, 'ENXIO');
}

async function withWorkspaceFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceIdentityError) throw error;
    throw new WorkspaceIdentityError(
      'workspace_io_failed',
      'Unable to resolve workspace identity',
      {
        cause: error,
      },
    );
  }
}
