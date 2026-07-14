/**
 * Inputs to runtime APIs (create session, send message, list/filter).
 */

import type { AttachmentRef } from './events.js';
import type { BackendKind, SessionBlockedReason, SessionStatus } from './session.js';
import type { PermissionMode } from './permission.js';
import type { ThinkingLevel } from './model-thinking.js';

export interface CreateSessionInput {
  /** Absolute path to the session's working dir (project root). */
  cwd: string;
  /** If omitted, runtime auto-derives a placeholder; users may rename later. */
  name?: string;
  backend: BackendKind;
  llmConnectionSlug: string;
  /** Falls back to the connection's defaultModel if omitted. */
  model?: string;
  /** Per-model reasoning-depth variant; `undefined` = model default. */
  thinkingLevel?: ThinkingLevel;
  permissionMode: PermissionMode;
  status?: SessionStatus;
  blockedReason?: SessionBlockedReason;
  parentSessionId?: string;
  branchOfTurnId?: string;
  labels?: string[];
}

export interface UserMessageInput {
  /** Caller-generated uuid. Same id used in the UserMessage.turnId and in
   *  every event emitted by this turn. */
  turnId: string;
  text: string;
  attachments?: AttachmentRef[];
  parentRunId?: string;
  agentId?: string;
  agentName?: string;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  /** What triggered this turn, when it is not a direct user message. Lets trace
   *  distinguish an automation-triggered run from a hand-typed one. */
  origin?: TurnOrigin;
}

/** Non-user trigger source for a turn (e.g. a scheduled automation fire). */
export type TurnOrigin = { kind: 'automation'; automationId: string };

export interface AgentSpec {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface ChildAgentTurnInput {
  turnId: string;
  parentRunId: string;
  spec: AgentSpec;
  prompt: string;
}

export interface RegenerateTurnInput {
  sourceTurnId: string;
  turnId?: string;
}

export interface BranchFromTurnInput {
  sourceTurnId: string;
  name?: string;
}

export interface SessionListFilter {
  isArchived?: boolean;
  isFlagged?: boolean;
  labelSlug?: string;
}
