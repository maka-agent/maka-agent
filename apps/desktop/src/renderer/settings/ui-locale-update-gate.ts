import type { UiLocalePreference } from '@maka/core';

export interface UiLocaleUpdateGate {
  begin(hasLocalePreference: boolean): number | null;
  cancel(ticket: number | null): void;
  commit(
    ticket: number | null,
    preference: UiLocalePreference,
    onUiLocalePreferenceChange: (preference: UiLocalePreference) => void,
  ): boolean;
  beginHydration(): UiLocaleHydrationTicket;
  commitHydration(
    ticket: UiLocaleHydrationTicket,
    preference: UiLocalePreference,
    onUiLocalePreferenceChange: (preference: UiLocalePreference) => void,
  ): boolean;
}

export interface UiLocaleHydrationTicket {
  readonly id: number;
  readonly localeWriteRevision: number;
  readonly startedWhileWritePending: boolean;
}

/**
 * Keeps locale writes ordered independently from unrelated Settings writes.
 * The gate deliberately outlives the Settings surface's mounted ownership:
 * AppShell owns the callback and must receive a successful persisted value
 * even when the modal closes before the IPC response arrives.
 */
export function createUiLocaleUpdateGate(): UiLocaleUpdateGate {
  let writeRevision = 0;
  let latestTicket = 0;
  let appliedTicket = 0;
  let latestHydrationTicket = 0;
  const pendingTickets = new Set<number>();
  const successfulWrites = new Map<number, {
    preference: UiLocalePreference;
    apply: (preference: UiLocalePreference) => void;
  }>();

  function latestUnsettledTicket(): number {
    let latest = 0;
    for (const ticket of pendingTickets) latest = Math.max(latest, ticket);
    for (const ticket of successfulWrites.keys()) latest = Math.max(latest, ticket);
    return latest;
  }

  function applySuccessfulWrite(ticket: number): boolean {
    const successful = successfulWrites.get(ticket);
    if (!successful) return false;
    successfulWrites.delete(ticket);
    appliedTicket = Math.max(appliedTicket, ticket);
    for (const staleTicket of successfulWrites.keys()) {
      if (staleTicket < appliedTicket) successfulWrites.delete(staleTicket);
    }
    successful.apply(successful.preference);
    return true;
  }

  return {
    begin(hasLocalePreference) {
      if (!hasLocalePreference) return null;
      const ticket = ++writeRevision;
      latestTicket = ticket;
      pendingTickets.add(ticket);
      return ticket;
    },
    cancel(ticket) {
      if (ticket === null) return;
      pendingTickets.delete(ticket);
      successfulWrites.delete(ticket);
      if (ticket !== latestTicket) return;
      latestTicket = latestUnsettledTicket();
      applySuccessfulWrite(latestTicket);
    },
    commit(ticket, preference, onUiLocalePreferenceChange) {
      if (ticket === null) return false;
      pendingTickets.delete(ticket);
      if (ticket < appliedTicket) return false;
      successfulWrites.set(ticket, {
        preference,
        apply: onUiLocalePreferenceChange,
      });
      if (ticket !== latestTicket) return false;
      return applySuccessfulWrite(ticket);
    },
    beginHydration() {
      return {
        id: ++latestHydrationTicket,
        localeWriteRevision: writeRevision,
        startedWhileWritePending: pendingTickets.size > 0,
      };
    },
    commitHydration(ticket, preference, onUiLocalePreferenceChange) {
      if (
        ticket.id !== latestHydrationTicket
        || ticket.localeWriteRevision !== writeRevision
        || ticket.startedWhileWritePending
        || pendingTickets.size > 0
      ) {
        return false;
      }
      onUiLocalePreferenceChange(preference);
      return true;
    },
  };
}
