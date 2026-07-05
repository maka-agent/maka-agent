import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TASK_LEDGER_MAX_TASKS, TASK_SUBJECT_MAX_CHARS } from '@maka/core/task-ledger';
import { createTaskLedgerStore } from '../task-ledger-store.js';

const SESSION_ID = 'sess-abc';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'maka-task-ledger-'));
}

function tasksFilePath(root: string): string {
  return join(root, 'sessions', SESSION_ID, 'tasks.json');
}

describe('TaskLedgerStore', () => {
  it('creates tasks with normalized subjects and pending status, returning created tasks and the new total', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);

    const { created, total } = await store.create(SESSION_ID, [{ subject: '  写测试 ' }, { subject: '实现功能' }]);
    assert.equal(created.length, 2);
    assert.equal(created[0]?.subject, '写测试');
    assert.equal(created[0]?.status, 'pending');
    assert.equal(typeof created[0]?.id, 'string');
    assert.equal(created[0]?.createdAt, created[0]?.updatedAt);
    assert.equal(total, 2);

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

  it('updates a task status and subject, returning the updated task and the new total', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const { created: [task], total: afterCreate } = await store.create(SESSION_ID, [{ subject: '原始' }, { subject: '其他' }]);
    assert.ok(task);
    assert.equal(afterCreate, 2);

    const { updated, total } = await store.update(SESSION_ID, task.id, { status: 'in_progress', subject: '改过' });
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.subject, '改过');
    assert.ok(updated.updatedAt >= task.updatedAt);
    assert.equal(updated.createdAt, task.createdAt);
    // total is the post-mutation count from inside the write queue; re-read the
    // ledger to verify the updated task landed and the file matches it.
    assert.equal(total, 2);
    const all = await store.list(SESSION_ID);
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

  it('re-applies subject normalization on read: discards overlong/blank/empty subjects and normalizes whitespace', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(tasksFilePath(root), JSON.stringify([
      { id: 'overlong', subject: 'X'.repeat(TASK_SUBJECT_MAX_CHARS + 1), status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'blank', subject: '   ', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'empty', subject: '', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'whitespace', subject: 'a\t\tb\n\nc   d', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'good', subject: '有效', status: 'pending', createdAt: 1, updatedAt: 1 },
    ]), 'utf8');
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    // overlong/blank/empty subjects are discarded per-record; good + whitespace survive.
    assert.equal(tasks.length, 2, `expected 2 surviving tasks, got ${tasks.length}: ${JSON.stringify(tasks.map((t) => t.id))}`);
    const ids = tasks.map((t) => t.id);
    assert.ok(ids.includes('good'));
    assert.ok(ids.includes('whitespace'));
    // whitespace subject is normalized (collapse + trim) on read.
    const ws = tasks.find((t) => t.id === 'whitespace');
    assert.equal(ws?.subject, 'a b c d', `expected normalized subject, got ${JSON.stringify(ws?.subject)}`);
  });

  it('treats an over-cap tasks.json as corrupt: list() rejects and mutate stays fail-closed', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    const overcap = Array.from({ length: TASK_LEDGER_MAX_TASKS + 1 }, (_, i) => ({
      id: `cap-${i}`, subject: `任务${i}`, status: 'pending', createdAt: i, updatedAt: i,
    }));
    await writeFile(tasksFilePath(root), JSON.stringify(overcap), 'utf8');
    const store = createTaskLedgerStore(root);
    // render path degrades to an empty list (readForRender try/catches the over-cap file)
    assert.deepEqual(await store.list(SESSION_ID), []);
    // mutate path stays fail-closed: a create must not silently truncate-and-overwrite the over-cap file
    await assert.rejects(() => store.create(SESSION_ID, [{ subject: '新任务' }]), /corrupt|limit|exceed/i);
    // the file is left untouched (not truncated)
    const raw = await readFile(tasksFilePath(root), 'utf8');
    assert.equal(JSON.parse(raw).length, TASK_LEDGER_MAX_TASKS + 1);
  });

  it('treats a tasks.json with duplicate ids as corrupt: render degrades to empty, mutate stays fail-closed', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(tasksFilePath(root), JSON.stringify([
      { id: 'dup-id', subject: 'first', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'dup-id', subject: 'second', status: 'pending', createdAt: 2, updatedAt: 2 },
      { id: 'uniq', subject: 'unique', status: 'pending', createdAt: 3, updatedAt: 3 },
    ]), 'utf8');
    const store = createTaskLedgerStore(root);
    // render path degrades to empty: no duplicate id reaches the turn tail
    // (two same-id tasks would be indistinguishable to the model).
    assert.deepEqual(await store.list(SESSION_ID), []);
    // mutate path stays fail-closed: an update must not silently keep both
    // dups and rewrite a "half-correct" file (first updated, second stale).
    await assert.rejects(() => store.update(SESSION_ID, 'dup-id', { status: 'completed' }), /corrupt|duplicate|ambiguous/i);
    const raw = await readFile(tasksFilePath(root), 'utf8');
    assert.equal(JSON.parse(raw).length, 3, 'file must be left untouched');
  });

  it('rejects non-finite timestamps (1e999 -> Infinity) so they cannot round-trip to null and vanish', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    // raw JSON with 1e999, which JSON.parse reads as Infinity; JSON.stringify of
    // Infinity is null, so writing via JSON.stringify could not reproduce this --
    // only a hand-edited or legacy file carries it.
    await writeFile(tasksFilePath(root),
      '[{"id":"good","subject":"ok","status":"pending","createdAt":1,"updatedAt":1},'
        + '{"id":"bad-ts","subject":"inf","status":"pending","createdAt":1e999,"updatedAt":1e999}]',
      'utf8');
    const store = createTaskLedgerStore(root);
    // read path drops the non-finite record (render degrades to the valid one)
    assert.deepEqual((await store.list(SESSION_ID)).map((t) => t.id), ['good']);
    // mutate path: a create must not round-trip the Infinity to null
    await store.create(SESSION_ID, [{ subject: 'after' }]);
    const raw = JSON.parse(await readFile(tasksFilePath(root), 'utf8')) as Array<{ createdAt: unknown; updatedAt: unknown }>;
    for (const r of raw) {
      assert.equal(Number.isFinite(r.createdAt), true, `createdAt must stay finite after mutate, got ${JSON.stringify(r)}`);
      assert.equal(Number.isFinite(r.updatedAt), true, `updatedAt must stay finite after mutate, got ${JSON.stringify(r)}`);
    }
  });

  it('rejects records with unsafe ids (newline, overlong, empty, whitespace) on read', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(tasksFilePath(root), JSON.stringify([
      { id: 'abc\nINJECTED', subject: '换行id', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'X'.repeat(5000), subject: '超长id', status: 'pending', createdAt: 2, updatedAt: 2 },
      { id: '', subject: '空id', status: 'pending', createdAt: 3, updatedAt: 3 },
      { id: 'has space', subject: '带空格id', status: 'pending', createdAt: 4, updatedAt: 4 },
      { id: 'good-id', subject: '正常', status: 'pending', createdAt: 5, updatedAt: 5 },
    ]), 'utf8');
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.equal(tasks.length, 1, `expected only the safe-id record to survive, got ${JSON.stringify(tasks.map((t) => t.id))}`);
    assert.equal(tasks[0]?.id, 'good-id');
  });

  it('rejects ids that are not redaction-stable tokens (tag-like, angle brackets, quotes, parens, secret-shaped); keeps UUID-shaped and simple ids', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(tasksFilePath(root), JSON.stringify([
      { id: 'a<task-ledger/>b', subject: 'tag-like', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: 'a>b', subject: 'gt', status: 'pending', createdAt: 2, updatedAt: 2 },
      { id: 'a"b', subject: 'quote', status: 'pending', createdAt: 3, updatedAt: 3 },
      { id: 'a(b)', subject: 'paren', status: 'pending', createdAt: 4, updatedAt: 4 },
      { id: 'a=b', subject: 'equals', status: 'pending', createdAt: 5, updatedAt: 5 },
      // secret-shaped stable tokens: pass the charset/length rules but redactSecrets
      // would render them as (id: [redacted]), so TaskUpdate on [redacted] would miss.
      { id: 'ghp_abcdefghijklmnopqrstuvwxyz', subject: 'ghp', status: 'pending', createdAt: 6, updatedAt: 6 },
      { id: 'sk-abcdefghi', subject: 'sk', status: 'pending', createdAt: 7, updatedAt: 7 },
      { id: 'a'.repeat(40), subject: 'hex40', status: 'pending', createdAt: 8, updatedAt: 8 },
      { id: 'AIza' + 'X'.repeat(24), subject: 'aiza', status: 'pending', createdAt: 9, updatedAt: 9 },
      { id: '123e4567-e89b-12d3-a456-426614174000', subject: 'uuid', status: 'pending', createdAt: 10, updatedAt: 10 },
      { id: 'good-id_1:2', subject: 'simple', status: 'pending', createdAt: 11, updatedAt: 11 },
    ]), 'utf8');
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    const ids = tasks.map((t) => t.id);
    // Only ids that are stable tokens AND survive redaction (so the rendered id
    // equals the stored id) survive; a TaskUpdate on the rendered id then hits.
    assert.deepEqual(ids, ['123e4567-e89b-12d3-a456-426614174000', 'good-id_1:2']);
  });

  it('rejects an oversized batch before generating tasks or writing (existing ledger unchanged)', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(SESSION_ID, [{ subject: 'seed' }]);
    const before = await readFile(tasksFilePath(root), 'utf8');
    // Oversized batch with an invalid draft in the middle: without an early
    // batch-size check, normalizeCreateTaskInput runs during `drafts.map` and
    // throws the per-draft subject error; with the early check, the batch is
    // rejected as a batch before any draft is touched or any id is generated.
    const batch = Array.from({ length: TASK_LEDGER_MAX_TASKS + 5 }, (_, i) =>
      i === 2 ? { subject: '' } : { subject: `任务${i}` });
    await assert.rejects(() => store.create(SESSION_ID, batch), /cap|limit|exceed|batch/i);
    const after = await readFile(tasksFilePath(root), 'utf8');
    assert.equal(after, before, 'existing ledger must be unchanged');
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

    // A single batch larger than the cap rejects at the front door (per-batch
    // cap, before generating ids), so the ledger stays empty.
    const freshStore = createTaskLedgerStore(await tempRoot());
    const oversizedBatch = Array.from({ length: TASK_LEDGER_MAX_TASKS + 1 }, (_, i) => ({ subject: `b${i}` }));
    await assert.rejects(() => freshStore.create(SESSION_ID, oversizedBatch), /per-batch cap/);
    assert.deepEqual(await freshStore.list(SESSION_ID), []);
  });
});
