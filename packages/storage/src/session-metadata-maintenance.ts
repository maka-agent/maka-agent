import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { SessionHeader } from '@maka/core';
import { decodeSessionHeader, SQLITE_SESSION_METADATA_DATABASE_NAME } from './session-store.js';
import {
  createSqliteSessionMetadataStore,
  type SessionMetadataRecord,
} from './sqlite-session-metadata-store.js';
import { decodeSessionTranscriptMarker, isSessionTranscriptMarker } from './session-transcript.js';

export const SESSION_METADATA_EXPORT_FORMAT = 'maka-session-metadata-export';
export const SESSION_METADATA_EXPORT_SCHEMA_VERSION = 1;
export const SESSION_METADATA_EXPORT_MANIFEST_NAME = 'session-metadata.json';

export interface SessionMetadataExportManifest {
  format: typeof SESSION_METADATA_EXPORT_FORMAT;
  schemaVersion: typeof SESSION_METADATA_EXPORT_SCHEMA_VERSION;
  exportedAt: number;
  sessions: SessionMetadataRecord[];
}

export interface LegacySessionTreeExportReport {
  destinationRoot: string;
  sessionsExported: number;
  manifestPath: string;
}

/**
 * Export a self-contained legacy-compatible session tree without changing the
 * canonical SQLite database or the live transcript files.
 */
export async function exportLegacySessionTree(input: {
  workspaceRoot: string;
  destinationRoot: string;
  now?: () => number;
}): Promise<LegacySessionTreeExportReport> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const destinationRoot = resolve(input.destinationRoot);
  const sourceSessionsRoot = join(workspaceRoot, 'sessions');
  const destinationSessionsRoot = join(destinationRoot, 'sessions');
  if (
    destinationRoot === workspaceRoot ||
    isInsideOrSamePath(sourceSessionsRoot, destinationRoot) ||
    destinationSessionsRoot === sourceSessionsRoot
  ) {
    throw new Error('Session metadata export destination overlaps the live session tree');
  }
  await assertPathMissing(destinationRoot, 'Session metadata export destination');

  const databasePath = join(workspaceRoot, SQLITE_SESSION_METADATA_DATABASE_NAME);
  await assertFileExists(databasePath, 'SQLite session metadata database');
  const metadata = createSqliteSessionMetadataStore(databasePath);
  const stagingRoot = `${destinationRoot}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const records = (await metadata.list()).sort((a, b) => a.header.id.localeCompare(b.header.id));
    await mkdir(join(stagingRoot, 'sessions'), { recursive: true });
    for (const record of records) {
      const sourcePath = join(sourceSessionsRoot, record.header.id, 'session.jsonl');
      const transcript = await readFile(sourcePath, 'utf8');
      const body = legacyCompatibleTranscriptBody(transcript, record.header.id, record.header);
      const destinationPath = join(stagingRoot, 'sessions', record.header.id, 'session.jsonl');
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, body, 'utf8');
    }
    const manifest: SessionMetadataExportManifest = {
      format: SESSION_METADATA_EXPORT_FORMAT,
      schemaVersion: SESSION_METADATA_EXPORT_SCHEMA_VERSION,
      exportedAt: (input.now ?? Date.now)(),
      sessions: records,
    };
    await writeFile(
      join(stagingRoot, SESSION_METADATA_EXPORT_MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    await mkdir(dirname(destinationRoot), { recursive: true });
    await rename(stagingRoot, destinationRoot);
    return {
      destinationRoot,
      sessionsExported: records.length,
      manifestPath: join(destinationRoot, SESSION_METADATA_EXPORT_MANIFEST_NAME),
    };
  } finally {
    metadata.close();
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function backupSessionMetadataDatabase(input: {
  workspaceRoot: string;
  destinationPath: string;
}): Promise<{ destinationPath: string; pagesCopied: number }> {
  const databasePath = join(resolve(input.workspaceRoot), SQLITE_SESSION_METADATA_DATABASE_NAME);
  const destinationPath = resolve(input.destinationPath);
  await assertFileExists(databasePath, 'SQLite session metadata database');
  const metadata = createSqliteSessionMetadataStore(databasePath);
  try {
    return {
      destinationPath,
      pagesCopied: await metadata.backup(destinationPath),
    };
  } finally {
    metadata.close();
  }
}

function legacyCompatibleTranscriptBody(
  transcript: string,
  sessionId: string,
  header: SessionHeader,
): string {
  const firstNewline = transcript.indexOf('\n');
  if (firstNewline < 0) {
    throw new Error(`Session ${sessionId}: cannot find first JSONL record`);
  }
  const firstLine = transcript.slice(0, firstNewline);
  let firstRecord: unknown;
  try {
    firstRecord = JSON.parse(firstLine) as unknown;
    if (isSessionTranscriptMarker(firstRecord)) {
      decodeSessionTranscriptMarker(firstRecord, sessionId);
    } else {
      decodeSessionHeader(firstRecord, sessionId);
    }
  } catch (error) {
    throw new Error(`Session ${sessionId}: invalid first JSONL record`, { cause: error });
  }
  return `${JSON.stringify(header)}\n${transcript.slice(firstNewline + 1)}`;
}

async function assertPathMissing(path: string, label: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

async function assertFileExists(path: string, label: string): Promise<void> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${path}`);
    throw error;
  });
  if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
}

function isInsideOrSamePath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !path.includes(':'));
}
