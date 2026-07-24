import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimRequest,
  AgentGraphIntentClaimStore,
} from '@maka/core/agent-graph-control';
import { claimAgentGraphRunnableIntent } from '../stream-graph-admission.js';
import type { AgentGraphRunnableIntent } from '../stream-graph-readiness.js';

describe('stream graph admission', () => {
  test('claims one durable activation identity without invoking runtime', async () => {
    const store = new MemoryClaimStore();
    const generated = ['turn-first', 'run-first', 'turn-discarded', 'run-discarded'];
    const first = await claimAgentGraphRunnableIntent({
      intent: runnableIntent(),
      store,
      newId: () => generated.shift()!,
    });
    const retry = await claimAgentGraphRunnableIntent({
      intent: runnableIntent(),
      store,
      newId: () => generated.shift()!,
    });

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.deepEqual(retry.claim, first.claim);
    assert.equal(first.claim.targetSessionId, 'session-child');
    assert.equal(first.claim.targetTurnId, 'turn-first');
    assert.equal(first.claim.targetRunId, 'run-first');
    assert.match(first.claim.claimId, /^graph_claim_[a-f0-9]{32}$/);
    assert.match(first.claim.intentFingerprint, /^sha256:[a-f0-9]{64}$/);
  });
});

class MemoryClaimStore implements AgentGraphIntentClaimStore {
  private claim: AgentGraphIntentClaim | undefined;

  async claimAgentGraphIntent(request: AgentGraphIntentClaimRequest) {
    if (this.claim) return { claim: this.claim, created: false };
    this.claim = { ...request, claimedAt: 42 };
    return { claim: this.claim, created: true };
  }

  async readAgentGraphIntentClaim() {
    return this.claim;
  }

  async listAgentGraphIntentClaims() {
    return this.claim ? [this.claim] : [];
  }
}

function runnableIntent(): AgentGraphRunnableIntent {
  return {
    schemaVersion: 1,
    intentId: `graph_intent_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    readinessContextFingerprint: `sha256:${'b'.repeat(64)}`,
    policyFingerprint: `sha256:${'c'.repeat(64)}`,
    readinessId: 'readiness-1',
    operatorId: 'summarizer',
    targetSessionId: 'session-child',
    policyKind: 'map',
    triggerRouteIds: ['route-1'],
    triggerRecordIds: ['record-1'],
  };
}
