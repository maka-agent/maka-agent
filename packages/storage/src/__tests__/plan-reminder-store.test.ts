import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    assert.deepEqual(reminder.delivery, { channel: 'local' });
    assert.deepEqual(reminder.runs, []);

    const reloaded = createPlanReminderStore(root);
    assert.equal((await reloaded.list()).length, 1);
    assert.equal((await reloaded.listDue(runAt - 1)).length, 0);
    assert.equal((await reloaded.listDue(runAt)).length, 1);

    const raw = JSON.parse(await readFile(join(root, 'plan-reminders.json'), 'utf8')) as unknown[];
    assert.equal(raw.length, 1);
  });

  it('persists bot delivery and defaults legacy records to local delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;

    const reminder = await store.create({
      title: '投递到 Telegram',
      runAt,
      delivery: { channel: 'bot', platform: 'telegram', chatId: ' 12345 ' },
    });
    assert.deepEqual(reminder.delivery, { channel: 'bot', platform: 'telegram', chatId: '12345' });

    const raw = JSON.parse(await readFile(join(root, 'plan-reminders.json'), 'utf8')) as unknown[];
    assert.deepEqual((raw[0] as { delivery?: unknown }).delivery, { channel: 'bot', platform: 'telegram', chatId: '12345' });

    await writeFile(join(root, 'plan-reminders.json'), JSON.stringify([{
      id: 'legacy',
      title: '旧提醒',
      note: '',
      schedule: { kind: 'once', runAt },
      status: 'scheduled',
      enabled: true,
      createdAt: runAt - 1000,
      updatedAt: runAt - 1000,
      nextRunAt: runAt,
      runs: [],
      runCount: 0,
    }]), 'utf8');

    const reloaded = await createPlanReminderStore(root).list();
    assert.deepEqual(reloaded[0]?.delivery, { channel: 'local' });
  });

  it('keeps recurring reminders active after a trigger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;

    const reminder = await store.create({ title: '每日复盘', runAt, recurrence: 'daily' });
    assert.equal(reminder.schedule.kind, 'recurring');
    assert.equal(reminder.nextRunAt, runAt);

    const triggered = await store.markTriggered(reminder.id, {
      at: runAt,
      status: 'triggered',
      message: '提醒已触发',
    });
    assert.equal(triggered.status, 'scheduled');
    assert.equal(triggered.enabled, true);
    assert.equal(triggered.nextRunAt, runAt + 24 * 60 * 60 * 1000);
    assert.deepEqual(triggered.runs.map((run) => run.status), ['triggered']);
    assert.equal((await store.listDue(runAt + 1)).length, 0);
    assert.equal((await store.listDue(runAt + 24 * 60 * 60 * 1000)).length, 1);
  });

  it('keeps cron reminders active and persists their expression', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;

    const reminder = await store.create({
      title: '工作日早报',
      runAt,
      recurrence: 'cron',
      cronExpression: '30 9 * * 1-5',
    });
    assert.deepEqual(reminder.schedule, { kind: 'cron', startAt: runAt, expression: '30 9 * * 1-5' });
    assert.equal(typeof reminder.nextRunAt, 'number');

    const triggered = await store.markTriggered(reminder.id, {
      at: reminder.nextRunAt!,
      status: 'triggered',
      message: '提醒已触发',
    });
    assert.equal(triggered.status, 'scheduled');
    assert.equal(triggered.enabled, true);
    assert.equal(triggered.schedule.kind, 'cron');
    assert.equal(typeof triggered.nextRunAt, 'number');
    assert.ok(triggered.nextRunAt! > reminder.nextRunAt!);
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
    assert.deepEqual(triggered.runs.map((run) => run.id), [triggered.lastRun?.id]);
    assert.equal(triggered.runCount, 1);

    await store.remove(reminder.id);
    assert.equal((await store.list()).length, 0);
  });

  it('snoozes scheduled reminders without changing the recurrence contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;
    const reminder = await store.create({ title: '工作日早报', runAt, recurrence: 'cron', cronExpression: '0 9 * * 1-5' });

    const snoozed = await store.snooze(reminder.id, 10 * 60 * 1000, runAt - 30_000);
    assert.equal(snoozed.status, 'scheduled');
    assert.equal(snoozed.enabled, true);
    assert.equal(snoozed.schedule.kind, 'cron');
    assert.equal(snoozed.nextRunAt, Math.max(runAt - 30_000, reminder.nextRunAt!) + 10 * 60 * 1000);
    assert.equal(snoozed.runs.length, 0);
  });

  it('updates title, schedule, recurrence, delivery, and note through the edit path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;
    const reminder = await store.create({ title: '旧标题', note: '旧备注', runAt });
    const nextRunAt = runAt + 60_000;

    const updated = await store.update(reminder.id, {
      title: '新标题',
      note: '',
      runAt: nextRunAt,
      recurrence: 'weekly',
      delivery: { channel: 'bot', platform: 'telegram', chatId: ' 42 ' },
    });

    assert.equal(updated.title, '新标题');
    assert.equal(updated.note, '');
    assert.deepEqual(updated.schedule, { kind: 'recurring', startAt: nextRunAt, recurrence: 'weekly' });
    assert.deepEqual(updated.delivery, { channel: 'bot', platform: 'telegram', chatId: '42' });
    assert.equal(updated.status, 'scheduled');
    assert.equal(updated.nextRunAt, nextRunAt);
  });

  it('resumes paused recurring reminders at the next future occurrence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;
    const reminder = await store.create({ title: '每周同步', runAt, recurrence: 'weekly' });
    await store.setEnabled(reminder.id, false);

    const resumed = await store.setEnabled(reminder.id, true);
    assert.equal(resumed.status, 'scheduled');
    assert.equal(resumed.schedule.kind, 'recurring');
    assert.equal(resumed.nextRunAt, runAt);
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

  it('keeps recurring run history in newest-first order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-plan-reminders-'));
    const store = createPlanReminderStore(root);
    const runAt = Date.now() + 60_000;
    const reminder = await store.create({ title: '每日复盘', runAt, recurrence: 'daily' });

    const first = await store.markTriggered(reminder.id, {
      id: 'run-1',
      at: runAt,
      status: 'triggered',
      message: '第一次触发',
    });
    const second = await store.markBlocked(reminder.id, {
      id: 'run-2',
      at: runAt + 24 * 60 * 60 * 1000,
      message: '隐私模式已开启',
      blockReason: 'incognito_active',
    });

    assert.deepEqual(first.runs.map((run) => run.id), ['run-1']);
    assert.deepEqual(second.runs.map((run) => run.id), ['run-2', 'run-1']);
    assert.equal(second.lastRun?.id, 'run-2');
    assert.equal(second.runCount, 2);
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
