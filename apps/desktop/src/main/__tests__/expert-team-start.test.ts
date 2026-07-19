/**
 * Tests for the expert-team session entry handler.
 *
 * Locks the behavioral gates:
 *  - unknown team id → `unknown_team`, NO onboarding read, NO session created
 *  - non-ready OnboardingState → `setup_required`, NO session created
 *  - empty prompt → create-and-open only; NO send
 *  - non-empty prompt → walks the send path
 *  - workspace failures preserve their recovery semantics; other failures
 *    become `send_failed` with generalized Chinese copy
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { OnboardingState, SessionSummary } from '@maka/core';
import { handleExpertTeamStart, type ExpertTeamStartDeps } from '../expert-team-start.js';
import { SESSION_WORKSPACE_UNAVAILABLE_CODE } from '../project-context-root.js';

function fakeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: overrides.id ?? 'session-expert-1',
    name: overrides.name ?? 'Code Review Team',
    isFlagged: false,
    isArchived: false,
    labels: ['mode:expert-team:code-review'],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-live',
    connectionLocked: false,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'explore',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ExpertTeamStartDeps> = {}) {
  const spy = {
    onboardingReads: 0,
    createInputs: [] as Array<{ teamId: string; defaultConnectionSlug: string; defaultModel: string }>,
    emitCalls: [] as string[],
    sendCalls: [] as Array<{ sessionId: string; text: string }>,
  };
  const deps: ExpertTeamStartDeps = {
    isKnownTeam: (teamId) => teamId === 'code-review',
    async getOnboardingState() {
      spy.onboardingReads += 1;
      return {
        kind: 'ready_empty',
        defaultConnectionSlug: 'anthropic-live',
        defaultModel: 'claude-sonnet-4-5-20250929',
      } as OnboardingState;
    },
    async createSession(input) {
      spy.createInputs.push(input);
      return fakeSession();
    },
    emitCreated(sessionId) {
      spy.emitCalls.push(sessionId);
    },
    async ensureCanSend() {},
    async sendFirstMessage(sessionId, text) {
      spy.sendCalls.push({ sessionId, text });
    },
    ...overrides,
  };
  return { deps, spy };
}

describe('handleExpertTeamStart', () => {
  it('fails closed on an unknown team without reading onboarding or creating a session', async () => {
    const { deps, spy } = makeDeps();
    const result = await handleExpertTeamStart({ teamId: 'nope' }, deps);
    assert.deepEqual(result, { ok: false, reason: 'unknown_team', teamId: 'nope' });
    assert.equal(spy.onboardingReads, 0);
    assert.equal(spy.createInputs.length, 0);
  });

  it('fails closed when teamId is missing', async () => {
    const { deps } = makeDeps();
    const result = await handleExpertTeamStart({}, deps);
    assert.deepEqual(result, { ok: false, reason: 'unknown_team', teamId: '' });
  });

  it('returns setup_required and creates nothing when not ready', async () => {
    const { deps, spy } = makeDeps({
      async getOnboardingState() {
        return { kind: 'needs_connection' } as OnboardingState;
      },
    });
    const result = await handleExpertTeamStart({ teamId: 'code-review' }, deps);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'setup_required');
    assert.equal(spy.createInputs.length, 0);
  });

  it('creates a labeled session and does not send on an empty prompt', async () => {
    const { deps, spy } = makeDeps();
    const result = await handleExpertTeamStart({ teamId: 'code-review', prompt: '   ' }, deps);
    assert.deepEqual(result, { ok: true, sessionId: 'session-expert-1' });
    assert.equal(spy.createInputs[0]?.teamId, 'code-review');
    assert.deepEqual(spy.emitCalls, ['session-expert-1']);
    assert.equal(spy.sendCalls.length, 0);
  });

  it('sends the first message when a prompt is provided', async () => {
    const { deps, spy } = makeDeps();
    const result = await handleExpertTeamStart(
      { teamId: 'code-review', prompt: 'Review the diff.' },
      deps,
    );
    assert.deepEqual(result, { ok: true, sessionId: 'session-expert-1' });
    assert.deepEqual(spy.sendCalls, [{ sessionId: 'session-expert-1', text: 'Review the diff.' }]);
  });

  it('returns send_failed with a generalized message when create throws', async () => {
    const { deps } = makeDeps({
      async createSession() {
        throw new Error('boom secret detail');
      },
    });
    const result = await handleExpertTeamStart({ teamId: 'code-review', prompt: 'hi' }, deps);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'send_failed');
  });

  it('preserves an unavailable workspace as a domain result', async () => {
    const { deps } = makeDeps({
      async createSession() {
        throw new Error(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}: unavailable`);
      },
    });

    const result = await handleExpertTeamStart({ teamId: 'code-review', prompt: 'hi' }, deps);

    assert.deepEqual(result, { ok: false, reason: 'workspace_unavailable' });
  });
});
