import type {
  AgentGraphIntentClaimResult,
  AgentGraphIntentClaimStore,
} from '@maka/core/agent-graph-control';
import { AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION } from '@maka/core/agent-graph-control';
import { stableHash } from './request-shape.js';
import type { AgentGraphRunnableIntent } from './stream-graph-readiness.js';

export interface ClaimAgentGraphRunnableIntentInput {
  intent: AgentGraphRunnableIntent;
  store: AgentGraphIntentClaimStore;
  newId: () => string;
}

/**
 * Claims a deterministic readiness intent without invoking Agent runtime.
 *
 * The store is the admission authority. Proposed ids are disposable on an
 * idempotent retry: the persisted turn/run identity always wins.
 */
export function claimAgentGraphRunnableIntent(
  input: ClaimAgentGraphRunnableIntentInput,
): Promise<AgentGraphIntentClaimResult> {
  const intentFingerprint = stableHash(input.intent);
  const claimHash = stableHash({
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    graphId: input.intent.graphId,
    intentId: input.intent.intentId,
  });
  return input.store.claimAgentGraphIntent({
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    claimId: `graph_claim_${claimHash.slice('sha256:'.length, 'sha256:'.length + 32)}`,
    graphId: input.intent.graphId,
    intentId: input.intent.intentId,
    intentFingerprint,
    readinessContextFingerprint: input.intent.readinessContextFingerprint,
    targetOperatorId: input.intent.operatorId,
    targetSessionId: input.intent.targetSessionId,
    targetTurnId: input.newId(),
    targetRunId: input.newId(),
  });
}
