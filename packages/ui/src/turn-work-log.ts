import type { TurnTimelineItem } from './materialize.js';

export function shouldAutoCollapseWorkLog(previousLive: boolean, live: boolean): boolean {
  return previousLive && !live;
}

/**
 * Resolve the controlled disclosure state during a live -> settled render.
 * Returning `false` synchronously keeps the just-settled process body out of
 * that commit instead of waiting for an effect and paying for one final full
 * Markdown render before it disappears.
 */
export function resolveWorkLogOpen(
  open: boolean,
  previousLive: boolean,
  live: boolean,
): boolean {
  return shouldAutoCollapseWorkLog(previousLive, live) ? false : open;
}

/**
 * Live-turn overlaying recreates timeline wrapper objects on every answer
 * delta. Compare their render-bearing fields so an unchanged process log can
 * stay behind a memo boundary while the final answer continues streaming.
 */
export function areWorkLogTimelineItemsEqual(
  previous: TurnTimelineItem,
  next: TurnTimelineItem,
): boolean {
  if (previous === next) return true;
  if (previous.kind !== next.kind) return false;
  if (previous.kind === 'tools' && next.kind === 'tools') {
    return previous.items.length === next.items.length
      && previous.items.every((item, index) => item === next.items[index]);
  }
  if (previous.kind === 'thinking' && next.kind === 'thinking') {
    return previous.messageId === next.messageId
      && previous.text === next.text
      && previous.live === next.live
      && previous.truncated === next.truncated;
  }
  if (previous.kind === 'text' && next.kind === 'text') {
    return previous.messageId === next.messageId
      && previous.text === next.text
      && previous.ts === next.ts
      && previous.live === next.live
      && previous.complete === next.complete
      && previous.truncated === next.truncated;
  }
  return false;
}

export function areWorkLogTimelineListsEqual(
  previous: readonly TurnTimelineItem[],
  next: readonly TurnTimelineItem[],
): boolean {
  return previous === next
    || (previous.length === next.length
      && previous.every((item, index) => areWorkLogTimelineItemsEqual(item, next[index]!)));
}

/**
 * A tool-bearing turn gets exactly one final answer: the last text block after
 * the last tool. Earlier user-visible text and tools belong to the process log;
 * provider reasoning is removed from both surfaces.
 */
export function splitTimelineAtLastTool(items: readonly TurnTimelineItem[]): {
  workLog: TurnTimelineItem[];
  answer: TurnTimelineItem[];
} {
  // Provider reasoning is internal model state, not user-facing narration.
  // Keeping it out of both surfaces prevents raw English chain-of-thought from
  // appearing beside a Chinese answer (and avoids rendering it while streaming).
  const visibleItems = items.filter((item) => item.kind !== 'thinking');
  let lastToolIndex = -1;
  for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
    if (visibleItems[index]?.kind === 'tools') {
      lastToolIndex = index;
      break;
    }
  }
  if (lastToolIndex < 0) return { workLog: [], answer: visibleItems };
  let finalAnswerIndex = -1;
  for (let index = visibleItems.length - 1; index > lastToolIndex; index -= 1) {
    if (visibleItems[index]?.kind === 'text') {
      finalAnswerIndex = index;
      break;
    }
  }
  if (finalAnswerIndex < 0) return { workLog: visibleItems, answer: [] };
  return {
    workLog: [
      ...visibleItems.slice(0, finalAnswerIndex),
      ...visibleItems.slice(finalAnswerIndex + 1),
    ],
    answer: [visibleItems[finalAnswerIndex]!],
  };
}
