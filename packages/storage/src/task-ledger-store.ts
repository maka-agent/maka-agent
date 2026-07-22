import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TASK_LEDGER_MAX_TASKS,
  TASK_ARCHIVE_AFTER_MS,
  findTaskByRef,
  isSafeTaskId,
  isTaskKey,
  isTaskOwner,
  isTerminalTaskStatus,
  decodeTaskLedgerRecord,
  normalizeUpdateTaskInput,
  normalizeCreateTaskInput,
  projectTaskLedgerEvents,
  taskLedgerEventTypeForCreate,
  taskLedgerEventTypeForUpdate,
  validateTaskUpdate,
  classifyTaskResumeTrust,
  type Task,
  type TaskAgentOutcome,
  type TaskAvailableClaimScope,
  type TaskLedgerChangedEvent,
  type TaskLedgerEvent,
  type TaskLedgerListOptions,
  type TaskLedgerMutationContext,
  type TaskLedgerRecord,
  type TaskLedgerStore,
  type TaskOwner,
} from '@maka/core/task-ledger';
import { chainWrite } from './write-queue.js';
import { classifyJsonRecord } from './json-prefix.js';
import { appendJsonl } from './jsonl-append.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { assertSafeSessionId } from './session-store.js';

export type { TaskLedgerStore } from '@maka/core/task-ledger';

const writerBrand: unique symbol = Symbol('InteractiveTaskLedgerWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveTaskLedgerWriterFacade>();

export interface TaskLedgerCanonicalReader {
  listCanonical(sessionId: string, options?: TaskLedgerListOptions): Promise<Task[]>;
}

export interface InteractiveTaskLedgerWriterFacade
  extends TaskLedgerStore,
    TaskLedgerCanonicalReader {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
}

export function authenticateInteractiveTaskLedgerWriter(
  store: InteractiveTaskLedgerWriterFacade,
): InteractiveTaskLedgerWriterFacade {
  if (!writers.has(store)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authenticated interactive task ledger writer',
    );
  }
  return store;
}

export async function openInteractiveTaskLedgerStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveTaskLedgerWriterFacade> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;

  const store = new FileTaskLedgerStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'write', operation);
  const facade: InteractiveTaskLedgerWriterFacade = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    list: (sessionId, options) => run(() => store.list(sessionId, options)),
    listCanonical: (sessionId, options) => run(() => store.listCanonical(sessionId, options)),
    get: (sessionId, id, options) => run(() => store.get(sessionId, id, options)),
    create: (sessionId, drafts, context) => run(() => store.create(sessionId, drafts, context)),
    update: (sessionId, id, patch, context) =>
      run(() => store.update(sessionId, id, patch, context)),
    claim: (sessionId, id, owner, context) => run(() => store.claim(sessionId, id, owner, context)),
    claimAvailable: (sessionId, id, owner, scope, context) =>
      run(() => store.claimAvailable(sessionId, id, owner, scope, context)),
    settleAgentOutcome: (sessionId, id, outcome, context) =>
      run(() => store.settleAgentOutcome(sessionId, id, outcome, context)),
    subscribe: (listener) => store.subscribe(listener),
  };
  Object.freeze(facade);
  writers.add(facade);
  writerByLease.set(lease, facade);
  return facade;
}

export function createTaskLedgerStore(
  workspaceRoot: string,
): TaskLedgerStore & TaskLedgerCanonicalReader {
  return new FileTaskLedgerStore(workspaceRoot);
}

class FileTaskLedgerStore implements TaskLedgerStore {
  private readonly durabilityRoot: string;
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: TaskLedgerChangedEvent) => void>();

  constructor(workspaceRoot: string) {
    this.durabilityRoot = resolve(workspaceRoot);
    this.sessionsRoot = join(this.durabilityRoot, 'sessions');
  }

  async list(sessionId: string, options: TaskLedgerListOptions = {}): Promise<Task[]> {
    assertSafeSessionId(sessionId);
    try {
      return await this.listCanonical(sessionId, options);
    } catch {
      return [];
    }
  }

  async listCanonical(sessionId: string, options: TaskLedgerListOptions = {}): Promise<Task[]> {
    assertSafeSessionId(sessionId);
    return this.applyListOptions(await this.readProjected(sessionId), options);
  }

  async get(
    sessionId: string,
    id: string,
    options: TaskLedgerListOptions = {},
  ): Promise<Task | undefined> {
    assertSafeSessionId(sessionId);
    if (!isSafeTaskId(id))
      throw new Error('Task id must be a stable token (alphanumeric plus . _ : -, max 64 chars)');
    const tasks = await this.list(sessionId, options);
    return findTaskByRef(tasks, id);
  }

  subscribe(listener: (event: TaskLedgerChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    const normalizedDrafts = drafts.map((draft) => {
      const normalized = normalizeCreateTaskInput(draft);
      if (!normalized.ok) throw new Error(normalized.message);
      return normalized.value;
    });
    const created: Task[] = [];
    // Cap check runs inside the serialized mutate callback (after reading the
    // current ledger) so concurrent creates cannot race past the limit, and a
    // rejected create never touches the file.
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        if (tasks.length + normalizedDrafts.length > TASK_LEDGER_MAX_TASKS) {
          throw new Error(
            `Task ledger is limited to ${TASK_LEDGER_MAX_TASKS} tasks total per session ` +
              `(currently ${tasks.length}, adding ${normalizedDrafts.length}). This is a hard runaway guard on the ` +
              'total count — completed or cancelled tasks still count, so batch related work into fewer, ' +
              'coarser tasks instead.',
          );
        }
        const now = Date.now();
        for (const draft of normalizedDrafts) {
          const parent = draft.parentId ? findTaskByRef(tasks, draft.parentId) : undefined;
          if (draft.parentId && !parent) throw new Error(`No such parent task: ${draft.parentId}`);
          if (parent && isTerminalTaskStatus(parent.status)) {
            throw new Error(`Cannot create a child under terminal task ${parent.key}`);
          }
          const task: Task = {
            id: randomUUID(),
            key: nextTaskKey([...tasks, ...created], parent),
            subject: draft.subject,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            ...(parent ? { parentId: parent.id } : {}),
            ...(ownerFromContext(context) ? { owner: ownerFromContext(context) } : {}),
          };
          created.push(task);
        }
        return [...tasks, ...created];
      },
      (next) =>
        created.map((task) =>
          buildTaskLedgerEvent({
            type: taskLedgerEventTypeForCreate(task),
            sessionId,
            task,
            context,
          }),
        ),
    );
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
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        // Locate the target before producing a new list: an unknown id must
        // fail inside the callback without rewriting an identical file.
        const resolved = findTaskByRef(tasks, id);
        const index = resolved ? tasks.findIndex((task) => task.id === resolved.id) : -1;
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
          ...(taskPatch.blockedReason !== undefined
            ? { blockedReason: taskPatch.blockedReason }
            : {}),
          ...(taskPatch.failureReason !== undefined
            ? { failureReason: taskPatch.failureReason }
            : {}),
          ...(taskPatch.completionEvidence !== undefined
            ? { completionEvidence: taskPatch.completionEvidence }
            : {}),
          ...(taskPatch.status === 'in_progress' && context.actor === 'main_agent'
            ? { owner: ownerFromContext(context) }
            : {}),
          updatedAt: now,
        };
        if (taskPatch.status !== undefined && isTerminalTaskStatus(taskPatch.status)) {
          if (taskPatch.status === 'completed') assertDescendantsTerminal(tasks, current.id);
          updated.endedAt = now;
        } else if (taskPatch.status === 'pending' || taskPatch.status === 'in_progress') {
          delete updated.endedAt;
        }
        if (taskPatch.status === 'pending') delete updated.owner;
        updated = clearStaleTaskEvidence(updated);
        const next = [...tasks];
        next[index] = updated;
        return next;
      },
      () => {
        if (!previous || !updated) return [];
        return [
          buildTaskLedgerEvent({
            type: taskLedgerEventTypeForUpdate(previous, updated),
            sessionId,
            task: updated,
            previous,
            context,
          }),
        ];
      },
    );
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  async claim(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ updated: Task; total: number }> {
    assertSafeSessionId(sessionId);
    assertChildTaskOwner(owner);
    let updated: Task | undefined;
    let previous: Task | undefined;
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        const current = findTaskByRef(tasks, id);
        if (!current) throw new Error(`No such task: ${id}`);
        if (isTerminalTaskStatus(current.status))
          throw new Error(`Cannot claim terminal task ${current.key}`);
        if (
          current.status === 'in_progress' &&
          current.owner?.actor === 'child_agent' &&
          current.owner.turnId !== owner.turnId
        ) {
          throw new Error(`Task ${current.key} is already claimed by another child agent`);
        }
        previous = current;
        updated = clearStaleTaskEvidence({
          ...current,
          status: 'in_progress',
          owner,
          updatedAt: Date.now(),
        });
        return tasks.map((task) => (task.id === current.id ? updated! : task));
      },
      () =>
        previous && updated
          ? [
              buildTaskLedgerEvent({
                type: taskLedgerEventTypeForUpdate(previous, updated),
                sessionId,
                task: updated,
                previous,
                context,
              }),
            ]
          : [],
    );
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  async claimAvailable(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    scope: TaskAvailableClaimScope,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ updated: Task; total: number }> {
    assertSafeSessionId(sessionId);
    assertChildTaskOwner(owner);
    if (!isSafeTaskId(scope.parentRunId))
      throw new Error('Available task claim requires a stable parent AgentRun id');
    let updated: Task | undefined;
    let previous: Task | undefined;
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        const current = findTaskByRef(tasks, id);
        if (!current) throw new Error(`No such task: ${id}`);
        if (isTerminalTaskStatus(current.status))
          throw new Error(`Cannot claim terminal task ${current.key}`);

        const alreadyClaimed = tasks.find(
          (task) =>
            task.id !== current.id &&
            !isTerminalTaskStatus(task.status) &&
            task.owner?.actor === 'child_agent' &&
            task.owner.turnId === owner.turnId,
        );
        if (alreadyClaimed) {
          throw new Error(
            `Child agent already owns task ${alreadyClaimed.key}; one shared task may be claimed per child turn`,
          );
        }

        const sameOwner =
          current.owner?.actor === 'child_agent' && current.owner.turnId === owner.turnId;
        if (
          !sameOwner &&
          (current.owner?.actor !== 'main_agent' || current.owner.runId !== scope.parentRunId)
        ) {
          throw new Error(`Task ${current.key} is not shared by parent run ${scope.parentRunId}`);
        }
        if (current.status === 'in_progress' && !sameOwner) {
          throw new Error(
            `Task ${current.key} is already in progress and is not available for self-claim`,
          );
        }
        if (current.owner?.actor === 'child_agent' && !sameOwner) {
          throw new Error(`Task ${current.key} is already claimed by another child agent`);
        }

        previous = current;
        updated =
          sameOwner && current.status === 'in_progress'
            ? current
            : clearStaleTaskEvidence({
                ...current,
                status: 'in_progress',
                owner,
                updatedAt: Date.now(),
              });
        return updated === current
          ? tasks
          : tasks.map((task) => (task.id === current.id ? updated! : task));
      },
      () =>
        previous && updated && previous !== updated
          ? [
              buildTaskLedgerEvent({
                type: taskLedgerEventTypeForUpdate(previous, updated),
                sessionId,
                task: updated,
                previous,
                context,
              }),
            ]
          : [],
    );
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  async settleAgentOutcome(
    sessionId: string,
    id: string,
    outcome: TaskAgentOutcome,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ updated: Task; total: number }> {
    assertSafeSessionId(sessionId);
    assertChildTaskOwner(outcome.owner);
    let updated: Task | undefined;
    let previous: Task | undefined;
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        const current = findTaskByRef(tasks, id);
        if (!current) throw new Error(`No such task: ${id}`);
        if (
          current.owner?.actor === 'child_agent' &&
          current.owner.turnId &&
          current.owner.turnId !== outcome.owner.turnId
        ) {
          throw new Error(`Task ${current.key} is owned by a different child agent`);
        }
        previous = current;
        const now = Date.now();
        updated = { ...current, owner: outcome.owner, updatedAt: now };
        if (!isTerminalTaskStatus(current.status)) {
          if (outcome.status === 'failed') {
            updated.status = 'failed';
            updated.failureReason = normalizeOutcomeReason(outcome.reason, 'Child agent failed');
            updated.endedAt = now;
          } else if (outcome.status === 'cancelled') {
            updated.status = 'cancelled';
            updated.endedAt = now;
          } else if (outcome.status === 'waiting_permission') {
            updated.status = 'blocked';
            updated.blockedReason = normalizeOutcomeReason(
              outcome.reason,
              'Child agent is waiting for permission',
            );
          }
        }
        updated = clearStaleTaskEvidence(updated);
        return tasks.map((task) => (task.id === current.id ? updated! : task));
      },
      () =>
        previous && updated
          ? [
              buildTaskLedgerEvent({
                type: taskLedgerEventTypeForUpdate(previous, updated),
                sessionId,
                task: updated,
                previous,
                context: { ...context, reason: outcome.reason ?? context.reason },
              }),
            ]
          : [],
    );
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  private eventsPath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'task-events.jsonl');
  }
  private async readProjected(sessionId: string): Promise<Task[]> {
    const events = (await this.readTaskRecords(sessionId)).flatMap((record) => record.events);
    const projection = projectTaskLedgerEvents(events);
    if (projection.diagnostics.length > 0) {
      throw new Error(
        `task event ledger has projection diagnostics: ${projection.diagnostics.join('; ')}`,
      );
    }
    if (projection.tasks.length > TASK_LEDGER_MAX_TASKS) {
      throw new Error(
        `task event ledger has ${projection.tasks.length} tasks, exceeding the ${TASK_LEDGER_MAX_TASKS}-task cap; refusing to load an unbounded ledger`,
      );
    }
    return projection.tasks;
  }

  private async readTaskRecords(sessionId: string): Promise<TaskLedgerRecord[]> {
    let text: string;
    try {
      text = await readFile(this.eventsPath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (text.length === 0) return [];

    const terminated = text.endsWith('\n');
    const lines = text.split('\n');
    if (terminated) lines.pop();
    const records: TaskLedgerRecord[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const isCrashTail = !terminated && index === lines.length - 1;
      if (isCrashTail && classifyJsonRecord(line) === 'incomplete-prefix') break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid task ledger JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const decoded = decodeTaskLedgerRecord(parsed);
      if (!decoded) {
        throw new Error(`Invalid task ledger JSONL line ${index + 1}: unexpected record shape`);
      }
      if (decoded.sessionId !== sessionId) {
        throw new Error(
          `Task ledger record ${decoded.recordId} belongs to session ${decoded.sessionId}, expected ${sessionId}`,
        );
      }
      const mismatchedEvent = decoded.events.find((event) => event.sessionId !== sessionId);
      if (mismatchedEvent) {
        throw new Error(
          `Task ledger event ${mismatchedEvent.eventId} belongs to session ${mismatchedEvent.sessionId}, expected ${sessionId}`,
        );
      }
      records.push(decoded);
    }
    return records;
  }

  private async mutate(
    sessionId: string,
    fn: (tasks: Task[]) => Task[],
    eventsForMutation: (next: Task[]) => TaskLedgerEvent[],
  ): Promise<Task[]> {
    let next: Task[] = [];
    await chainWrite(this.writeQueues, sessionId, async () => {
      const current = await this.readProjected(sessionId);
      next = fn(current);
      const mutationEvents = eventsForMutation(next);
      await this.appendRecord(sessionId, mutationEvents);
      if (mutationEvents.length > 0) {
        this.emitChanged({
          sessionId,
          taskIds: [...new Set(mutationEvents.map((event) => event.taskId))],
          at: Date.now(),
        });
      }
    });
    return next;
  }

  private async appendRecord(sessionId: string, events: TaskLedgerEvent[]): Promise<void> {
    if (events.length === 0) return;
    const filePath = this.eventsPath(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    const record: TaskLedgerRecord = {
      version: 1,
      recordId: `task-record-${randomUUID()}`,
      sessionId,
      ts: Date.now(),
      events,
    };
    await appendJsonl(filePath, `${JSON.stringify(record)}\n`, {
      durable: true,
      durabilityRoot: this.durabilityRoot,
    });
  }

  private applyListOptions(tasks: Task[], options: TaskLedgerListOptions): Task[] {
    const now = options.now ?? Date.now();
    const filtered = tasks.filter((task) => {
      if (options.status && task.status !== options.status) return false;
      if (options.includeTerminal === false && isTerminalTaskStatus(task.status)) return false;
      if (
        options.includeArchived === false &&
        isTerminalTaskStatus(task.status) &&
        task.endedAt !== undefined &&
        task.endedAt <= now - TASK_ARCHIVE_AFTER_MS
      )
        return false;
      return true;
    });
    if (options.classifyResumeTrust !== true) return filtered;
    return filtered.map((task) => ({
      ...task,
      resumeTrust: task.resumeTrust ?? classifyTaskResumeTrust(task),
    }));
  }

  private emitChanged(event: TaskLedgerChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* observers cannot perturb the ledger */
      }
    }
  }
}

function nextTaskKey(tasks: readonly Task[], parent: Task | undefined): string {
  const siblings = tasks.filter((task) => task.parentId === parent?.id);
  const prefix = parent ? `${parent.key}.` : 'T';
  const used = new Set(siblings.map((task) => task.key));
  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  const key = `${prefix}${index}`;
  if (!isTaskKey(key))
    throw new Error(
      `Task hierarchy is too deep to allocate a stable key under ${parent?.key ?? 'root'}`,
    );
  return key;
}

function assertChildTaskOwner(
  owner: TaskOwner,
): asserts owner is TaskOwner & { actor: 'child_agent'; agentId: string; turnId: string } {
  if (owner.actor !== 'child_agent' || !owner.agentId || !owner.turnId || !isTaskOwner(owner)) {
    throw new Error(
      'Child task ownership requires stable child_agent agentId and turnId references',
    );
  }
}

function ownerFromContext(context: TaskLedgerMutationContext): TaskOwner | undefined {
  if (context.actor !== 'main_agent') return undefined;
  return {
    actor: 'main_agent',
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
}

function assertDescendantsTerminal(tasks: readonly Task[], parentId: string): void {
  const pending = [parentId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const child of tasks.filter((task) => task.parentId === current)) {
      if (!isTerminalTaskStatus(child.status)) {
        throw new Error(
          `Cannot complete a parent while descendant ${child.key} is ${child.status}`,
        );
      }
      pending.push(child.id);
    }
  }
}

function normalizeOutcomeReason(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).normalize('NFC').replace(/\s+/g, ' ').trim();
  return Array.from(normalized).slice(0, 1000).join('');
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
    ...((input.context.reason ?? eventReason(input.task))
      ? { reason: input.context.reason ?? eventReason(input.task) }
      : {}),
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
