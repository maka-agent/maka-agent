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

import type { AttachmentRef, ToolResultContent } from './events.js';
import type { PermissionMode } from './permission.js';

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

  // Unread tracking
  lastReadMessageId?: string;
  hasUnread: boolean;

  // Backend / model config
  backend: BackendKind;
  llmConnectionSlug: string;
  /** True after first UserMessage is flushed. Storage self-heals (§5.2). */
  connectionLocked: boolean;
  /** Model id; can change within the same connection across turns. */
  model: string;
  permissionMode: PermissionMode;

  /** Forward-compatible schema versioning. V0.1 only writes 1. */
  schemaVersion: 1;
}

export type BackendKind = 'ai-sdk' | 'fake';

export interface SessionSummary {
  id: string;
  name: string;
  isFlagged: boolean;
  isArchived: boolean;
  labels: string[];
  hasUnread: boolean;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  backend: BackendKind;
  llmConnectionSlug: string;
  permissionMode: PermissionMode;
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
  | SystemNoteMessage;

export interface UserMessage {
  type: 'user';
  id: string;
  turnId: string;
  ts: number;
  text: string;
  attachments?: AttachmentRef[];
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
  /** Actual model used for this turn. */
  modelId: string;
}

export interface ToolCallMessage {
  type: 'tool_call';
  /** Equals toolUseId — used to match ToolResultMessage.toolUseId. */
  id: string;
  turnId: string;
  ts: number;
  toolName: string;
  displayName?: string;
  intent?: string;
  args: unknown;
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
  cacheRead?: number;
  cacheCreation?: number;
  costUsd?: number;
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
    | 'error'
    | 'abort';
  /** Shape depends on `kind`. */
  data?: unknown;
}
