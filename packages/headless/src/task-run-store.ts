import { Buffer } from 'node:buffer';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionLogCursor } from '@maka/core/execution-evidence';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from '@maka/storage/root-authority';
import { chainWrite } from '@maka/storage/write-queue';
import { unlock, waitForLock } from 'fs-native-extensions';
import { publishFileExclusively } from './immutable-file.js';
import type { TaskEvent } from './task-contracts.js';
import { isTaskRunLocator, taskRunLocator } from './task-run-identity.js';
import { projectTaskRun, type TaskRunProjection } from './task-run-projection.js';

export interface TaskRunReader {
  listTaskRunIds(): Promise<string[]>;
  readEventRecords(taskRunId: string): Promise<TaskEventLedgerEntry[]>;
  readEvents(taskRunId: string): Promise<TaskEvent[]>;
  project(taskRunId: string): Promise<TaskRunProjection>;
}

export interface TaskRunWriter extends TaskRunReader {
  appendEvent(taskRunId: string, event: TaskEvent): Promise<void>;
}

export interface TaskEventLedgerEntry {
  event: TaskEvent;
  cursor: ExecutionLogCursor;
}

export function createInMemoryTaskRunStore(
  initialEvents: readonly TaskEvent[] = [],
): TaskRunWriter {
  return new InMemoryTaskRunStore(initialEvents);
}

export async function openHeadlessTaskRunReader(
  lease: StorageRootLease<'headless', 'read'>,
): Promise<TaskRunReader> {
  await assertStorageRootLease(lease, 'headless', 'read');
  const store = new FileTaskRunStore(lease.canonicalPath);
  return taskRunReaderFacade(store, (operation) =>
    runWithStorageRootLease(lease, 'headless', 'read', operation),
  );
}

export async function openHeadlessTaskRunWriter(
  lease: StorageRootLease<'headless', 'write'>,
): Promise<TaskRunWriter> {
  await assertStorageRootLease(lease, 'headless', 'write');
  const store = new FileTaskRunStore(lease.canonicalPath);
  return taskRunWriterFacade(store, (operation) =>
    runWithStorageRootLease(lease, 'headless', 'write', operation),
  );
}

type RunTaskRunOperation = <T>(operation: () => Promise<T>) => Promise<T>;

function taskRunReaderFacade(store: FileTaskRunStore, run: RunTaskRunOperation): TaskRunReader {
  return Object.freeze(taskRunReaderMethods(store, run));
}

function taskRunReaderMethods(store: FileTaskRunStore, run: RunTaskRunOperation): TaskRunReader {
  return {
    listTaskRunIds: () => run(() => store.listTaskRunIds()),
    readEventRecords: (taskRunId) => run(() => store.readEventRecords(taskRunId)),
    readEvents: (taskRunId) => run(() => store.readEvents(taskRunId)),
    project: (taskRunId) => run(() => store.project(taskRunId)),
  };
}

function taskRunWriterFacade(store: FileTaskRunStore, run: RunTaskRunOperation): TaskRunWriter {
  const writer: TaskRunWriter = {
    ...taskRunReaderMethods(store, run),
    appendEvent: (taskRunId, event) => run(() => store.appendEvent(taskRunId, event)),
  };
  return Object.freeze(writer);
}

class InMemoryTaskRunStore implements TaskRunWriter {
  private readonly events = new Map<string, TaskEvent[]>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(initialEvents: readonly TaskEvent[]) {
    for (const event of initialEvents) {
      const events = this.events.get(event.taskRunId) ?? [];
      events.push(event);
      this.events.set(event.taskRunId, events);
    }
  }

  async appendEvent(taskRunId: string, event: TaskEvent): Promise<void> {
    if (event.taskRunId !== taskRunId) {
      throw new Error(`taskRunId mismatch: append target ${taskRunId}, event ${event.taskRunId}`);
    }

    await chainWrite(this.queues, taskRunId, async () => {
      const events = this.events.get(taskRunId) ?? [];
      events.push(event);
      this.events.set(taskRunId, events);
    });
  }

  async listTaskRunIds(): Promise<string[]> {
    return [...this.events.keys()].sort();
  }

  async readEvents(taskRunId: string): Promise<TaskEvent[]> {
    return (await this.readEventRecords(taskRunId)).map((record) => record.event);
  }

  async readEventRecords(taskRunId: string): Promise<TaskEventLedgerEntry[]> {
    return (this.events.get(taskRunId) ?? []).map((event, sequence) => ({
      event,
      cursor: taskEventCursor(taskRunId, sequence, event.id),
    }));
  }

  async project(taskRunId: string): Promise<TaskRunProjection> {
    return projectTaskRun(await this.readEvents(taskRunId), taskRunId);
  }
}

class FileTaskRunStore implements TaskRunWriter {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly storageRoot: string) {}

  async appendEvent(taskRunId: string, event: TaskEvent): Promise<void> {
    if (event.taskRunId !== taskRunId) {
      throw new Error(`taskRunId mismatch: append target ${taskRunId}, event ${event.taskRunId}`);
    }

    const locator = taskRunLocator(taskRunId);
    await chainWrite(this.queues, locator, () =>
      this.appendTaskRunEvent(locator, taskRunId, event),
    );
  }

  async listTaskRunIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = (await readdir(this.taskRunDir())).filter((name) => name.endsWith('.jsonl')).sort();
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const identities: string[] = [];
    for (const entry of entries) {
      const locator = taskRunLocatorFromFilename(entry);
      const header = await readTaskRunLedgerHeader(join(this.taskRunDir(), entry));
      assertTaskRunLedgerIdentity(header, locator, entry);
      identities.push(header.taskRunId);
    }
    return identities.sort();
  }

  async readEvents(taskRunId: string): Promise<TaskEvent[]> {
    return (await this.readEventRecords(taskRunId)).map((record) => record.event);
  }

  async readEventRecords(taskRunId: string): Promise<TaskEventLedgerEntry[]> {
    const path = this.taskRunPath(taskRunId);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const lines = durableJsonlLines(content);
    const header = parseTaskRunLedgerHeader(lines.shift(), path);
    assertTaskRunLedgerIdentity(header, taskRunLocator(taskRunId), path);
    if (header.taskRunId !== taskRunId) {
      throw new Error(`TaskRun ledger identity does not match requested taskRunId ${taskRunId}`);
    }
    const records: TaskEventLedgerEntry[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      let event: TaskEvent;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          typeof (parsed as { taskRunId?: unknown }).taskRunId !== 'string'
        ) {
          throw new Error('record is not a TaskEvent');
        }
        event = parsed as TaskEvent;
      } catch (error) {
        event = {
          type: 'event_corrupt',
          id: `corrupt-${i + 1}`,
          taskRunId,
          ts: 0,
          raw: line,
          error: errorMessage(error),
        };
      }
      if (event.taskRunId !== taskRunId) {
        throw new Error(`TaskRun ledger ${path} contains event for ${String(event.taskRunId)}`);
      }
      records.push({
        event,
        cursor: taskEventCursor(taskRunId, records.length, event.id),
      });
    }
    return records;
  }

  async project(taskRunId: string): Promise<TaskRunProjection> {
    return projectTaskRun(await this.readEvents(taskRunId), taskRunId);
  }

  private taskRunDir(): string {
    return join(this.storageRoot, 'task-runs');
  }

  private taskRunPath(taskRunId: string): string {
    return join(this.taskRunDir(), `${taskRunLocator(taskRunId)}.jsonl`);
  }

  private async appendTaskRunEvent(
    locator: string,
    taskRunId: string,
    event: TaskEvent,
  ): Promise<void> {
    const eventLine = `${JSON.stringify(event)}\n`;
    await mkdir(this.taskRunDir(), { recursive: true });
    const path = join(this.taskRunDir(), `${locator}.jsonl`);
    await withTaskRunLedgerLock(`${path}.lock`, async () => {
      let header: TaskRunLedgerHeader;
      try {
        header = await readTaskRunLedgerHeader(path);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        const initialContent = `${JSON.stringify(taskRunLedgerHeader(taskRunId))}\n${eventLine}`;
        if (await publishFileExclusively(path, initialContent)) return;
        header = await readTaskRunLedgerHeader(path);
      }

      assertTaskRunLedgerIdentity(header, locator, path);
      if (header.taskRunId !== taskRunId) {
        throw new Error(`TaskRun identity collision between ${header.taskRunId} and ${taskRunId}`);
      }
      await truncatePartialTaskRunTail(path);
      await appendFile(path, eventLine, 'utf8');
    });
  }
}

const TASK_RUN_LEDGER_SCHEMA_VERSION = 1 as const;
const TASK_RUN_LEDGER_TYPE = 'task_run_ledger' as const;

interface TaskRunLedgerHeader {
  schemaVersion: typeof TASK_RUN_LEDGER_SCHEMA_VERSION;
  type: typeof TASK_RUN_LEDGER_TYPE;
  taskRunId: string;
}

function taskRunLocatorFromFilename(filename: string): string {
  const locator = filename.slice(0, -'.jsonl'.length);
  if (!isTaskRunLocator(locator)) {
    throw new Error(`Invalid TaskRun ledger filename ${filename}`);
  }
  return locator;
}

function taskRunLedgerHeader(taskRunId: string): TaskRunLedgerHeader {
  taskRunLocator(taskRunId);
  return {
    schemaVersion: TASK_RUN_LEDGER_SCHEMA_VERSION,
    type: TASK_RUN_LEDGER_TYPE,
    taskRunId,
  };
}

function parseTaskRunLedgerHeader(line: string | undefined, source: string): TaskRunLedgerHeader {
  if (!line) throw new Error(`TaskRun ledger ${source} has no durable header`);
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch (error) {
    throw new Error(`TaskRun ledger ${source} has an invalid header: ${errorMessage(error)}`);
  }
  if (
    typeof record !== 'object' ||
    record === null ||
    (record as { schemaVersion?: unknown }).schemaVersion !== TASK_RUN_LEDGER_SCHEMA_VERSION ||
    (record as { type?: unknown }).type !== TASK_RUN_LEDGER_TYPE ||
    typeof (record as { taskRunId?: unknown }).taskRunId !== 'string'
  ) {
    throw new Error(`TaskRun ledger ${source} has an invalid header`);
  }
  const header = record as TaskRunLedgerHeader;
  taskRunLocator(header.taskRunId);
  return header;
}

function assertTaskRunLedgerIdentity(
  header: TaskRunLedgerHeader,
  expectedLocator: string,
  source: string,
): void {
  if (taskRunLocator(header.taskRunId) !== expectedLocator) {
    throw new Error(`TaskRun ledger ${source} does not match its identity locator`);
  }
}

async function withTaskRunLedgerLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const handle = await open(lockPath, 'a+', 0o600);
  try {
    await assertStableLockArtifact(handle, lockPath);
    await handle.chmod(0o600);
    await waitForLock(handle.fd);
    try {
      await assertStableLockArtifact(handle, lockPath);
      return await operation();
    } finally {
      releaseLock(handle);
    }
  } finally {
    await handle.close();
  }
}

async function assertStableLockArtifact(handle: FileHandle, path: string): Promise<void> {
  const [handleStats, pathStats] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (
    !handleStats.isFile() ||
    !pathStats.isFile() ||
    handleStats.dev !== pathStats.dev ||
    handleStats.ino !== pathStats.ino
  ) {
    throw new Error(`TaskRun lock path is not one stable regular file: ${path}`);
  }
}

function releaseLock(handle: FileHandle): void {
  try {
    unlock(handle.fd);
  } catch {
    // Closing the file handle is the authoritative release path.
  }
}

async function readTaskRunLedgerHeader(path: string): Promise<TaskRunLedgerHeader> {
  return parseTaskRunLedgerHeader(await readFirstDurableLine(path), path);
}

async function truncatePartialTaskRunTail(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    const { size } = await handle.stat();
    let position = size;
    while (position > 0) {
      const length = Math.min(position, 4096);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const read = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
        if (read.bytesRead === 0) {
          throw new Error(`TaskRun ledger ${path} changed while repairing its tail`);
        }
        bytesRead += read.bytesRead;
      }
      const newline = buffer.lastIndexOf(0x0a);
      if (newline === -1) continue;
      const durableSize = position + newline + 1;
      if (durableSize < size) {
        await handle.truncate(durableSize);
        await handle.sync();
      }
      return;
    }
    throw new Error(`TaskRun ledger ${path} has no durable record`);
  } finally {
    await handle.close();
  }
}

async function readFirstDurableLine(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r');
  const chunks: Buffer[] = [];
  let position = 0;
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return undefined;
      const bytes = buffer.subarray(0, bytesRead);
      const newline = bytes.indexOf(0x0a);
      chunks.push(newline === -1 ? bytes : bytes.subarray(0, newline));
      if (newline !== -1) return Buffer.concat(chunks).toString('utf8');
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

function durableJsonlLines(content: string): string[] {
  return content.endsWith('\n') ? content.split('\n') : content.split('\n').slice(0, -1);
}

function taskEventCursor(taskRunId: string, sequence: number, eventId: string): ExecutionLogCursor {
  return { ledger: 'task_event', streamId: taskRunId, sequence, eventId };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
