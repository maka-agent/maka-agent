/**
 * Session disk format: JSONL with SessionHeader as line 1 + append-only
 * StoredMessage lines.
 * Storage layer enforces append-only for messages and read-rewrite-write
 * (atomic temp + rename) for header. Per-session write queue invariant
 * is enforced by the storage implementation.
 */

import {
  TOOL_ACTIVITY_KINDS,
  type AttachmentRef,
  type ToolActivityKind,
  type ToolResultContent,
} from './events.js';
import type { PermissionMode } from './permission.js';
import type {
  CacheMissInputSource,
  ContextBudgetDiagnostic,
  PrefixChangeReason,
  PromptSegmentEstimate,
} from './usage-stats/types.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';
import { isAttachmentRef, isPermissionDecisionFields } from './interaction-record-schema.js';
import { isTokenUsageFields } from './usage-record-schema.js';
import {
  decodeCanonicalToolResultContent,
  normalizeToolResultContentForRead,
} from './tool-result-record-schema.js';

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

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_BLOCKED_REASONS = [
  'NO_REAL_CONNECTION',
  'auth',
  'permission_required',
  'tool_failed',
  'unknown',
] as const;

export type SessionBlockedReason = (typeof SESSION_BLOCKED_REASONS)[number];

export const TURN_STATUSES = ['running', 'completed', 'aborted', 'failed'] as const;

export type TurnStatus = (typeof TURN_STATUSES)[number];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isSessionBlockedReason(value: unknown): value is SessionBlockedReason {
  return (
    typeof value === 'string' && (SESSION_BLOCKED_REASONS as readonly string[]).includes(value)
  );
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
  /** One-shot model context to inject after a CLI session cwd move. */
  pendingCwdReminder?: { from: string; to: string };

  // Lifecycle timestamps
  createdAt: number;
  lastUsedAt: number;
  lastMessageAt?: number;

  // User metadata
  name: string;
  titleIsManual: boolean;
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
  /** One-shot model context to inject after a CLI session cwd move. */
  pendingCwdReminder?: { from: string; to: string };
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
  /**
   * True once the session has user messages — its connection/model is
   * sticky and the send path will never silently rebind it. Surfaced so
   * the renderer can project send outcomes (#1038) without a main
   * round-trip.
   */
  connectionLocked: boolean;
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
  | 'goal-change'
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
  /**
   * Model-facing turn text (and the default human-facing text). May be a
   * composed envelope when the client injected content such as explicit
   * skill instructions; see `displayText`.
   */
  text: string;
  /**
   * Human-facing text when it differs from `text`. Presentation layers
   * (transcript, rewind, previews, search) should prefer this. Absent on
   * legacy rows and on turns where the model text is what the user typed.
   */
  displayText?: string;
  attachments?: AttachmentRef[];
  /** Non-user trigger source (automation fire). Lets the chat mark turns the
   *  user did not hand-type. Mirrors TurnOrigin in runtime-inputs. */
  origin?: { kind: 'automation'; automationId: string };
}

/** Prefer the human-facing view of a user message when one was stored. */
export function userFacingText(message: Pick<UserMessage, 'text' | 'displayText'>): string {
  return message.displayText ?? message.text;
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
  reviewer?: import('./permission.js').ApprovalsReviewer;
  rationale?: string;
  riskLevel?: import('./permission.js').ApprovalRiskLevel;
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
    | 'context_compaction_failed_open'
    | 'step_limit'
    | 'error'
    | 'abort';
  /** Shape depends on `kind`. */
  data?: unknown;
}

const USER_MESSAGE_SHAPE = defineObjectShape<UserMessage>()(
  ['type', 'id', 'turnId', 'ts', 'text'],
  ['displayText', 'attachments', 'origin'],
);
const ASSISTANT_MESSAGE_SHAPE = defineObjectShape<AssistantMessage>()(
  ['type', 'id', 'turnId', 'ts', 'text', 'modelId'],
  ['thinking', 'contentOrder'],
);
const TOOL_CALL_MESSAGE_SHAPE = defineObjectShape<ToolCallMessage>()(
  ['type', 'id', 'turnId', 'ts', 'toolName', 'args'],
  ['activityKind', 'displayName', 'intent', 'stepId'],
);
const TOOL_RESULT_MESSAGE_SHAPE = defineObjectShape<ToolResultMessage>()(
  ['type', 'id', 'turnId', 'ts', 'toolUseId', 'isError', 'content'],
  ['durationMs'],
);
const PERMISSION_DECISION_MESSAGE_SHAPE = defineObjectShape<PermissionDecisionMessage>()(
  ['type', 'id', 'turnId', 'ts', 'toolUseId', 'toolName', 'decision'],
  ['rememberForTurn', 'reviewer', 'rationale', 'riskLevel', 'hint'],
);
const TOKEN_USAGE_MESSAGE_SHAPE = defineObjectShape<TokenUsageMessage>()(
  ['type', 'id', 'turnId', 'ts', 'input', 'output'],
  [
    'cacheHitInput',
    'cacheMissInput',
    'cacheWriteInput',
    'cacheMissInputSource',
    'reasoning',
    'total',
    'rawFinishReason',
    'runtimeSteps',
    'cacheRead',
    'cacheCreation',
    'costUsd',
    'systemPromptHash',
    'prefixHash',
    'prefixChangeReason',
    'requestShapeHash',
    'requestShapeChangeReason',
    'promptSegments',
    'contextBudget',
  ],
);
const TURN_STATE_MESSAGE_SHAPE = defineObjectShape<TurnStateMessage>()(
  ['type', 'id', 'turnId', 'ts', 'status', 'partialOutputRetained'],
  [
    'parentTurnId',
    'retriedFromTurnId',
    'regeneratedFromTurnId',
    'branchOfTurnId',
    'parentSessionId',
    'abortedAt',
    'abortSource',
    'errorClass',
  ],
);
const SYSTEM_NOTE_MESSAGE_SHAPE = defineObjectShape<SystemNoteMessage>()(
  ['type', 'id', 'ts', 'kind'],
  ['turnId', 'data'],
);
type AssistantThinking = NonNullable<AssistantMessage['thinking']>;
const ASSISTANT_THINKING_SHAPE = defineObjectShape<AssistantThinking>()(['text'], ['signature']);
type AutomationOrigin = NonNullable<UserMessage['origin']>;
const AUTOMATION_ORIGIN_SHAPE = defineObjectShape<AutomationOrigin>()(['kind', 'automationId'], []);

const SYSTEM_NOTE_KINDS = new Set([
  'session_start',
  'session_resume',
  'mode_change',
  'model_change',
  'context_compacted',
  'context_compaction_failed_open',
  'step_limit',
  'error',
  'abort',
]);

export function decodeStoredMessageForRead(value: unknown): StoredMessage {
  return decodeStoredMessage(value, normalizeToolResultContentForRead);
}

export function decodeStoredMessageForRecovery(value: unknown): StoredMessage {
  return decodeStoredMessage(value, decodeCanonicalToolResultContent);
}

function decodeStoredMessage(
  value: unknown,
  decodeToolResultContent: (content: unknown) => ToolResultContent,
): StoredMessage {
  const message = decodeStoredMessageContent(value, decodeToolResultContent);
  if (!isRecord(message)) throw new Error('Invalid stored message schema');
  switch (message.type) {
    case 'user':
      if (
        hasExactShape(message, USER_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.text === 'string' &&
        isOptionalString(message.displayText) &&
        (message.attachments === undefined ||
          (Array.isArray(message.attachments) && message.attachments.every(isAttachmentRef))) &&
        (message.origin === undefined || isAutomationOrigin(message.origin))
      )
        return message as unknown as UserMessage;
      break;
    case 'assistant':
      if (
        hasExactShape(message, ASSISTANT_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.text === 'string' &&
        typeof message.modelId === 'string' &&
        (message.thinking === undefined || isAssistantThinking(message.thinking)) &&
        (message.contentOrder === undefined ||
          (Array.isArray(message.contentOrder) &&
            message.contentOrder.every(
              (item) => item === 'thinking' || item === 'text' || item === 'tools',
            )))
      )
        return message as unknown as AssistantMessage;
      break;
    case 'tool_call':
      if (
        hasExactShape(message, TOOL_CALL_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.toolName === 'string' &&
        Object.hasOwn(message, 'args') &&
        (message.activityKind === undefined ||
          (TOOL_ACTIVITY_KINDS as readonly unknown[]).includes(message.activityKind)) &&
        isOptionalString(message.displayName) &&
        isOptionalString(message.intent) &&
        isOptionalString(message.stepId)
      )
        return message as unknown as ToolCallMessage;
      break;
    case 'tool_result':
      if (
        hasExactShape(message, TOOL_RESULT_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.toolUseId === 'string' &&
        typeof message.isError === 'boolean' &&
        isOptionalFiniteDuration(message.durationMs)
      )
        return message as unknown as ToolResultMessage;
      break;
    case 'permission_decision':
      if (
        hasExactShape(message, PERMISSION_DECISION_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.toolUseId === 'string' &&
        typeof message.toolName === 'string' &&
        isPermissionDecisionFields(message, { allowHint: true })
      )
        return message as unknown as PermissionDecisionMessage;
      break;
    case 'token_usage':
      if (
        hasExactShape(message, TOKEN_USAGE_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        isTokenUsageFields(message)
      )
        return message as unknown as TokenUsageMessage;
      break;
    case 'turn_state':
      if (
        hasExactShape(message, TURN_STATE_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        isTurnStatus(message.status) &&
        typeof message.partialOutputRetained === 'boolean' &&
        isOptionalString(message.parentTurnId) &&
        isOptionalString(message.retriedFromTurnId) &&
        isOptionalString(message.regeneratedFromTurnId) &&
        isOptionalString(message.branchOfTurnId) &&
        isOptionalString(message.parentSessionId) &&
        (message.abortedAt === undefined || isFiniteNumber(message.abortedAt)) &&
        isOptionalString(message.abortSource) &&
        isOptionalString(message.errorClass)
      )
        return message as unknown as TurnStateMessage;
      break;
    case 'system_note':
      if (
        hasExactShape(message, SYSTEM_NOTE_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, false) &&
        isOptionalString(message.turnId) &&
        SYSTEM_NOTE_KINDS.has(message.kind as string)
      )
        return message as unknown as SystemNoteMessage;
      break;
  }
  throw new Error('Invalid stored message schema');
}

function decodeStoredMessageContent(
  value: unknown,
  decodeToolResultContent: (content: unknown) => ToolResultContent,
): unknown {
  if (!isRecord(value) || value.type !== 'tool_result') return value;
  return {
    ...value,
    content: decodeToolResultContent(value.content),
  };
}

function hasMessageEnvelope(value: Record<string, unknown>, turnRequired: boolean): boolean {
  return (
    typeof value.id === 'string' &&
    isFiniteNumber(value.ts) &&
    (turnRequired ? typeof value.turnId === 'string' : true)
  );
}

function isAssistantThinking(value: unknown): value is AssistantThinking {
  return (
    isRecord(value) &&
    hasExactShape(value, ASSISTANT_THINKING_SHAPE) &&
    typeof value.text === 'string' &&
    isOptionalString(value.signature)
  );
}

function isAutomationOrigin(value: unknown): value is AutomationOrigin {
  return (
    isRecord(value) &&
    hasExactShape(value, AUTOMATION_ORIGIN_SHAPE) &&
    value.kind === 'automation' &&
    typeof value.automationId === 'string'
  );
}

function isOptionalFiniteDuration(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

export const STEP_LIMIT_NOTICE_TEXT =
  'Reached the configured step limit. The task may be incomplete. Send “continue” to resume.';

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
    const partialOutputRetained = bucket.some(
      (message) =>
        (message.type === 'assistant' && message.text.trim().length > 0) ||
        message.type === 'tool_result',
    );
    if (latestState) {
      return {
        turnId,
        status: latestState.status,
        ...(latestState.parentTurnId ? { parentTurnId: latestState.parentTurnId } : {}),
        ...(latestState.retriedFromTurnId
          ? { retriedFromTurnId: latestState.retriedFromTurnId }
          : {}),
        ...(latestState.regeneratedFromTurnId
          ? { regeneratedFromTurnId: latestState.regeneratedFromTurnId }
          : {}),
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
  if (messages.some((message) => message.type === 'system_note' && message.kind === 'abort'))
    return 'aborted';
  if (messages.some((message) => message.type === 'assistant')) return 'completed';
  if (messages.some((message) => message.type === 'tool_result' && message.isError))
    return 'failed';
  return 'completed';
}
