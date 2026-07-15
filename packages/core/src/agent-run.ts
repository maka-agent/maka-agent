import type { PermissionMode } from './permission.js';
import type { BackendKind } from './session.js';

export const AGENT_RUN_STATUSES = [
  'created',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentRunStatus = typeof AGENT_RUN_STATUSES[number];

export interface AgentRunHeader {
  runId: string;
  /** Durable Runtime invocation spine. Optional only for legacy run headers. */
  invocationId?: string;
  sessionId: string;
  turnId: string;
  status: AgentRunStatus;
  backendKind: BackendKind;
  llmConnectionSlug: string;
  modelId: string;
  cwd: string;
  permissionMode: PermissionMode;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  parentRunId?: string;
  agentId?: string;
  agentName?: string;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  /** Non-user trigger for this run (e.g. a scheduled automation fire). */
  automationId?: string;
  failureClass?: string;
  failureMessage?: string;
  abortSource?: string;
  traceWriteError?: string;
}

export interface AgentRunInputSummary {
  textLength: number;
  attachmentCount: number;
}

export type AgentRunEventType =
  | 'run_created'
  | 'run_started'
  | 'turn_started'
  | 'run_status_changed'
  | 'model_resolved'
  | 'model_resolve_failed'
  | 'model_stream_started'
  | 'model_stream_completed'
  | 'model_stream_failed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'permission_requested'
  | 'permission_decided'
  | 'permission_failed'
  | 'approval_routed'
  | 'auto_review_started'
  | 'auto_review_decided'
  | 'auto_review_failed'
  | 'sandbox_escalation_requested'
  | 'sandbox_escalation_granted'
  | 'sandbox_escalation_denied'
  | 'sandbox_escalation_applied'
  | 'sandbox_escalation_failed'
  | 'sandbox_denial_detected'
  | 'usage_recorded'
  | 'history_compact_checkpoint_recorded'
  | 'active_full_compact_block_recorded'
  | 'semantic_compact_block_recorded'
  | 'task_gate_decided'
  | 'abort_requested'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled'
  | 'trace_write_failed'
  | 'event_corrupt';

export interface AgentRunEvent {
  type: AgentRunEventType;
  id: string;
  runId: string;
  sessionId: string;
  turnId: string;
  ts: number;
  message?: string;
  data?: Record<string, unknown>;
}

export interface AgentRunStore {
  createRun(header: AgentRunHeader): Promise<AgentRunHeader>;
  updateRun(sessionId: string, runId: string, patch: Partial<AgentRunHeader>): Promise<AgentRunHeader>;
  readRun(sessionId: string, runId: string): Promise<AgentRunHeader>;
  listSessionRuns(sessionId: string): Promise<AgentRunHeader[]>;
  appendEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void>;
  readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  /** `undefined` means uninitialized; `null` is an initialized empty projection. */
  readEventProjection?(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined>;
  /** Rewrites derived state after the canonical event ledger repairs an absent or damaged projection. */
  repairEventProjection?(
    sessionId: string,
    type: AgentRunEventType,
    event: AgentRunEvent | null,
    options?: { replaceEventId?: string },
  ): Promise<void>;
}
