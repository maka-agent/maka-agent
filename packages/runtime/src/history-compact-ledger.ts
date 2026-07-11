import type { AgentRunStore } from '@maka/core';
import {
  validateHistoryCompactCheckpointShape,
  selectFurthestHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

export async function loadLatestHistoryCompactCheckpointFromRunLedger(
  runStore: Pick<AgentRunStore, 'listSessionRuns' | 'readEvents'>,
  sessionId: string,
): Promise<HistoryCompactCheckpoint | undefined> {
  const runs = await runStore.listSessionRuns(sessionId);
  let selected: HistoryCompactCheckpoint | undefined;
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex]!;
    const events = await runStore.readEvents(sessionId, run.runId);
    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = events[eventIndex]!;
      if (event.type !== 'history_compact_checkpoint_recorded') continue;
      const checkpoint = event.data?.checkpoint;
      if (validateHistoryCompactCheckpointShape(checkpoint, sessionId)) {
        selected = selectFurthestHistoryCompactCheckpoint(selected, checkpoint);
      }
    }
  }
  return selected;
}
