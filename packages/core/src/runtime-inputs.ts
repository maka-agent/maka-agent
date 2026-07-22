/**
 * Inputs to runtime APIs (create session, send message, list/filter).
 */

import type { MessageContent, QuoteRef } from './events.js';
import type { BackendKind, SessionBlockedReason, SessionStatus } from './session.js';
import type { PermissionMode } from './permission.js';
import type { ThinkingLevel } from './model-thinking.js';
import type { CollaborationMode } from './collaboration.js';
import type { OrchestrationMode, TurnOrchestration } from './orchestration.js';

export type { TurnOrchestration } from './orchestration.js';

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
  /** Defaults to `agent`. */
  collaborationMode?: CollaborationMode;
  /** Defaults to `default`. Orthogonal to Agent/Plan collaboration mode. */
  orchestrationMode?: OrchestrationMode;
  status?: SessionStatus;
  blockedReason?: SessionBlockedReason;
  parentSessionId?: string;
  branchOfTurnId?: string;
  revisionRootSessionId?: string;
  revisionParentSessionId?: string;
  revisionOfTurnId?: string;
  revisionIndex?: number;
  revisionState?: 'preparing' | 'committed';
  labels?: string[];
}

export interface UserMessageInput extends MessageContent {
  /** Caller-generated uuid. Same id used in the UserMessage.turnId and in
   *  every event emitted by this turn. */
  turnId: string;
  /** Trusted host-supplied orchestration override for this turn only. */
  turnOrchestration?: TurnOrchestration;
  /** Inline quoted excerpts; folded into model content, rendered as chips. */
  quotes?: QuoteRef[];
  parentRunId?: string;
  /** Child AgentRun whose durable conversation this child continues. */
  resumedFromRunId?: string;
  /** Immediate child AgentRun retried without appending another user prompt. */
  retriedFromRunId?: string;
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
  /** Trusted, preflighted child AgentRun whose RuntimeEvent history is replayed. */
  resumedFromRunId?: string;
}

export interface RegenerateTurnInput {
  sourceTurnId: string;
  turnId?: string;
}

export interface BranchFromTurnInput {
  sourceTurnId: string;
  name?: string;
}

export interface ReviseBeforeTurnInput {
  sourceTurnId: string;
}

export interface SessionListFilter {
  isArchived?: boolean;
  isFlagged?: boolean;
  labelSlug?: string;
}
