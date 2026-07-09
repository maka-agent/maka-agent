import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isShellRunStatus,
  type ShellRunRecord,
  type ShellRunStore,
} from '@maka/core';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function createShellRunStore(workspaceRoot: string): ShellRunStore {
  return new FileShellRunStore(workspaceRoot);
}

class FileShellRunStore implements ShellRunStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
  }

  async createShellRun(record: ShellRunRecord): Promise<ShellRunRecord> {
    assertSafeId(record.sessionId, 'Invalid session id');
    assertSafeId(record.shellRunId, 'Invalid shell run id');
    const normalized = normalizeShellRunRecord(record, record.sessionId, record.shellRunId);
    await this.withQueue(record.sessionId, record.shellRunId, async () => {
      if (await pathExists(this.shellRunPath(record.sessionId, record.shellRunId))) {
        throw new Error(`ShellRun already exists: ${record.shellRunId}`);
      }
      await mkdir(this.shellRunDir(record.sessionId, record.shellRunId), { recursive: true });
      await writeAtomic(this.shellRunPath(record.sessionId, record.shellRunId), JSON.stringify(normalized, sanitizeJson) + '\n');
    });
    return normalized;
  }

  async updateShellRun(
    sessionId: string,
    shellRunId: string,
    patch: Partial<ShellRunRecord>,
  ): Promise<ShellRunRecord> {
    let next: ShellRunRecord | undefined;
    await this.withQueue(sessionId, shellRunId, async () => {
      const current = await this.readShellRunUnlocked(sessionId, shellRunId);
      next = normalizeShellRunRecord({ ...current, ...patch, sessionId, shellRunId }, sessionId, shellRunId);
      await writeAtomic(this.shellRunPath(sessionId, shellRunId), JSON.stringify(next, sanitizeJson) + '\n');
    });
    if (!next) throw new Error(`Failed to update shell run ${shellRunId}`);
    return next;
  }

  async readShellRun(sessionId: string, shellRunId: string): Promise<ShellRunRecord> {
    return this.readShellRunUnlocked(sessionId, shellRunId);
  }

  async listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]> {
    assertSafeId(sessionId, 'Invalid session id');
    let entries;
    try {
      entries = await readdir(this.shellRunsRoot(sessionId), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: ShellRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      try {
        records.push(await this.readShellRunUnlocked(sessionId, entry.name));
      } catch {
        // Malformed shell run folders should not hide healthy runs.
      }
    }
    return records.sort((a, b) => a.startedAt - b.startedAt || a.shellRunId.localeCompare(b.shellRunId));
  }

  private async readShellRunUnlocked(sessionId: string, shellRunId: string): Promise<ShellRunRecord> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(shellRunId, 'Invalid shell run id');
    return normalizeShellRunRecord(
      JSON.parse(await readFile(this.shellRunPath(sessionId, shellRunId), 'utf8')),
      sessionId,
      shellRunId,
    );
  }

  private shellRunsRoot(sessionId: string): string {
    assertSafeId(sessionId, 'Invalid session id');
    return join(this.sessionsRoot, sessionId, 'shell-runs');
  }

  private shellRunDir(sessionId: string, shellRunId: string): string {
    assertSafeId(shellRunId, 'Invalid shell run id');
    return join(this.shellRunsRoot(sessionId), shellRunId);
  }

  private shellRunPath(sessionId: string, shellRunId: string): string {
    return join(this.shellRunDir(sessionId, shellRunId), 'shell-run.json');
  }

  private withQueue(sessionId: string, shellRunId: string, operation: () => Promise<void>): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(shellRunId, 'Invalid shell run id');
    const key = `${sessionId}:${shellRunId}`;
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.writeQueues.set(
      key,
      next.catch(() => {
        // Keep the chain alive after failures.
      }),
    );
    return next;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function normalizeShellRunRecord(value: unknown, sessionId: string, shellRunId: string): ShellRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: expected an object`);
  }
  const record = value as Partial<ShellRunRecord>;
  const requiredStrings = [
    record.shellRunId,
    record.sessionId,
    record.sourceTurnId,
    record.sourceToolCallId,
    record.cwd,
    record.command,
    record.stdoutTail,
    record.stderrTail,
  ];
  const optionalStrings = [
    record.sourceRunId,
    record.failureMessage,
    record.orphanedReason,
  ];
  const valid = requiredStrings.every((item) => typeof item === 'string') &&
    record.sessionId === sessionId &&
    record.shellRunId === shellRunId &&
    isShellRunStatus(record.status) &&
    isFiniteNumber(record.startedAt) &&
    isFiniteNumber(record.updatedAt) &&
    (record.completedAt === undefined || isFiniteNumber(record.completedAt)) &&
    (record.timeoutMs === undefined || isFiniteNumber(record.timeoutMs)) &&
    (record.exitCode === undefined || isFiniteNumber(record.exitCode)) &&
    (record.observedAt === undefined || isFiniteNumber(record.observedAt)) &&
    (record.pid === undefined || isFiniteNumber(record.pid)) &&
    typeof record.stdoutTruncated === 'boolean' &&
    typeof record.stderrTruncated === 'boolean' &&
    optionalStrings.every((item) => item === undefined || typeof item === 'string');
  if (!valid) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: malformed fields`);
  }
  if (!hasValidStateFields(record)) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: inconsistent state fields`);
  }
  return record as ShellRunRecord;
}

function hasValidStateFields(record: Partial<ShellRunRecord>): boolean {
  switch (record.status) {
    case 'running':
      return record.completedAt === undefined &&
        record.exitCode === undefined &&
        record.failureMessage === undefined &&
        record.observedAt === undefined &&
        record.orphanedReason === undefined;
    case 'completed':
      return record.completedAt !== undefined &&
        record.exitCode === 0 &&
        record.failureMessage === undefined &&
        record.orphanedReason === undefined;
    case 'failed':
      return record.completedAt !== undefined &&
        typeof record.exitCode === 'number' &&
        record.exitCode !== 0 &&
        record.orphanedReason === undefined;
    case 'timed_out':
      return record.completedAt !== undefined &&
        record.exitCode === 124 &&
        record.orphanedReason === undefined;
    case 'cancelled':
      return record.completedAt !== undefined &&
        record.exitCode === 130 &&
        record.orphanedReason === undefined;
    case 'orphaned':
      return record.completedAt !== undefined &&
        record.exitCode === undefined &&
        record.failureMessage === undefined &&
        typeof record.orphanedReason === 'string' &&
        record.orphanedReason.length > 0;
    default:
      return false;
  }
}

function assertSafeId(value: string, message: string): void {
  if (!isSafeId(value)) throw new Error(message);
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
