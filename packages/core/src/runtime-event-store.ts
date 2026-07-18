import type { RuntimeEvent } from './runtime-event.js';

export interface RuntimeEventStore {
  /** Canonical stores fail the active run closed on every durable write error. */
  readonly durability?: 'best_effort' | 'canonical';
  appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void>;
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  /** Physical append-log rows only; excludes mutable partial snapshots. */
  readImmutableRuntimeEvents?(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}
