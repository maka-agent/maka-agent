import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlanReminderDue,
  nextPlanReminderStateAfterTrigger,
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
      runAt: now + 60_000,
    });
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

  it('detects due scheduled reminders and completes them after trigger', () => {
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
});
