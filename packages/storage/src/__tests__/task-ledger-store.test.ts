import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TASK_LEDGER_MAX_TASKS } from '@maka/core/task-ledger';
import { createTaskLedgerStore } from '../task-ledger-store.js';

const SESSION_ID = 'sess-abc';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'maka-task-ledger-'));
}

function tasksFilePath(root: string): string {
  return join(root, 'sessions', SESSION_ID, 'tasks.json');
}

describe('TaskLedgerStore', () => {
  it('creates tasks with normalized subjects and pending status, returning the full ledger', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);

    const { created, all } = await store.create(SESSION_ID, [{ subject: '  写测试 ' }, { subject: '实现功能' }]);
    assert.equal(created.length, 2);
    assert.equal(created[0]?.subject, '写测试');
    assert.equal(created[0]?.status, 'pending');
    assert.equal(typeof created[0]?.id, 'string');
    assert.equal(created[0]?.createdAt, created[0]?.updatedAt);
    assert.deepEqual(all, created);

    const reloaded = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.equal(reloaded.length, 2);
    assert.deepEqual(reloaded.map((t) => t.subject), ['写测试', '实现功能']);

    const raw = JSON.parse(await readFile(tasksFilePath(root), 'utf8')) as unknown[];
    assert.equal(raw.length, 2);
  });

  it('lists an empty ledger when the file does not exist', async () => {
    const root = await tempRoot();
    assert.deepEqual(await createTaskLedgerStore(root).list(SESSION_ID), []);
  });

  it('updates a task status and subject, returning the updated task and full ledger', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const { created: [task], all: afterCreate } = await store.create(SESSION_ID, [{ subject: '原始' }, { subject: '其他' }]);
    assert.ok(task);
    assert.equal(afterCreate.length, 2);

    const { updated, all } = await store.update(SESSION_ID, task.id, { status: 'in_progress', subject: '改过' });
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.subject, '改过');
    assert.ok(updated.updatedAt >= task.updatedAt);
    assert.equal(updated.createdAt, task.createdAt);
    // `all` is the post-mutation ledger computed inside the write queue.
    assert.equal(all.length, 2);
    assert.deepEqual(all.find((t) => t.id === task.id), updated);

    const reloaded = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.deepEqual(reloaded, all);
  });

  it('rejects an unknown task id, an empty patch, an invalid status, and empty create drafts', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const { created: [task] } = await store.create(SESSION_ID, [{ subject: 'x' }]);
    assert.ok(task);

    await assert.rejects(() => store.update(SESSION_ID, 'no-such-id', { status: 'completed' }), /No such task/);
    await assert.rejects(() => store.update(SESSION_ID, task.id, {}), /at least one/);
    await assert.rejects(() => store.update(SESSION_ID, task.id, { status: 'bogus' }), /Task status/);
    await assert.rejects(() => store.create(SESSION_ID, []), /at least one/);
    await assert.rejects(() => store.create(SESSION_ID, [{ subject: '   ' }]), /empty/);
  });

  it('does not rewrite the file when the update target does not exist', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(SESSION_ID, [{ subject: 'x' }]);
    const before = await readFile(tasksFilePath(root), 'utf8');

    await assert.rejects(() => store.update(SESSION_ID, 'no-such-id', { status: 'completed' }), /No such task/);

    const after = await readFile(tasksFilePath(root), 'utf8');
    assert.equal(after, before);
  });

  it('degrades a corrupt ledger to an empty list on the render path', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(tasksFilePath(root), 'not json at all', 'utf8');
    assert.deepEqual(await createTaskLedgerStore(root).list(SESSION_ID), []);
  });

  it('refuses to mutate over a corrupt ledger and leaves the file untouched', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    const store = createTaskLedgerStore(root);

    for (const corrupt of ['not json at all', '{"not":"an array"}']) {
      await writeFile(tasksFilePath(root), corrupt, 'utf8');
      await assert.rejects(
        () => store.create(SESSION_ID, [{ subject: '新任务' }]),
        /corrupt; refusing to overwrite/,
      );
      await assert.rejects(
        () => store.update(SESSION_ID, 'any-id', { status: 'completed' }),
        /corrupt; refusing to overwrite/,
      );
      // The mutation must not have replaced the damaged file with fn([]).
      assert.equal(await readFile(tasksFilePath(root), 'utf8'), corrupt);
      // The render path still degrades to empty so turns are not wedged.
      assert.deepEqual(await store.list(SESSION_ID), []);
    }
  });

  it('drops malformed entries while keeping valid ones', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(tasksFilePath(root), JSON.stringify([
      { id: 'good', subject: '有效', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'bad-status', subject: 'x', status: 'nope', createdAt: 1, updatedAt: 1 },
      { subject: 'no id', status: 'pending', createdAt: 1, updatedAt: 1 },
      'garbage',
    ]), 'utf8');
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.id, 'good');
  });

  it('rejects an unsafe session id', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await assert.rejects(() => store.list('../escape'), /Invalid session id/);
  });

  it('serializes concurrent creates without losing writes', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await Promise.all([
      store.create(SESSION_ID, [{ subject: 'a' }]),
      store.create(SESSION_ID, [{ subject: 'b' }]),
      store.create(SESSION_ID, [{ subject: 'c' }]),
    ]);
    const tasks = await store.list(SESSION_ID);
    assert.equal(tasks.length, 3);
    assert.deepEqual(new Set(tasks.map((t) => t.subject)), new Set(['a', 'b', 'c']));
  });

  it('enforces the total-task cap inside the write queue without touching the file', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const fill = Array.from({ length: TASK_LEDGER_MAX_TASKS }, (_, i) => ({ subject: `t${i}` }));
    await store.create(SESSION_ID, fill);

    // Over-cap create must reject with a clear total-count message...
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: 'overflow' }]),
      new RegExp(`limited to ${TASK_LEDGER_MAX_TASKS} tasks total`),
    );

    // ...and must not have written anything: the ledger is unchanged.
    const tasks = await store.list(SESSION_ID);
    assert.equal(tasks.length, TASK_LEDGER_MAX_TASKS);
    assert.equal(tasks.some((t) => t.subject === 'overflow'), false);

    // Completing tasks does not free capacity: the cap is on total count.
    const first = tasks[0];
    assert.ok(first);
    await store.update(SESSION_ID, first.id, { status: 'completed' });
    await assert.rejects(() => store.create(SESSION_ID, [{ subject: 'still-over' }]), /hard runaway guard/);

    // A single batch larger than the cap rejects too.
    const freshStore = createTaskLedgerStore(await tempRoot());
    const oversizedBatch = Array.from({ length: TASK_LEDGER_MAX_TASKS + 1 }, (_, i) => ({ subject: `b${i}` }));
    await assert.rejects(() => freshStore.create(SESSION_ID, oversizedBatch), /limited to/);
    assert.deepEqual(await freshStore.list(SESSION_ID), []);
  });
});
