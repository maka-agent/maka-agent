/**
 * PermissionEngine — runtime wrapper around core's pure `preToolUse()`.
 *
 * Owns:
 * - requestId generation (uuid)
 * - per-turn "remember" set scoped to a specific tool intent
 * - parked Promise registry (one Promise per outstanding permission_request,
 *   keyed by requestId)
 * - response routing back to the awaiting adapter
 *
 * Adapter contract (see AiSdkBackend tool execute wrapper):
 *
 *   const decision = await engine.evaluate({ sessionId, turnId, toolUseId, toolName, args, mode, cwd });
 *   if (decision.kind === 'allow') { ...proceed with tool... }
 *   else if (decision.kind === 'block') { ...synthesize tool_result(isError) with decision.reason... }
 *   else if (decision.kind === 'prompt') {
 *     emit(decision.event);                                  // PermissionRequestEvent
 *     const userResponse = await decision.parked;            // resolves on respondToPermission()
 *     // record decision messages + ack event via callbacks
 *   }
 */

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  canonicalToolExecutionArgs,
  projectPublicToolApprovalReview,
  type CanonicalToolIntent,
  type PublicToolCommandReview,
} from '@maka/core';
import {
  matchToolPermissionRules,
  preToolUse,
  projectAdditionalPermissionReview,
  TurnPermissionMemory,
  type PermissionMode,
  type PermissionRememberScope,
  type PermissionRequest,
  type PermissionResponse,
  type PreToolUseResult,
  type ToolCategory,
  type ToolPermissionRule,
} from '@maka/core/permission';
import { InteractionPermissionProjectionError } from '@maka/core/interaction';
import type { AnyPermissionRequestEvent, PermissionDecisionAckEvent } from '@maka/core/events';
import {
  DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS,
  AdditionalPermissionError,
  assertAdditionalPermissionProposal,
  freezeAdditionalPermissionGrant,
  freezeAdditionalPermissionProposal,
  type AdditionalPermissionGrant,
  type AdditionalPermissionProposal,
} from './additional-permissions.js';
import {
  DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS,
  SandboxEscalationError,
  assertSandboxEscalationProposal,
  freezeSandboxEscalationGrant,
  freezeSandboxEscalationProposal,
  type SandboxEscalationGrant,
  type SandboxEscalationProposal,
} from './sandbox-escalation.js';
import { TurnScopedAwaitRegistry } from './turn-scoped-await-registry.js';
import {
  RuntimeInteractionAdmissionRejectedError,
  type RuntimeInteractionClosureReason,
} from './interaction-authority.js';

// ============================================================================
// Per-turn state
// ============================================================================

interface TurnState {
  turnId: string;
  turnMemory: TurnPermissionMemory;
  rememberScopeIds: Map<PermissionRememberScope, string>;
  /** Approved one-shot grants keyed by their bound tool invocation. */
  additionalGrants: Map<string, PendingAdditionalPermissionGrant>;
  /** Approved exact unsandboxed-command grants keyed by tool invocation. */
  sandboxEscalationGrants: Map<string, PendingSandboxEscalationGrant>;
}

interface ParkedPermissionBase {
  sessionId: string;
  turnId: string;
  toolUseId: string;
  toolName: string;
  category: ToolCategory;
}

type ParkedPermission =
  | (ParkedPermissionBase & {
      stage: 'base';
      rememberScope?: PermissionRememberScope;
      rememberForTurnAllowed: boolean;
    })
  | (ParkedPermissionBase & {
      stage: 'additional_permissions';
      proposal: AdditionalPermissionProposal;
    })
  | (ParkedPermissionBase & {
      stage: 'sandbox_escalation';
      proposal: SandboxEscalationProposal;
    });

interface PendingAdditionalPermissionGrant {
  grant: AdditionalPermissionGrant;
  consumed: boolean;
}

interface PendingSandboxEscalationGrant {
  grant: SandboxEscalationGrant;
  consumed: boolean;
}

// ============================================================================
// Evaluate result shapes
// ============================================================================

export type EvaluateResult =
  | { kind: 'allow'; category: ToolCategory }
  | {
      kind: 'block';
      category: ToolCategory;
      reason: string;
      /** Present for an invocation-local explicit deny so observers record a failed invocation. */
      decisionEvent?: PermissionDecisionAckEvent;
    }
  | {
      kind: 'prompt';
      category: ToolCategory;
      event: AnyPermissionRequestEvent;
      /** Stable non-secret identity used only for durable remember siblings. */
      rememberScopeId?: string;
      /** Resolves when the user responds via respondToPermission(). */
      parked: Promise<PermissionResponse>;
    };

interface EvaluateInputBase {
  /** The session this evaluation runs in. */
  sessionId: string;
  /** Current agent turn id (groups permission state). */
  turnId: string;
  /** The SDK's id for the tool invocation. */
  toolUseId: string;
  /** Sole authenticated private fact for classification, review, and execution. */
  intent: CanonicalToolIntent;
  /** Session's current permission mode. */
  mode: PermissionMode;
}

export type EvaluateInput =
  | (EvaluateInputBase & {
      stage: 'base';
      /** Whether the tool participates in the base mode policy when no explicit rule matches. */
      permissionRequired?: boolean;
      /** Invocation-local rules. Explicit deny wins over allow, then base mode applies. */
      permissionRules?: readonly ToolPermissionRule[];
      /** Optional trusted platform sandbox availability for sandbox-aware policy. */
      sandbox?: {
        platformSandboxAvailable: boolean;
      };
    })
  | (EvaluateInputBase & {
      stage: 'additional_permissions';
      proposal: AdditionalPermissionProposal;
    })
  | (EvaluateInputBase & {
      stage: 'sandbox_escalation';
      proposal: SandboxEscalationProposal;
    });

// ============================================================================
// Engine
// ============================================================================

export interface PermissionEngineDeps {
  /** Generate a fresh uuid. Injectable for tests. */
  newId: () => string;
  /** Wall-clock for event timestamps. Injectable for tests. */
  now: () => number;
}

export class PermissionEngine {
  private readonly turns = new Map<string, TurnState>();
  private readonly parked = new TurnScopedAwaitRegistry<PermissionResponse, ParkedPermission>();

  constructor(private readonly deps: PermissionEngineDeps) {}

  /** Begin tracking a new turn. Idempotent. */
  beginTurn(turnId: string): void {
    if (!this.turns.has(turnId)) {
      this.turns.set(turnId, {
        turnId,
        turnMemory: new TurnPermissionMemory(),
        rememberScopeIds: new Map(),
        additionalGrants: new Map(),
        sandboxEscalationGrants: new Map(),
      });
    }
    this.parked.beginTurn(turnId);
  }

  /** End tracking, rejecting any still-parked requests as user_stop. */
  endTurn(turnId: string, reason: 'completed' | 'aborted' = 'completed'): void {
    const state = this.turns.get(turnId);
    if (!state) return;
    this.parked.endTurn(turnId, (requestId, parked) => {
      const message = `Turn ${turnId} ${reason} before permission request ${requestId} was answered`;
      if (parked.stage === 'additional_permissions') {
        return new AdditionalPermissionError({
          stage: 'approval',
          reason: 'additional_permission_aborted',
          message,
          recoverable: true,
        });
      }
      if (parked.stage === 'sandbox_escalation') {
        return new SandboxEscalationError({
          stage: 'approval',
          reason: 'sandbox_escalation_aborted',
          message,
          recoverable: true,
        });
      }
      return new Error(message);
    });
    this.turns.delete(turnId);
  }

  /**
   * Evaluate a tool intent against the policy matrix and session state.
   * Returns one of three kinds; for 'prompt' the caller emits the event
   * and awaits `parked`.
   */
  evaluate(input: EvaluateInput): EvaluateResult {
    const state = this.requireTurn(input.turnId);
    if (input.stage === 'additional_permissions') {
      return this.evaluateAdditionalPermissions(input);
    }
    if (input.stage === 'sandbox_escalation') {
      return this.evaluateSandboxEscalation(input);
    }
    const { intent } = input;
    const category = intent.category;
    const ruleDecision = matchToolPermissionRules({
      intent,
      rules: input.permissionRules ?? [],
    });
    if (ruleDecision === 'allow') return { kind: 'allow', category };
    if (ruleDecision === 'deny') {
      const requestId = this.deps.newId();
      return {
        kind: 'block',
        category,
        reason: `Tool ${intent.toolName} was denied by an invocation permission rule`,
        decisionEvent: {
          type: 'permission_decision_ack',
          id: this.deps.newId(),
          turnId: input.turnId,
          ts: this.deps.now(),
          requestId,
          toolUseId: input.toolUseId,
          decision: 'deny',
        },
      };
    }
    if (ruleDecision === undefined && input.permissionRequired === false) {
      return { kind: 'allow', category };
    }

    let pre: PreToolUseResult;
    try {
      pre = preToolUse({
        intent,
        mode: input.mode,
        turnMemory: state.turnMemory,
        ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      });
    } catch (error) {
      throw permissionAdmissionError(input.toolUseId, error);
    }

    if (pre.kind === 'block') {
      return { kind: 'block', category: pre.category, reason: pre.reason };
    }
    if (pre.kind === 'allow') {
      return { kind: 'allow', category: pre.category };
    }
    if (!isAbsolute(intent.cwd)) {
      return {
        kind: 'block',
        category: pre.category,
        reason: 'Tool permission requests require a canonical cwd.',
      };
    }

    const requestId = this.deps.newId();
    let event: AnyPermissionRequestEvent;
    try {
      event = {
        type: 'permission_request',
        id: this.deps.newId(),
        turnId: input.turnId,
        ts: this.deps.now(),
        requestId,
        toolUseId: input.toolUseId,
        ...pre.prompt,
      };
    } catch (error) {
      throw permissionAdmissionError(input.toolUseId, error);
    }

    const rememberScope = pre.rememberScope;

    const parked = this.parked.park(input.turnId, requestId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      toolName: intent.toolName,
      category: pre.category,
      stage: 'base',
      ...(rememberScope === undefined ? {} : { rememberScope }),
      rememberForTurnAllowed: event.rememberForTurnAllowed,
    });

    return {
      kind: 'prompt',
      category: pre.category,
      event,
      ...(rememberScope !== undefined
        ? { rememberScopeId: this.rememberScopeId(state, rememberScope, requestId) }
        : {}),
      parked,
    };
  }

  private evaluateAdditionalPermissions(
    input: Extract<EvaluateInput, { stage: 'additional_permissions' }>,
  ): EvaluateResult {
    const { intent } = input;
    const category = intent.category;
    let proposal: AdditionalPermissionProposal;
    try {
      assertAdditionalPermissionProposal({
        proposal: input.proposal,
        toolName: intent.toolName,
        args: canonicalToolExecutionArgs(intent),
      });
      proposal = freezeAdditionalPermissionProposal(input.proposal);
    } catch (error) {
      return {
        kind: 'block',
        category,
        reason:
          error instanceof AdditionalPermissionError
            ? error.message
            : 'Additional permission proposal validation failed.',
      };
    }
    if (input.mode === 'explore') {
      return {
        kind: 'block',
        category,
        reason: 'Additional permissions are blocked in explore mode.',
      };
    }
    if (input.mode === 'bypass') return { kind: 'allow', category };
    if (!isAbsolute(intent.cwd)) {
      return {
        kind: 'block',
        category,
        reason: 'Additional permission requests require a canonical cwd.',
      };
    }

    const requestId = this.deps.newId();
    let event: AnyPermissionRequestEvent;
    try {
      event = {
        type: 'permission_request',
        kind: 'additional_permissions',
        id: this.deps.newId(),
        turnId: input.turnId,
        ts: this.deps.now(),
        requestId,
        toolUseId: input.toolUseId,
        toolName: intent.toolName,
        category,
        reason: 'additional_permissions',
        review: projectAdditionalPermissionReview({ cwd: intent.cwd, profile: proposal.profile }),
        risk: proposal.risk,
        alsoApprovesToolExecution: false,
        availableDecisions: ['allow_once', 'deny'],
      };
    } catch (error) {
      throw permissionAdmissionError(input.toolUseId, error);
    }
    const parked = this.parked.park(input.turnId, requestId, {
      stage: 'additional_permissions',
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      toolName: intent.toolName,
      category,
      proposal,
    });
    return { kind: 'prompt', category, event, parked };
  }

  private evaluateSandboxEscalation(
    input: Extract<EvaluateInput, { stage: 'sandbox_escalation' }>,
  ): EvaluateResult {
    const { intent } = input;
    const category = intent.category;
    let proposal: SandboxEscalationProposal;
    try {
      assertSandboxEscalationProposal({
        proposal: input.proposal,
        toolName: intent.toolName,
        args: canonicalToolExecutionArgs(intent),
        cwd: intent.cwd,
      });
      proposal = freezeSandboxEscalationProposal(input.proposal);
    } catch (error) {
      return {
        kind: 'block',
        category,
        reason:
          error instanceof SandboxEscalationError
            ? error.message
            : 'Sandbox escalation proposal validation failed.',
      };
    }
    if (input.mode === 'explore') {
      return { kind: 'block', category, reason: 'Sandbox escalation is blocked in explore mode.' };
    }
    if (input.mode === 'bypass') return { kind: 'allow', category };
    if (!isAbsolute(intent.cwd)) {
      return {
        kind: 'block',
        category,
        reason: 'Sandbox escalation requests require a canonical cwd.',
      };
    }

    const requestId = this.deps.newId();
    let event: AnyPermissionRequestEvent;
    try {
      event = {
        type: 'permission_request',
        kind: 'sandbox_escalation',
        id: this.deps.newId(),
        turnId: input.turnId,
        ts: this.deps.now(),
        requestId,
        toolUseId: input.toolUseId,
        toolName: 'Bash',
        category,
        reason: 'sandbox_escalation',
        review: commandReview(intent),
        trigger: proposal.trigger,
        risk: proposal.risk,
        alsoApprovesToolExecution: false,
        availableDecisions: ['allow_once', 'deny'],
      };
    } catch (error) {
      throw permissionAdmissionError(input.toolUseId, error);
    }
    const parked = this.parked.park(input.turnId, requestId, {
      stage: 'sandbox_escalation',
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      toolName: intent.toolName,
      category,
      proposal,
    });
    return { kind: 'prompt', category, event, parked };
  }

  /**
   * Route a user's response to the parked Promise. Idempotent on stray
   * responses for unknown requestIds (logs and ignores).
   *
   * Returns the resolved ParkedRequest (for the caller to write
   * PermissionDecisionMessage + emit PermissionDecisionAckEvent), or null
   * if the requestId was unknown.
   */
  recordResponse(
    turnId: string,
    response: PermissionResponse,
    options: { resolveRememberedSiblings?: boolean } = {},
  ): { category: ToolCategory; toolUseId: string } | null {
    if (
      !response ||
      typeof response.requestId !== 'string' ||
      (response.decision !== 'allow' && response.decision !== 'deny') ||
      (response.rememberForTurn !== undefined && typeof response.rememberForTurn !== 'boolean') ||
      (response.reviewer !== undefined &&
        response.reviewer !== 'user' &&
        response.reviewer !== 'auto_review') ||
      (response.riskLevel !== undefined &&
        !['low', 'medium', 'high', 'critical'].includes(response.riskLevel))
    ) {
      throw new Error('Invalid permission response');
    }
    const state = this.turns.get(turnId);
    if (!state) return null;
    const parked = this.parked
      .entries(turnId)
      .find(([requestId]) => requestId === response.requestId)?.[1];
    if (!parked) return null;

    if (parked.stage !== 'base' && response.rememberForTurn !== undefined) {
      throw new Error('One-shot permission responses cannot use rememberForTurn');
    }

    if (
      parked.stage === 'base' &&
      response.decision === 'allow' &&
      response.rememberForTurn &&
      !parked.rememberForTurnAllowed
    ) {
      throw new Error('This permission request cannot be remembered for the turn');
    }

    if (
      parked.stage === 'base' &&
      response.decision === 'allow' &&
      response.rememberForTurn &&
      parked.rememberForTurnAllowed
    ) {
      if (parked.rememberScope === undefined) {
        throw new Error('Rememberable permission request has no turn scope');
      }
      state.turnMemory.remember(parked.rememberScope);
      // The user allowed this scope for the whole turn, so other requests
      // already parked under the same scope (e.g. the rest of a parallel
      // browser_* batch) must not each re-prompt. Resolve them now — each
      // tool's own coroutine then emits its own permission_decision_ack, so the
      // UI queue drains without a second click. The current request was already
      // selected explicitly, so the snapshot must not auto-resolve it.
      if (options.resolveRememberedSiblings !== false) {
        for (const [otherId, other] of this.parked.entries(turnId)) {
          if (
            otherId !== response.requestId &&
            other.stage === 'base' &&
            other.rememberForTurnAllowed &&
            other.rememberScope === parked.rememberScope
          ) {
            this.parked.resolve(turnId, otherId, {
              requestId: otherId,
              decision: 'allow',
              rememberForTurn: true,
            });
          }
        }
      }
    }

    if (response.decision === 'allow' && parked.stage === 'additional_permissions') {
      if (state.additionalGrants.has(parked.toolUseId)) {
        throw new Error(`Additional permission grant already exists for tool ${parked.toolUseId}`);
      }
      const issuedAt = this.deps.now();
      state.additionalGrants.set(parked.toolUseId, {
        consumed: false,
        grant: freezeAdditionalPermissionGrant({
          grantId: this.deps.newId(),
          sessionId: parked.sessionId,
          turnId: parked.turnId,
          toolUseId: parked.toolUseId,
          toolName: parked.toolName,
          intentHash: parked.proposal.intentHash,
          permissionsHash: parked.proposal.permissionsHash,
          profile: parked.proposal.profile,
          normalizedPaths: parked.proposal.normalizedPaths,
          risk: parked.proposal.risk,
          issuedAt,
          expiresAt: issuedAt + DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS,
        }),
      });
    }

    if (response.decision === 'allow' && parked.stage === 'sandbox_escalation') {
      if (state.sandboxEscalationGrants.has(parked.toolUseId)) {
        throw new Error(`Sandbox escalation grant already exists for tool ${parked.toolUseId}`);
      }
      const issuedAt = this.deps.now();
      const proposal = parked.proposal;
      state.sandboxEscalationGrants.set(parked.toolUseId, {
        consumed: false,
        grant: freezeSandboxEscalationGrant({
          grantId: this.deps.newId(),
          sessionId: parked.sessionId,
          turnId: parked.turnId,
          toolUseId: parked.toolUseId,
          toolName: 'Bash',
          intentHash: proposal.intentHash,
          commandHash: proposal.commandHash,
          command: proposal.command,
          cwd: proposal.cwd,
          risk: proposal.risk,
          issuedAt,
          expiresAt: issuedAt + DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS,
        }),
      });
    }

    const resolvedResponse: PermissionResponse =
      parked.stage !== 'base'
        ? {
            requestId: response.requestId,
            decision: response.decision,
            ...(response.reviewer !== undefined ? { reviewer: response.reviewer } : {}),
            ...(response.riskLevel !== undefined ? { riskLevel: response.riskLevel } : {}),
          }
        : parked.rememberForTurnAllowed
          ? response
          : { ...response, rememberForTurn: false };
    this.parked.resolve(turnId, response.requestId, resolvedResponse);
    return { category: parked.category, toolUseId: parked.toolUseId };
  }

  /**
   * Fail one parked request without ending the whole turn.
   * Used by runtime-level permission timeouts so late UI responses do not
   * resolve a tool call that has already failed closed.
   */
  expireRequest(
    turnId: string,
    requestId: string,
    reason: string,
  ): { category: ToolCategory; toolUseId: string } | null {
    return this.closeRequest(turnId, requestId, 'timed_out', reason);
  }

  closeRequest(
    turnId: string,
    requestId: string,
    closure: RuntimeInteractionClosureReason,
    message?: string,
  ): { category: ToolCategory; toolUseId: string } | null {
    const metadata = this.parked.entries(turnId).find(([id]) => id === requestId)?.[1];
    if (!metadata) return null;
    const error = permissionClosureError(metadata, closure, message);
    const parked = this.parked.reject(turnId, requestId, error);
    if (!parked) return null;
    return { category: parked.category, toolUseId: parked.toolUseId };
  }

  rejectRequest(
    turnId: string,
    requestId: string,
    error: Error,
  ): { category: ToolCategory; toolUseId: string } | null {
    const parked = this.parked.reject(turnId, requestId, error);
    if (!parked) return null;
    return { category: parked.category, toolUseId: parked.toolUseId };
  }

  rejectPending(turnId: string, error: Error): void {
    this.parked.rejectAll(turnId, error);
  }

  /** Test/debug accessor. */
  pendingCount(turnId: string): number {
    return this.parked.pendingCount(turnId);
  }

  consumeAdditionalPermissionGrant(input: {
    sessionId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    intentHash: string;
  }): AdditionalPermissionGrant | undefined {
    const state = this.turns.get(input.turnId);
    const pending = state?.additionalGrants.get(input.toolUseId);
    if (!pending) return undefined;
    if (pending.consumed) {
      throw new AdditionalPermissionError({
        stage: 'consume',
        reason: 'grant_already_consumed',
      });
    }

    const grant = pending.grant;
    if (grant.expiresAt <= this.deps.now()) {
      state!.additionalGrants.delete(input.toolUseId);
      throw new AdditionalPermissionError({
        stage: 'consume',
        reason: 'grant_expired',
      });
    }
    if (
      grant.sessionId !== input.sessionId ||
      grant.turnId !== input.turnId ||
      grant.toolUseId !== input.toolUseId ||
      grant.toolName !== input.toolName ||
      grant.intentHash !== input.intentHash
    ) {
      throw new AdditionalPermissionError({
        stage: 'consume',
        reason: 'grant_intent_mismatch',
      });
    }

    pending.consumed = true;
    return grant;
  }

  consumeSandboxEscalationGrant(input: {
    sessionId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    intentHash: string;
    command: string;
    cwd: string;
  }): SandboxEscalationGrant | undefined {
    const state = this.turns.get(input.turnId);
    const pending = state?.sandboxEscalationGrants.get(input.toolUseId);
    if (!pending) return undefined;
    if (pending.consumed) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_grant_consumed',
      });
    }
    const grant = pending.grant;
    if (grant.expiresAt <= this.deps.now()) {
      state!.sandboxEscalationGrants.delete(input.toolUseId);
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_grant_expired',
      });
    }
    if (
      grant.sessionId !== input.sessionId ||
      grant.turnId !== input.turnId ||
      grant.toolUseId !== input.toolUseId ||
      grant.toolName !== input.toolName ||
      grant.intentHash !== input.intentHash
    ) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_intent_mismatch',
      });
    }
    if (grant.command !== input.command) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_command_mismatch',
      });
    }
    if (grant.cwd !== input.cwd) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_cwd_mismatch',
      });
    }
    pending.consumed = true;
    return grant;
  }

  private rememberScopeId(
    state: TurnState,
    scope: PermissionRememberScope,
    requestId: string,
  ): string {
    const existing = state.rememberScopeIds.get(scope);
    if (existing !== undefined) return existing;
    const id = createHash('sha256').update(requestId, 'utf8').digest('hex');
    state.rememberScopeIds.set(scope, id);
    return id;
  }

  private requireTurn(turnId: string): TurnState {
    let state = this.turns.get(turnId);
    if (!state) {
      // Auto-begin: callers may forget. This is a soft guarantee.
      state = {
        turnId,
        turnMemory: new TurnPermissionMemory(),
        rememberScopeIds: new Map(),
        additionalGrants: new Map(),
        sandboxEscalationGrants: new Map(),
      };
      this.turns.set(turnId, state);
      this.parked.beginTurn(turnId);
    }
    return state;
  }
}

function commandReview(intent: CanonicalToolIntent): PublicToolCommandReview {
  const review = projectPublicToolApprovalReview(intent);
  if (review.kind !== 'command') throw new InteractionPermissionProjectionError();
  return review;
}

function permissionAdmissionError(requestId: string, error: unknown): Error {
  if (error instanceof RuntimeInteractionAdmissionRejectedError) return error;
  if (error instanceof InteractionPermissionProjectionError) {
    return new RuntimeInteractionAdmissionRejectedError(requestId, 'invalid_request');
  }
  return error instanceof Error ? error : new Error(String(error));
}

function permissionClosureError(
  metadata: ParkedPermission,
  closure: RuntimeInteractionClosureReason,
  message = `Permission request closed: ${closure}`,
): Error {
  const timedOut = closure === 'timed_out';
  if (metadata.stage === 'additional_permissions') {
    return new AdditionalPermissionError({
      stage: 'approval',
      reason: timedOut ? 'additional_permission_timeout' : 'additional_permission_aborted',
      message,
      recoverable: true,
    });
  }
  if (metadata.stage === 'sandbox_escalation') {
    return new SandboxEscalationError({
      stage: 'approval',
      reason: timedOut ? 'sandbox_escalation_timeout' : 'sandbox_escalation_aborted',
      message,
      recoverable: true,
    });
  }
  return new Error(message);
}

// ============================================================================
// Default deps factory (Node / Bun)
// ============================================================================

export function createDefaultPermissionEngineDeps(): PermissionEngineDeps {
  return {
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
}
