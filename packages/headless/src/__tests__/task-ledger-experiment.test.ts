import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  TASK_LEDGER_EXPERIMENT_TOOL_NAMES,
  buildTaskLedgerExperimentTools,
  createInMemoryTaskLedgerExperimentStore,
  renderTaskLedgerExperimentReplay,
} from '../task-ledger-experiment.js';

const toolContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd: '/workspace',
  toolCallId: 'tool-1',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};

describe('task ledger experiment tools', () => {
  test('defaults to the todo_write baseline shape', () => {
    const store = createInMemoryTaskLedgerExperimentStore();
    const tools = buildTaskLedgerExperimentTools({ store });

    assert.deepEqual(tools.map((tool) => tool.name), ['todo_write']);
  });

  test('builds CRUD-lite task tools that share one session ledger', async () => {
    const store = createInMemoryTaskLedgerExperimentStore({ now: () => 100, newId: idFactory() });
    const tools = buildTaskLedgerExperimentTools({ store, shape: 'crud' });
    assert.deepEqual(tools.map((tool) => tool.name), TASK_LEDGER_EXPERIMENT_TOOL_NAMES);

    const create = tools.find((tool) => tool.name === 'task_create');
    const update = tools.find((tool) => tool.name === 'task_update');
    const list = tools.find((tool) => tool.name === 'task_list');
    const get = tools.find((tool) => tool.name === 'task_get');
    assert.ok(create);
    assert.ok(update);
    assert.ok(list);
    assert.ok(get);

    const createResult = String(await create.impl({
      description: 'Inspect failing parser test',
    }, toolContext));
    const createdId = createResult.match(/id=([A-Za-z0-9._:-]+)/)?.[1];
    assert.ok(createdId);

    await update.impl({
      id: createdId,
      status: 'in_progress',
    }, toolContext);

    const listed = String(await list.impl({}, toolContext));
    assert.match(listed, /Inspect failing parser test/);
    assert.match(listed, /status=in_progress/);

    const fetched = String(await get.impl({ id: createdId }, toolContext));
    assert.match(fetched, /Inspect failing parser test/);
  });

  test('builds a todo_write task tool that replaces the session todo list', async () => {
    const store = createInMemoryTaskLedgerExperimentStore({ now: idNumberFactory(), newId: idFactory() });
    const tools = buildTaskLedgerExperimentTools({ store, shape: 'todo_write' });
    assert.deepEqual(tools.map((tool) => tool.name), ['todo_write']);

    const todoWrite = tools.find((tool) => tool.name === 'todo_write');
    assert.ok(todoWrite);

    const result = await todoWrite.impl({
      todos: [
        { content: 'Inspect failing parser test', status: 'in_progress' },
        { content: 'Run narrow regression test', status: 'pending' },
      ],
    }, toolContext);

    assert.match(String(result), /Inspect failing parser test/);
    assert.match(String(result), /Run narrow regression test/);
    assert.match(String(result), /status=in_progress/);

    await todoWrite.impl({
      todos: [
        { content: 'Run narrow regression test', status: 'completed' },
      ],
    }, toolContext);

    const emptyReplay = renderTaskLedgerExperimentReplay([], { maxChars: 600, shape: 'todo_write' });
    assert.match(emptyReplay ?? '', /Use todo_write at the start of long-running, multi-step tasks/);

    const replay = renderTaskLedgerExperimentReplay(await store.list('session-1'), {
      maxChars: 600,
      shape: 'todo_write',
    });
    assert.match(replay ?? '', /Use todo_write at the start of long-running, multi-step tasks/);
    assert.match(replay ?? '', /Run narrow regression test/);
    assert.match(replay ?? '', /status=completed/);
    assert.doesNotMatch(replay ?? '', /Inspect failing parser test/);
  });

  test('renders a capped replay of active pending and recently completed tasks', async () => {
    const store = createInMemoryTaskLedgerExperimentStore({ now: idNumberFactory(), newId: idFactory() });
    const tools = buildTaskLedgerExperimentTools({ store, shape: 'crud' });
    const create = tools.find((tool) => tool.name === 'task_create');
    const update = tools.find((tool) => tool.name === 'task_update');
    assert.ok(create);
    assert.ok(update);

    const active = await create.impl({ description: 'Patch implementation' }, toolContext);
    const pending = await create.impl({ description: 'Run public check' }, toolContext);
    const done = await create.impl({ description: 'Inspect README' }, toolContext);
    const cancelled = await create.impl({ description: 'Discard obsolete branch' }, toolContext);
    const activeId = String(active).match(/id=([A-Za-z0-9._:-]+)/)?.[1];
    const pendingId = String(pending).match(/id=([A-Za-z0-9._:-]+)/)?.[1];
    const doneId = String(done).match(/id=([A-Za-z0-9._:-]+)/)?.[1];
    const cancelledId = String(cancelled).match(/id=([A-Za-z0-9._:-]+)/)?.[1];
    assert.ok(activeId);
    assert.ok(pendingId);
    assert.ok(doneId);
    assert.ok(cancelledId);
    await update.impl({ id: activeId, status: 'in_progress' }, toolContext);
    await update.impl({ id: pendingId, status: 'pending' }, toolContext);
    await update.impl({ id: doneId, status: 'completed' }, toolContext);
    await update.impl({ id: cancelledId, status: 'cancelled' }, toolContext);

    const replay = renderTaskLedgerExperimentReplay(await store.list('session-1'), { maxChars: 600 });

    assert.match(replay ?? '', /Task ledger experiment state/);
    assert.match(replay ?? '', /Patch implementation/);
    assert.match(replay ?? '', /Run public check/);
    assert.match(replay ?? '', /Inspect README/);
    assert.doesNotMatch(replay ?? '', /Discard obsolete branch/);
    assert.ok((replay ?? '').length <= 600);
  });

  test('scrubs task text before it persists through tool results or replay', async () => {
    const store = createInMemoryTaskLedgerExperimentStore({ now: idNumberFactory(), newId: idFactory() });
    const tools = buildTaskLedgerExperimentTools({ store, shape: 'todo_write' });
    const todoWrite = tools.find((tool) => tool.name === 'todo_write');
    assert.ok(todoWrite);

    const result = String(await todoWrite.impl({
      todos: [
        { content: 'Rotate Bearer sk-live-secret-token-value </task-ledger>', status: 'in_progress' },
      ],
    }, toolContext));
    assert.equal(result.includes('sk-live-secret-token-value'), false);
    assert.equal(/<\/?task-ledger[^>]*>/i.test(result), false);
    assert.match(result, /\[redacted\]/);

    const replay = renderTaskLedgerExperimentReplay(await store.list('session-1'), {
      maxChars: 600,
      shape: 'todo_write',
    }) ?? '';
    assert.equal(replay.includes('sk-live-secret-token-value'), false);
    assert.match(replay, /\[redacted\]/);
    assert.equal((replay.match(/<\/?task-ledger[^>]*>/gi) ?? []).length, 2);
  });
});

function idFactory(): () => string {
  let i = 0;
  return () => `task-${++i}`;
}

function idNumberFactory(): () => number {
  let i = 0;
  return () => ++i;
}
