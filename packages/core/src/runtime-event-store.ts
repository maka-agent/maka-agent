import type { RuntimeEvent } from './runtime-event.js';

export interface RuntimeEventStore {
  appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void>;
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}
