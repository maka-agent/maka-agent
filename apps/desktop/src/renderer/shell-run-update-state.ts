import {
  mergeShellRunUpdate,
  projectShellRunUpdateForSession,
  type ShellRunUpdate,
} from '@maka/core';

export type ShellRunUpdatesBySession = Record<string, Record<string, ShellRunUpdate>>;

export function mergeShellRunUpdates(
  current: ShellRunUpdatesBySession,
  updates: readonly ShellRunUpdate[],
): ShellRunUpdatesBySession {
  let next = current;
  for (const update of updates) {
    const session = next[update.sessionId] ?? {};
    const previous = session[update.sourceToolCallId];
    const merged = mergeShellRunUpdate(
      previous,
      update,
      'desktop.shell-run-update-state',
    );
    if (!merged.changed) continue;
    if (next === current) next = { ...current };
    next[update.sessionId] = {
      ...session,
      [update.sourceToolCallId]: merged.update,
    };
  }
  return next;
}

export function mergeShellRunNotification(
  current: ShellRunUpdatesBySession,
  sessionId: string,
  update: ShellRunUpdate,
): ShellRunUpdatesBySession {
  return mergeShellRunUpdates(
    current,
    projectShellRunUpdateForSession(
      sessionId,
      Object.values(current[sessionId] ?? {}),
      update,
    ),
  );
}
