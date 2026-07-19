import type { ToolResultContent } from './events.js';

export type AgentSwarmResult = Extract<ToolResultContent, { kind: 'agent_swarm' }>;

export interface AgentSwarmResultProjection {
  status: AgentSwarmResult['status'];
  itemCount: number;
  startedItemCount: number;
  completedItemCount: number;
  failedItemCount: number;
  cancelledItemCount: number;
  artifactCount: number;
  durationMs: number;
}

/**
 * Bounded presentation/diagnostic facts derived from the canonical settled
 * tool result. This is a projection only: child AgentRuns remain the authority
 * for child lifecycle and artifacts.
 */
export function projectAgentSwarmResult(result: AgentSwarmResult): AgentSwarmResultProjection {
  let startedItemCount = 0;
  let completedItemCount = 0;
  let failedItemCount = 0;
  let cancelledItemCount = 0;
  let artifactCount = 0;

  for (const item of result.items) {
    if (item.started) startedItemCount += 1;
    if (item.status === 'completed') completedItemCount += 1;
    else if (item.status === 'failed') failedItemCount += 1;
    else cancelledItemCount += 1;
    artifactCount += item.artifactIds.length;
  }

  return {
    status: result.status,
    itemCount: result.items.length,
    startedItemCount,
    completedItemCount,
    failedItemCount,
    cancelledItemCount,
    artifactCount,
    durationMs: result.durationMs,
  };
}
