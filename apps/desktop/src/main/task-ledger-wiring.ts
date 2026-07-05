import type { TaskLedgerStore } from '@maka/core';
import { createTaskLedgerStore } from '@maka/storage';
import { buildTaskLedgerTools, type MakaTool } from '@maka/runtime';

/**
 * The task-ledger wiring the main process needs: one per-session store shared
 * by the mutate face (TaskCreate/TaskUpdate tools) and the read face (the
 * turn-tail fragment). Grouping the construction here keeps the main-process
 * entry a thin assembler and lets the contract assert the wiring at behavior
 * level (tools present, store real, deps share the store instance, a create
 * lands in the store the tail reads) instead of via source-text regex.
 */
export interface MainTaskLedgerWiring {
  /** Per-session task ledger store; shared by tools (mutate) and turn tail (read). */
  store: TaskLedgerStore;
  /** TaskCreate/TaskUpdate bound to {@link store}. */
  tools: MakaTool[];
  /** Slice to spread into `createSystemPromptMainService` deps; same store instance. */
  systemPromptDeps: { taskLedger: Pick<TaskLedgerStore, 'list'> };
}

export function createMainTaskLedgerWiring(workspaceRoot: string): MainTaskLedgerWiring {
  const store = createTaskLedgerStore(workspaceRoot);
  return {
    store,
    tools: buildTaskLedgerTools({ store }),
    systemPromptDeps: { taskLedger: store },
  };
}