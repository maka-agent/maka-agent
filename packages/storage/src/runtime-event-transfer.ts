import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeEvent, RuntimeEventStore } from '@maka/core';
import { createRuntimeEventStore } from './agent-run-store.js';
import type { SqliteRuntimeStore } from './sqlite-runtime-store.js';
import { createSqliteRuntimeStore } from './sqlite-runtime-store.js';

export const SQLITE_RUNTIME_DATABASE_NAME = 'runtime.sqlite';
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type RuntimeEventPersistence = {
  kind: 'jsonl' | 'sqlite';
  runtimeEventStore: RuntimeEventStore;
  runtimeCommitStore?: SqliteRuntimeStore;
  importReport?: LegacyRuntimeEventImportReport;
  close(): void;
};

export interface RuntimeEventImportReport {
  eventsRead: number;
  eventsImported: number;
  eventsExisting: number;
}

export interface LegacyRuntimeEventImportReport extends RuntimeEventImportReport {
  filesScanned: number;
}

export async function openRuntimeEventPersistence(input: {
  workspaceRoot: string;
  sqliteCanonical: boolean;
}): Promise<RuntimeEventPersistence> {
  if (!input.sqliteCanonical) {
    return {
      kind: 'jsonl',
      runtimeEventStore: createRuntimeEventStore(input.workspaceRoot),
      close: () => {},
    };
  }
  const store = createSqliteRuntimeStore(join(input.workspaceRoot, SQLITE_RUNTIME_DATABASE_NAME));
  try {
    const importReport = await importLegacyRuntimeEventJsonlTree({
      workspaceRoot: input.workspaceRoot,
      destination: store,
    });
    return {
      kind: 'sqlite',
      runtimeEventStore: store,
      runtimeCommitStore: store,
      importReport,
      close: () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

export async function exportRuntimeEventsToJsonl(
  source: RuntimeEventStore,
  sessionId: string,
  runId: string,
): Promise<string> {
  const events = source.readImmutableRuntimeEvents
    ? await source.readImmutableRuntimeEvents(sessionId, runId)
    : await source.readRuntimeEvents(sessionId, runId);
  return events.length === 0
    ? ''
    : `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

export async function importRuntimeEventsFromJsonl(input: {
  jsonl: string;
  sessionId: string;
  runId: string;
  destination: SqliteRuntimeStore;
}): Promise<RuntimeEventImportReport> {
  const events = parseRuntimeEventJsonl(input.jsonl, input.sessionId, input.runId);
  return importRuntimeEvents(events, input.sessionId, input.runId, input.destination);
}

export async function importLegacyRuntimeEventJsonlTree(input: {
  workspaceRoot: string;
  destination: SqliteRuntimeStore;
}): Promise<LegacyRuntimeEventImportReport> {
  const source = createRuntimeEventStore(input.workspaceRoot);
  const sessionsRoot = join(input.workspaceRoot, 'sessions');
  const report: LegacyRuntimeEventImportReport = {
    filesScanned: 0,
    eventsRead: 0,
    eventsImported: 0,
    eventsExisting: 0,
  };
  for (const session of await directoryNames(sessionsRoot)) {
    const runsRoot = join(sessionsRoot, session, 'runs');
    for (const run of await directoryNames(runsRoot)) {
      const events = source.readImmutableRuntimeEvents
        ? await source.readImmutableRuntimeEvents(session, run)
        : await source.readRuntimeEvents(session, run);
      if (events.length === 0) continue;
      report.filesScanned += 1;
      const imported = await importRuntimeEvents(events, session, run, input.destination);
      report.eventsRead += imported.eventsRead;
      report.eventsImported += imported.eventsImported;
      report.eventsExisting += imported.eventsExisting;
    }
  }
  return report;
}

async function importRuntimeEvents(
  events: readonly RuntimeEvent[],
  sessionId: string,
  runId: string,
  destination: SqliteRuntimeStore,
): Promise<RuntimeEventImportReport> {
  const report: RuntimeEventImportReport = {
    eventsRead: events.length,
    eventsImported: 0,
    eventsExisting: 0,
  };
  for (const event of events) {
    assertRuntimeEventImportIdentity(event, sessionId, runId);
    const created = await destination.importRuntimeEvent(sessionId, runId, event);
    if (created) report.eventsImported += 1;
    else report.eventsExisting += 1;
  }
  return report;
}

function parseRuntimeEventJsonl(
  jsonl: string,
  sessionId: string,
  runId: string,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const lines = jsonl.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let event: RuntimeEvent;
    try {
      event = JSON.parse(line) as RuntimeEvent;
    } catch (error) {
      throw new Error(`Invalid RuntimeEvent JSONL line ${index + 1} for run ${runId}`, { cause: error });
    }
    assertRuntimeEventImportIdentity(event, sessionId, runId);
    events.push(event);
  }
  return events;
}

function assertRuntimeEventImportIdentity(
  event: RuntimeEvent,
  sessionId: string,
  runId: string,
): void {
  if (!event || typeof event !== 'object' || event.sessionId !== sessionId || event.runId !== runId) {
    throw new Error(`RuntimeEvent import identity mismatch for session ${sessionId}, run ${runId}`);
  }
}

async function directoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
