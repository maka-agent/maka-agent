export interface BootstrapSelectionLease<Summary extends { id: string; lastMessageAt?: number }> {
  reconcile(sessions: readonly Summary[]): boolean;
  release(): void;
}

export function createBootstrapSelectionLease<Summary extends { id: string; lastMessageAt?: number }>(options: {
  readActiveId: () => string | undefined;
  readSelectionRevision: () => number;
  select: (sessionId: string | undefined) => void;
}): BootstrapSelectionLease<Summary> {
  let ownedRevision = options.readSelectionRevision();
  let active = true;

  return {
    reconcile(sessions): boolean {
      if (!active || options.readSelectionRevision() !== ownedRevision) {
        active = false;
        return false;
      }

      const current = options.readActiveId();
      const next = current && sessions.some((session) => session.id === current)
        ? current
        : sessions[0]?.lastMessageAt
          ? sessions[0].id
          : undefined;
      if (next !== current) options.select(next);
      ownedRevision = options.readSelectionRevision();
      return true;
    },
    release(): void {
      active = false;
    },
  };
}
