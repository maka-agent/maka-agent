import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TASK_LEDGER_MAX_TASKS,
  isSafeTaskId,
  isTaskStatus,
  isTaskLedgerEvent,
  normalizeUpdateTaskInput,
  normalizeCreateTaskInput,
  normalizeResumeTrust,
  normalizeTaskEvidenceText,
  normalizeTaskSubject,
  projectTaskLedgerEvents,
  taskLedgerEventTypeForCreate,
  taskLedgerEventTypeForUpdate,
  validateTaskUpdate,
  classifyTaskResumeTrust,
  type Task,
  type TaskLedgerEvent,
  type TaskLedgerListOptions,
  type TaskLedgerMutationContext,
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

  async list(sessionId: string, options: TaskLedgerListOptions = {}): Promise<Task[]> {
    assertSafeSessionId(sessionId);
    return this.applyListOptions(await this.readForRender(sessionId), options);
  }

  async get(sessionId: string, id: string, options: TaskLedgerListOptions = {}): Promise<Task | undefined> {
    assertSafeSessionId(sessionId);
    if (!isSafeTaskId(id)) throw new Error('Task id must be a stable token (alphanumeric plus . _ : -, max 64 chars)');
    const tasks = await this.list(sessionId, options);
    return tasks.find((task) => task.id === id);
  }

  async create(
    sessionId: string,
    drafts: unknown,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ created: Task[]; total: number }> {
    assertSafeSessionId(sessionId);
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new Error('TaskCreate requires at least one task draft');
    }
    // Front-door the per-batch cap before generating ids or normalizing drafts:
    // a single call can never add more than the absolute ledger cap, and rejecting
    // here avoids generating N uuids for a batch the write-queue total check
    // would refuse anyway. The total (existing + new) cap is still enforced
    // inside the serialized mutate callback below.
    if (drafts.length > TASK_LEDGER_MAX_TASKS) {
      throw new Error(
        `TaskCreate batch of ${drafts.length} tasks exceeds the ${TASK_LEDGER_MAX_TASKS}-task per-batch cap; split the work into smaller calls.`,
      );
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
    }, (next) => created.map((task) => buildTaskLedgerEvent({
      type: taskLedgerEventTypeForCreate(task),
      sessionId,
      task,
      context,
    })));
    return { created, total: all.length };
  }

  async update(
    sessionId: string,
    id: string,
    patch: unknown,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ updated: Task; total: number }> {
    assertSafeSessionId(sessionId);
    const now = Date.now();
    let updated: Task | undefined;
    let previous: Task | undefined;
    const all = await this.mutate(sessionId, (tasks) => {
      // Locate the target before producing a new list: an unknown id must
      // fail inside the callback without rewriting an identical file.
      const index = tasks.findIndex((task) => task.id === id);
      const current = index === -1 ? undefined : tasks[index];
      if (!current) throw new Error(`No such task: ${id}`);
      previous = current;
      const normalizedPatch = normalizeUpdateTaskInput(patch);
      if (!normalizedPatch.ok) throw new Error(normalizedPatch.message);
      const normalized = validateTaskUpdate(current, normalizedPatch.value, {
        explicitReopen: normalizedPatch.value.explicitReopen === true,
      });
      if (!normalized.ok) throw new Error(normalized.message);
      const { explicitReopen: _explicitReopen, ...taskPatch } = normalized.value;
      void _explicitReopen;
      updated = {
        ...current,
        ...(taskPatch.subject !== undefined ? { subject: taskPatch.subject } : {}),
        ...(taskPatch.status !== undefined ? { status: taskPatch.status } : {}),
        ...(taskPatch.blockedReason !== undefined ? { blockedReason: taskPatch.blockedReason } : {}),
        ...(taskPatch.failureReason !== undefined ? { failureReason: taskPatch.failureReason } : {}),
        ...(taskPatch.completionEvidence !== undefined ? { completionEvidence: taskPatch.completionEvidence } : {}),
        updatedAt: now,
      };
      updated = clearStaleTaskEvidence(updated);
      const next = [...tasks];
      next[index] = updated;
      return next;
    }, () => {
      if (!previous || !updated) return [];
      return [buildTaskLedgerEvent({
        type: taskLedgerEventTypeForUpdate(previous, updated),
        sessionId,
        task: updated,
        previous,
        context,
      })];
    });
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  private filePath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'tasks.json');
  }

  private eventsPath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'task-events.jsonl');
  }

  /**
   * Render-path read: a damaged event ledger falls back to the projection cache
   * as untrusted when possible, so resume/debug surfaces retain conservative
   * state without allowing writes to proceed from that cache.
   */
  private async readForRender(sessionId: string): Promise<Task[]> {
    try {
      return await this.readProjected(sessionId);
    } catch (eventError) {
      try {
        await readFile(this.eventsPath(sessionId), 'utf8');
        return await this.readUntrustedCache(sessionId);
      } catch (readEventError) {
        if ((readEventError as NodeJS.ErrnoException).code !== 'ENOENT') {
          return await this.readUntrustedCache(sessionId);
        }
      }
      try {
        return decodeTasks(await readFile(this.filePath(sessionId), 'utf8'));
      } catch {
        return [];
      }
    }
  }

  private async readUntrustedCache(sessionId: string): Promise<Task[]> {
    try {
      const tasks = decodeTasks(await readFile(this.filePath(sessionId), 'utf8'));
      return tasks.map((task) => ({ ...task, resumeTrust: 'untrusted' }));
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
  private async readForMutateWithSource(sessionId: string): Promise<{ tasks: Task[]; source: 'events' | 'legacy' }> {
    try {
      return { tasks: await this.readProjected(sessionId), source: 'events' };
    } catch (eventError) {
      try {
        await readFile(this.eventsPath(sessionId), 'utf8');
        throw eventError;
      } catch (readEventError) {
        if ((readEventError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw eventError;
        }
      }
    }
    let text: string;
    try {
      text = await readFile(this.filePath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [], source: 'legacy' };
      throw error;
    }
    try {
      return { tasks: decodeTasks(text), source: 'legacy' };
    } catch (error) {
      throw new Error(
        `Task ledger file for session ${sessionId} is corrupt; refusing to overwrite it: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async readProjected(sessionId: string): Promise<Task[]> {
    const events = await this.readTaskEvents(sessionId);
    const projection = projectTaskLedgerEvents(events);
    if (projection.diagnostics.length > 0) {
      throw new Error(`task event ledger has projection diagnostics: ${projection.diagnostics.join('; ')}`);
    }
    if (projection.tasks.length > TASK_LEDGER_MAX_TASKS) {
      throw new Error(
        `task event ledger has ${projection.tasks.length} tasks, exceeding the ${TASK_LEDGER_MAX_TASKS}-task cap; refusing to load an unbounded ledger`,
      );
    }
    return projection.tasks;
  }

  private async readTaskEvents(sessionId: string): Promise<TaskLedgerEvent[]> {
    const text = await readFile(this.eventsPath(sessionId), 'utf8');
    const events: TaskLedgerEvent[] = [];
    const lines = text.split(/\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid task event JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isTaskLedgerEvent(parsed)) {
        throw new Error(`Invalid task event JSONL line ${index + 1}: unexpected event shape`);
      }
      events.push(parsed);
    }
    return events;
  }

  private async mutate(
    sessionId: string,
    fn: (tasks: Task[]) => Task[],
    eventsForMutation: (next: Task[]) => TaskLedgerEvent[],
  ): Promise<Task[]> {
    let next: Task[] = [];
    await chainWrite(this.writeQueues, sessionId, async () => {
      const currentRead = await this.readForMutateWithSource(sessionId);
      const current = currentRead.tasks;
      next = fn(current);
      await this.appendEvents(sessionId, [
        ...(currentRead.source === 'legacy' ? current.map((task) => buildTaskLedgerEvent({
          type: 'task_imported',
          sessionId,
          task,
          context: { source: 'import', actor: 'system' },
        })) : []),
        ...eventsForMutation(next),
      ]);
      await this.write(sessionId, next);
    });
    return next;
  }

  private async appendEvents(sessionId: string, events: TaskLedgerEvent[]): Promise<void> {
    if (events.length === 0) return;
    const filePath = this.eventsPath(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  }

  private async write(sessionId: string, tasks: Task[]): Promise<void> {
    const filePath = this.filePath(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(tasks, null, 2) + '\n', 'utf8');
    await rename(tempPath, filePath);
  }

  private applyListOptions(tasks: Task[], options: TaskLedgerListOptions): Task[] {
    if (options.classifyResumeTrust !== true) return tasks;
    return tasks.map((task) => ({
      ...task,
      resumeTrust: task.resumeTrust ?? classifyTaskResumeTrust(task),
    }));
  }
}

function decodeTasks(text: string): Task[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('expected a JSON array of tasks');
  }
  const tasks: Task[] = [];
  const seenIds = new Set<string>();
  for (const value of parsed) {
    const task = normalizePersistedTask(value);
    if (!task) continue;
    // A tasks.json with two records sharing an id would render two
    // indistinguishable tasks in the turn tail, and TaskUpdate's first-match
    // lookup would only ever touch the first -- the second is unreachable and
    // a mutate would silently keep both. Treat a duplicate id as corrupt so
    // the render path degrades to empty and the mutate path stays fail-closed
    // instead of rewriting a "half-correct" file.
    if (seenIds.has(task.id)) {
      throw new Error(`task ledger has a duplicate id "${task.id}"; refusing to load an ambiguous ledger`);
    }
    seenIds.add(task.id);
    tasks.push(task);
  }
  // Enforce the same total-task cap as the write path on read. A hand-edited,
  // legacy, or externally-written tasks.json could otherwise carry an
  // unbounded number of valid records, which `list()` would inject into the
  // turn tail every turn. Treat over-cap as corrupt so the render path
  // degrades to empty (its caller already try/catches) and the mutate path
  // stays fail-closed instead of silently truncating-and-overwriting.
  if (tasks.length > TASK_LEDGER_MAX_TASKS) {
    throw new Error(
      `task ledger has ${tasks.length} tasks, exceeding the ${TASK_LEDGER_MAX_TASKS}-task cap; refusing to load an unbounded ledger`,
    );
  }
  return tasks;
}

function normalizePersistedTask(value: unknown): Task | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<Task>;
  // Timestamps must be finite: a hand-edited `1e999` parses to Infinity, and
  // JSON.stringify(Infinity) writes null, so the record would silently vanish
  // on the next write. Reject it up front (per-record drop) instead.
  if (
    typeof record.id !== 'string' ||
    !isSafeTaskId(record.id) ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    !isTaskStatus(record.status)
  ) {
    return undefined;
  }
  // Re-apply the same subject normalization as the write path (NFC, whitespace
  // collapse, trim, length cap, non-empty) so a manually-edited or legacy
  // tasks.json cannot inject an overlong/blank subject into the turn tail
  // every turn. Invalid subjects drop the whole record, matching the existing
  // "single malformed entry discarded" semantic.
  const subject = normalizeTaskSubject(record.subject);
  if (!subject.ok) return undefined;
  return {
    id: record.id,
    subject: subject.value,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(normalizeOptionalEvidence(record.blockedReason, 'blockedReason')),
    ...(normalizeOptionalEvidence(record.failureReason, 'failureReason')),
    ...(normalizeOptionalEvidence(record.completionEvidence, 'completionEvidence')),
    ...(normalizeOptionalResumeTrust(record.resumeTrust)),
  };
}

function normalizeOptionalEvidence(
  value: unknown,
  field: 'blockedReason' | 'failureReason' | 'completionEvidence',
): Partial<Task> {
  if (value === undefined) return {};
  const normalized = normalizeTaskEvidenceText(value, field);
  if (!normalized.ok) return {};
  return { [field]: normalized.value } as Partial<Task>;
}

function normalizeOptionalResumeTrust(value: unknown): Pick<Task, 'resumeTrust'> | Record<string, never> {
  if (value === undefined) return {};
  const normalized = normalizeResumeTrust(value);
  if (!normalized.ok) return {};
  return { resumeTrust: normalized.value };
}

function clearStaleTaskEvidence(task: Task): Task {
  const next: Task = { ...task };
  if (next.status !== 'blocked') delete next.blockedReason;
  if (next.status !== 'failed') delete next.failureReason;
  if (next.status !== 'completed') delete next.completionEvidence;
  return next;
}

function buildTaskLedgerEvent(input: {
  type: TaskLedgerEvent['type'];
  sessionId: string;
  task: Task;
  previous?: Task;
  context: TaskLedgerMutationContext;
}): TaskLedgerEvent {
  return {
    eventId: `task-event-${randomUUID()}`,
    type: input.type,
    ts: Date.now(),
    sessionId: input.sessionId,
    taskId: input.task.id,
    ...(input.previous ? { previousStatus: input.previous.status } : {}),
    nextStatus: input.task.status,
    task: input.task,
    ...(eventReason(input.task) ? { reason: eventReason(input.task) } : {}),
    ...(eventEvidence(input.task) ? { evidence: eventEvidence(input.task) } : {}),
    ...(eventRefs(input.context) ? { refs: eventRefs(input.context) } : {}),
    ...(input.context.source ? { source: input.context.source } : {}),
    ...(input.context.actor ? { actor: input.context.actor } : {}),
  };
}

function eventReason(task: Task): string | undefined {
  return task.blockedReason ?? task.failureReason;
}

function eventEvidence(task: Task): string | undefined {
  return task.completionEvidence;
}

function eventRefs(context: TaskLedgerMutationContext): TaskLedgerEvent['refs'] | undefined {
  const refs = {
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
  };
  return Object.keys(refs).length === 0 ? undefined : refs;
}
