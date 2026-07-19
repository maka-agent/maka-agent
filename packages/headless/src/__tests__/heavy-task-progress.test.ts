import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildHeavyTaskProgressTools,
  createHeavyTaskProgressRecorder,
  heavyTaskInventorySubmitSchema,
  heavyTaskTodoUpdateSchema,
  renderHeavyTaskProgressForPrompt,
} from '../heavy-task-progress.js';
import type { HeavyTaskInventoryState, HeavyTaskTodoState } from '../task-contracts.js';
import { createInMemoryTaskRunStore } from '../task-run-store.js';

const toolContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd: '/workspace',
  toolCallId: 'tool-1',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};

describe('heavy-task progress tools', () => {
  test('inventory_submit records a typed inventory event and returns structured state', async () => {
    const store = createInMemoryTaskRunStore();
    const tools = buildHeavyTaskProgressTools(
      createHeavyTaskProgressRecorder({
        taskRunId: 'run-1',
        attemptId: 'attempt-1',
        store,
        now: () => 123,
        newId: idFactory(),
      }),
    );
    const inventorySubmit = tools.find((tool) => tool.name === 'inventory_submit');
    assert.ok(inventorySubmit);

    const result = (await inventorySubmit.impl(
      {
        summary: 'Inspected public source files.',
        items: [
          { path: 'src/app.js', kind: 'file', status: 'observed', purpose: 'main app entry' },
          { path: 'build-output.log', kind: 'artifact', status: 'planned' },
        ],
        openQuestions: ['Need to inspect README.md'],
      },
      toolContext,
    )) as { accepted: boolean; inventory: HeavyTaskInventoryState };

    assert.equal(result.accepted, true);
    assert.equal(result.inventory.taskRunId, 'run-1');
    assert.equal(result.inventory.source.toolCallId, 'tool-1');
    const events = await store.readEvents('run-1');
    assert.equal(events[0]?.type, 'heavy_task_inventory_recorded');
  });

  test('todo_update records a typed todo snapshot and rejects corrupt progress state', async () => {
    const store = createInMemoryTaskRunStore();
    const tools = buildHeavyTaskProgressTools(
      createHeavyTaskProgressRecorder({
        taskRunId: 'run-2',
        store,
        now: () => 456,
        newId: idFactory(),
      }),
    );
    const todoUpdate = tools.find((tool) => tool.name === 'todo_update');
    assert.ok(todoUpdate);

    const result = (await todoUpdate.impl(
      {
        items: [
          { id: 'inspect', content: 'Inspect public files', status: 'completed', priority: 'high' },
          {
            id: 'artifact',
            kind: 'runnable_artifact',
            content: 'Patch implementation',
            status: 'in_progress',
            priority: 'high',
          },
          {
            id: 'check',
            kind: 'public_check',
            content: 'Run public check',
            status: 'pending',
            priority: 'high',
          },
        ],
      },
      toolContext,
    )) as { accepted: boolean; todos: HeavyTaskTodoState };

    assert.equal(result.accepted, true);
    assert.equal(result.todos.items[1]?.status, 'in_progress');
    assert.equal(result.todos.items[1]?.kind, 'runnable_artifact');
    assert.equal(result.todos.items[2]?.kind, 'public_check');
    assert.throws(
      () =>
        heavyTaskTodoUpdateSchema.parse({
          items: [
            { id: 'same', content: 'First', status: 'pending', priority: 'medium' },
            { id: 'same', content: 'Second', status: 'pending', priority: 'low' },
          ],
        }),
      /duplicate todo id/,
    );
    assert.throws(
      () =>
        heavyTaskTodoUpdateSchema.parse({
          items: [
            { id: 'one', content: 'First', status: 'in_progress', priority: 'medium' },
            { id: 'two', content: 'Second', status: 'in_progress', priority: 'low' },
          ],
        }),
      /at most one todo item/,
    );
    assert.throws(() =>
      heavyTaskInventorySubmitSchema.parse({
        summary: 'x'.repeat(2_001),
        items: [],
      }),
    );
  });

  test('renders compact replay state for prompts', () => {
    const rendered = renderHeavyTaskProgressForPrompt({
      latestHeavyTaskInventory: {
        schemaVersion: 1,
        inventoryId: 'inventory-1',
        taskRunId: 'run-3',
        ts: 1,
        summary: 'Inspected source and README.',
        items: [{ path: 'README.md', kind: 'file', status: 'observed' }],
        source: { kind: 'model_tool', toolCallId: 'tool-1' },
      },
      latestHeavyTaskTodos: {
        schemaVersion: 1,
        todoSetId: 'todos-1',
        taskRunId: 'run-3',
        ts: 2,
        items: [
          {
            id: 'artifact',
            kind: 'runnable_artifact',
            content: 'Patch implementation',
            status: 'in_progress',
            priority: 'high',
          },
          {
            id: 'check',
            kind: 'public_check',
            content: 'Run public check',
            status: 'pending',
            priority: 'high',
          },
        ],
        source: { kind: 'model_tool', toolCallId: 'tool-2' },
      },
    });

    assert.match(rendered ?? '', /Heavy-task progress state/);
    assert.match(rendered ?? '', /README\.md/);
    assert.match(rendered ?? '', /Active todo: artifact/);
    assert.match(rendered ?? '', /runnable_artifact/);
    assert.match(rendered ?? '', /public_check/);
  });
});

function idFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}
