import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlanReminderDue,
  nextPlanReminderStateAfterTrigger,
  nextPlanReminderRunAtAfter,
  normalizeCreatePlanReminderInput,
  normalizeUpdatePlanReminderInput,
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
      status: 'scheduled',
      enabled: true,
      createdAt: now - 1000,
      updatedAt: now - 1000,
      nextRunAt: now,
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
  });

  it('keeps recurring reminders scheduled after each trigger', () => {
    const reminder: PlanReminder = {
      id: 'r2',
      title: '每日站会',
      note: '',
      schedule: { kind: 'recurring', startAt: now, recurrence: 'daily' },
      status: 'scheduled',
      enabled: true,
      createdAt: now - 1000,
      updatedAt: now - 1000,
      nextRunAt: now,
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
