import type { IpcMain } from 'electron';
import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import { MODEL_CALL_ATTEMPT_EVENT_TYPE } from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { PromptComposition, SessionTrace } from '@maka/core/session-trace';
import { tryResult } from '@maka/core/result';
import { projectSessionTrace, readPromptCompositionEvent } from '@maka/runtime';

/**
 * Read-only projection of one session's causal trace for the Inspector (#1625).
 *
 * Reads two ledgers and writes nothing. The AgentRun stream is the authority
 * for canonical metering — not the Usage read model, which is range-queried and
 * carries no session predicate — and `readSessionRuntimeEvents` supplies the
 * causal structure the metering ledger knows nothing about.
 */
export interface InspectorIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  readSessionRuntimeEvents: (sessionId: string) => Promise<readonly RuntimeEvent[]>;
  listSessionRuns: (sessionId: string) => Promise<readonly { readonly runId: string }[]>;
  readRunEvents: (
    sessionId: string,
    runId: string,
  ) => Promise<readonly { readonly type: string; readonly data?: unknown }[]>;
}

export function registerInspectorIpc(deps: InspectorIpcDeps): void {
  deps.ipcMain.handle('inspector:trace', (_event, sessionId: string) =>
    tryResult(async () => await readSessionTrace(deps, sessionId), 'INSPECTOR_TRACE_FAILED'),
  );
}

export async function readSessionTrace(
  deps: Omit<InspectorIpcDeps, 'ipcMain'>,
  sessionId: string,
): Promise<SessionTrace> {
  const [runtimeEvents, runs] = await Promise.all([
    deps.readSessionRuntimeEvents(sessionId),
    deps.listSessionRuns(sessionId),
  ]);

  const modelCallAttempts: ModelCallAttempt[] = [];
  let unreadableRecords = 0;
  // Per run rather than per session: the authority stream is keyed that way, so
  // reading it run by run is reading it as it is stored, not reshaping it.
  //
  // Each run's events are read independently because a read failure is just
  // another way a record can be unreadable: one corrupt event row would
  // otherwise fail the whole trace on every retry, the opposite of the
  // "counted, not dropped" rule this projection is built on.
  //
  // The two reads above are NOT covered by that. `listSessionRunsForRecovery`
  // parses every header row with no per-row tolerance
  // (`agent-run-store.ts:333`), so one corrupt header still rejects the whole
  // trace. Fixing it there changes the contract every recovery caller depends
  // on, which is a decision about recovery rather than about this read model —
  // so it is stated here rather than quietly half-fixed.
  const runEvents = await Promise.all(
    runs.map(async (run) => {
      try {
        return await deps.readRunEvents(sessionId, run.runId);
      } catch {
        // Nothing is known about how many records the run held, so it counts as
        // one gap rather than a guess at its size.
        unreadableRecords += 1;
        return [];
      }
    }),
  );
  // Composition rides the same walk as metering: both live on this stream, and
  // recognising a second event type costs one branch rather than a second read
  // path with its own traversal (#2323). It is deliberately NOT counted into
  // `unreadableRecords` — that number is about spend the trace cannot show, and
  // a missing composition loses no spend. It shows as an attempt without a
  // breakdown, which the panel states as a gap.
  const promptCompositions = new Map<string, PromptComposition>();
  for (const events of runEvents) {
    for (const event of events) {
      if (event.type === MODEL_CALL_ATTEMPT_EVENT_TYPE) {
        try {
          modelCallAttempts.push(decodeModelCallAttempt(event.data));
        } catch {
          // A record that will not decode is spend this trace cannot show.
          // Counted so the gap is visible; dropping it silently is the failure
          // this projection exists to avoid.
          unreadableRecords += 1;
        }
        continue;
      }
      const composition = readPromptCompositionEvent(event);
      // Later wins: an attempt is captured once, but a stream read has no
      // dedupe, and the last append is the one the metering record settled on.
      if (composition) promptCompositions.set(composition.attemptId, composition.composition);
    }
  }

  return projectSessionTrace({
    sessionId,
    runtimeEvents,
    modelCallAttempts,
    ...(promptCompositions.size > 0 ? { promptCompositions } : {}),
    ...(unreadableRecords > 0 ? { unreadableRecords } : {}),
  });
}
