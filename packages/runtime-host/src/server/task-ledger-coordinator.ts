import { createHash } from 'node:crypto';
import { findTaskByRef, sanitizeTaskLedgerTask } from '@maka/core/task-ledger';
import type { TaskLedgerCanonicalReader } from '@maka/storage/task-ledger-store';
import {
  encodeTaskLedgerQueryResult,
  TASK_LEDGER_PAGE_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_ITEMS,
  type OperationOutcome,
  type TaskLedgerQueryInput,
  type TaskLedgerQueryResult,
  type TaskLedgerRevision,
  type TaskLedgerTask,
} from '../protocol/index.js';
import type { TaskLedgerOperationHandlerMap } from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';

const LIST_OPTIONS = Object.freeze({
  includeTerminal: true,
  includeArchived: false,
  classifyResumeTrust: true,
});

/** Host-owned, read-only projection over the canonical Task Ledger. */
export class HostTaskLedgerCoordinator {
  readonly handlers: TaskLedgerOperationHandlerMap = {
    'task.ledger.query': (input) => this.#query(input),
  };

  constructor(
    private readonly reader: TaskLedgerCanonicalReader,
    private readonly sessionAdmission: SessionAdmissionGate,
  ) {}

  #query(input: TaskLedgerQueryInput): Promise<OperationOutcome<'task.ledger.query'>> {
    return this.sessionAdmission.run(input.sessionId, async () => {
      try {
        const tasks = (await this.reader.listCanonical(input.sessionId, LIST_OPTIONS)).map(
          sanitizeTaskLedgerTask,
        );
        const revision = taskLedgerRevision(tasks);

        if (input.kind === 'get') {
          return success(
            encodeTaskLedgerQueryResult({
              kind: 'task',
              sessionId: input.sessionId,
              revision,
              task: findTaskByRef(tasks, input.taskRef) ?? null,
            }),
          );
        }

        if (input.kind === 'list_continue' && input.revision !== revision) {
          return success({
            kind: 'revision_changed',
            expected: input.revision,
            actual: revision,
          });
        }

        const offset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
        if (
          offset === undefined ||
          offset > tasks.length ||
          (input.kind === 'list_continue' && offset === tasks.length)
        ) {
          return invalidRequest('Task ledger cursor is invalid');
        }
        return success(createPage(input.sessionId, revision, tasks, offset));
      } catch {
        return persistenceFailure();
      }
    });
  }
}

function taskLedgerRevision(tasks: readonly TaskLedgerTask[]): TaskLedgerRevision {
  return `sha256:${createHash('sha256').update(JSON.stringify(tasks)).digest('hex')}`;
}

function createPage(
  sessionId: string,
  revision: TaskLedgerRevision,
  tasks: readonly TaskLedgerTask[],
  offset: number,
): TaskLedgerQueryResult {
  const pageTasks: TaskLedgerTask[] = [];
  for (let index = offset; index < tasks.length; index += 1) {
    if (pageTasks.length >= TASK_LEDGER_PAGE_MAX_ITEMS) break;
    const task = tasks[index];
    if (!task) break;
    const candidateTasks = [...pageTasks, task];
    const nextOffset = index + 1;
    const candidate = {
      kind: 'page' as const,
      sessionId,
      revision,
      tasks: candidateTasks,
      nextCursor: nextOffset < tasks.length ? encodeCursor(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > TASK_LEDGER_PAGE_MAX_BYTES) {
      if (pageTasks.length === 0) {
        throw new Error('A canonical Task cannot fit in one Task Ledger page');
      }
      break;
    }
    pageTasks.push(task);
  }

  const nextOffset = offset + pageTasks.length;
  return encodeTaskLedgerQueryResult({
    kind: 'page',
    sessionId,
    revision,
    tasks: pageTasks,
    nextCursor: nextOffset < tasks.length ? encodeCursor(nextOffset) : null,
  });
}

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function success(result: TaskLedgerQueryResult): OperationOutcome<'task.ledger.query'> {
  return { ok: true, result };
}

function invalidRequest(message: string): OperationOutcome<'task.ledger.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}

function persistenceFailure(): OperationOutcome<'task.ledger.query'> {
  return {
    ok: false,
    error: {
      code: 'persistence_failed',
      message: 'Task ledger projection is unavailable',
    },
  };
}
