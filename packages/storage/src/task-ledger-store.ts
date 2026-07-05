import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TASK_LEDGER_MAX_TASKS,
  isTaskStatus,
  normalizeCreateTaskInput,
  normalizeUpdateTaskInput,
  type Task,
  type TaskLedgerStore,
} from '@maka/core/task-ledger';
import { chainWrite } from './write-queue.js';
import { assertSafeSessionId } from './session-store.js';

export type { TaskLedgerStore } from '@maka/core/task-ledger';

export function createTaskLedgerStore(workspaceRoot: string): TaskLedgerStore {
  return new FileTaskLedgerStore(workspaceRoot);
}

class FileTaskLedgerStore implements TaskLedgerStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
  }

  async list(sessionId: string): Promise<Task[]> {
    assertSafeSessionId(sessionId);
    return this.readForRender(sessionId);
  }

  async create(sessionId: string, drafts: unknown): Promise<{ created: Task[]; all: Task[] }> {
    assertSafeSessionId(sessionId);
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new Error('TaskCreate requires at least one task draft');
    }
    const now = Date.now();
    const created: Task[] = drafts.map((draft) => {
      const normalized = normalizeCreateTaskInput(draft);
      if (!normalized.ok) throw new Error(normalized.message);
      return {
        id: randomUUID(),
        subject: normalized.value.subject,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
    });
    // Cap check runs inside the serialized mutate callback (after reading the
    // current ledger) so concurrent creates cannot race past the limit, and a
    // rejected create never touches the file.
    const all = await this.mutate(sessionId, (tasks) => {
      if (tasks.length + created.length > TASK_LEDGER_MAX_TASKS) {
        throw new Error(
          `Task ledger is limited to ${TASK_LEDGER_MAX_TASKS} tasks total per session `
          + `(currently ${tasks.length}, adding ${created.length}). This is a hard runaway guard on the `
          + 'total count — completed or cancelled tasks still count, so batch related work into fewer, '
          + 'coarser tasks instead.',
        );
      }
      return [...tasks, ...created];
    });
    return { created, all };
  }

  async update(sessionId: string, id: string, patch: unknown): Promise<{ updated: Task; all: Task[] }> {
    assertSafeSessionId(sessionId);
    const normalized = normalizeUpdateTaskInput(patch);
    if (!normalized.ok) throw new Error(normalized.message);
    const now = Date.now();
    let updated: Task | undefined;
    const all = await this.mutate(sessionId, (tasks) => {
      // Locate the target before producing a new list: an unknown id must
      // fail inside the callback without rewriting an identical file.
      const index = tasks.findIndex((task) => task.id === id);
      const current = index === -1 ? undefined : tasks[index];
      if (!current) throw new Error(`No such task: ${id}`);
      updated = {
        ...current,
        ...(normalized.value.subject !== undefined ? { subject: normalized.value.subject } : {}),
        ...(normalized.value.status !== undefined ? { status: normalized.value.status } : {}),
        updatedAt: now,
      };
      const next = [...tasks];
      next[index] = updated;
      return next;
    });
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, all };
  }

  private filePath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'tasks.json');
  }

  /**
   * Render-path read: any failure degrades to an empty list so a damaged
   * ledger never wedges a turn. Never used as the base of a write.
   */
  private async readForRender(sessionId: string): Promise<Task[]> {
    try {
      return decodeTasks(await readFile(this.filePath(sessionId), 'utf8'));
    } catch {
      return [];
    }
  }

  /**
   * Mutate-path read: only ENOENT means a legitimately fresh ledger. Any
   * other read error, undecodable JSON, or a non-array payload throws so the
   * mutation fails closed instead of rebuilding the ledger from [] and
   * silently overwriting whatever is on disk.
   */
  private async readForMutate(sessionId: string): Promise<Task[]> {
    let text: string;
    try {
      text = await readFile(this.filePath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      return decodeTasks(text);
    } catch (error) {
      throw new Error(
        `Task ledger file for session ${sessionId} is corrupt; refusing to overwrite it: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async mutate(sessionId: string, fn: (tasks: Task[]) => Task[]): Promise<Task[]> {
    let next: Task[] = [];
    await chainWrite(this.writeQueues, sessionId, async () => {
      const current = await this.readForMutate(sessionId);
      next = fn(current);
      await this.write(sessionId, next);
    });
    return next;
  }

  private async write(sessionId: string, tasks: Task[]): Promise<void> {
    const filePath = this.filePath(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(tasks, null, 2) + '\n', 'utf8');
    await rename(tempPath, filePath);
  }
}

function decodeTasks(text: string): Task[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('expected a JSON array of tasks');
  }
  const tasks: Task[] = [];
  for (const value of parsed) {
    const task = normalizePersistedTask(value);
    if (task) tasks.push(task);
  }
  return tasks;
}

function normalizePersistedTask(value: unknown): Task | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<Task>;
  if (
    typeof record.id !== 'string' ||
    typeof record.subject !== 'string' ||
    !isTaskStatus(record.status) ||
    typeof record.createdAt !== 'number' ||
    typeof record.updatedAt !== 'number'
  ) {
    return undefined;
  }
  return {
    id: record.id,
    subject: record.subject,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
