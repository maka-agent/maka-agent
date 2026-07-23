import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeSessionHeader, isSafeSessionId } from './session-store.js';
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
}

/**
 * Import every legacy line-1 SessionHeader in one SQLite transaction.
 *
 * The scan and decode phase completes before the transaction begins, so a
 * malformed header cannot leave a partially imported session catalog.
 */
export async function importLegacySessionMetadataTree(input: {
  workspaceRoot: string;
  destination: SqliteSessionMetadataStore;
}): Promise<LegacySessionMetadataImportReport> {
  const sessionsRoot = join(input.workspaceRoot, 'sessions');
  const entries: SessionMetadataImportEntry[] = [];
  for (const directory of await sessionDirectoryNames(sessionsRoot)) {
    const sourcePath = join(sessionsRoot, directory, 'session.jsonl');
    let value: unknown;
    let headerLine: string;
    try {
      headerLine = await readFirstJsonlRecord(sourcePath);
      value = JSON.parse(headerLine) as unknown;
    } catch (error) {
      throw new Error(`Invalid legacy session header at ${sourcePath}`, { cause: error });
    }
    const fingerprint = createHash('sha256').update(headerLine).digest('hex');
    entries.push({
      header: decodeSessionHeader(value, directory),
      source: { path: sourcePath, fingerprint },
    });
  }
  const result = await input.destination.importEntries(entries);
  const headersImported = result.created.filter(Boolean).length;
  return {
    filesScanned: entries.length,
    headersRead: entries.length,
    headersImported,
    headersExisting: result.created.length - headersImported,
    sourcesAlreadyImported: result.sourcesAlreadyImported,
  };
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
