/**
 * End-to-end (no Electron): a durable cron keeps firing through the REAL manager
 * + scheduler + the REAL kind-aware canFire gate, even after its creator session
 * is archived/deleted — while a heartbeat in the same archived session does not.
 *
 * This ties the P1 fix together: evaluateAutomationCanFire (cron ignores its
 * creator session) → AutomationScheduler actually dispatches the cron.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AutomationManager, AutomationScheduler, type AutomationDefinition } from '@maka/runtime';
import { evaluateAutomationCanFire } from '../automation-wiring.js';

const IDLE = new Set(['active', 'done', 'waiting_for_user']);

function harness(opts: { sessionArchived: boolean; incognito?: boolean }) {
  let time = 1_700_000_000_000;
  let idc = 0;
  const timers: Array<{ fn: () => void; id: number }> = [];
  let timerId = 0;
  const freshRuns: string[] = [];
  const injected: string[] = [];

  const manager = new AutomationManager({ generateId: () => `a-${++idc}`, now: () => time, random: () => 0 });

  const scheduler = new AutomationScheduler({
    automationManager: manager,
    // The REAL kind-aware gate. The creator session is "archived" (or gone).
    canFire: (automation: AutomationDefinition) => evaluateAutomationCanFire(automation, {
      isIncognitoActive: async () => opts.incognito === true,
      readSessionHeader: async () =>
        opts.sessionArchived ? { status: 'active', archivedAt: time } : { status: 'active', archivedAt: null },
      idleStatuses: IDLE,
    }),
    injectTurn: async (_s, _p, id) => { injected.push(id); return { runId: `h-${id}`, ok: true }; },
    createFreshRun: async (_p, id) => { freshRuns.push(id); return { runId: `c-${id}`, ok: true }; },
    setTimeout: (fn) => { const id = ++timerId; timers.push({ fn, id }); return id; },
    clearTimeout: (t) => { const i = timers.findIndex(x => x.id === t); if (i >= 0) timers.splice(i, 1); },
    now: () => time,
  });

  return {
    manager, scheduler, freshRuns, injected,
    advance: (ms: number) => { time += ms; },
    async tick() { const t = timers.shift(); if (t) t.fn(); for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); },
  };
}

describe('E2E: durable cron fires after its creator session is archived', () => {
  it('cron fires even though the creating conversation is archived', async () => {
    const h = harness({ sessionArchived: true });
    const cron = h.manager.create({
      kind: 'cron', name: 'nightly', prompt: 'run it',
      sessionId: 'archived-conversation', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in cron));

    h.advance(31_000);
    h.scheduler.start();
    await h.tick();

    assert.equal(h.freshRuns.length, 1, 'cron should fire despite the archived creator session');
    h.scheduler.dispose();
  });

  it('a heartbeat in the same archived session does NOT fire', async () => {
    const h = harness({ sessionArchived: true });
    const beat = h.manager.create({
      kind: 'heartbeat', name: 'poll', prompt: 'check',
      sessionId: 'archived-conversation', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in beat));

    h.advance(31_000);
    h.scheduler.start();
    // canFire=false → defers, never injects. Tick a few times to be sure.
    await h.tick(); await h.tick(); await h.tick();

    assert.equal(h.injected.length, 0, 'heartbeat must not fire into an archived session');
    h.scheduler.dispose();
  });

  it('incognito blocks the cron too', async () => {
    const h = harness({ sessionArchived: false, incognito: true });
    const cron = h.manager.create({
      kind: 'cron', name: 'nightly', prompt: 'run it',
      sessionId: 's', schedule: { type: 'interval', seconds: 30 },
    });
    assert.ok(!('error' in cron));

    h.advance(31_000);
    h.scheduler.start();
    await h.tick();

    assert.equal(h.freshRuns.length, 0, 'cron must not fire while incognito is active');
    h.scheduler.dispose();
  });
});
