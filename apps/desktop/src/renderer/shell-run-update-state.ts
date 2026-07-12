import { mergeShellRunStateWithDiagnostics, type ShellRunUpdate } from '@maka/core';

export type ShellRunUpdatesBySession = Record<string, Record<string, ShellRunUpdate>>;

export function mergeShellRunUpdates(
  current: ShellRunUpdatesBySession,
  updates: readonly ShellRunUpdate[],
): ShellRunUpdatesBySession {
  let next = current;
  for (const update of updates) {
    const session = next[update.sessionId] ?? {};
    const previous = session[update.sourceToolCallId];
    const merged = mergeShellRunStateWithDiagnostics(
      previous?.result,
      update.result,
      'desktop.shell-run-update-state',
    );
    if (!merged.changed) continue;
    if (next === current) next = { ...current };
    next[update.sessionId] = {
      ...session,
      [update.sourceToolCallId]: { ...update, result: merged.result },
    };
  }
  return next;
}
