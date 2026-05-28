import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlanReminderDue,
  nextPlanReminderStateAfterTrigger,
  nextPlanReminderRunAtAfter,
  normalizeCreatePlanReminderInput,
  normalizePlanReminderDeliveryTarget,
  normalizeUpdatePlanReminderInput,
  PLAN_REMINDER_RUN_HISTORY_LIMIT,
  type PlanReminder,
} from '../plan-reminders.js';

describe('plan reminder contract', () => {
  const now = 1_700_000_000_000;

  it('normalizes create input for explicit future one-shot reminders', () => {
    const result = normalizeCreatePlanReminderInput({
      title: '  复盘   周报  ',
      note: '  带上本周 blocker  ',
      runAt: now + 60_000,
    }, now);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      title: '复盘 周报',
      note: '带上本周 blocker',
      schedule: { kind: 'once', runAt: now + 60_000 },
      delivery: { channel: 'local' },
      nextRunAt: now + 60_000,
    });
  });

  it('normalizes recurring reminders using a closed recurrence enum', () => {
    const result = normalizeCreatePlanReminderInput({
      title: '每日复盘',
      runAt: now + 60_000,
      recurrence: 'daily',
    }, now);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.schedule, {
      kind: 'recurring',
      startAt: now + 60_000,
      recurrence: 'daily',
    });
    assert.equal(normalizeCreatePlanReminderInput({ title: 'x', runAt: now + 1, recurrence: 'hourly' }, now).ok, false);
  });

  it('normalizes bot delivery with a closed platform and sanitized chat id', () => {
    const result = normalizeCreatePlanReminderInput({
      title: '站会',
      runAt: now + 60_000,
      delivery: { channel: 'bot', platform: 'telegram', chatId: ' 123\u0000\u200B456 ' },
    }, now);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.delivery, { channel: 'bot', platform: 'telegram', chatId: '123 456' });
  });

  it('rejects unsupported delivery targets instead of silently falling back', () => {
    assert.equal(normalizePlanReminderDeliveryTarget({ channel: 'email', address: 'x' }).ok, false);
    assert.equal(normalizePlanReminderDeliveryTarget({ channel: 'bot', platform: 'mastodon', chatId: '1' }).ok, false);
    assert.equal(normalizePlanReminderDeliveryTarget({ channel: 'bot', platform: 'telegram', chatId: ' ' }).ok, false);
  });

  it('rejects empty title and past runAt instead of silently defaulting', () => {
    assert.equal(normalizeCreatePlanReminderInput({ title: ' ', runAt: now + 1 }, now).ok, false);
    const past = normalizeCreatePlanReminderInput({ title: '站会', runAt: now - 1 }, now);
    assert.equal(past.ok, false);
    if (past.ok) return;
    assert.equal(past.reason, 'invalid_run_at');
  });

  it('normalizes update patches without requiring every field', () => {
    const result = normalizeUpdatePlanReminderInput({ enabled: false }, now);
    assert.deepEqual(result, { ok: true, value: { enabled: false } });
  });

  it('detects due scheduled reminders and completes one-shot reminders after trigger', () => {
    const reminder: PlanReminder = {
      id: 'r1',
      title: '站会',
      note: '',
      schedule: { kind: 'once', runAt: now },
      delivery: { channel: 'local' },
      status: 'scheduled',
      enabled: true,
      createdAt: now - 1000,
      updatedAt: now - 1000,
      nextRunAt: now,
      runs: [],
      runCount: 0,
    };
    assert.equal(isPlanReminderDue(reminder, now), true);
    const next = nextPlanReminderStateAfterTrigger(reminder, {
      id: 'run1',
      at: now,
      status: 'triggered',
      message: '提醒已触发',
    });
    assert.equal(next.status, 'completed');
    assert.equal(next.enabled, false);
    assert.equal(next.nextRunAt, undefined);
    assert.equal(next.runCount, 1);
    assert.equal(next.lastRun?.status, 'triggered');
    assert.deepEqual(next.runs.map((run) => run.id), ['run1']);
  });

  it('keeps recurring reminders scheduled after each trigger', () => {
    const reminder: PlanReminder = {
      id: 'r2',
      title: '每日站会',
      note: '',
      schedule: { kind: 'recurring', startAt: now, recurrence: 'daily' },
      delivery: { channel: 'local' },
      status: 'scheduled',
      enabled: true,
      createdAt: now - 1000,
      updatedAt: now - 1000,
      nextRunAt: now,
      runs: [],
      runCount: 0,
    };
    const next = nextPlanReminderStateAfterTrigger(reminder, {
      id: 'run1',
      at: now,
      status: 'triggered',
      message: '提醒已触发',
    });
    assert.equal(next.status, 'scheduled');
    assert.equal(next.enabled, true);
    assert.equal(next.nextRunAt, now + 24 * 60 * 60 * 1000);
    assert.equal(next.runCount, 1);
    assert.deepEqual(next.runs.map((run) => run.id), ['run1']);
  });

  it('keeps newest run history capped for recurring reminders', () => {
    let reminder: PlanReminder = {
      id: 'r3',
      title: '每日站会',
      note: '',
      schedule: { kind: 'recurring', startAt: now, recurrence: 'daily' },
      delivery: { channel: 'local' },
      status: 'scheduled',
      enabled: true,
      createdAt: now - 1000,
      updatedAt: now - 1000,
      nextRunAt: now,
      runs: [],
      runCount: 0,
    };

    for (let i = 0; i < PLAN_REMINDER_RUN_HISTORY_LIMIT + 2; i += 1) {
      reminder = nextPlanReminderStateAfterTrigger(reminder, {
        id: `run-${i}`,
        at: now + i * 24 * 60 * 60 * 1000,
        status: 'triggered',
        message: '提醒已触发',
      });
    }

    assert.equal(reminder.runs.length, PLAN_REMINDER_RUN_HISTORY_LIMIT);
    assert.equal(reminder.runs[0]?.id, `run-${PLAN_REMINDER_RUN_HISTORY_LIMIT + 1}`);
    assert.equal(reminder.runs.at(-1)?.id, 'run-2');
  });

  it('computes monthly recurrence by clamping impossible month days', () => {
    const jan31 = new Date(2026, 0, 31, 9, 0, 0, 0).getTime();
    const feb28 = new Date(2026, 1, 28, 9, 0, 0, 0).getTime();
    assert.equal(
      nextPlanReminderRunAtAfter({ kind: 'recurring', startAt: jan31, recurrence: 'monthly' }, jan31),
      feb28,
    );
  });
});
