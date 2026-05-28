import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPlanReminderStore } from '../plan-reminder-store.js';

describe('PlanReminderStore', () => {
  it('persists reminders and exposes due reminders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;

    const reminder = await store.create({ title: '  站会提醒 ', note: '准备昨天的 blocker', runAt });
    assert.equal(reminder.title, '站会提醒');
    assert.equal(reminder.enabled, true);
    assert.equal(reminder.nextRunAt, runAt);

    const reloaded = createPlanReminderStore(root);
    assert.equal((await reloaded.list()).length, 1);
    assert.equal((await reloaded.listDue(runAt - 1)).length, 0);
    assert.equal((await reloaded.listDue(runAt)).length, 1);

    const raw = JSON.parse(await readFile(join(root, 'plan-reminders.json'), 'utf8')) as unknown[];
    assert.equal(raw.length, 1);
  });

  it('supports pause, resume, delete, and triggered run records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;
    const reminder = await store.create({ title: '复盘', runAt });

    const paused = await store.setEnabled(reminder.id, false);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.nextRunAt, undefined);

    const resumed = await store.setEnabled(reminder.id, true);
    assert.equal(resumed.status, 'scheduled');
    assert.equal(resumed.nextRunAt, runAt);

    const triggered = await store.markTriggered(reminder.id, {
      at: runAt,
      status: 'triggered',
      message: '提醒已触发',
    });
    assert.equal(triggered.status, 'completed');
    assert.equal(triggered.lastRun?.status, 'triggered');
    assert.equal(triggered.runCount, 1);

    await store.remove(reminder.id);
    assert.equal((await store.list()).length, 0);
  });

  it('lists active reminders before paused reminders and completed history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const base = Date.now() + 60_000;

    const completed = await store.create({ title: '已触发', runAt: base + 30_000 });
    const paused = await store.create({ title: '暂停中', runAt: base + 20_000 });
    const scheduled = await store.create({ title: '待触发', runAt: base + 10_000 });

    await store.markTriggered(completed.id, {
      at: base + 30_000,
      status: 'triggered',
      message: '提醒已触发',
    });
    await store.setEnabled(paused.id, false);

    assert.deepEqual((await store.list()).map((reminder) => reminder.title), [
      '待触发',
      '暂停中',
      '已触发',
    ]);
  });

  it('rejects invalid creates before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);

    await assert.rejects(
      () => store.create({ title: '', runAt: Date.now() + 1000 }),
      /title cannot be empty/,
    );
    assert.equal((await store.list()).length, 0);
  });
});
