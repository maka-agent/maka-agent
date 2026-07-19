import { isPermissionMode, type PermissionMode } from './permission.js';
import type { BackendKind } from './session.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';

export const AGENT_RUN_STATUSES = [
  'created',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

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

export const AGENT_RUN_EVENT_TYPES = [
  'run_created',
  'run_started',
  'turn_started',
  'run_status_changed',
  'model_resolved',
  'model_resolve_failed',
  'model_stream_started',
  'model_stream_completed',
  'model_stream_failed',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'permission_requested',
  'permission_decided',
  'permission_failed',
  'approval_routed',
  'auto_review_started',
  'auto_review_decided',
  'auto_review_failed',
  'sandbox_escalation_requested',
  'sandbox_escalation_granted',
  'sandbox_escalation_denied',
  'sandbox_escalation_applied',
  'sandbox_escalation_failed',
  'sandbox_denial_detected',
  'usage_recorded',
  'history_compact_checkpoint_recorded',
  'active_full_compact_block_recorded',
  'semantic_compact_block_recorded',
  'task_gate_decided',
  'abort_requested',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'trace_write_failed',
  'event_corrupt',
] as const;

export type AgentRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number];

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

const AGENT_RUN_HEADER_SHAPE = defineObjectShape<AgentRunHeader>()(
  [
    'runId',
    'sessionId',
    'turnId',
    'status',
    'backendKind',
    'llmConnectionSlug',
    'modelId',
    'cwd',
    'permissionMode',
    'createdAt',
    'updatedAt',
  ],
  [
    'invocationId',
    'completedAt',
    'parentRunId',
    'agentId',
    'agentName',
    'parentTurnId',
    'retriedFromTurnId',
    'regeneratedFromTurnId',
    'branchOfTurnId',
    'parentSessionId',
    'automationId',
    'failureClass',
    'failureMessage',
    'abortSource',
    'traceWriteError',
  ],
);

const AGENT_RUN_EVENT_SHAPE = defineObjectShape<AgentRunEvent>()(
  ['type', 'id', 'runId', 'sessionId', 'turnId', 'ts'],
  ['message', 'data'],
);

export function decodeAgentRunHeader(value: unknown): AgentRunHeader {
  if (!isRecord(value) || !hasExactShape(value, AGENT_RUN_HEADER_SHAPE)) {
    throw new Error('Invalid AgentRun header schema');
  }
  const valid =
    typeof value.runId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.turnId === 'string' &&
    (AGENT_RUN_STATUSES as readonly unknown[]).includes(value.status) &&
    isBackendKind(value.backendKind) &&
    typeof value.llmConnectionSlug === 'string' &&
    typeof value.modelId === 'string' &&
    typeof value.cwd === 'string' &&
    isPermissionMode(value.permissionMode) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isOptionalString(value.invocationId) &&
    (value.completedAt === undefined || isFiniteNumber(value.completedAt)) &&
    [
      value.parentRunId,
      value.agentId,
      value.agentName,
      value.parentTurnId,
      value.retriedFromTurnId,
      value.regeneratedFromTurnId,
      value.branchOfTurnId,
      value.parentSessionId,
      value.automationId,
      value.failureClass,
      value.failureMessage,
      value.abortSource,
      value.traceWriteError,
    ].every(isOptionalString);
  if (!valid) throw new Error('Invalid AgentRun header schema');
  return value as unknown as AgentRunHeader;
}

export function decodeAgentRunEvent(value: unknown): AgentRunEvent {
  if (
    !isRecord(value) ||
    !hasExactShape(value, AGENT_RUN_EVENT_SHAPE) ||
    !(AGENT_RUN_EVENT_TYPES as readonly unknown[]).includes(value.type) ||
    typeof value.id !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.turnId !== 'string' ||
    !isFiniteNumber(value.ts) ||
    !isOptionalString(value.message) ||
    (value.data !== undefined && !isRecord(value.data))
  ) {
    throw new Error('Invalid AgentRun event schema');
  }
  return value as unknown as AgentRunEvent;
}

function isBackendKind(value: unknown): value is BackendKind {
  return value === 'ai-sdk' || value === 'fake' || value === 'pi-agent';
}

export interface AgentRunStore {
  createRun(header: AgentRunHeader, options?: { durable?: boolean }): Promise<AgentRunHeader>;
  updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<AgentRunHeader>,
    options?: { durable?: boolean },
  ): Promise<AgentRunHeader>;
  readRun(sessionId: string, runId: string): Promise<AgentRunHeader>;
  listSessionRuns(sessionId: string): Promise<AgentRunHeader[]>;
  appendEvent(
    sessionId: string,
    runId: string,
    event: AgentRunEvent,
    options?: { durable?: boolean },
  ): Promise<void>;
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
