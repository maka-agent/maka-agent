/**
 * Session disk format: JSONL with SessionHeader as line 1 + append-only
 * StoredMessage lines.
 *
 * Source: V0.1_TECH_SPEC.md §4.2
 *
 * Storage layer enforces append-only for messages and read-rewrite-write
 * (atomic temp + rename) for header. Per-session write queue invariant
 * documented in spec §5.2.
 */

import type { AttachmentRef, ToolActivityKind, ToolResultContent } from './events.js';
import type { PermissionMode } from './permission.js';
import type {
  CacheMissInputSource,
  ContextBudgetDiagnostic,
  PrefixChangeReason,
  PromptSegmentEstimate,
} from './usage-stats/types.js';

export const SESSION_STATUSES = [
  'active',
  'running',
  'waiting_for_user',
  'blocked',
  'review',
  'done',
  'archived',
  'aborted',
] as const;

export type SessionStatus = typeof SESSION_STATUSES[number];

export const SESSION_BLOCKED_REASONS = [
  'NO_REAL_CONNECTION',
  'auth',
  'permission_required',
  'tool_failed',
  'unknown',
] as const;

export type SessionBlockedReason = typeof SESSION_BLOCKED_REASONS[number];

export const TURN_STATUSES = [
  'running',
  'completed',
  'aborted',
  'failed',
] as const;

export type TurnStatus = typeof TURN_STATUSES[number];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isSessionBlockedReason(value: unknown): value is SessionBlockedReason {
  return typeof value === 'string' && (SESSION_BLOCKED_REASONS as readonly string[]).includes(value);
}

export function isTurnStatus(value: unknown): value is TurnStatus {
  return typeof value === 'string' && (TURN_STATUSES as readonly string[]).includes(value);
}

// ============================================================================
// Header (JSONL line 1)
// ============================================================================

export interface SessionHeader {
  // Identity
  id: string;
  workspaceRoot: string;
  cwd: string;

  // Lifecycle timestamps
  createdAt: number;
  lastUsedAt: number;
  lastMessageAt?: number;

  // User metadata
  name: string;
  isFlagged: boolean;
  labels: string[];

  isArchived: boolean;
  archivedAt?: number;
  status: SessionStatus;
  blockedReason?: SessionBlockedReason;
  statusUpdatedAt?: number;
  parentSessionId?: string;
  branchOfTurnId?: string;

  // Unread tracking
  lastReadMessageId?: string;
  hasUnread: boolean;

  // Backend / model config
  backend: BackendKind;
  llmConnectionSlug: string;
  /** True after first UserMessage is flushed. Storage self-heals (§5.2). */
  connectionLocked: boolean;
  /** Sticky session default model id, captured when the session is created. */
  model: string;
  /** Per-model reasoning-depth variant; `undefined` = model default. Cleared on model switch. */
  thinkingLevel?: import('./model-thinking.js').ThinkingLevel;
  permissionMode: PermissionMode;

  /** Forward-compatible schema versioning. V0.1 only writes 1. */
  schemaVersion: 1;
}

export type BackendKind = 'ai-sdk' | 'fake' | 'pi-agent';

export interface SessionSummary {
  id: string;
  cwd?: string;
  name: string;
  isFlagged: boolean;
  isArchived: boolean;
  labels: string[];
  hasUnread: boolean;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  status: SessionStatus;
  blockedReason?: SessionBlockedReason;
  statusUpdatedAt?: number;
  parentSessionId?: string;
  branchOfTurnId?: string;
  backend: BackendKind;
  llmConnectionSlug: string;
  /** Sticky session default model id for renderer/header display. */
  model: string;
  /** Per-model reasoning-depth variant; `undefined` = model default. Cleared on model switch. */
  thinkingLevel?: import('./model-thinking.js').ThinkingLevel;
  permissionMode: PermissionMode;
}

export type SessionChangedReason =
  | 'created'
  | 'updated'
  | 'archived'
  | 'deleted'
  | 'message-appended'
  | 'pinned'
  | 'renamed'
  | 'mode-change'
  | 'status-change'
  | 'turn-status-change'
  | 'rebound';

export interface SessionChangedEvent {
  type: 'sessions_changed';
  reason: SessionChangedReason;
  sessionId?: string;
  connectionSlug?: string;
  modelId?: string;
  ts: number;
}

// ============================================================================
// Stored messages (JSONL line 2+, append-only)
// ============================================================================

export type StoredMessage =
  | UserMessage
  | AssistantMessage
  | ToolCallMessage
  | ToolResultMessage
  | PermissionDecisionMessage
  | TokenUsageMessage
  | TurnStateMessage
  | SystemNoteMessage;

export interface UserMessage {
  type: 'user';
  id: string;
  turnId: string;
  ts: number;
  text: string;
  attachments?: AttachmentRef[];
  /** Non-user trigger source (automation fire). Lets the chat mark turns the
   *  user did not hand-type. Mirrors TurnOrigin in runtime-inputs. */
  origin?: { kind: 'automation'; automationId: string };
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  turnId: string;
  ts: number;
  text: string;
  thinking?: {
    text: string;
    /** Anthropic signed thinking for replay. */
    signature?: string;
  };
  /**
   * First-observed order of visible content inside this assistant step.
   * RuntimeEvent projection records partial text/thinking and the paired tool
   * call before dropping partial rows, so live and persisted timelines can use
   * the same append-only order. Absent on legacy rows, which retain the older
   * semantic thinking → text → tools fallback.
   */
  contentOrder?: AssistantStepContentKind[];
  /** Actual model used for this turn. */
  modelId: string;
}

export type AssistantStepContentKind = 'thinking' | 'text' | 'tools';

export interface ToolCallMessage {
  type: 'tool_call';
  /** Equals toolUseId — used to match ToolResultMessage.toolUseId. */
  id: string;
  turnId: string;
  ts: number;
  toolName: string;
  /** Stable semantic category for presentation; absent on legacy rows. */
  activityKind?: ToolActivityKind;
  displayName?: string;
  intent?: string;
  args: unknown;
  /**
   * Assistant step this call belongs to (equals the step's AssistantMessage
   * id, stamped from the same source as ToolStartEvent.stepId). Optional for
   * legacy rows written before per-step persistence. First consumer is the UI
   * timeline (materializeTurns), which orders a step's thinking/text ahead of
   * the tools whose stepId matches that step; the backfill path also reads it
   * to re-pair tools with their step after a restart.
   */
  stepId?: string;
}

export interface ToolResultMessage {
  type: 'tool_result';
  /** Own message id (not the tool's). */
  id: string;
  turnId: string;
  ts: number;
  /** Matches ToolCallMessage.id. */
  toolUseId: string;
  isError: boolean;
  content: ToolResultContent;
  durationMs?: number;
}

export interface PermissionDecisionMessage {
  type: 'permission_decision';
  /** Equals PermissionRequestEvent.requestId for audit correlation. */
  id: string;
  turnId: string;
  ts: number;
  toolUseId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  rememberForTurn?: boolean;
  hint?: string;
}

export interface TokenUsageMessage {
  type: 'token_usage';
  id: string;
  turnId: string;
  ts: number;
  input: number;
  output: number;
  cacheHitInput?: number;
  cacheMissInput?: number;
  cacheWriteInput?: number;
  cacheMissInputSource?: CacheMissInputSource;
  reasoning?: number;
  total?: number;
  rawFinishReason?: string;
  /** Number of provider runtime/tool-loop steps represented by this usage. */
  runtimeSteps?: number;
  /** Backward-compatible alias for cacheHitInput. */
  cacheRead?: number;
  /** Backward-compatible alias for cacheWriteInput. */
  cacheCreation?: number;
  costUsd?: number;
  systemPromptHash?: string;
  prefixHash?: string;
  prefixChangeReason?: PrefixChangeReason;
  requestShapeHash?: string;
  requestShapeChangeReason?: PrefixChangeReason;
  promptSegments?: PromptSegmentEstimate[];
  contextBudget?: ContextBudgetDiagnostic;
}

export interface TurnStateMessage {
  type: 'turn_state';
  id: string;
  turnId: string;
  ts: number;
  status: TurnStatus;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  abortedAt?: number;
  /** Diagnostic source for user/renderer-triggered aborts, e.g. renderer.stop_button. */
  abortSource?: string;
  errorClass?: string;
  partialOutputRetained: boolean;
}

export interface TurnRecord {
  turnId: string;
  status: TurnStatus;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  abortedAt?: number;
  abortSource?: string;
  errorClass?: string;
  partialOutputRetained: boolean;
}

export interface SystemNoteMessage {
  type: 'system_note';
  id: string;
  /** Session-level notes omit turnId. */
  turnId?: string;
  ts: number;
  kind:
    | 'session_start'
    | 'session_resume'
    | 'mode_change'
    | 'model_change'
    | 'context_compacted'
    | 'error'
    | 'abort';
  /** Shape depends on `kind`. */
  data?: unknown;
}

export function deriveTurnRecords(messages: readonly StoredMessage[]): TurnRecord[] {
  const order: string[] = [];
  const buckets = new Map<string, StoredMessage[]>();
  for (const message of messages) {
    const turnId = (message as { turnId?: string }).turnId;
    if (!turnId) continue;
    if (!buckets.has(turnId)) {
      buckets.set(turnId, []);
      order.push(turnId);
    }
    buckets.get(turnId)!.push(message);
  }

  return order.map((turnId) => {
    const bucket = buckets.get(turnId) ?? [];
    const latestState = bucket
      .filter((message): message is TurnStateMessage => message.type === 'turn_state')
      .at(-1);
    const partialOutputRetained = bucket.some((message) =>
      (message.type === 'assistant' && message.text.trim().length > 0) ||
      message.type === 'tool_result',
    );
    if (latestState) {
      return {
        turnId,
        status: latestState.status,
        ...(latestState.parentTurnId ? { parentTurnId: latestState.parentTurnId } : {}),
        ...(latestState.retriedFromTurnId ? { retriedFromTurnId: latestState.retriedFromTurnId } : {}),
        ...(latestState.regeneratedFromTurnId ? { regeneratedFromTurnId: latestState.regeneratedFromTurnId } : {}),
        ...(latestState.branchOfTurnId ? { branchOfTurnId: latestState.branchOfTurnId } : {}),
        ...(latestState.parentSessionId ? { parentSessionId: latestState.parentSessionId } : {}),
        ...(latestState.abortedAt !== undefined ? { abortedAt: latestState.abortedAt } : {}),
        ...(latestState.abortSource ? { abortSource: latestState.abortSource } : {}),
        ...(latestState.errorClass ? { errorClass: latestState.errorClass } : {}),
        partialOutputRetained: latestState.partialOutputRetained || partialOutputRetained,
      };
    }
    return {
      turnId,
      status: inferLegacyTurnStatus(bucket),
      partialOutputRetained,
    };
  });
}

function inferLegacyTurnStatus(messages: readonly StoredMessage[]): TurnStatus {
  if (messages.some((message) => message.type === 'system_note' && message.kind === 'abort')) return 'aborted';
  if (messages.some((message) => message.type === 'assistant')) return 'completed';
  if (messages.some((message) => message.type === 'tool_result' && message.isError)) return 'failed';
  return 'completed';
}
