import type { TaskLedgerStore } from '@maka/core';
import { createTaskLedgerStore } from '@maka/storage';
import { buildTaskLedgerTools, type MakaTool } from '@maka/runtime';

/**
 * The task-ledger wiring the main process needs: one per-session store shared
 * by the mutate face (TaskCreate/TaskUpdate tools) and the read face (the
 * turn-tail fragment). Grouping the construction here keeps the main-process
 * entry a thin assembler and lets the contract assert the wiring at behavior
 * level (tools present, store real, a create lands in the store the tail
 * reads) instead of via source-text regex.
 */
export interface MainTaskLedgerWiring {
  /** Per-session task ledger store; shared by tools (mutate) and turn tail (read). */
  store: TaskLedgerStore;
  /** TaskCreate/TaskUpdate bound to {@link store}. */
  tools: MakaTool[];
}

export interface MainTaskLedgerWiringOptions {
  /**
   * Fired after every committed ledger mutation — model tools and any host
   * surface (e.g. the renderer cancel IPC) share the wired store, so they all
   * notify. Best-effort: a throwing observer must never fail the mutation
   * that already committed.
   */
  onMutation?: (sessionId: string) => void;
}

export function createMainTaskLedgerWiring(
  workspaceRoot: string,
  options: MainTaskLedgerWiringOptions = {},
): MainTaskLedgerWiring {
  const store = withMutationNotifications(createTaskLedgerStore(workspaceRoot), options.onMutation);
  return {
    store,
    tools: buildTaskLedgerTools({ store }),
  };
}

function withMutationNotifications(
  store: TaskLedgerStore,
  onMutation: ((sessionId: string) => void) | undefined,
): TaskLedgerStore {
  if (!onMutation) return store;
  const notify = (sessionId: string): void => {
    try {
      onMutation(sessionId);
    } catch {
      // Observer failure (renderer window gone, …) must not surface here.
    }
  };
  return {
    list: (sessionId) => store.list(sessionId),
    create: async (sessionId, drafts) => {
      const result = await store.create(sessionId, drafts);
      notify(sessionId);
      return result;
    },
    update: async (sessionId, id, patch) => {
      const result = await store.update(sessionId, id, patch);
      notify(sessionId);
      return result;
    },
  };
}