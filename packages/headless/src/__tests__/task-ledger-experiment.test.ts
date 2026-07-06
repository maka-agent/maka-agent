import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
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

  test('builds a todo_write task tool that replaces the session todo list', async () => {
    const store = createInMemoryTaskLedgerExperimentStore({ now: idNumberFactory(), newId: idFactory() });
    const tools = buildTaskLedgerExperimentTools({ store });
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

    const emptyReplay = renderTaskLedgerExperimentReplay([], { maxChars: 600 });
    assert.match(emptyReplay ?? '', /Use todo_write at the start of long-running, multi-step tasks/);

    const replay = renderTaskLedgerExperimentReplay(await store.list('session-1'), {
      maxChars: 600,
    });
    assert.match(replay ?? '', /Use todo_write at the start of long-running, multi-step tasks/);
    assert.match(replay ?? '', /Run narrow regression test/);
    assert.match(replay ?? '', /status=completed/);
    assert.doesNotMatch(replay ?? '', /Inspect failing parser test/);
  });

  test('renders a capped replay of active pending and recently completed tasks', async () => {
    const store = createInMemoryTaskLedgerExperimentStore({ now: idNumberFactory(), newId: idFactory() });
    const tools = buildTaskLedgerExperimentTools({ store });
    const todoWrite = tools.find((tool) => tool.name === 'todo_write');
    assert.ok(todoWrite);
    await todoWrite.impl({
      todos: [
        { content: 'Patch implementation', status: 'in_progress' },
        { content: 'Run public check', status: 'pending' },
        { content: 'Inspect README', status: 'completed' },
      ],
    }, toolContext);

    const replay = renderTaskLedgerExperimentReplay(await store.list('session-1'), { maxChars: 600 });

    assert.match(replay ?? '', /Use todo_write at the start of long-running, multi-step tasks/);
    assert.match(replay ?? '', /Task ledger experiment state/);
    assert.match(replay ?? '', /Patch implementation/);
    assert.match(replay ?? '', /Run public check/);
    assert.match(replay ?? '', /Inspect README/);
    assert.ok((replay ?? '').length <= 600);
  });

  test('scrubs task text before it persists through tool results or replay', async () => {
    const store = createInMemoryTaskLedgerExperimentStore({ now: idNumberFactory(), newId: idFactory() });
    const tools = buildTaskLedgerExperimentTools({ store });
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
