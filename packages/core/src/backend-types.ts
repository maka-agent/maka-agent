/**
 * AgentBackend contract types.
 *
 * Source: V0.1_TECH_SPEC.md §13 + §6.1
 *
 * The full `AgentBackend` interface lives in @maka/runtime since
 * the implementations (AiSdkBackend / FakeBackend) are runtime
 * concerns. Core only exports the request/response shapes that cross the
 * runtime boundary.
 */

import type { AttachmentRef } from './events.js';
import type { RuntimeEvent } from './runtime-event.js';
import type { StoredMessage } from './session.js';
import type { PermissionResponse } from './permission.js';

export interface BackendSendInput {
  /** Caller-generated turn id shared by the persisted UserMessage and every emitted event. */
  turnId: string;
  text: string;
  attachments?: AttachmentRef[];
  /**
   * Prior conversation projected from the RuntimeEvent ledger into the
   * existing StoredMessage public shape. Adapters materialize this into the
   * SDK's expected conversation shape when native RuntimeEvent replay is not
   * available.
   */
  context: StoredMessage[];
  /**
   * Optional prior RuntimeEvent ledger for model-history projection. Backends
   * prefer this when supplied and usable; `context` is the RuntimeEvent-derived
   * compatibility projection.
   */
  runtimeContext?: RuntimeEvent[];
}

/** Alias for clarity at the backend boundary. */
export type PermissionDecision = PermissionResponse;
