import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import {
  access,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  ARTIFACT_KINDS,
  ARTIFACT_SOURCES,
  ARTIFACT_STATUSES,
  type ArtifactBinaryReadResult,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactSource,
  type ArtifactTextReadResult,
} from '@maka/core/artifacts';
import {
  isDeepResearchArtifactRole,
  type DeepResearchArtifactRole,
} from '@maka/core/deep-research-run';

export const ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES = 50 * 1024 * 1024;

const PUBLICATION_STAGING_PATTERN =
  /^\.artifact-publish\.([a-f0-9]{64})\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.tmp$/;

export interface CreateArtifactInput {
  sessionId: string;
  turnId: string;
  name: string;
  kind: ArtifactKind;
  content: string | Uint8Array;
  mimeType?: string;
  source?: ArtifactSource;
  summary?: string;
  deepResearchRole?: DeepResearchArtifactRole;
  now?: number;
  id?: string;
}

export interface ArtifactStoreReader {
  list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
  get(artifactId: string): Promise<ArtifactRecord | null>;
  readText(
    artifactId: string,
    opts?: { maxBytes?: number; includeDeleted?: boolean },
  ): Promise<ArtifactTextReadResult>;
  readBinary(artifactId: string, opts?: { maxBytes?: number }): Promise<ArtifactBinaryReadResult>;
}

export type DurableArtifactBinaryReadResult =
  | ArtifactBinaryReadResult
  | { ok: false; reason: 'session_mismatch' };

export interface DurableArtifactAttachmentReader {
  readDurableAttachmentBinary(input: {
    artifactId: string;
    sessionId: string;
    maxBytes?: number;
  }): Promise<DurableArtifactBinaryReadResult>;
}

export interface ArtifactStore extends ArtifactStoreReader, DurableArtifactAttachmentReader {
  recover(): Promise<void>;
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  delete(artifactId: string): Promise<void>;
  purge(artifactIds: readonly string[]): Promise<void>;
}

export function createArtifactStore(workspaceRoot: string): ArtifactStore {
  return new FileArtifactStore(workspaceRoot);
}

class FileArtifactStore implements ArtifactStore {
  private readonly artifactRoot: string;
  private readonly metadataPath: string;
  private records: ArtifactRecord[] = [];
  private loaded = false;
  private writerPrepared = false;
  private loadPromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {
    this.artifactRoot = join(workspaceRoot, 'artifacts');
    this.metadataPath = join(this.artifactRoot, 'metadata.jsonl');
  }

  async recover(): Promise<void> {
    await this.enqueue(() => this.prepareWriterUnlocked());
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const id = input.id ?? randomUUID();
    if (!ARTIFACT_KIND_SET.has(input.kind)) throw new Error('Invalid Artifact kind');
    if (input.source !== undefined && !ARTIFACT_SOURCE_SET.has(input.source)) {
      throw new Error('Invalid Artifact source');
    }
    if (input.now !== undefined && (!Number.isSafeInteger(input.now) || input.now < 0)) {
      throw new Error('Invalid Artifact creation time');
    }
    if (!isNonEmptyString(input.turnId)) throw new Error('Artifact turnId must be non-empty');
    validateArtifactPathSegment(input.sessionId, 'sessionId');
    validateArtifactPathSegment(id, 'id');
    const name = sanitizeArtifactName(input.name);
    const relativePath = `${input.sessionId}/${id}-${name}`;
    validateRelativeArtifactPath(relativePath);
    validateCanonicalArtifactTargetName(basename(relativePath));
    return this.enqueue(async () => {
      await this.prepareWriterUnlocked();
      if (this.records.some((record) => record.id === id)) {
        throw new Error(`Artifact ${id} already exists`);
      }
      const target = join(this.artifactRoot, relativePath);
      const targetDirectory = dirname(target);
      await mkdir(targetDirectory, { recursive: true });
      await assertArtifactDirectory(this.artifactRoot, targetDirectory);
      const tempPath = join(targetDirectory, publicationStagingName(basename(target)));
      let preserveStaging = false;
      try {
        await writeFile(tempPath, input.content, { flag: 'wx' });
        const size = await stat(tempPath);
        const record: ArtifactRecord = {
          id,
          sessionId: input.sessionId,
          turnId: input.turnId,
          createdAt: input.now ?? Date.now(),
          name,
          kind: input.kind,
          relativePath,
          sizeBytes: size.size,
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.deepResearchRole ? { deepResearchRole: input.deepResearchRole } : {}),
          status: 'live',
        };
        const nextRecords = [...this.records, record];
        try {
          await link(tempPath, target);
        } catch (error) {
          if (isAlreadyExists(error)) throw new Error(`Artifact target already exists: ${id}`);
          throw error;
        }
        try {
          await this.writeMetadataUnlocked(nextRecords);
        } catch (error) {
          await unlink(target).catch((cleanupError: unknown) => {
            if (!isNotFound(cleanupError)) {
              preserveStaging = true;
              throw new AggregateError(
                [error, cleanupError],
                `Artifact ${id} metadata publication and payload cleanup both failed`,
              );
            }
          });
          throw error;
        }
        this.records = nextRecords;
        return { ...record };
      } finally {
        if (!preserveStaging) await unlink(tempPath).catch(() => {});
      }
    });
  }

  async list(
    sessionId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<ArtifactRecord[]> {
    await this.load();
    return (
      this.records
        .filter((record) => record.sessionId === sessionId)
        .filter((record) => opts.includeDeleted || record.status !== 'deleted')
        // Secondary `id` sort for determinism when fixture artifacts share
        // a frozen createdAt (PR108k-yj e2e-fixture determinism).
        .sort((a, b) => {
          const tsDelta = b.createdAt - a.createdAt;
          if (tsDelta !== 0) return tsDelta;
          return a.id.localeCompare(b.id);
        })
        .map((record) => ({ ...record }))
    );
  }

  async get(artifactId: string): Promise<ArtifactRecord | null> {
    await this.load();
    const record = this.records.find((item) => item.id === artifactId);
    return record ? { ...record } : null;
  }

  async readText(
    artifactId: string,
    opts: { maxBytes?: number; includeDeleted?: boolean } = {},
  ): Promise<ArtifactTextReadResult> {
    const prepared = await this.prepareRead(
      artifactId,
      opts.maxBytes ?? ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES,
      opts.includeDeleted ?? false,
    );
    if (!prepared.ok) return prepared;
    try {
      return { ok: true, text: await readFile(prepared.path, 'utf8') };
    } catch {
      return { ok: false, reason: 'read_failed' };
    }
  }

  async readBinary(
    artifactId: string,
    opts: { maxBytes?: number } = {},
  ): Promise<ArtifactBinaryReadResult> {
    const prepared = await this.prepareRead(
      artifactId,
      opts.maxBytes ?? ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES,
      false,
    );
    return this.readPreparedBinary(prepared);
  }

  async readDurableAttachmentBinary(input: {
    artifactId: string;
    sessionId: string;
    maxBytes?: number;
  }): Promise<DurableArtifactBinaryReadResult> {
    await this.load();
    const record = this.records.find((item) => item.id === input.artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.sessionId !== input.sessionId) {
      return { ok: false, reason: 'session_mismatch' };
    }
    const prepared = await this.prepareRecordRead(
      record,
      input.maxBytes ?? ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES,
      true,
    );
    return this.readPreparedBinary(prepared);
  }

  private async readPreparedBinary(
    prepared:
      | { ok: true; path: string; record: ArtifactRecord }
      | {
          ok: false;
          reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted';
        },
  ): Promise<ArtifactBinaryReadResult> {
    if (!prepared.ok) return prepared;
    try {
      const bytes = await readFile(prepared.path);
      const mimeType = sniffAllowedBinaryMime(bytes);
      if (!mimeType) return { ok: false, reason: 'unsupported_mime' };
      return { ok: true, base64: bytes.toString('base64'), mimeType };
    } catch {
      return { ok: false, reason: 'read_failed' };
    }
  }

  async delete(artifactId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.prepareWriterUnlocked();
      const nextRecords: ArtifactRecord[] = this.records.map((record) =>
        record.id === artifactId && record.status !== 'deleted'
          ? { ...record, status: 'deleted' }
          : record,
      );
      if (nextRecords.every((record, index) => record === this.records[index])) return;
      await this.writeMetadataUnlocked(nextRecords);
      this.records = nextRecords;
    });
  }

  async purge(artifactIds: readonly string[]): Promise<void> {
    await this.enqueue(async () => {
      await this.prepareWriterUnlocked();
      const ids = new Set(artifactIds);
      const records = this.records.filter((record) => ids.has(record.id));
      if (records.length === 0) return;
      const root = await ensureRealDirectory(this.artifactRoot);
      const paths: string[] = [];
      for (const record of records) {
        validateRelativeArtifactPath(record.relativePath);
        const path = await resolveArtifactRemovalEntry(this.artifactRoot, record.relativePath);
        if (!path) continue;
        if (!isInsideOrSamePath(root, dirname(path))) {
          throw new Error(`Artifact ${record.id} resolves outside the artifact root`);
        }
        paths.push(path);
      }
      for (const path of paths) await rm(path, { force: true });
      const nextRecords = this.records.filter((record) => !ids.has(record.id));
      await this.writeMetadataUnlocked(nextRecords);
      this.records = nextRecords;
    });
  }

  private async prepareRead(
    artifactId: string,
    maxBytes: number,
    includeDeleted = false,
  ): Promise<
    | { ok: true; path: string; record: ArtifactRecord }
    | { ok: false; reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted' }
  > {
    const record = await this.get(artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    return this.prepareRecordRead(record, maxBytes, includeDeleted);
  }

  private async prepareRecordRead(
    record: ArtifactRecord,
    maxBytes: number,
    includeDeleted: boolean,
  ): Promise<
    | { ok: true; path: string; record: ArtifactRecord }
    | { ok: false; reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted' }
  > {
    if (record.status === 'deleted' && !includeDeleted) return { ok: false, reason: 'deleted' };
    const resolved = await resolveArtifactPath({
      artifactRoot: this.artifactRoot,
      relativePath: record.relativePath,
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const size = await stat(resolved.path).catch(() => null);
    if (!size || !size.isFile()) return { ok: false, reason: 'not_found' };
    if (size.size > maxBytes) return { ok: false, reason: 'too_large' };
    return { ok: true, path: resolved.path, record };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = (async () => {
      try {
        const text = await readFile(this.metadataPath, 'utf8');
        this.records = parseArtifactMetadata(text);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        this.records = [];
      }
      this.loaded = true;
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async writeMetadataUnlocked(records: readonly ArtifactRecord[]): Promise<void> {
    await mkdir(dirname(this.metadataPath), { recursive: true });
    const tempPath = `${this.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = records.map((record) => JSON.stringify(record)).join('\n');
    try {
      await writeFile(tempPath, payload ? `${payload}\n` : '', { encoding: 'utf8', flag: 'wx' });
      await rename(tempPath, this.metadataPath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  private async prepareWriterUnlocked(): Promise<void> {
    await this.load();
    if (this.writerPrepared) return;
    await this.recoverPublicationsUnlocked();
    this.writerPrepared = true;
  }

  private async recoverPublicationsUnlocked(): Promise<void> {
    let sessionEntries: Dirent[];
    try {
      sessionEntries = await readdir(this.artifactRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDirectory = join(this.artifactRoot, sessionEntry.name);
      const entries = await readdir(sessionDirectory, { withFileTypes: true });
      for (const entry of entries) {
        const match = PUBLICATION_STAGING_PATTERN.exec(entry.name);
        if (!match) continue;
        await this.recoverPublicationUnlocked({
          sessionId: sessionEntry.name,
          sessionDirectory,
          stagingName: entry.name,
          targetHash: match[1]!,
        });
      }
    }
  }

  private async recoverPublicationUnlocked(input: {
    sessionId: string;
    sessionDirectory: string;
    stagingName: string;
    targetHash: string;
  }): Promise<void> {
    const stagingPath = join(input.sessionDirectory, input.stagingName);
    const stagingStat = await lstat(stagingPath);
    if (!stagingStat.isFile() || stagingStat.isSymbolicLink()) {
      throw invalidPublicationResidue(input.stagingName);
    }

    const metadataMatches = this.records.filter((record) => {
      if (record.sessionId !== input.sessionId) return false;
      return artifactTargetHash(basename(record.relativePath)) === input.targetHash;
    });
    if (metadataMatches.length > 1) throw invalidPublicationResidue(input.stagingName);

    const directoryEntries = await readdir(input.sessionDirectory, { withFileTypes: true });
    const matchingTargets: Array<{
      name: string;
      size: number;
      dev: number;
      ino: number;
    }> = [];
    for (const entry of directoryEntries) {
      if (entry.name === input.stagingName || PUBLICATION_STAGING_PATTERN.test(entry.name))
        continue;
      if (artifactTargetHash(entry.name) !== input.targetHash) continue;
      const candidateStat = await lstat(join(input.sessionDirectory, entry.name));
      if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
        throw invalidPublicationResidue(input.stagingName);
      }
      matchingTargets.push({
        name: entry.name,
        size: candidateStat.size,
        dev: candidateStat.dev,
        ino: candidateStat.ino,
      });
    }

    const metadataRecord = metadataMatches[0];
    if (matchingTargets.length === 0 && !metadataRecord && stagingStat.nlink === 1) {
      await unlink(stagingPath);
      return;
    }
    if (matchingTargets.length !== 1 || stagingStat.nlink !== 2) {
      throw invalidPublicationResidue(input.stagingName);
    }

    const [linkedTarget] = matchingTargets;
    if (
      !linkedTarget ||
      linkedTarget.dev !== stagingStat.dev ||
      linkedTarget.ino !== stagingStat.ino
    ) {
      throw invalidPublicationResidue(input.stagingName);
    }
    const relativePath = `${input.sessionId}/${linkedTarget.name}`;
    validateRelativeArtifactPath(relativePath);

    if (metadataRecord) {
      if (
        metadataRecord.relativePath !== relativePath ||
        metadataRecord.sizeBytes !== linkedTarget.size
      ) {
        throw invalidPublicationResidue(input.stagingName);
      }
      await unlink(stagingPath);
      return;
    }

    await unlink(join(input.sessionDirectory, linkedTarget.name));
    await unlink(stagingPath);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

function publicationStagingName(targetBasename: string): string {
  return `.artifact-publish.${artifactTargetHash(targetBasename)}.${randomUUID()}.tmp`;
}

function artifactTargetHash(targetBasename: string): string {
  return createHash('sha256').update(targetBasename).digest('hex');
}

function invalidPublicationResidue(stagingName: string): Error {
  return new Error(`Artifact publication residue does not match canonical state: ${stagingName}`);
}

export async function resolveArtifactPath(input: {
  artifactRoot: string;
  relativePath: string;
}): Promise<
  { ok: true; path: string } | { ok: false; reason: 'not_found' | 'not_allowed' | 'read_failed' }
> {
  if (!isSafeRelativeArtifactPath(input.relativePath)) return { ok: false, reason: 'not_allowed' };
  const target = join(input.artifactRoot, input.relativePath);
  let root: string;
  let resolvedTarget: string;
  try {
    root = await ensureRealDirectory(input.artifactRoot);
    resolvedTarget = await realpath(target);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!isInsideOrSamePath(root, resolvedTarget)) return { ok: false, reason: 'not_allowed' };
  return { ok: true, path: resolvedTarget };
}

export function isSafeRelativeArtifactPath(relativePath: string): boolean {
  if (!relativePath || isAbsolute(relativePath)) return false;
  if (relativePath.includes('\0')) return false;
  if (relativePath.includes('//') || relativePath.includes('\\\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relativePath)) return false;
  const parts = relativePath.split(/[\\/]+/);
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

export function sanitizeArtifactName(name: string): string {
  const trimmed = name.trim();
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|\0]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/^-+/, '')
    .trim();
  return (cleaned || 'artifact').slice(0, 120);
}

function validateRelativeArtifactPath(relativePath: string): void {
  if (!isSafeRelativeArtifactPath(relativePath)) {
    throw new Error('Artifact relativePath must be artifact-root-relative');
  }
}

function validateCanonicalArtifactTargetName(targetName: string): void {
  if (PUBLICATION_STAGING_PATTERN.test(targetName)) {
    throw new Error('Artifact target name uses the reserved publication staging namespace');
  }
}

function validateArtifactPathSegment(value: string, field: 'sessionId' | 'id'): void {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error(`Artifact ${field} must be one safe path segment`);
  }
}

function parseArtifactMetadata(text: string): ArtifactRecord[] {
  const records: ArtifactRecord[] = [];
  const ids = new Set<string>();
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.length === 0 && index === lines.length - 1) continue;
    if (line.trim().length === 0) throw invalidMetadataLine(index + 1);
    try {
      const record = parseArtifactRecord(JSON.parse(line), index + 1);
      if (ids.has(record.id)) throw invalidMetadataLine(index + 1);
      ids.add(record.id);
      records.push(record);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid artifact metadata line')) {
        throw error;
      }
      throw invalidMetadataLine(index + 1, error);
    }
  }
  return records;
}

const ARTIFACT_KIND_SET = new Set<ArtifactKind>(ARTIFACT_KINDS);
const ARTIFACT_SOURCE_SET = new Set<ArtifactSource>(ARTIFACT_SOURCES);
const ARTIFACT_STATUS_SET = new Set<string>(ARTIFACT_STATUSES);
const ARTIFACT_RECORD_KEYS = new Set([
  'id',
  'sessionId',
  'turnId',
  'createdAt',
  'name',
  'kind',
  'relativePath',
  'sizeBytes',
  'mimeType',
  'source',
  'summary',
  'deepResearchRole',
  'status',
]);

function parseArtifactRecord(value: unknown, line: number): ArtifactRecord {
  if (!isRecord(value)) throw invalidMetadataLine(line);
  if (Object.keys(value).some((key) => !ARTIFACT_RECORD_KEYS.has(key))) {
    throw invalidMetadataLine(line);
  }
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.name) ||
    typeof value.kind !== 'string' ||
    !ARTIFACT_KIND_SET.has(value.kind as ArtifactKind) ||
    !isNonEmptyString(value.relativePath) ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    typeof value.status !== 'string' ||
    !ARTIFACT_STATUS_SET.has(value.status) ||
    !isOptionalNonEmptyString(value.mimeType) ||
    !isOptionalNonEmptyString(value.summary) ||
    (value.deepResearchRole !== undefined && !isDeepResearchArtifactRole(value.deepResearchRole)) ||
    (value.source !== undefined &&
      (typeof value.source !== 'string' ||
        !ARTIFACT_SOURCE_SET.has(value.source as ArtifactSource)))
  ) {
    throw invalidMetadataLine(line);
  }
  validateArtifactPathSegment(value.sessionId, 'sessionId');
  validateArtifactPathSegment(value.id, 'id');
  validateRelativeArtifactPath(value.relativePath);
  validateCanonicalArtifactTargetName(basename(value.relativePath));
  if (value.name !== sanitizeArtifactName(value.name)) throw invalidMetadataLine(line);
  if (value.relativePath !== `${value.sessionId}/${value.id}-${value.name}`) {
    throw invalidMetadataLine(line);
  }
  return value as unknown as ArtifactRecord;
}

function invalidMetadataLine(line: number, cause?: unknown): Error {
  return new Error(`Invalid artifact metadata line ${line}`, cause === undefined ? {} : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

async function assertArtifactDirectory(artifactRoot: string, directory: string): Promise<void> {
  const root = await ensureRealDirectory(artifactRoot);
  const resolvedDirectory = await realpath(directory);
  if (!isInsideOrSamePath(root, resolvedDirectory)) {
    throw new Error('Artifact target directory resolves outside the artifact root');
  }
}

async function ensureRealDirectory(path: string): Promise<string> {
  await access(path, fsConstants.R_OK);
  return realpath(path);
}

async function resolveArtifactRemovalEntry(
  artifactRoot: string,
  relativePath: string,
): Promise<string | undefined> {
  const target = join(artifactRoot, relativePath);
  try {
    const parent = await realpath(dirname(target));
    return join(parent, basename(target));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    rel !== '..' &&
    !rel.includes(`..${sep}`) &&
    !rel.startsWith(sep)
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function sniffAllowedBinaryMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiStartsWith(bytes, 'GIF87a') || asciiStartsWith(bytes, 'GIF89a')) return 'image/gif';
  if (
    asciiStartsWith(bytes, 'RIFF') &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (asciiStartsWith(bytes, '%PDF-')) return 'application/pdf';
  const leading = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, Math.min(bytes.length, 512)))
    .trimStart();
  if (/^<svg[\s>]/i.test(leading) || /^<\?xml[\s\S]*<svg[\s>]/i.test(leading))
    return 'image/svg+xml';
  return null;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function asciiStartsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.split('').every((char, index) => bytes[index] === char.charCodeAt(0));
}
