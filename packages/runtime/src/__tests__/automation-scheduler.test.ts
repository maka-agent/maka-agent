import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationManager } from '../automation-state.js';
import { AutomationScheduler } from '../automation-scheduler.js';

function createTestSetup() {
  let idCounter = 0;
  let time = 1700000000000;
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let timerId = 0;
  const fired: Array<{ sessionId: string; prompt: string; automationId: string }> = [];
  const freshRuns: Array<{ prompt: string; automationId: string }> = [];
  let canFireResult = true;
  let canFireThrows = false;
  let injectTurnThrows = false;
  let createFreshRunFn: ((prompt: string, automationId: string) => void) | undefined = undefined;

  const manager = new AutomationManager({
    generateId: () => `auto-${++idCounter}`,
    now: () => time,
  });

  const scheduler = new AutomationScheduler({
    automationManager: manager,
    canFire: async () => {
      if (canFireThrows) throw new Error('canFire error');
      return canFireResult;
    },
    injectTurn: (sessionId, prompt, automationId) => {
      if (injectTurnThrows) throw new Error('injectTurn error');
      fired.push({ sessionId, prompt, automationId });
    },
    get createFreshRun() { return createFreshRunFn; },
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimeout: (timer) => {
      const idx = timers.findIndex(t => t.id === timer);
      if (idx >= 0) timers.splice(idx, 1);
    },
    now: () => time,
  });

  function advanceTime(ms: number) { time += ms; }
  function fireNextTimer() {
    const timer = timers.shift();
    if (timer) timer.fn();
  }
  async function runTick() {
    fireNextTimer();
    await new Promise(r => setTimeout(r, 0));
  }

  return {
    manager, scheduler, fired, freshRuns, timers,
    advanceTime, fireNextTimer, runTick,
    setCanFire: (v: boolean) => { canFireResult = v; },
    setCanFireThrows: (v: boolean) => { canFireThrows = v; },
    setInjectTurnThrows: (v: boolean) => { injectTurnThrows = v; },
    setCreateFreshRun: (fn: ((prompt: string, automationId: string) => void) | undefined) => {
      createFreshRunFn = fn;
    },
    getTime: () => time,
  };
}

describe('AutomationScheduler', () => {
  test('fires automation when time arrives and session is idle', async () => {
    const t = createTestSetup();
    t.manager.create({
      kind: 'heartbeat', name: 'test', prompt: 'check it',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();
    assert.equal(t.fired.length, 1);
    assert.equal(t.fired[0].prompt, '[Automation: test]\n\ncheck it');
  });

  test('does not fire when session is busy', async () => {
    const t = createTestSetup();
    t.manager.create({
      kind: 'heartbeat', name: 'test', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    t.advanceTime(31000);
    t.setCanFire(false);
    t.scheduler.start();
    await t.runTick();
    assert.equal(t.fired.length, 0);
  });

  test('skips fire and advances schedule after max defer retries', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'test', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 60 },
    });
    assert.ok(!('error' in auto));
    const originalNextFire = auto.nextFireAt;

    t.advanceTime(61000);
    t.setCanFire(false);
    t.scheduler.start();

    // Run 24 ticks (MAX_DEFER_RETRIES)
    for (let i = 0; i < 24; i++) {
      await t.runTick();
    }

    // Should have skipped — nextFireAt advanced
    const updated = t.manager.get(auto.id);
    assert.ok(updated);
    assert.ok(updated!.nextFireAt! > originalNextFire!);
    assert.equal(t.fired.length, 0);
  });

  test('canFire throwing does not crash the scheduler', async () => {
    const t = createTestSetup();
    t.manager.create({
      kind: 'heartbeat', name: 'test', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    t.advanceTime(31000);
    t.setCanFireThrows(true);
    t.scheduler.start();
    await t.runTick();
    // Should not crash, just skip
    assert.equal(t.fired.length, 0);
    // Scheduler still ticking (timer re-registered)
    assert.ok(t.timers.length > 0);
  });

  test('injectTurn throwing marks automation as failed', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'test', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.setInjectTurnThrows(true);
    t.scheduler.start();
    await t.runTick();

    const updated = t.manager.get(auto.id);
    assert.equal(updated?.consecutiveFailures, 1);
    assert.equal(updated?.lastError, 'injectTurn error');
  });

  test('dispose stops the tick loop', async () => {
    const t = createTestSetup();
    t.scheduler.start();
    assert.ok(t.timers.length > 0);
    t.scheduler.dispose();
    assert.equal(t.timers.length, 0);
  });

  test('does not fire expired automations', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'expiring', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
      expiresAt: t.getTime() + 20000, // expires in 20s
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000); // past expiry
    t.scheduler.start();
    await t.runTick();

    assert.equal(t.fired.length, 0);
    assert.equal(t.manager.get(auto.id)?.status, 'expired');
  });

  test('one-shot fires once then completes', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'once', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'once', delaySeconds: 10 },
    });
    assert.ok(!('error' in auto));
    t.advanceTime(11000);
    t.scheduler.start();
    await t.runTick();

    assert.equal(t.fired.length, 1);
    assert.equal(t.manager.get(auto.id)?.status, 'completed');

    // Next tick should not fire again
    t.advanceTime(11000);
    await t.runTick();
    assert.equal(t.fired.length, 1);
  });

  test('cron automation fires via createFreshRun when provided', async () => {
    const t = createTestSetup();
    const freshRuns: Array<{ prompt: string; id: string }> = [];
    t.setCreateFreshRun((prompt, automationId) => {
      freshRuns.push({ prompt, id: automationId });
    });
    const auto = t.manager.create({
      kind: 'cron', name: 'daily', prompt: 'review PRs',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();

    assert.equal(freshRuns.length, 1);
    assert.equal(freshRuns[0].prompt, 'review PRs');
    assert.equal(freshRuns[0].id, auto.id);
    assert.equal(t.fired.length, 0); // should NOT call injectTurn
  });

  test('cron automation marks failure when createFreshRun is not provided', async () => {
    const t = createTestSetup();
    // createFreshRun is undefined by default
    const auto = t.manager.create({
      kind: 'cron', name: 'daily', prompt: 'review PRs',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();

    assert.equal(t.fired.length, 0);
    const updated = t.manager.get(auto.id);
    assert.equal(updated?.consecutiveFailures, 1);
    assert.ok(updated?.lastError?.includes('not configured'));
  });

  test('expired automations are swept even before nextFireAt', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'expiring', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 3600 }, // next fire in 1 hour
      expiresAt: t.getTime() + 30000, // expires in 30s
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000); // past expiry but before nextFireAt (1 hour)
    t.scheduler.start();
    await t.runTick();

    assert.equal(t.fired.length, 0);
    assert.equal(t.manager.get(auto.id)?.status, 'expired');
  });

  test('markFailure does not overwrite terminal status', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'limited', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
      maxFires: 1,
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.setInjectTurnThrows(true);
    t.scheduler.start();
    await t.runTick();

    // markFired sets completed (maxFires=1), then injectTurn throws,
    // markFailure should NOT overwrite completed with paused.
    const updated = t.manager.get(auto.id);
    assert.equal(updated?.status, 'completed');
  });
});
