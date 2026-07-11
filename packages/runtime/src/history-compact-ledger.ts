import type { AgentRunEvent, AgentRunStore } from '@maka/core';
import {
  validateHistoryCompactCheckpointShape,
  selectFurthestHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

export async function loadLatestHistoryCompactCheckpointFromRunLedger(
  runStore: Pick<
    AgentRunStore,
    'listSessionRuns' | 'readEvents' | 'readEventProjection' | 'repairEventProjection'
  >,
  sessionId: string,
): Promise<HistoryCompactCheckpoint | undefined> {
  if (runStore.readEventProjection) {
    try {
      const projected = await runStore.readEventProjection(
        sessionId,
        'history_compact_checkpoint_recorded',
      );
      if (projected === null) return undefined;
      const checkpoint = projected?.data?.checkpoint;
      if (validateHistoryCompactCheckpointShape(checkpoint, sessionId)) return checkpoint;
    } catch {
      // Recover the derived projection from the canonical ledger below.
    }
  }
  const runs = await runStore.listSessionRuns(sessionId);
  let selected: HistoryCompactCheckpoint | undefined;
  let selectedEvent: AgentRunEvent | null = null;
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex]!;
    const events = await runStore.readEvents(sessionId, run.runId);
    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = events[eventIndex]!;
      if (event.type !== 'history_compact_checkpoint_recorded') continue;
      const checkpoint = event.data?.checkpoint;
      if (validateHistoryCompactCheckpointShape(checkpoint, sessionId)) {
        const next = selectFurthestHistoryCompactCheckpoint(selected, checkpoint);
        if (next === checkpoint) {
          selected = checkpoint;
          selectedEvent = event;
        }
      }
    }
  }
  await runStore.repairEventProjection?.(
    sessionId,
    'history_compact_checkpoint_recorded',
    selectedEvent,
  ).catch(() => {
    // Recovery succeeded; a later cold read can retry this derived-state repair.
  });
  return selected;
}
