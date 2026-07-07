import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationManager, computeNextCronFire, matchesCronField } from '../automation-state.js';
import type { AutomationSchedule } from '../automation-state.js';

let idCounter = 0;
function createManager() {
  idCounter = 0;
  return new AutomationManager({
    generateId: () => `auto-${++idCounter}`,
    now: () => 1700000000000,
  });
}

describe('AutomationManager', () => {
  describe('create', () => {
    test('creates a heartbeat automation', () => {
      const mgr = createManager();
      const result = mgr.create({
        kind: 'heartbeat',
        name: 'check deploy',
        prompt: 'Run deploy check',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 30 },
      });
      assert.ok(!('error' in result));
      assert.equal(result.id, 'auto-1');
      assert.equal(result.kind, 'heartbeat');
      assert.equal(result.status, 'active');
      assert.equal(result.fireCount, 0);
      assert.ok(result.nextFireAt);
    });

    test('creates a cron automation', () => {
      const mgr = createManager();
      const result = mgr.create({
        kind: 'cron',
        name: 'daily review',
        prompt: 'Review PRs',
        sessionId: 'sess-1',
        schedule: { type: 'cron', expression: '0 9 * * 1-5' },
      });
      assert.ok(!('error' in result));
      assert.equal(result.kind, 'cron');
    });

    test('creates a one-shot automation', () => {
      const mgr = createManager();
      const result = mgr.create({
        kind: 'heartbeat',
        name: 'remind me',
        prompt: 'Check the thing',
        sessionId: 'sess-1',
        schedule: { type: 'once', delaySeconds: 300 },
      });
      assert.ok(!('error' in result));
      assert.equal(result.schedule.type, 'once');
    });

    test('rejects when max automations reached', () => {
      const mgr = createManager();
      for (let i = 0; i < 20; i++) {
        mgr.create({
          kind: 'heartbeat',
          name: `auto-${i}`,
          prompt: 'test',
          sessionId: 'sess-1',
          schedule: { type: 'interval', seconds: 60 },
        });
      }
      const result = mgr.create({
        kind: 'heartbeat',
        name: 'overflow',
        prompt: 'test',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok('error' in result);
      assert.ok(result.error.includes('Maximum'));
    });

    test('different sessions have independent limits', () => {
      const mgr = createManager();
      for (let i = 0; i < 20; i++) {
        mgr.create({
          kind: 'heartbeat',
          name: `auto-${i}`,
          prompt: 'test',
          sessionId: 'sess-1',
          schedule: { type: 'interval', seconds: 60 },
        });
      }
      const result = mgr.create({
        kind: 'heartbeat',
        name: 'another session',
        prompt: 'test',
        sessionId: 'sess-2',
        schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in result));
    });

    test('respects maxFires', () => {
      const mgr = createManager();
      const result = mgr.create({
        kind: 'heartbeat',
        name: 'limited',
        prompt: 'test',
        sessionId: 'sess-1',
        schedule: { type: 'interval', seconds: 60 },
        maxFires: 3,
      });
      assert.ok(!('error' in result));
      assert.equal(result.maxFires, 3);
    });
  });

  describe('delete', () => {
    test('deletes own automation', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      assert.equal(mgr.delete(auto.id, 'sess-1'), true);
      assert.equal(mgr.get(auto.id), undefined);
    });

    test('cannot delete another sessions automation', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      assert.equal(mgr.delete(auto.id, 'sess-2'), false);
    });
  });

  describe('pause and resume', () => {
    test('pause sets status to paused', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      const paused = mgr.pause(auto.id, 'sess-1');
      assert.equal(paused?.status, 'paused');
    });

    test('resume reactivates paused automation', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.pause(auto.id, 'sess-1');
      const resumed = mgr.resume(auto.id, 'sess-1');
      assert.equal(resumed?.status, 'active');
      assert.ok(resumed?.nextFireAt);
    });

    test('cannot pause already paused', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.pause(auto.id, 'sess-1');
      assert.equal(mgr.pause(auto.id, 'sess-1'), undefined);
    });
  });

  describe('markFired', () => {
    test('increments fireCount and updates nextFireAt', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      const fired = mgr.attemptStarted(auto.id);
      assert.equal(fired?.fireCount, 1);
      assert.ok(fired?.nextFireAt);
      assert.ok(fired?.lastFireAt);
    });

    test('one-shot completes after a successful fire', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'once', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'once', delaySeconds: 30 },
      });
      assert.ok(!('error' in auto));
      // Started nulls nextFireAt but stays active until the outcome is known.
      const started = mgr.attemptStarted(auto.id);
      assert.equal(started?.status, 'active');
      assert.equal(started?.nextFireAt, null);
      mgr.attemptSucceeded(auto.id, 'run-1');
      assert.equal(mgr.get(auto.id)?.status, 'completed');
      assert.equal(mgr.get(auto.id)?.lastRunId, 'run-1');
    });

    test('maxFires completes on the successful fire that reaches the cap', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'limited', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
        maxFires: 2,
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.attemptSucceeded(auto.id);
      assert.equal(mgr.get(auto.id)?.status, 'active'); // 1/2
      mgr.attemptStarted(auto.id);
      mgr.attemptSucceeded(auto.id);
      assert.equal(mgr.get(auto.id)?.status, 'completed'); // 2/2
    });

    test('a failed fire does NOT complete (even at maxFires)', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'limited', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
        maxFires: 1,
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.attemptFailed(auto.id, 'boom');
      // Not 'completed' — a failure never masquerades as success.
      assert.notEqual(mgr.get(auto.id)?.status, 'completed');
    });

    test('does not fire paused automation', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.pause(auto.id, 'sess-1');
      assert.equal(mgr.attemptStarted(auto.id), undefined);
    });
  });

  describe('attemptFailed', () => {
    test('increments consecutiveFailures', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptFailed(auto.id, 'timeout');
      assert.equal(mgr.get(auto.id)?.consecutiveFailures, 1);
      assert.equal(mgr.get(auto.id)?.lastError, 'timeout');
    });

    test('auto-pauses after MAX_CONSECUTIVE_FAILURES', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      for (let i = 0; i < 5; i++) mgr.attemptFailed(auto.id, 'fail');
      assert.equal(mgr.get(auto.id)?.status, 'paused');
    });

    test('a one-shot failure pauses (visible, not a silent zombie)', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'once', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'once', delaySeconds: 10 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id); // nextFireAt → null
      mgr.attemptFailed(auto.id, 'boom');
      assert.equal(mgr.get(auto.id)?.status, 'paused');
    });

    test('attemptSucceeded resets failure count', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptFailed(auto.id, 'fail');
      mgr.attemptFailed(auto.id, 'fail');
      mgr.attemptSucceeded(auto.id);
      assert.equal(mgr.get(auto.id)?.consecutiveFailures, 0);
      assert.equal(mgr.get(auto.id)?.lastError, null);
    });
  });

  describe('removeAllForSession', () => {
    test('removes heartbeat automations only', () => {
      const mgr = createManager();
      mgr.create({ kind: 'heartbeat', name: 'h1', prompt: 'p', sessionId: 's1', schedule: { type: 'interval', seconds: 60 } });
      mgr.create({ kind: 'cron', name: 'c1', prompt: 'p', sessionId: 's1', schedule: { type: 'cron', expression: '0 9 * * *' } });
      const removed = mgr.removeAllForSession('s1');
      assert.equal(removed, 1);
      assert.equal(mgr.listForSession('s1').length, 1);
      assert.equal(mgr.listForSession('s1')[0].kind, 'cron');
    });
  });

  describe('dispose', () => {
    test('clears all automations', () => {
      const mgr = createManager();
      mgr.create({ kind: 'heartbeat', name: 'h1', prompt: 'p', sessionId: 's1', schedule: { type: 'interval', seconds: 60 } });
      mgr.create({ kind: 'cron', name: 'c1', prompt: 'p', sessionId: 's2', schedule: { type: 'cron', expression: '0 9 * * *' } });
      mgr.dispose();
      assert.equal(mgr.listActive().length, 0);
    });
  });
});

describe('computeNextCronFire', () => {
  test('every 5 minutes', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    const next = computeNextCronFire('*/5 * * * *', base);
    assert.ok(next);
    const d = new Date(next!);
    assert.equal(d.getMinutes() % 5, 0);
    assert.ok(next! > base);
  });

  test('specific time (9:30)', () => {
    const base = new Date('2026-07-06T08:00:00').getTime();
    const next = computeNextCronFire('30 9 * * *', base);
    assert.ok(next);
    const d = new Date(next!);
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 30);
  });

  test('weekdays only', () => {
    // 2026-07-06 is a Monday
    const base = new Date('2026-07-06T10:00:00').getTime();
    const next = computeNextCronFire('0 9 * * 1-5', base);
    assert.ok(next);
    const d = new Date(next!);
    const dow = d.getDay();
    assert.ok(dow >= 1 && dow <= 5);
  });

  test('returns null for invalid expression', () => {
    assert.equal(computeNextCronFire('invalid', Date.now()), null);
  });

  test('handles range in field', () => {
    const base = new Date('2026-07-06T00:00:00').getTime();
    const next = computeNextCronFire('0 9-17 * * *', base);
    assert.ok(next);
    const d = new Date(next!);
    assert.ok(d.getHours() >= 9 && d.getHours() <= 17);
  });

  test('handles comma-separated values', () => {
    const base = new Date('2026-07-06T00:00:00').getTime();
    const next = computeNextCronFire('0,30 * * * *', base);
    assert.ok(next);
    const d = new Date(next!);
    assert.ok(d.getMinutes() === 0 || d.getMinutes() === 30);
  });

  test('range/step 10-30/5 only matches 10,15,20,25,30', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    const results: number[] = [];
    let cursor = base;
    for (let i = 0; i < 10; i++) {
      const next = computeNextCronFire('10-30/5 * * * *', cursor);
      if (!next) break;
      results.push(new Date(next).getMinutes());
      cursor = next;
    }
    for (const min of results) {
      assert.ok(min >= 10 && min <= 30, `minute ${min} should be in range 10-30`);
      assert.equal((min - 10) % 5, 0, `minute ${min} should be step of 5 from 10`);
    }
  });

  test('range/step */10 matches 0,10,20,30,40,50', () => {
    const base = new Date('2026-07-06T10:00:00').getTime();
    const next = computeNextCronFire('*/10 * * * *', base);
    assert.ok(next);
    const min = new Date(next!).getMinutes();
    assert.equal(min % 10, 0);
  });

  test('range/step 5-15/3 does not match 18,21,24...', () => {
    // Verify values outside the range don't match
    assert.equal(matchesCronField('5-15/3', 18, 0, 59), false);
    assert.equal(matchesCronField('5-15/3', 21, 0, 59), false);
    assert.equal(matchesCronField('5-15/3', 5, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 8, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 11, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 14, 0, 59), true);
    assert.equal(matchesCronField('5-15/3', 15, 0, 59), false); // 15-5=10, 10%3≠0
  });

  test('timestamps are on clean minute boundaries', () => {
    const base = new Date('2026-07-06T10:00:37.123').getTime();
    const next = computeNextCronFire('*/5 * * * *', base);
    assert.ok(next);
    const d = new Date(next!);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
  });
});

describe('AutomationManager edge cases', () => {
  test('create rejects invalid cron expression', () => {
    const mgr = createManager();
    const result = mgr.create({
      kind: 'heartbeat', name: 'bad cron', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'cron', expression: 'not valid' },
    });
    assert.ok('error' in result);
    assert.ok(result.error.includes('Invalid cron'));
  });

  test('pruneTerminal removes old completed automations', () => {
    const mgr = createManager();
    // Create and complete 10 automations
    for (let i = 0; i < 10; i++) {
      const auto = mgr.create({
        kind: 'heartbeat', name: `auto-${i}`, prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'once', delaySeconds: 10 },
      });
      assert.ok(!('error' in auto));
      mgr.attemptStarted(auto.id);
      mgr.attemptSucceeded(auto.id);
    }
    // Pruning is triggered on next create
    mgr.create({
      kind: 'heartbeat', name: 'trigger-prune', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
    });
    const all = mgr.listForSession('sess-1');
    const completed = all.filter(a => a.status === 'completed');
    assert.ok(completed.length <= 5, `Expected <=5 completed, got ${completed.length}`);
  });

  test('skipFire advances nextFireAt without incrementing fireCount', () => {
    let time = 1700000000000;
    const mgr = new AutomationManager({
      generateId: () => 'skip-test',
      now: () => time,
    });
    const auto = mgr.create({
      kind: 'heartbeat', name: 'skip test', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
    });
    assert.ok(!('error' in auto));
    const originalNext = auto.nextFireAt!;
    // Advance time so skipFire computes a different nextFireAt
    time += 30000;
    mgr.skipFire(auto.id);
    const updated = mgr.get(auto.id)!;
    assert.ok(updated.nextFireAt! > originalNext, `expected ${updated.nextFireAt} > ${originalNext}`);
    assert.equal(updated.fireCount, 0);
  });

  test('attemptFailed does not overwrite completed status', () => {
    const mgr = createManager();
    const auto = mgr.create({
      kind: 'heartbeat', name: 'terminal', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'once', delaySeconds: 10 },
    });
    assert.ok(!('error' in auto));
    mgr.attemptStarted(auto.id);
    mgr.attemptSucceeded(auto.id); // completes (one-shot)
    mgr.attemptFailed(auto.id, 'should not change status');
    assert.equal(mgr.get(auto.id)?.status, 'completed');
  });

  test('listAll returns all automations regardless of status', () => {
    const mgr = createManager();
    mgr.create({ kind: 'heartbeat', name: 'active', prompt: 'p', sessionId: 's1', schedule: { type: 'interval', seconds: 60 } });
    const once = mgr.create({ kind: 'heartbeat', name: 'done', prompt: 'p', sessionId: 's1', schedule: { type: 'once', delaySeconds: 10 } });
    assert.ok(!('error' in once));
    mgr.attemptStarted(once.id);
    mgr.attemptSucceeded(once.id);

    const all = mgr.listAll();
    assert.ok(all.length >= 2);
    const statuses = all.map(a => a.status);
    assert.ok(statuses.includes('active'));
    assert.ok(statuses.includes('completed'));
  });

  test('registerAll bulk-loads automations', () => {
    const mgr = createManager();
    mgr.registerAll([
      { id: 'loaded-1', kind: 'heartbeat', name: 'a', status: 'active', prompt: 'p', sessionId: 's1', schedule: { type: 'interval', seconds: 60 }, createdAt: 0, updatedAt: 0, nextFireAt: 999, lastFireAt: null, lastRunId: null, fireCount: 0, maxFires: null, expiresAt: null, lastError: null, consecutiveFailures: 0 },
      { id: 'loaded-2', kind: 'cron', name: 'b', status: 'paused', prompt: 'p', sessionId: 's1', schedule: { type: 'cron', expression: '0 9 * * *' }, createdAt: 0, updatedAt: 0, nextFireAt: 999, lastFireAt: null, lastRunId: null, fireCount: 0, maxFires: null, expiresAt: null, lastError: null, consecutiveFailures: 0 },
    ]);
    assert.equal(mgr.get('loaded-1')?.name, 'a');
    assert.equal(mgr.get('loaded-2')?.status, 'paused');
  });
});
