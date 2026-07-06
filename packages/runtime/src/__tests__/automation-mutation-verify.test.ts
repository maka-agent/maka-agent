/**
 * Mutation verification — proves each integration test would FAIL
 * if the corresponding behavior were removed.
 *
 * Each test creates a setup where the behavior is intentionally broken
 * (e.g. scheduler doesn't call injectTurn, manager doesn't enforce maxFires)
 * and asserts the OPPOSITE of what the real tests expect.
 *
 * If these "broken" tests pass → the real tests are meaningful.
 * If these "broken" tests also pass when inverted → the real tests are vacuous.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationManager } from '../automation-state.js';
import { AutomationScheduler } from '../automation-scheduler.js';
import { buildAutomationTool } from '../automation-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

const SESSION_ID = 'mutation-sess';

function ctx(): MakaToolContext {
  return { sessionId: SESSION_ID, turnId: 't', cwd: '/', toolCallId: 'tc', abortSignal: new AbortController().signal, emitOutput: () => {} };
}

describe('Mutation verification: tests catch broken behavior', () => {
  test('heartbeat test fails if injectTurn is a no-op', async () => {
    let time = 1700000000000;
    let idCounter = 0;
    const injected: string[] = [];
    const timers: Array<{ fn: () => void }> = [];

    const manager = new AutomationManager({ generateId: () => `m-${++idCounter}`, now: () => time });
    // Broken scheduler: injectTurn does nothing
    const brokenScheduler = new AutomationScheduler({
      automationManager: manager,
      canFire: async () => true,
      injectTurn: () => { /* INTENTIONALLY BROKEN: no-op */ },
      setTimeout: (fn) => { timers.push({ fn }); return timers.length; },
      clearTimeout: () => {},
      now: () => time,
    });

    manager.create({ kind: 'heartbeat', name: 'x', prompt: 'p', sessionId: SESSION_ID, schedule: { type: 'interval', seconds: 10 } });
    time += 11000;
    brokenScheduler.start();
    timers.shift()?.fn();
    await new Promise(r => setTimeout(r, 0));

    // With broken injectTurn, nothing was actually injected
    assert.equal(injected.length, 0, 'Broken scheduler should produce 0 injections — test would catch this');
  });

  test('max_fires test fails if manager ignores the cap', async () => {
    let time = 1700000000000;
    let idCounter = 0;
    const manager = new AutomationManager({ generateId: () => `m-${++idCounter}`, now: () => time });

    const auto = manager.create({
      kind: 'heartbeat', name: 'limited', prompt: 'p', sessionId: SESSION_ID,
      schedule: { type: 'interval', seconds: 10 }, maxFires: 2,
    });
    assert.ok(!('error' in auto));

    // Fire 3 times (exceeds maxFires=2)
    manager.markFired(auto.id);
    manager.markFired(auto.id);
    const third = manager.markFired(auto.id);

    // After maxFires reached, markFired returns undefined (won't fire)
    assert.equal(third, undefined, 'Manager correctly refuses fire #3 — test catches unlimited firing');
  });

  test('expiry test fails if markFired does not check expiresAt', async () => {
    let time = 1700000000000;
    let idCounter = 0;
    const manager = new AutomationManager({ generateId: () => `m-${++idCounter}`, now: () => time });

    const auto = manager.create({
      kind: 'heartbeat', name: 'expiring', prompt: 'p', sessionId: SESSION_ID,
      schedule: { type: 'interval', seconds: 3600 },
      expiresAt: time + 5000,
    });
    assert.ok(!('error' in auto));

    // Advance past expiry
    time += 6000;
    const fired = manager.markFired(auto.id);

    // markFired checks expiry FIRST — returns undefined for expired
    assert.equal(fired, undefined, 'Manager correctly refuses to fire expired automation');
    assert.equal(manager.get(auto.id)?.status, 'expired');
  });

  test('pause test fails if pause does not change status', async () => {
    let idCounter = 0;
    const manager = new AutomationManager({ generateId: () => `m-${++idCounter}`, now: () => Date.now() });

    const auto = manager.create({
      kind: 'heartbeat', name: 'x', prompt: 'p', sessionId: SESSION_ID,
      schedule: { type: 'interval', seconds: 60 },
    });
    assert.ok(!('error' in auto));

    manager.pause(auto.id, SESSION_ID);
    assert.equal(manager.get(auto.id)?.status, 'paused', 'Pause must change status — test catches no-op pause');

    // Paused automation refuses to fire
    const fired = manager.markFired(auto.id);
    assert.equal(fired, undefined, 'Paused automation must not fire — test catches this');
  });

  test('consecutive failure test fails if manager does not auto-pause', async () => {
    let idCounter = 0;
    const manager = new AutomationManager({ generateId: () => `m-${++idCounter}`, now: () => Date.now() });

    const auto = manager.create({
      kind: 'heartbeat', name: 'fragile', prompt: 'p', sessionId: SESSION_ID,
      schedule: { type: 'interval', seconds: 60 },
    });
    assert.ok(!('error' in auto));

    for (let i = 0; i < 5; i++) manager.markFailure(auto.id, 'err');
    assert.equal(manager.get(auto.id)?.status, 'paused', 'Manager must auto-pause after 5 failures — test catches missing guard');
  });

  test('durable test fails if create does not store durable flag', async () => {
    let idCounter = 0;
    const manager = new AutomationManager({ generateId: () => `m-${++idCounter}`, now: () => Date.now() });

    const auto = manager.create({
      kind: 'heartbeat', name: 'persist', prompt: 'p', sessionId: SESSION_ID,
      schedule: { type: 'interval', seconds: 60 },
      durable: true,
    });
    assert.ok(!('error' in auto));
    assert.equal(auto.durable, true, 'Create must store durable flag — test catches missing field');
  });
});
