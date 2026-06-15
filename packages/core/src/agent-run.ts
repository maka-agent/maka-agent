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
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  failureClass?: string;
  failureMessage?: string;
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
  | 'usage_recorded'
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
}
