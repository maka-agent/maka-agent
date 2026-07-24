import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeSessionHeader, isSafeSessionId } from './session-store.js';
import { decodeSessionTranscriptMarker, isSessionTranscriptMarker } from './session-transcript.js';
import type {
  SessionMetadataImportEntry,
  SqliteSessionMetadataStore,
} from './sqlite-session-metadata-store.js';

const LEGACY_SESSION_HEADER_MAX_BYTES = 1024 * 1024;
const LEGACY_SESSION_HEADER_READ_BYTES = 8192;

class MalformedLegacySessionHeaderError extends Error {
  constructor(sourcePath: string, cause?: unknown) {
    super(`Invalid legacy session header at ${sourcePath}`, { cause });
    this.name = 'MalformedLegacySessionHeaderError';
  }
}

export interface LegacySessionMetadataImportReport {
  filesScanned: number;
  headersRead: number;
  headersImported: number;
  headersExisting: number;
  sourcesAlreadyImported: number;
  sourcesTombstoned: number;
}

/**
 * Import every legacy line-1 SessionHeader in one SQLite transaction.
 *
 * The scan and decode phase completes before the transaction begins.
 * Malformed headers are skipped (not tombstoned) so one corrupt session
 * cannot block the rest of the catalog.  Skipping without tombstoning means
 * a repaired header will be picked up on the next launch.
 */
export async function importLegacySessionMetadataTree(input: {
  workspaceRoot: string;
  destination: SqliteSessionMetadataStore;
}): Promise<LegacySessionMetadataImportReport> {
  const sessionsRoot = join(input.workspaceRoot, 'sessions');
  const entries: SessionMetadataImportEntry[] = [];
  const transcriptMarkerSessionIds: string[] = [];
  const directories = await sessionDirectoryNames(sessionsRoot);
  for (const directory of directories) {
    const sourcePath = join(sessionsRoot, directory, 'session.jsonl');
    try {
      const entry = await readLegacySessionMetadataEntry(sourcePath, directory);
      if (entry) {
        entries.push(entry);
      } else {
        transcriptMarkerSessionIds.push(directory);
      }
    } catch (error) {
      if (isNotFound(error)) {
        const canonicalStateExists =
          (await input.destination.has(directory)) ||
          (await input.destination.isTombstoned(directory));
        if (canonicalStateExists) continue;
        throw error;
      }
      // Corrupt or malformed legacy session headers should not crash the
      // entire import. Skip the session without tombstoning it — the
      // deletion tombstone is permanent and would suppress a repaired
      // header on subsequent launches. Skipping means the malformed
      // session is retried next launch, which is harmless (it will be
      // skipped again until repaired).
      if (error instanceof MalformedLegacySessionHeaderError) {
        continue;
      }
      throw error;
    }
  }
  for (const sessionId of transcriptMarkerSessionIds) {
    if (
      !(await input.destination.has(sessionId)) &&
      !(await input.destination.isTombstoned(sessionId))
    ) {
      throw new Error(`Session transcript marker has no SQLite metadata: ${sessionId}`);
    }
  }
  const result = await input.destination.importEntries(entries);
  const headersImported = result.created.filter(Boolean).length;
  return {
    filesScanned: directories.length,
    headersRead: entries.length,
    headersImported,
    headersExisting: result.created.length - headersImported,
    sourcesAlreadyImported: result.sourcesAlreadyImported,
    sourcesTombstoned: result.sourcesTombstoned,
  };
}

export async function readLegacySessionMetadataEntry(
  sourcePath: string,
  sessionId: string,
): Promise<SessionMetadataImportEntry | null> {
  const headerLine = await readFirstJsonlRecord(sourcePath);
  let value: unknown;
  try {
    value = JSON.parse(headerLine) as unknown;
  } catch (error) {
    throw new MalformedLegacySessionHeaderError(sourcePath, error);
  }
  if (isSessionTranscriptMarker(value)) {
    decodeSessionTranscriptMarker(value, sessionId);
    return null;
  }
  let header;
  try {
    header = decodeSessionHeader(value, sessionId);
  } catch (error) {
    throw new MalformedLegacySessionHeaderError(sourcePath, error);
  }
  return {
    header,
    source: {
      path: sourcePath,
      fingerprint: createHash('sha256').update(headerLine).digest('hex'),
    },
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function sessionDirectoryNames(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeSessionId(entry.name)) {
      throw new Error(`Invalid Session entry: ${entry.name}`);
    }
    names.push(entry.name);
  }
  return names.sort();
}

async function readFirstJsonlRecord(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < LEGACY_SESSION_HEADER_MAX_BYTES) {
      const buffer = Buffer.alloc(
        Math.min(LEGACY_SESSION_HEADER_READ_BYTES, LEGACY_SESSION_HEADER_MAX_BYTES - offset),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      const text = Buffer.concat(chunks).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline >= 0) return text.slice(0, newline);
      offset += bytesRead;
    }
    throw new MalformedLegacySessionHeaderError(
      path,
      new Error(`Cannot read legacy session header from ${path}`),
    );
  } finally {
    await handle.close();
  }
}
