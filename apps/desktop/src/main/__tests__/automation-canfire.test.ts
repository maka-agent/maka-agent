/**
 * evaluateAutomationCanFire — the kind-aware fire gate.
 *
 * Regression coverage for the P1 durability bug: a cron must keep firing even
 * after the conversation that created it is archived, deleted, or gone after a
 * restart (cron spawns a FRESH session, so its creator session is irrelevant).
 * Heartbeats stay gated on their own session; incognito blocks everything.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { evaluateAutomationCanFire } from '../automation-wiring.js';

const IDLE = new Set(['active', 'done', 'waiting_for_user']);
const cron = { kind: 'cron' as const, sessionId: 'creator' };
const beat = { kind: 'heartbeat' as const, sessionId: 'own' };

function deps(over: Partial<Parameters<typeof evaluateAutomationCanFire>[1]> = {}) {
  return {
    isIncognitoActive: async () => false,
    readSessionHeader: async () => ({ status: 'active' as string, archivedAt: null as number | null }),
    idleStatuses: IDLE,
    ...over,
  };
}

describe('evaluateAutomationCanFire — kind-aware fire gate', () => {
  it('cron fires regardless of its creator session (archived)', async () => {
    const d = deps({ readSessionHeader: async () => ({ status: 'active', archivedAt: 123 }) });
    assert.equal(await evaluateAutomationCanFire(cron, d), true);
  });

  it('cron fires even when its creator session was DELETED (readHeader throws)', async () => {
    const d = deps({ readSessionHeader: async () => { throw new Error('ENOENT'); } });
    assert.equal(await evaluateAutomationCanFire(cron, d), true);
  });

  it('cron never reads the session header at all', async () => {
    let read = false;
    const d = deps({ readSessionHeader: async () => { read = true; return { status: 'active', archivedAt: null }; } });
    await evaluateAutomationCanFire(cron, d);
    assert.equal(read, false);
  });

  it('incognito blocks cron', async () => {
    assert.equal(await evaluateAutomationCanFire(cron, deps({ isIncognitoActive: async () => true })), false);
  });

  it('incognito blocks heartbeat', async () => {
    assert.equal(await evaluateAutomationCanFire(beat, deps({ isIncognitoActive: async () => true })), false);
  });

  it('heartbeat fires into an idle (active/done/waiting_for_user) session', async () => {
    assert.equal(await evaluateAutomationCanFire(beat, deps({ readSessionHeader: async () => ({ status: 'active', archivedAt: null }) })), true);
    assert.equal(await evaluateAutomationCanFire(beat, deps({ readSessionHeader: async () => ({ status: 'done', archivedAt: null }) })), true);
    // #639 decision: waiting_for_user is the wakeup's HOME scenario — the
    // heartbeat starts a turn in place of the user.
    assert.equal(await evaluateAutomationCanFire(beat, deps({ readSessionHeader: async () => ({ status: 'waiting_for_user', archivedAt: null }) })), true);
  });

  it('heartbeat does NOT fire into a busy/blocked session', async () => {
    assert.equal(await evaluateAutomationCanFire(beat, deps({ readSessionHeader: async () => ({ status: 'running', archivedAt: null }) })), false);
    assert.equal(await evaluateAutomationCanFire(beat, deps({ readSessionHeader: async () => ({ status: 'blocked', archivedAt: null }) })), false);
  });

  it('heartbeat does NOT fire into an archived or missing session', async () => {
    assert.equal(await evaluateAutomationCanFire(beat, deps({ readSessionHeader: async () => ({ status: 'active', archivedAt: 1 }) })), false);
    assert.equal(await evaluateAutomationCanFire(beat, deps({ readSessionHeader: async () => null })), false);
  });

  it('heartbeat does NOT fire when its session was deleted (readHeader throws)', async () => {
    assert.equal(await evaluateAutomationCanFire(beat, deps({ readSessionHeader: async () => { throw new Error('ENOENT'); } })), false);
  });
});
