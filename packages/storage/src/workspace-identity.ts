import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { link, lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { join, normalize, parse, resolve } from 'node:path';

export const WORKSPACE_MARKER_FILE = '.maka-workspace.json';
export const WORKSPACE_MARKER_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_IDENTITY_PREFIX = 'workspace:v1:' as const;
const MAX_WORKSPACE_MARKER_BYTES = 4_096;
const MAX_LEGACY_ANCHORS = 32;

interface WorkspaceMarker {
  schemaVersion: typeof WORKSPACE_MARKER_SCHEMA_VERSION;
  workspaceId: string;
  legacyAnchors: string[];
}

export interface WorkspaceIdentityResolution {
  workspaceIdentity: string;
  canonicalPath: string;
  /** Legacy filesystem identities accepted only while migrating old AgentRun headers. */
  legacyWorkspaceIdentities: readonly string[];
}

export interface ResolveWorkspaceIdentityInput {
  path: string;
}

export interface AdoptWorkspaceIdentityOnImportInput extends ResolveWorkspaceIdentityInput {
  /** When supplied, importing a marker with any other UUID fails closed. */
  expectedWorkspaceIdentity?: string;
  /** Explicit provenance supplied by an importer for a pre-marker bundle. */
  legacyWorkspaceIdentity?: string;
}

export type WorkspaceIdentityErrorCode =
  | 'workspace_not_found'
  | 'invalid_workspace'
  | 'workspace_unmarked'
  | 'invalid_workspace_marker'
  | 'workspace_identity_conflict'
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
    const currentLegacyAnchor = legacyAnchor(snapshot.canonicalPath, snapshot.workspaceStat);
    const marker = await ensureWorkspaceMarker(snapshot, currentLegacyAnchor);
    return toResolution(snapshot.canonicalPath, marker, currentLegacyAnchor);
  });
}

/**
 * Explicit import boundary. It preserves a copied marker UUID, or creates a
 * marker for a legacy bundle while recording the importer's trusted old anchor.
 */
export async function adoptWorkspaceIdentityOnImport(
  input: AdoptWorkspaceIdentityOnImportInput,
): Promise<WorkspaceIdentityResolution> {
  return withWorkspaceFailure(async () => {
    const expectedWorkspaceId =
      input.expectedWorkspaceIdentity === undefined
        ? undefined
        : parseWorkspaceIdentity(input.expectedWorkspaceIdentity);
    if (
      input.legacyWorkspaceIdentity !== undefined &&
      !isLegacyWorkspaceIdentity(input.legacyWorkspaceIdentity)
    ) {
      throw new WorkspaceIdentityError(
        'invalid_workspace_marker',
        `Invalid legacy workspace identity: ${input.legacyWorkspaceIdentity}`,
      );
    }

    const snapshot = await resolveWorkspaceSnapshot(input.path);
    const currentLegacyAnchor = legacyAnchor(snapshot.canonicalPath, snapshot.workspaceStat);
    let marker: WorkspaceMarker;
    try {
      marker = await readWorkspaceMarker(snapshot.canonicalPath);
    } catch (error) {
      if (!(error instanceof WorkspaceIdentityError) || error.code !== 'workspace_unmarked') {
        throw error;
      }
      marker = await createWorkspaceMarker(
        snapshot,
        expectedWorkspaceId ?? randomUUID(),
        uniqueStrings([input.legacyWorkspaceIdentity, currentLegacyAnchor]),
      );
    }

    if (expectedWorkspaceId !== undefined && marker.workspaceId !== expectedWorkspaceId) {
      throw new WorkspaceIdentityError(
        'workspace_identity_conflict',
        `Imported workspace marker does not match the expected identity: ${snapshot.canonicalPath}`,
      );
    }

    const nextLegacyAnchors = uniqueStrings([
      ...marker.legacyAnchors,
      input.legacyWorkspaceIdentity,
    ]);
    if (!sameStrings(marker.legacyAnchors, nextLegacyAnchors)) {
      marker = await replaceWorkspaceMarker(snapshot, {
        ...marker,
        legacyAnchors: nextLegacyAnchors,
      });
    }
    return toResolution(snapshot.canonicalPath, marker, currentLegacyAnchor);
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

async function ensureWorkspaceMarker(
  snapshot: WorkspaceSnapshot,
  currentLegacyAnchor: string,
): Promise<WorkspaceMarker> {
  try {
    return await readWorkspaceMarker(snapshot.canonicalPath);
  } catch (error) {
    if (!(error instanceof WorkspaceIdentityError) || error.code !== 'workspace_unmarked') {
      throw error;
    }
  }
  return createWorkspaceMarker(snapshot, randomUUID(), [currentLegacyAnchor]);
}

async function createWorkspaceMarker(
  snapshot: WorkspaceSnapshot,
  workspaceId: string,
  legacyAnchors: string[],
): Promise<WorkspaceMarker> {
  const marker: WorkspaceMarker = {
    schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
    workspaceId,
    legacyAnchors,
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

async function replaceWorkspaceMarker(
  snapshot: WorkspaceSnapshot,
  marker: WorkspaceMarker,
): Promise<WorkspaceMarker> {
  const markerPath = join(snapshot.canonicalPath, WORKSPACE_MARKER_FILE);
  const existing = await readWorkspaceMarker(snapshot.canonicalPath);
  if (existing.workspaceId !== marker.workspaceId) {
    throw new WorkspaceIdentityError(
      'workspace_identity_conflict',
      `Workspace identity changed while adopting an import: ${snapshot.canonicalPath}`,
    );
  }
  const tempPath = temporaryMarkerPath(snapshot.canonicalPath);
  let tempCreated = false;
  try {
    await writeMarkerFile(tempPath, marker);
    tempCreated = true;
    await assertWorkspaceSnapshot(snapshot);
    await rename(tempPath, markerPath);
    tempCreated = false;
    await syncDirectory(snapshot.canonicalPath);
  } finally {
    if (tempCreated) await unlinkIfPresent(tempPath);
  }
  await assertWorkspaceSnapshot(snapshot);
  const adopted = await readWorkspaceMarker(snapshot.canonicalPath);
  if (adopted.workspaceId !== marker.workspaceId) {
    throw new WorkspaceIdentityError(
      'workspace_identity_conflict',
      `Workspace identity changed while adopting an import: ${snapshot.canonicalPath}`,
    );
  }
  return adopted;
}

async function writeMarkerFile(path: string, marker: WorkspaceMarker): Promise<void> {
  const serializedMarker = serializeWorkspaceMarker(marker);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(serializedMarker, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
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
    keys.length === 3 &&
    keys[0] === 'legacyAnchors' &&
    keys[1] === 'schemaVersion' &&
    keys[2] === 'workspaceId' &&
    marker.schemaVersion === WORKSPACE_MARKER_SCHEMA_VERSION &&
    typeof marker.workspaceId === 'string' &&
    isUuid(marker.workspaceId) &&
    Array.isArray(marker.legacyAnchors) &&
    marker.legacyAnchors.length <= MAX_LEGACY_ANCHORS &&
    marker.legacyAnchors.every(isLegacyWorkspaceIdentity) &&
    new Set(marker.legacyAnchors).size === marker.legacyAnchors.length
  );
}

function parseWorkspaceIdentity(value: string): string {
  if (!value.startsWith(WORKSPACE_IDENTITY_PREFIX)) {
    throw new WorkspaceIdentityError(
      'invalid_workspace_marker',
      `Invalid workspace identity: ${value}`,
    );
  }
  const workspaceId = value.slice(WORKSPACE_IDENTITY_PREFIX.length);
  if (!isUuid(workspaceId)) {
    throw new WorkspaceIdentityError(
      'invalid_workspace_marker',
      `Invalid workspace identity: ${value}`,
    );
  }
  return workspaceId;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isLegacyWorkspaceIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^fs:\d+:\d+:.+/.test(value) &&
    Buffer.byteLength(value, 'utf8') <= 2_048
  );
}

function legacyAnchor(path: string, workspaceStat: BigIntStats): string {
  return `fs:${workspaceStat.dev.toString()}:${workspaceStat.ino.toString()}:${normalizeWorkspacePath(path)}`;
}

function toResolution(
  canonicalPath: string,
  marker: WorkspaceMarker,
  currentLegacyAnchor: string,
): WorkspaceIdentityResolution {
  return {
    workspaceIdentity: `${WORKSPACE_IDENTITY_PREFIX}${marker.workspaceId}`,
    canonicalPath,
    legacyWorkspaceIdentities: uniqueStrings([...marker.legacyAnchors, currentLegacyAnchor]),
  };
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function normalizeWorkspacePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
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
