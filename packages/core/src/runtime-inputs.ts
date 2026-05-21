/**
 * Inputs to runtime APIs (create session, send message, list/filter).
 *
 * Source: V0.1_TECH_SPEC.md §13
 */

import type { AttachmentRef } from './events.js';
import type { BackendKind, SessionBlockedReason, SessionStatus } from './session.js';
import type { PermissionMode } from './permission.js';

export interface CreateSessionInput {
  /** Absolute path to the session's working dir (project root). */
  cwd: string;
  /** If omitted, runtime auto-derives a placeholder; users may rename later. */
  name?: string;
  backend: BackendKind;
  llmConnectionSlug: string;
  /** Falls back to the connection's defaultModel if omitted. */
  model?: string;
  permissionMode: PermissionMode;
  status?: SessionStatus;
  blockedReason?: SessionBlockedReason;
  labels?: string[];
}

export interface UserMessageInput {
  /** Caller-generated uuid. Same id used in the UserMessage.turnId and in
   *  every event emitted by this turn. */
  turnId: string;
  text: string;
  attachments?: AttachmentRef[];
}

export interface SessionListFilter {
  isArchived?: boolean;
  isFlagged?: boolean;
  labelSlug?: string;
}
