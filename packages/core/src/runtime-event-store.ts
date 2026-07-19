import type { RuntimeEvent } from './runtime-event.js';

/** A requested stable-storage barrier failed; read-back cannot upgrade it to success. */
export class DurableStoreWriteError extends Error {
  readonly name = 'DurableStoreWriteError';

  constructor(
    message: string,
    readonly storeCause: unknown,
  ) {
    super(message);
  }
}

export interface RuntimeEventStore {
  appendRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
    options?: { durable?: boolean },
  ): Promise<void>;
  /** Append the terminal event if absent, or re-establish its stable-storage barrier if present. */
  ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void>;
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  /** Physical append-log rows only; excludes mutable partial snapshots. */
  readImmutableRuntimeEvents?(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}
