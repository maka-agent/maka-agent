import { z } from 'zod';
import {
  TASK_STATUSES,
  TASK_SUBJECT_MAX_CHARS,
  TASK_LEDGER_MAX_TASKS,
  TASK_ID_MAX_CHARS,
  isSafeTaskId,
  renderSafeTaskLedgerText,
  type Task,
  type TaskLedgerStore,
} from '@maka/core/task-ledger';
import type { MakaTool } from './tool-runtime.js';

// PascalCase matches the model-facing builtin tools (Bash/Read/Write); the
// snake_case convention is reserved for the agent-orchestration family
// (agent_spawn/agent_list).
export const TASK_CREATE_TOOL_NAME = 'TaskCreate';
export const TASK_UPDATE_TOOL_NAME = 'TaskUpdate';

export function buildTaskLedgerTools(deps: { store: TaskLedgerStore }): MakaTool[] {
  return [buildTaskCreateTool(deps.store), buildTaskUpdateTool(deps.store)];
}

function buildTaskCreateTool(store: TaskLedgerStore): MakaTool<{ tasks: Array<{ subject: string }> }, string> {
  return {
    name: TASK_CREATE_TOOL_NAME,
    displayName: 'Task Create',
    description:
      'Add one or more tasks to the session task ledger. The full updated ledger is re-shown each turn, '
      + 'so use this to record work you plan to do; update status with TaskUpdate as you progress.',
    parameters: z.object({
      tasks: z.array(z.object({
        subject: z.string().trim().min(1).max(TASK_SUBJECT_MAX_CHARS)
          .describe(`Short imperative description of the task (max ${TASK_SUBJECT_MAX_CHARS} characters).`),
      })).min(1).max(TASK_LEDGER_MAX_TASKS).describe('One or more tasks to add. Each starts in the pending state.'),
    }),
    // Pure local session state, no external side effect (cf. agent_list).
    permissionRequired: false,
    impl: async (input, ctx) => {
      const { created, total } = await store.create(ctx.sessionId, input.tasks);
      // Tool results persist into session history and replay every turn; the
      // turn tail already re-injects the full ledger each turn, so the tool
      // result only echoes the created tasks (with their ids, so the model can
      // update them next) and the new total -- not the whole ledger, which would
      // duplicate the tail and bloat history under a large ledger.
      return `Created ${created.length} task(s); ledger total: ${total}.\n${renderSafeTaskLedgerText(created)}`;
    },
  };
}

function buildTaskUpdateTool(
  store: TaskLedgerStore,
): MakaTool<{ id: string; status?: typeof TASK_STATUSES[number]; subject?: string }, string> {
  return {
    name: TASK_UPDATE_TOOL_NAME,
    displayName: 'Task Update',
    description:
      'Update a task in the session task ledger by id. Provide status and/or a revised subject. '
      + 'Mark tasks in_progress when you start them and completed (or cancelled) when done.',
    parameters: z.object({
      id: z.string().min(1).max(TASK_ID_MAX_CHARS).refine(isSafeTaskId, 'Task id must be a stable token (alphanumeric plus . _ : -, max 64 chars) from the current ledger.').describe('Task id from the current ledger.'),
      status: z.enum(TASK_STATUSES).optional().describe('New task status.'),
      subject: z.string().trim().min(1).max(TASK_SUBJECT_MAX_CHARS).optional()
        .describe(`Revised task description (max ${TASK_SUBJECT_MAX_CHARS} characters).`),
    }).superRefine((input, ctx) => {
      if (input.status === undefined && input.subject === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Provide at least one of status or subject.',
        });
      }
    }),
    permissionRequired: false,
    impl: async (input, ctx) => {
      const { updated, total } = await store.update(ctx.sessionId, input.id, {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
      });
      return `Updated 1 task; ledger total: ${total}.\n${renderSafeTaskLedgerText([updated])}`;
    },
  };
}

