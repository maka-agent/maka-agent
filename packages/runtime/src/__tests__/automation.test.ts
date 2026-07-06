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
      const fired = mgr.markFired(auto.id);
      assert.equal(fired?.fireCount, 1);
      assert.ok(fired?.nextFireAt);
      assert.ok(fired?.lastFireAt);
    });

    test('one-shot completes after fire', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'once', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'once', delaySeconds: 30 },
      });
      assert.ok(!('error' in auto));
      const fired = mgr.markFired(auto.id);
      assert.equal(fired?.status, 'completed');
      assert.equal(fired?.nextFireAt, null);
    });

    test('maxFires completes automation', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'limited', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
        maxFires: 2,
      });
      assert.ok(!('error' in auto));
      mgr.markFired(auto.id);
      const second = mgr.markFired(auto.id);
      assert.equal(second?.status, 'completed');
    });

    test('does not fire paused automation', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.pause(auto.id, 'sess-1');
      assert.equal(mgr.markFired(auto.id), undefined);
    });
  });

  describe('markFailure', () => {
    test('increments consecutiveFailures', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.markFailure(auto.id, 'timeout');
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
      for (let i = 0; i < 5; i++) mgr.markFailure(auto.id, 'fail');
      assert.equal(mgr.get(auto.id)?.status, 'paused');
    });

    test('markSuccess resets failure count', () => {
      const mgr = createManager();
      const auto = mgr.create({
        kind: 'heartbeat', name: 'test', prompt: 'p',
        sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
      });
      assert.ok(!('error' in auto));
      mgr.markFailure(auto.id, 'fail');
      mgr.markFailure(auto.id, 'fail');
      mgr.markSuccess(auto.id);
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
});
