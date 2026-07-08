import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WakeupScheduler, computeNextCronRun, computeJitter, MAX_RECORDS_PER_SESSION } from '../wakeup-scheduler.js';

function createTestScheduler(overrides: Partial<ConstructorParameters<typeof WakeupScheduler>[0]> = {}) {
  const fired: Array<{ sessionId: string; turnId: string; text: string }> = [];
  const timers: Array<{ id: number; cb: () => void; ms: number; cleared: boolean }> = [];
  let nextId = 1;
  let mockNow = 1000000;

  const scheduler = new WakeupScheduler({
    newId: () => `id-${nextId++}`,
    now: () => mockNow,
    injectTurn: (sessionId, input) => { fired.push({ sessionId, ...input }); },
    canFire: async () => true,
    setTimer: (cb, ms) => {
      const timer = { id: timers.length + 1, cb, ms, cleared: false };
      timers.push(timer);
      return timer.id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => {
      const timer = timers.find(t => t.id === (id as unknown as number));
      if (timer) timer.cleared = true;
    },
    ...overrides,
  });

  return {
    scheduler,
    fired,
    timers,
    advanceTime: (ms: number) => { mockNow += ms; },
    fireNextTimer: async () => {
      const pending = timers.find(t => !t.cleared);
      if (pending) {
        pending.cleared = true;
        mockNow += pending.ms;
        pending.cb();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    },
  };
}

describe('WakeupScheduler', () => {
  test('schedule creates a pending record and sets a timer', () => {
    const { scheduler, timers } = createTestScheduler();
    const record = scheduler.schedule('session-1', {
      delaySeconds: 60,
      message: 'check status',
      reason: 'polling deployment',
    });
    assert.equal(record.status, 'pending');
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.message, 'check status');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 60000);
  });

  test('timer fire injects a turn with the message', async () => {
    const { scheduler, fired, fireNextTimer } = createTestScheduler();
    scheduler.schedule('session-1', { delaySeconds: 10, message: 'hello wakeup', reason: 'test' });
    await fireNextTimer();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].sessionId, 'session-1');
    assert.ok(fired[0].text.includes('hello wakeup'));
  });

  test('fired non-recurring record stays listed as terminal history', async () => {
    const { scheduler, fireNextTimer } = createTestScheduler();
    const record = scheduler.schedule('session-1', { delaySeconds: 5, message: 'check', reason: 'test' });
    await fireNextTimer();
    assert.equal(record.status, 'fired');
    // Review fix: terminal records stay observable (capped by pruneSession)
    // so CronList can show what just fired.
    const records = scheduler.listForSession('session-1');
    assert.equal(records.length, 1, 'fired record should stay as terminal history');
    assert.equal(records[0]!.status, 'fired');
  });

  test('cancel prevents firing', () => {
    const { scheduler, fired, timers } = createTestScheduler();
    const record = scheduler.schedule('session-1', { delaySeconds: 30, message: 'should not fire', reason: 'test' });
    const cancelled = scheduler.cancel(record.id);
    assert.equal(cancelled, true);
    assert.ok(timers[0].cleared);
    assert.equal(fired.length, 0);
    assert.equal(scheduler.listForSession('session-1')[0].status, 'cancelled');
  });

  test('cancelAllForSession cancels all pending wakeups', () => {
    const { scheduler } = createTestScheduler();
    scheduler.schedule('session-1', { delaySeconds: 10, message: 'a', reason: 'test' });
    scheduler.schedule('session-1', { delaySeconds: 20, message: 'b', reason: 'test' });
    scheduler.schedule('session-2', { delaySeconds: 30, message: 'c', reason: 'test' });
    scheduler.cancelAllForSession('session-1');
    const s1 = scheduler.listForSession('session-1');
    const s2 = scheduler.listForSession('session-2');
    assert.ok(s1.every(r => r.status === 'cancelled'));
    assert.equal(s2[0].status, 'pending');
  });

  test('rejects more than 5 pending wakeups per session', () => {
    const { scheduler } = createTestScheduler();
    for (let i = 0; i < 5; i++) {
      scheduler.schedule('session-1', { delaySeconds: 10, message: `m${i}`, reason: 'test' });
    }
    assert.throws(
      () => scheduler.schedule('session-1', { delaySeconds: 10, message: 'overflow', reason: 'test' }),
      /Max 5 pending wakeups/,
    );
  });

  test('rejects delay out of range', () => {
    const { scheduler } = createTestScheduler();
    assert.throws(() => scheduler.schedule('s', { delaySeconds: 0, message: 'm', reason: 'r' }), /delay_seconds/);
    assert.throws(() => scheduler.schedule('s', { delaySeconds: 100000, message: 'm', reason: 'r' }), /delay_seconds/);
  });

  test('delaySeconds=1 (minimum boundary) succeeds', () => {
    const { scheduler, timers } = createTestScheduler();
    const record = scheduler.schedule('session-1', { delaySeconds: 1, message: 'boundary', reason: 'test' });
    assert.equal(record.status, 'pending');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 1000);
  });

  test('rejects when both cronExpression and delaySeconds are provided', () => {
    const { scheduler } = createTestScheduler();
    assert.throws(
      () => scheduler.schedule('s', { cronExpression: '* * * * *', delaySeconds: 60, message: 'm', reason: 'r' }),
      /Provide cronExpression or delaySeconds, not both/,
    );
  });

  test('backs off and retries when canFire returns false', async () => {
    let canFireCount = 0;
    const { scheduler, fired, fireNextTimer } = createTestScheduler({
      canFire: async () => { canFireCount++; return canFireCount >= 3; },
    });
    scheduler.schedule('session-1', { delaySeconds: 5, message: 'retry-test', reason: 'test' });
    await fireNextTimer();
    assert.equal(fired.length, 0);
    await fireNextTimer();
    assert.equal(fired.length, 0);
    await fireNextTimer();
    assert.equal(fired.length, 1);
    assert.ok(fired[0].text.includes('retry-test'));
  });

  test('expires after max retries', async () => {
    const { scheduler, fired, fireNextTimer } = createTestScheduler({ canFire: async () => false });
    const record = scheduler.schedule('session-1', { delaySeconds: 5, message: 'expire-test', reason: 'test' });
    // Review fix: the idle-gate now retries 12 times with exponential
    // backoff (a 15s window silently dropped wakeups landing mid-turn);
    // drain the initial fire plus all 12 retries.
    for (let i = 0; i < 13; i++) {
      await fireNextTimer();
    }
    assert.equal(fired.length, 0);
    assert.equal(scheduler.listForSession('session-1').find(r => r.id === record.id)?.status, 'expired');
  });

  test('dispose clears all timers', () => {
    const { scheduler, timers } = createTestScheduler();
    scheduler.schedule('session-1', { delaySeconds: 10, message: 'a', reason: 'test' });
    scheduler.schedule('session-1', { delaySeconds: 20, message: 'b', reason: 'test' });
    scheduler.dispose();
    assert.ok(timers.every(t => t.cleared));
  });

  test('multiple sessions work independently', async () => {
    const { scheduler, fired, fireNextTimer } = createTestScheduler();
    scheduler.schedule('session-1', { delaySeconds: 5, message: 'msg-1', reason: 'test' });
    scheduler.schedule('session-2', { delaySeconds: 10, message: 'msg-2', reason: 'test' });
    await fireNextTimer();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].sessionId, 'session-1');
    await fireNextTimer();
    assert.equal(fired.length, 2);
    assert.equal(fired[1].sessionId, 'session-2');
  });

  // ─── Cron expression tests ──────────────────────────────────────────────────

  test('computeNextCronRun returns a future timestamp for valid expression', () => {
    // "every minute" should return 1 minute after the reference time
    const refMs = Date.now();
    const next = computeNextCronRun('* * * * *', refMs);
    assert.notEqual(next, null);
    assert.ok(next! > refMs, 'next run should be in the future');
    // Should be within 60 seconds of the reference
    assert.ok(next! - refMs <= 60_000, 'next run for * * * * * should be within 60s');
  });

  test('computeNextCronRun returns null for invalid expression', () => {
    assert.equal(computeNextCronRun('invalid', 1000000), null);
    assert.equal(computeNextCronRun('60 * * * *', 1000000), null); // minute out of range
    assert.equal(computeNextCronRun('* * * *', 1000000), null); // only 4 fields
  });

  test('schedule with cronExpression creates a pending record', () => {
    const { scheduler, timers } = createTestScheduler();
    const record = scheduler.schedule('session-1', {
      cronExpression: '* * * * *',
      message: 'cron check',
      reason: 'every minute',
    });
    assert.equal(record.status, 'pending');
    assert.equal(record.cronExpression, '* * * * *');
    assert.ok(record.firesAt > 1000000, 'firesAt should be in the future');
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms > 0, 'timer delay should be positive');
  });

  test('schedule rejects when neither delaySeconds nor cronExpression provided', () => {
    const { scheduler } = createTestScheduler();
    assert.throws(
      () => scheduler.schedule('s', { message: 'm', reason: 'r' }),
      /Either cronExpression or delaySeconds/,
    );
  });

  test('schedule rejects invalid cron expression', () => {
    const { scheduler } = createTestScheduler();
    assert.throws(
      () => scheduler.schedule('s', { cronExpression: 'bad bad bad', message: 'm', reason: 'r' }),
      /Invalid cron expression/,
    );
  });

  test('cron-based recurring job reschedules in-place after firing', async () => {
    const { scheduler, fired, fireNextTimer } = createTestScheduler();
    const record = scheduler.schedule('session-1', {
      cronExpression: '* * * * *',
      message: 'cron recurring',
      reason: 'every minute',
      recurring: true,
    });
    const originalId = record.id;
    await fireNextTimer();
    assert.equal(fired.length, 1);
    assert.ok(fired[0].text.includes('cron recurring'));
    // The same record should be reused in-place (no new record created)
    const pending = scheduler.listForSession('session-1').filter(r => r.status === 'pending');
    assert.equal(pending.length, 1, 'should have one pending record');
    assert.equal(pending[0].id, originalId, 'should reuse the same record id');
    assert.equal(pending[0].cronExpression, '* * * * *');
  });

  // ─── Auto-expire tests ─────────────────────────────────────────────────────

  test('recurring job expires after 7 days', async () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const { scheduler, fired, timers, advanceTime, fireNextTimer } = createTestScheduler();
    const record = scheduler.schedule('session-1', {
      delaySeconds: 60,
      message: 'long running',
      reason: 'test',
      recurring: true,
    });
    // Verify expiresAt is set
    assert.notEqual(record.expiresAt, null);
    assert.equal(record.expiresAt, record.scheduledAt + sevenDaysMs);

    // Advance time past the 7-day expiry before firing
    advanceTime(sevenDaysMs + 1000);
    await fireNextTimer();

    // The job should have expired, not fired
    assert.equal(fired.length, 0);
    const records = scheduler.listForSession('session-1');
    assert.equal(records.find(r => r.id === record.id)?.status, 'expired');
  });

  test('one-shot jobs have null expiresAt', () => {
    const { scheduler } = createTestScheduler();
    const record = scheduler.schedule('session-1', {
      delaySeconds: 60,
      message: 'one-shot',
      reason: 'test',
      recurring: false,
    });
    assert.equal(record.expiresAt, null);
  });

  // ─── Jitter tests ──────────────────────────────────────────────────────────

  test('computeJitter for recurring returns a value within bounds', () => {
    for (let i = 0; i < 50; i++) {
      const delayMs = 600_000; // 10 minutes
      const jitter = computeJitter(delayMs, true);
      // 10% of 600000 = 60000, which is < MAX_JITTER_MS (15 min = 900000)
      assert.ok(jitter >= 0, 'recurring jitter should be non-negative');
      assert.ok(jitter <= 60_000, 'recurring jitter should be <= 10% of delay');
    }
  });

  test('computeJitter for one-shot returns 0 when the fire time is off the round mark', () => {
    // Review fix: the round-mark property belongs to the fire TIMESTAMP,
    // not the delay. 10:07 + 30min = 10:37 → no early jitter.
    const firesAt = new Date(2026, 0, 1, 10, 37, 0, 0).getTime();
    const jitter = computeJitter(30 * 60 * 1000, false, Math.random, firesAt);
    assert.equal(jitter, 0);
    // Without a timestamp there is no round-mark evidence → no jitter.
    assert.equal(computeJitter(60_000, false), 0);
  });

  // ─── Idle-gate observability tests ─────────────────────────────────────────

  test('fireAttempts increments and deferredFires logs timestamps on idle rejection', async () => {
    let callCount = 0;
    const { scheduler, fireNextTimer } = createTestScheduler({
      canFire: async () => { callCount++; return callCount >= 2; },
    });
    const record = scheduler.schedule('session-1', {
      delaySeconds: 5,
      message: 'idle-gate test',
      reason: 'test',
    });
    // First fire attempt: rejected
    await fireNextTimer();
    // Record is still pending (not yet fired), so it remains in the scheduler
    assert.equal(record.fireAttempts, 1);
    assert.equal(record.deferredFires.length, 1);
    // Second fire attempt: succeeds
    await fireNextTimer();
    // After successful fire, the non-recurring record is removed from the map
    // but the object reference still has the final state
    assert.equal(record.fireAttempts, 2);
    assert.equal(record.status, 'fired');
    // deferredFires should still have 1 entry (only logged on rejection)
    assert.equal(record.deferredFires.length, 1);
  });

  // ─── Cancel edge-case tests ────────────────────────────────────────────────

  test('cancel returns false when the wakeup has already fired', async () => {
    const { scheduler, fireNextTimer } = createTestScheduler();
    const record = scheduler.schedule('session-1', { delaySeconds: 5, message: 'fire-first', reason: 'test' });
    await fireNextTimer();
    assert.equal(record.status, 'fired');
    const result = scheduler.cancel(record.id);
    assert.equal(result, false);
    assert.equal(record.status, 'fired');
  });

  test('cancel returns false on second call (already cancelled)', () => {
    const { scheduler } = createTestScheduler();
    const record = scheduler.schedule('session-1', { delaySeconds: 30, message: 'cancel-twice', reason: 'test' });
    const first = scheduler.cancel(record.id);
    assert.equal(first, true);
    assert.equal(record.status, 'cancelled');
    const second = scheduler.cancel(record.id);
    assert.equal(second, false);
    assert.equal(record.status, 'cancelled');
  });

  // ─── Race condition: cancel during canFire await ───────────────────────────

  test('cancel during canFire await prevents firing', async () => {
    let canFireResolve: (value: boolean) => void;
    const { scheduler, fired, fireNextTimer } = createTestScheduler({
      canFire: () => new Promise<boolean>((resolve) => { canFireResolve = resolve; }),
    });
    const record = scheduler.schedule('session-1', { delaySeconds: 5, message: 'race', reason: 'test' });

    // Fire the timer -- this starts the async canFire call
    const firePromise = fireNextTimer();

    // While canFire is in-flight, cancel the wakeup
    scheduler.cancel(record.id);
    assert.equal(record.status, 'cancelled');

    // Now resolve canFire -- fire() should see the cancelled status and bail
    canFireResolve!(true);
    await firePromise;

    assert.equal(fired.length, 0, 'cancelled wakeup should not have fired');
    assert.equal(record.status, 'cancelled');
  });

  // ─── One-shot jitter on 30-minute-aligned delays ──────────────────────────

  test('computeJitter for one-shot firing on a :00/:30 minute returns negative value in bounds', () => {
    for (let i = 0; i < 50; i++) {
      const firesAt = new Date(2026, 0, 1, 11, i % 2 === 0 ? 0 : 30, 0, 0).getTime();
      const jitter = computeJitter(17 * 60 * 1000, false, Math.random, firesAt);
      assert.ok(jitter <= 0, `one-shot jitter should be <= 0, got ${jitter}`);
      assert.ok(jitter >= -90_000, `one-shot jitter should be >= -90000, got ${jitter}`);
    }
  });

  // ─── Record accumulation prevention tests ─────────────────────────────────

  test('fired non-recurring job stays observable as a terminal record', async () => {
    // Review fix: fired one-shots used to be deleted immediately, making
    // the 'fired' status unreachable and CronList unable to show what just
    // happened. Terminal records stay (pruneSession caps the history).
    const { scheduler, fired, fireNextTimer } = createTestScheduler();
    scheduler.schedule('session-1', { delaySeconds: 5, message: 'one-shot', reason: 'test' });
    await fireNextTimer();
    assert.equal(fired.length, 1);
    const records = scheduler.listForSession('session-1');
    assert.equal(records.length, 1, 'fired one-shot should stay as a terminal record');
    assert.equal(records[0]!.status, 'fired');
    assert.equal(scheduler.listForSession('session-1', { activeOnly: true }).length, 0);
  });

  test('recurring job does not duplicate records on fire', async () => {
    const { scheduler, fired, fireNextTimer } = createTestScheduler();
    scheduler.schedule('session-1', {
      delaySeconds: 60,
      message: 'recurring-check',
      reason: 'test',
      recurring: true,
    });
    // Fire multiple times
    await fireNextTimer();
    await fireNextTimer();
    await fireNextTimer();
    assert.equal(fired.length, 3, 'should have fired 3 times');
    // Only ONE record should exist (reused in-place)
    const records = scheduler.listForSession('session-1');
    assert.equal(records.length, 1, 'should have exactly one record for recurring job');
    assert.equal(records[0].status, 'pending', 'record should be pending for next fire');
  });

  test('max records cap is enforced', () => {
    const { scheduler } = createTestScheduler();
    // Create many records that exceed the cap by scheduling and cancelling
    for (let i = 0; i < MAX_RECORDS_PER_SESSION + 10; i++) {
      const rec = scheduler.schedule('session-1', {
        delaySeconds: 60,
        message: `job-${i}`,
        reason: 'test',
      });
      scheduler.cancel(rec.id);
    }
    // All records are cancelled (terminal), schedule() should prune
    // Schedule one more to trigger pruning
    scheduler.schedule('session-1', { delaySeconds: 60, message: 'final', reason: 'test' });
    const records = scheduler.listForSession('session-1');
    assert.ok(records.length <= MAX_RECORDS_PER_SESSION, `records (${records.length}) should not exceed cap (${MAX_RECORDS_PER_SESSION})`);
  });

  test('listForSession with activeOnly only returns pending records', async () => {
    const { scheduler, fireNextTimer } = createTestScheduler();
    scheduler.schedule('session-1', { delaySeconds: 5, message: 'will-fire', reason: 'test', recurring: true });
    const cancelMe = scheduler.schedule('session-1', { delaySeconds: 30, message: 'will-cancel', reason: 'test' });
    scheduler.cancel(cancelMe.id);
    // Fire the recurring job once (it stays as pending for next)
    await fireNextTimer();
    // Now we have: 1 pending (recurring, re-scheduled) + 1 cancelled
    const all = scheduler.listForSession('session-1');
    const active = scheduler.listForSession('session-1', { activeOnly: true });
    assert.equal(all.length, 2, 'all records includes cancelled');
    assert.equal(active.length, 1, 'activeOnly returns only pending');
    assert.equal(active[0].status, 'pending');
  });
});
