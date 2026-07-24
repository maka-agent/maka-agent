import type { RuntimeEvent } from './runtime-event.js';

export const RUNTIME_FACT_WRITE_CAPABILITY_V1 = 'runtime_fact_envelope_v1' as const;
export type RuntimeFactWriteCapability = typeof RUNTIME_FACT_WRITE_CAPABILITY_V1;

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
  /** Canonical stores fail the active run closed on every durable write error. */
  readonly durability?: 'best_effort' | 'canonical';
  /** Present only when the store's downgrade gate protects runtime-fact readers. */
  readonly runtimeFactWriteCapability?: RuntimeFactWriteCapability;
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
