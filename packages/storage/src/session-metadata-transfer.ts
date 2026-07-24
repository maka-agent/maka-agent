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
      if (isMalformedLegacySessionHeader(error)) {
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
  try {
    // readFirstJsonlRecord may throw:
    //  - Filesystem I/O errors (EACCES, EIO, EISDIR, etc.) which carry a
    //    `.code` property and must propagate without wrapping.
    //  - Content/framing errors (empty file, no newline, oversized header)
    //    which are plain Error instances without `.code` and should be
    //    treated as malformed legacy content.
    const headerLine = await readFirstJsonlRecord(sourcePath);
    const value = JSON.parse(headerLine) as unknown;
    if (isSessionTranscriptMarker(value)) {
      decodeSessionTranscriptMarker(value, sessionId);
      return null;
    }
    return {
      header: decodeSessionHeader(value, sessionId),
      source: {
        path: sourcePath,
        fingerprint: createHash('sha256').update(headerLine).digest('hex'),
      },
    };
  } catch (error) {
    // Filesystem I/O errors propagate without wrapping so they are not
    // mistaken for corrupt data by isMalformedLegacySessionHeader().
    if (isFilesystemError(error)) throw error;
    throw new Error(`Invalid legacy session header at ${sourcePath}`, { cause: error });
  }
}

function isNotFound(error: unknown): boolean {
  let current = error;
  while (current && typeof current === 'object') {
    if ('code' in current && current.code === 'ENOENT') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Returns `true` for Node.js filesystem errors that carry a `.code`
 * property (e.g. `EACCES`, `EIO`, `EISDIR`, `EMFILE`).  These are
 * transient or environmental failures, not corrupt session content.
 */
function isFilesystemError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^E[A-Z]/.test(code);
}

/**
 * Detects errors caused by a corrupt or malformed legacy session header.
 *
 * `readLegacySessionMetadataEntry` wraps only parse/decode/framing
 * failures (JSON.parse, decodeSessionHeader, decodeSessionTranscriptMarker,
 * empty/truncated/oversized files) as `"Invalid legacy session header at
 * <path>"` with the original error as `cause`.  Filesystem I/O errors
 * (EACCES, EIO, etc.) propagate without wrapping and are NOT matched
 * here, so transient failures are not treated as corrupt data.
 */
function isMalformedLegacySessionHeader(error: unknown): boolean {
  let current = error;
  while (current && typeof current === 'object') {
    if (current instanceof Error) {
      const msg = current.message;
      if (msg.startsWith('Invalid legacy session header at ')) return true;
      if (msg.startsWith('Invalid session header for session ')) return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
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
    throw new Error(`Cannot read legacy session header from ${path}`);
  } finally {
    await handle.close();
  }
}
