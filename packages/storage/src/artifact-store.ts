import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  ArtifactBinaryReadResult,
  ArtifactKind,
  ArtifactRecord,
  ArtifactSource,
  ArtifactTextReadResult,
} from '@maka/core';

export const ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES = 50 * 1024 * 1024;

export interface CreateArtifactInput {
  sessionId: string;
  turnId: string;
  name: string;
  kind: ArtifactKind;
  content: string | Uint8Array;
  mimeType?: string;
  source?: ArtifactSource;
  summary?: string;
  now?: number;
  id?: string;
}

export interface ArtifactStore {
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  append(record: ArtifactRecord): Promise<ArtifactRecord>;
  list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
  get(artifactId: string): Promise<ArtifactRecord | null>;
  readText(
    artifactId: string,
    opts?: { maxBytes?: number; includeDeleted?: boolean },
  ): Promise<ArtifactTextReadResult>;
  readBinary(artifactId: string, opts?: { maxBytes?: number }): Promise<ArtifactBinaryReadResult>;
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
  private loadPromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {
    this.artifactRoot = join(workspaceRoot, 'artifacts');
    this.metadataPath = join(this.artifactRoot, 'metadata.jsonl');
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const id = input.id ?? randomUUID();
    const name = sanitizeArtifactName(input.name);
    const relativePath = `${input.sessionId}/${id}-${name}`;
    validateRelativeArtifactPath(relativePath);
    const target = join(this.artifactRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content);
    const size = await stat(target);
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
      status: 'live',
    };
    return this.append(record);
  }

  async append(record: ArtifactRecord): Promise<ArtifactRecord> {
    validateRelativeArtifactPath(record.relativePath);
    await this.load();
    await this.enqueue(async () => {
      this.records = upsertById(this.records, normalizeRecord(record));
      await this.writeMetadataUnlocked();
    });
    return record;
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
        // a frozen createdAt (PR108k-yj visual-smoke determinism).
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
    );
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
    await this.load();
    await this.enqueue(async () => {
      this.records = this.records.map((record) =>
        record.id === artifactId ? { ...record, status: 'deleted' } : record,
      );
      await this.writeMetadataUnlocked();
    });
  }

  async purge(artifactIds: readonly string[]): Promise<void> {
    await this.load();
    await this.enqueue(async () => {
      const ids = new Set(artifactIds);
      const records = this.records.filter((record) => ids.has(record.id));
      if (records.length === 0) return;
      const root = await ensureRealDirectory(this.artifactRoot);
      const paths = new Map<string, ArtifactRecord>();
      const relativePaths = new Map(
        records.map((record) => [record.relativePath, record] as const),
      );
      for (const record of records) {
        validateRelativeArtifactPath(record.relativePath);
        const path = await resolveArtifactRemovalEntry(this.artifactRoot, record.relativePath);
        if (!path) continue;
        if (!isInsideOrSamePath(root, dirname(path))) {
          throw new Error(`Artifact ${record.id} resolves outside the artifact root`);
        }
        paths.set(path, record);
      }
      for (const record of this.records) {
        if (ids.has(record.id)) continue;
        const exactTarget = relativePaths.get(record.relativePath);
        if (exactTarget) {
          throw new Error(
            `Artifact ${exactTarget.id} path is still referenced by artifact ${record.id}`,
          );
        }
        const path = await resolveArtifactRemovalEntry(this.artifactRoot, record.relativePath);
        const target = path ? paths.get(path) : undefined;
        if (target) {
          throw new Error(
            `Artifact ${target.id} path is still referenced by artifact ${record.id}`,
          );
        }
      }
      for (const path of paths.keys()) await rm(path, { force: true });
      const previous = this.records;
      this.records = this.records.filter((record) => !ids.has(record.id));
      try {
        await this.writeMetadataUnlocked();
      } catch (error) {
        this.records = previous;
        throw error;
      }
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
        await this.writeMetadataUnlocked();
      }
      this.loaded = true;
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async writeMetadataUnlocked(): Promise<void> {
    await mkdir(dirname(this.metadataPath), { recursive: true });
    const tempPath = `${this.metadataPath}.${process.pid}.${Date.now()}.tmp`;
    const payload = this.records.map((record) => JSON.stringify(record)).join('\n');
    await writeFile(tempPath, payload ? `${payload}\n` : '', 'utf8');
    await rename(tempPath, this.metadataPath);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
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

function normalizeRecord(record: ArtifactRecord): ArtifactRecord {
  validateRelativeArtifactPath(record.relativePath);
  return {
    ...record,
    status: record.status === 'deleted' ? 'deleted' : 'live',
  };
}

function parseArtifactMetadata(text: string): ArtifactRecord[] {
  const records: ArtifactRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      records.push(normalizeRecord(JSON.parse(line) as ArtifactRecord));
    } catch {
      // Keep the rest of the JSONL index readable if one metadata row is
      // truncated or from a newer schema. A later write compacts valid rows.
    }
  }
  return records;
}

async function ensureRealDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
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

function upsertById<T extends { id: string }>(rows: T[], row: T): T[] {
  return [...rows.filter((current) => current.id !== row.id), row];
}
