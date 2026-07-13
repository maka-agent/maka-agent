/**
 * AgentBackend contract types.
 *
 * The `AgentBackend` port interface and the request/response shapes that
 * cross the runtime boundary live here in @maka/core so that every backend
 * implementation (AiSdkBackend / PiAgentBackend / FakeBackend) and their
 * consumers depend on a small pure-type module, not on a concrete backend
 * implementation file.
 */

import type { AttachmentRef, SessionEvent } from './events.js';
import type { RuntimeEvent } from './runtime-event.js';
import type { StoredMessage, BackendKind } from './session.js';
import type { PermissionResponse } from './permission.js';
import type { ContextBudgetDiagnostic } from './usage-stats/types.js';

export interface BackendSendInput {
  /** AgentRun id for this invocation, when the caller has a run ledger. */
  runId?: string;
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

export interface BackendCompactHistoryInput {
  turnId: string;
  runtimeContext: readonly RuntimeEvent[];
}

export interface BackendCompactHistoryResult {
  contextBudget?: ContextBudgetDiagnostic;
}

export interface AgentBackend {
  readonly kind: BackendKind;
  readonly sessionId: string;
  send(input: BackendSendInput): AsyncIterable<SessionEvent>;
  compactHistory?(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult>;
  stop(reason: 'user_stop' | 'redirect'): Promise<void>;
  respondToPermission(decision: PermissionDecision): Promise<void>;
  dispose(): Promise<void>;
}
