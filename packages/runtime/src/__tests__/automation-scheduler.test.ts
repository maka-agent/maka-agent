import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationManager } from '../automation-state.js';
import { AutomationScheduler, type AutomationFireResult } from '../automation-scheduler.js';

function createTestSetup() {
  let idCounter = 0;
  let time = 1700000000000;
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let timerId = 0;
  const fired: Array<{ sessionId: string; prompt: string; automationId: string }> = [];
  let canFireResult = true;
  let canFireThrows = false;
  let injectResult: AutomationFireResult = { runId: 'run-x', ok: true };
  let injectRejects = false;
  let createFreshRunFn: ((prompt: string, automationId: string) => Promise<AutomationFireResult>) | undefined;

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
    injectTurn: async (sessionId, prompt, automationId) => {
      fired.push({ sessionId, prompt, automationId });
      if (injectRejects) throw new Error('injectTurn error');
      return injectResult;
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
  // Fire the pending tick, then flush enough microtask cycles for the async
  // fire dispatch (.then/.catch → attemptSucceeded/attemptFailed) to settle.
  async function runTick() {
    fireNextTimer();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
  }

  return {
    manager, scheduler, fired, timers,
    advanceTime, fireNextTimer, runTick,
    setCanFire: (v: boolean) => { canFireResult = v; },
    setCanFireThrows: (v: boolean) => { canFireThrows = v; },
    setInjectRejects: (v: boolean) => { injectRejects = v; },
    setInjectResult: (r: AutomationFireResult) => { injectResult = r; },
    setCreateFreshRun: (fn: ((prompt: string, automationId: string) => Promise<AutomationFireResult>) | undefined) => {
      createFreshRunFn = fn;
    },
    getTime: () => time,
  };
}

describe('AutomationScheduler', () => {
  test('fires a heartbeat when time arrives and session is idle', async () => {
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
    for (let i = 0; i < 24; i++) await t.runTick();
    const updated = t.manager.get(auto.id);
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
    assert.equal(t.fired.length, 0);
    assert.ok(t.timers.length > 0);
  });

  test('a rejected fire marks the automation failed (outcome after stream)', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'test', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.setInjectRejects(true);
    t.scheduler.start();
    await t.runTick();
    const updated = t.manager.get(auto.id);
    assert.equal(updated?.consecutiveFailures, 1);
    assert.equal(updated?.lastError, 'injectTurn error');
  });

  test('a fire that resolves ok:false marks failed, not success', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'test', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.setInjectResult({ runId: 'run-1', ok: false, error: 'turn errored' });
    t.scheduler.start();
    await t.runTick();
    const updated = t.manager.get(auto.id);
    assert.equal(updated?.consecutiveFailures, 1);
    assert.equal(updated?.lastError, 'turn errored');
  });

  test('a successful fire records the runId', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'test', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.setInjectResult({ runId: 'run-42', ok: true });
    t.scheduler.start();
    await t.runTick();
    assert.equal(t.manager.get(auto.id)?.lastRunId, 'run-42');
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
      expiresAt: t.getTime() + 20000,
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();
    assert.equal(t.fired.length, 0);
    assert.equal(t.manager.get(auto.id)?.status, 'expired');
  });

  test('one-shot fires once then completes (on success)', async () => {
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

  test('cron fires via createFreshRun, not injectTurn', async () => {
    const t = createTestSetup();
    const freshRuns: Array<{ prompt: string; id: string }> = [];
    t.setCreateFreshRun(async (prompt, automationId) => {
      freshRuns.push({ prompt, id: automationId });
      return { runId: 'fresh-1', ok: true };
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
    assert.equal(t.fired.length, 0);
    assert.equal(t.manager.get(auto.id)?.lastRunId, 'fresh-1');
  });

  test('cron is silently ignored when createFreshRun is not provided (no state corruption)', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'cron', name: 'daily', prompt: 'review PRs',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in auto));
    const originalFireCount = auto.fireCount;
    const originalNextFireAt = auto.nextFireAt;
    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();
    await t.runTick();
    assert.equal(t.fired.length, 0);
    const updated = t.manager.get(auto.id);
    // A host without a cron executor must leave the cron COMPLETELY untouched —
    // no failure, no pause, no advance — because the durable store may be shared
    // with a host that CAN run it (heartbeat-only CLI + desktop share a store).
    assert.equal(updated?.status, 'active');
    assert.equal(updated?.consecutiveFailures, 0);
    assert.equal(updated?.lastError, null);
    assert.equal(updated?.fireCount, originalFireCount);
    assert.equal(updated?.nextFireAt, originalNextFireAt);
  });

  test('expired automations are swept even before nextFireAt', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'expiring', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 3600 },
      expiresAt: t.getTime() + 30000,
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.scheduler.start();
    await t.runTick();
    assert.equal(t.fired.length, 0);
    assert.equal(t.manager.get(auto.id)?.status, 'expired');
  });

  test('a failed maxFires=1 fire ends failed/paused, never completed', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'limited', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 30 },
      maxFires: 1,
    });
    assert.ok(!('error' in auto));
    t.advanceTime(31000);
    t.setInjectRejects(true);
    t.scheduler.start();
    await t.runTick();
    const updated = t.manager.get(auto.id);
    assert.notEqual(updated?.status, 'completed');
  });

  test('in-flight guard: a slow cron does not re-fire concurrently', async () => {
    const t = createTestSetup();
    let dispatches = 0;
    let release!: (r: AutomationFireResult) => void;
    // A createFreshRun that hangs until we release it — models a run slower than
    // the cadence (the exact concurrency window).
    t.setCreateFreshRun((_p, _id) => {
      dispatches++;
      return new Promise<AutomationFireResult>((res) => { release = (r) => res(r); });
    });
    const auto = t.manager.create({
      kind: 'cron', name: 'slow', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 10 },
    });
    assert.ok(!('error' in auto));
    t.scheduler.start();
    // Fire is due; run it multiple times while the first dispatch is still pending.
    t.advanceTime(11000);
    await t.runTick();               // dispatch #1 (hangs)
    t.advanceTime(11000);
    await t.runTick();               // due again — must be skipped (in-flight)
    t.advanceTime(11000);
    await t.runTick();               // still in-flight — skipped
    assert.equal(dispatches, 1, 'only one fire dispatched while the run is in flight');
    // Release the run → next due tick may fire again.
    release({ runId: 'r1', ok: true });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    t.advanceTime(11000);
    await t.runTick();
    assert.equal(dispatches, 2, 're-fires only after the prior run resolves');
  });

  test('maxFires bounds fire ATTEMPTS even when every run fails', async () => {
    const t = createTestSetup();
    const auto = t.manager.create({
      kind: 'heartbeat', name: 'flaky', prompt: 'p',
      sessionId: 'sess-1', schedule: { type: 'interval', seconds: 10 },
      maxFires: 2,
    });
    assert.ok(!('error' in auto));
    t.setInjectRejects(true); // every fire fails
    t.scheduler.start();
    // Tick well past 2 fire windows.
    for (let i = 0; i < 6; i++) { t.advanceTime(11000); await t.runTick(); }
    const updated = t.manager.get(auto.id);
    // Fired at most maxFires times (2), NOT up to the consecutive-failure cap (5).
    assert.ok(updated!.fireCount <= 2, `fireCount=${updated!.fireCount} should be <= maxFires(2)`);
    assert.equal(updated!.nextFireAt, null, 'no further fires scheduled past maxFires');
  });
});
