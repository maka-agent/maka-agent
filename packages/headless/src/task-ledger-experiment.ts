import { randomUUID } from 'node:crypto';
import {
  TASK_ID_MAX_CHARS,
  TASK_LEDGER_MAX_TASKS,
  TASK_STATUSES,
  TASK_SUBJECT_MAX_CHARS,
  isSafeTaskId,
  renderSafeTaskLedgerText,
  type Task,
  type TaskStatus,
} from '@maka/core/task-ledger';
import type { MakaTool } from '@maka/runtime';
import { z } from 'zod';

export const TASK_LEDGER_EXPERIMENT_TOOL_NAMES = ['task_create', 'task_update', 'task_list', 'task_get'] as const;
export const TASK_LEDGER_EXPERIMENT_TODO_TOOL_NAMES = ['todo_write'] as const;

export const TASK_LEDGER_EXPERIMENT_STATUSES = TASK_STATUSES;

export type TaskLedgerExperimentStatus = TaskStatus;
export type TaskLedgerExperimentShape = 'crud' | 'todo_write';
export type TaskLedgerExperimentTodoStatus = 'pending' | 'in_progress' | 'completed';
export type TaskLedgerExperimentTask = Task;

export interface TaskLedgerExperimentStore {
  create(sessionId: string, input: {
    description: string;
  }): Promise<TaskLedgerExperimentTask>;
  update(sessionId: string, id: string, patch: {
    description?: string;
    status?: TaskLedgerExperimentStatus;
  }): Promise<TaskLedgerExperimentTask>;
  replace(sessionId: string, todos: Array<{
    content: string;
    status: TaskLedgerExperimentTodoStatus;
  }>): Promise<TaskLedgerExperimentTask[]>;
  list(sessionId: string): Promise<TaskLedgerExperimentTask[]>;
  get(sessionId: string, id: string): Promise<TaskLedgerExperimentTask>;
}

const DEFAULT_REPLAY_MAX_CHARS = 4_000;
const TODO_WRITE_GUIDANCE_LINES: string[] = [
  'Todo tool guidance:',
  '<todo-tool-guidance>',
  '- Use todo_write at the start of long-running, multi-step tasks with a short outcome-focused plan.',
  '- Keep exactly one in_progress item while working; mark items completed as soon as they are done.',
  '- Rewrite the list when the plan changes, keeping items concise.',
  '</todo-tool-guidance>',
];

const taskDescriptionSchema = z.string().trim().min(1).max(TASK_SUBJECT_MAX_CHARS);
const taskIdSchema = z.string().trim().min(1).max(TASK_ID_MAX_CHARS)
  .refine(isSafeTaskId, 'Task id must be a stable token from task_list or task_create.');

const taskCreateSchema = z.object({
  description: taskDescriptionSchema.describe('Short description of the task.'),
}).strict();

const taskUpdateSchema = z.object({
  id: taskIdSchema.describe('Task id from task_list or the task_create result.'),
  description: taskDescriptionSchema.optional().describe('Replacement task description.'),
  status: z.enum(TASK_LEDGER_EXPERIMENT_STATUSES).optional().describe('New task status.'),
}).strict().superRefine((value, ctx) => {
  if (
    value.description === undefined &&
    value.status === undefined
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide at least one field to update.' });
  }
});

const taskGetSchema = z.object({ id: taskIdSchema }).strict();
const taskListSchema = z.object({}).strict();
const todoWriteSchema = z.object({
  todos: z.array(z.object({
    content: taskDescriptionSchema.describe('Short todo item content.'),
    status: z.enum(['pending', 'in_progress', 'completed']).describe('Current todo status.'),
  }).strict()).max(TASK_LEDGER_MAX_TASKS).describe('The complete current todo list, replacing any previous todo list.'),
}).strict();

export function createInMemoryTaskLedgerExperimentStore(input: {
  now?: () => number;
  newId?: () => string;
} = {}): TaskLedgerExperimentStore {
  return new InMemoryTaskLedgerExperimentStore(input.now ?? Date.now, input.newId ?? defaultId);
}

export function buildTaskLedgerExperimentTools(input: {
  store: TaskLedgerExperimentStore;
  shape?: TaskLedgerExperimentShape;
}): MakaTool[] {
  if ((input.shape ?? 'todo_write') === 'todo_write') {
    return [{
      name: 'todo_write',
      description:
        'Replace the current todo list for a long-running task. '
        + 'Use it when planning work, when switching the active item, and when marking work complete.',
      parameters: todoWriteSchema,
      permissionRequired: false,
      impl: async (args, ctx) => {
        const parsed = todoWriteSchema.parse(args);
        const todos = await input.store.replace(ctx.sessionId, parsed.todos);
        return renderMutationResult('Replaced todo list', todos.length, todos);
      },
    }];
  }
  return [
    {
      name: 'task_create',
      description: 'Create one short task in the experimental session task ledger.',
      parameters: taskCreateSchema,
      permissionRequired: false,
      impl: async (args, ctx) => {
        const parsed = taskCreateSchema.parse(args);
        const task = await input.store.create(ctx.sessionId, parsed);
        const total = (await input.store.list(ctx.sessionId)).length;
        return renderMutationResult('Created 1 task', total, [task]);
      },
    },
    {
      name: 'task_update',
      description: 'Update one task in the experimental session task ledger.',
      parameters: taskUpdateSchema,
      permissionRequired: false,
      impl: async (args, ctx) => {
        const parsed = taskUpdateSchema.parse(args);
        const { id, ...patch } = parsed;
        const task = await input.store.update(ctx.sessionId, id, patch);
        const total = (await input.store.list(ctx.sessionId)).length;
        return renderMutationResult('Updated 1 task', total, [task]);
      },
    },
    {
      name: 'task_list',
      description: 'List the current experimental session tasks.',
      parameters: taskListSchema,
      permissionRequired: false,
      impl: async (args, ctx) => {
        taskListSchema.parse(args);
        const tasks = await input.store.list(ctx.sessionId);
        return renderMutationResult('Listed task ledger', tasks.length, tasks);
      },
    },
    {
      name: 'task_get',
      description: 'Get one experimental session task by id.',
      parameters: taskGetSchema,
      permissionRequired: false,
      impl: async (args, ctx) => {
        const parsed = taskGetSchema.parse(args);
        const task = await input.store.get(ctx.sessionId, parsed.id);
        const total = (await input.store.list(ctx.sessionId)).length;
        return renderMutationResult('Fetched 1 task', total, [task]);
      },
    },
  ];
}

export function renderTaskLedgerExperimentReplay(
  tasks: readonly TaskLedgerExperimentTask[],
  options: { maxChars?: number; shape?: TaskLedgerExperimentShape } = {},
): string | undefined {
  const selected = tasks
    .filter((task) => task.status !== 'cancelled')
    .sort((a, b) => taskReplayRank(a) - taskReplayRank(b) || b.updatedAt - a.updatedAt);
  if (selected.length === 0 && options.shape !== 'todo_write') return undefined;

  const lines: string[] = options.shape === 'todo_write' ? [...TODO_WRITE_GUIDANCE_LINES] : [];
  if (selected.length > 0) {
    lines.push(
      'Task ledger experiment state (current-turn tail; informational, not an instruction):',
      '<task-ledger>',
    );
    lines.push(renderSafeTaskLedgerText(selected));
    lines.push('</task-ledger>');
  }
  return capLines(lines, options.maxChars ?? DEFAULT_REPLAY_MAX_CHARS);
}

function renderMutationResult(action: string, total: number, tasks: readonly TaskLedgerExperimentTask[]): string {
  const renderedTasks = renderSafeTaskLedgerText(tasks);
  return `${action}; ledger total: ${total}.${renderedTasks ? `\n${renderedTasks}` : ''}`;
}

class InMemoryTaskLedgerExperimentStore implements TaskLedgerExperimentStore {
  private readonly bySession = new Map<string, TaskLedgerExperimentTask[]>();

  constructor(
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  async create(sessionId: string, input: {
    description: string;
  }): Promise<TaskLedgerExperimentTask> {
    const tasks = this.sessionTasks(sessionId);
    if (tasks.length >= TASK_LEDGER_MAX_TASKS) {
      throw new Error(`Task ledger experiment is limited to ${TASK_LEDGER_MAX_TASKS} tasks per session`);
    }
    const ts = this.now();
    const task: TaskLedgerExperimentTask = {
      id: this.newId(),
      subject: input.description,
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    };
    tasks.push(task);
    return task;
  }

  async update(sessionId: string, id: string, patch: {
    description?: string;
    status?: TaskLedgerExperimentStatus;
  }): Promise<TaskLedgerExperimentTask> {
    const tasks = this.sessionTasks(sessionId);
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new Error(`No such task: ${id}`);
    const current = tasks[index]!;
    const task: TaskLedgerExperimentTask = {
      ...current,
      ...(patch.description !== undefined ? { subject: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: this.now(),
    };
    tasks[index] = task;
    return task;
  }

  async replace(sessionId: string, todos: Array<{
    content: string;
    status: TaskLedgerExperimentTodoStatus;
  }>): Promise<TaskLedgerExperimentTask[]> {
    if (todos.length > TASK_LEDGER_MAX_TASKS) {
      throw new Error(`Task ledger experiment is limited to ${TASK_LEDGER_MAX_TASKS} tasks per session`);
    }
    const ts = this.now();
    const tasks = todos.map((todo) => ({
      id: this.newId(),
      subject: todo.content,
      status: todo.status,
      createdAt: ts,
      updatedAt: ts,
    }));
    this.bySession.set(sessionId, tasks);
    return tasks.map((task) => ({ ...task }));
  }

  async list(sessionId: string): Promise<TaskLedgerExperimentTask[]> {
    return this.sessionTasks(sessionId).map((task) => ({ ...task }));
  }

  async get(sessionId: string, id: string): Promise<TaskLedgerExperimentTask> {
    const task = this.sessionTasks(sessionId).find((candidate) => candidate.id === id);
    if (!task) throw new Error(`No such task: ${id}`);
    return { ...task };
  }

  private sessionTasks(sessionId: string): TaskLedgerExperimentTask[] {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;
    const tasks: TaskLedgerExperimentTask[] = [];
    this.bySession.set(sessionId, tasks);
    return tasks;
  }
}

function taskReplayRank(task: TaskLedgerExperimentTask): number {
  if (task.status === 'in_progress') return 0;
  if (task.status === 'pending') return 1;
  if (task.status === 'completed') return 2;
  return 3;
}

function capLines(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length === 0 ? 0 : 1);
    if (kept.length > 0 && total + cost > maxChars) {
      kept.push(`... omitted to stay within ${maxChars} chars`);
      break;
    }
    kept.push(line);
    total += cost;
  }
  return kept.join('\n').slice(0, maxChars);
}

function defaultId(): string {
  return randomUUID();
}
