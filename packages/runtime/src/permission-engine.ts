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
 * Source: V0.1_TECH_SPEC.md §6.1, §6.2
 *
 * Adapter contract (see AiSdkBackend tool execute wrapper):
 *
 *   const decision = await engine.evaluate({ sessionId, turnId, toolUseId, toolName, args, mode });
 *   if (decision.kind === 'allow') { ...proceed with tool... }
 *   else if (decision.kind === 'block') { ...synthesize tool_result(isError) with decision.reason... }
 *   else if (decision.kind === 'prompt') {
 *     emit(decision.event);                                  // PermissionRequestEvent
 *     const userResponse = await decision.parked;            // resolves on respondToPermission()
 *     // record decision messages + ack event via callbacks
 *   }
 */

import {
  preToolUse,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
  type PreToolUseSandboxContext,
  type PreToolUseResult,
  type ToolCategory,
  type ToolExecutionFacts,
} from '@maka/core/permission';
import type { PermissionRequestEvent } from '@maka/core/events';
import {
  DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS,
  AdditionalPermissionError,
  assertAdditionalPermissionProposal,
  freezeAdditionalPermissionProposal,
  freezeAdditionalPermissionGrant,
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

// ============================================================================
// Per-turn state
// ============================================================================

interface TurnState {
  turnId: string;
  /** Tool-intent scopes granted with `rememberForTurn: true` in this turn. */
  remembered: Set<string>;
  /** Outstanding parked permission requests, keyed by requestId. */
  parked: Map<string, ParkedRequest>;
  /** Approved grants waiting for their bound tool implementation to consume them. */
  grants: Map<string, PendingGrant>;
  escalationGrants: Map<string, PendingEscalationGrant>;
}

interface ParkedRequest {
  requestId: string;
  toolUseId: string;
  category: ToolCategory;
  scopeKey: string;
  sessionId: string;
  toolName: string;
  turnId: string;
  additionalProposal?: AdditionalPermissionProposal;
  sandboxEscalationProposal?: SandboxEscalationProposal;
  resolve(response: PermissionResponse): void;
  reject(err: Error): void;
}

interface PendingGrant {
  grant: AdditionalPermissionGrant;
  consumed: boolean;
}

interface PendingEscalationGrant {
  grant: SandboxEscalationGrant;
  consumed: boolean;
}

// ============================================================================
// Evaluate result shapes
// ============================================================================

export type EvaluateResult =
  | { kind: 'allow'; category: ToolCategory }
  | { kind: 'block'; category: ToolCategory; reason: string }
  | {
      kind: 'prompt';
      category: ToolCategory;
      event: PermissionRequestEvent;
      /** Resolves when the user responds via respondToPermission(). */
      parked: Promise<PermissionResponse>;
    };

export interface EvaluateInput {
  /** The session this evaluation runs in. */
  sessionId: string;
  /** Current agent turn id (groups permission state). */
  turnId: string;
  /** The SDK's id for the tool invocation. */
  toolUseId: string;
  toolName: string;
  args: unknown;
  categoryHint?: ToolCategory;
  /** Session's current permission mode. */
  mode: PermissionMode;
  /** Optional hint shown to user in the dialog. */
  hint?: string;
  /** Optional trusted facts about the executor that would run this tool. */
  executionFacts?: ToolExecutionFacts;
  /** Active runtime capability for this tool's declared sandbox requirement. */
  sandbox?: PreToolUseSandboxContext;
  /** Runtime-normalized per-call permission proposal. */
  additionalPermissionProposal?: AdditionalPermissionProposal;
  /** Runtime-normalized request to execute this exact Bash call without Maka's command sandbox. */
  sandboxEscalationProposal?: SandboxEscalationProposal;
  /** Canonical cwd shown in an additional permission request. */
  cwd?: string;
}

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

  constructor(private readonly deps: PermissionEngineDeps) {}

  /** Begin tracking a new turn. Idempotent. */
  beginTurn(turnId: string): void {
    if (!this.turns.has(turnId)) {
      this.turns.set(turnId, {
        turnId,
        remembered: new Set(),
        parked: new Map(),
        grants: new Map(),
        escalationGrants: new Map(),
      });
    }
  }

  /** End tracking, rejecting any still-parked requests as user_stop. */
  endTurn(turnId: string, reason: 'completed' | 'aborted' = 'completed'): void {
    const state = this.turns.get(turnId);
    if (!state) return;
    for (const parked of state.parked.values()) {
      const message = `Turn ${turnId} ${reason} before permission request ${parked.requestId} was answered`;
      parked.reject(parked.additionalProposal
        ? new AdditionalPermissionError({
            stage: 'approval',
            reason: 'additional_permission_aborted',
            message,
            recoverable: true,
          })
        : parked.sandboxEscalationProposal
          ? new SandboxEscalationError({
              stage: 'approval',
              reason: 'sandbox_escalation_aborted',
              message,
              recoverable: true,
            })
          : new Error(message));
    }
    this.turns.delete(turnId);
  }

  /**
   * Evaluate a tool intent against the policy matrix and session state.
   * Returns one of three kinds; for 'prompt' the caller emits the event
   * and awaits `parked`.
   */
  evaluate(input: EvaluateInput): EvaluateResult {
    const state = this.requireTurn(input.turnId);

    const pre: PreToolUseResult = preToolUse({
      toolName: input.toolName,
      args: input.args,
      ...(input.categoryHint !== undefined ? { categoryHint: input.categoryHint } : {}),
      ...(input.executionFacts !== undefined ? { executionFacts: input.executionFacts } : {}),
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      mode: input.mode,
      turnRemembered: state.remembered,
    });

    if (pre.blockReason !== undefined) {
      return { kind: 'block', category: pre.category, reason: pre.blockReason };
    }

    let additional = input.additionalPermissionProposal;
    let sandboxEscalation = input.sandboxEscalationProposal;
    if (additional && sandboxEscalation) {
      return {
        kind: 'block',
        category: pre.category,
        reason: 'Additional permissions and sandbox escalation cannot be requested together.',
      };
    }
    if (additional) {
      try {
        assertAdditionalPermissionProposal({ proposal: additional, toolName: input.toolName, args: input.args });
        additional = freezeAdditionalPermissionProposal(additional);
      } catch (error) {
        return {
          kind: 'block',
          category: pre.category,
          reason: error instanceof AdditionalPermissionError
            ? error.message
            : 'Additional permission proposal validation failed.',
        };
      }
    }
    if (additional && input.mode === 'explore') {
      return {
        kind: 'block',
        category: pre.category,
        reason: 'Additional permissions are blocked in explore mode.',
      };
    }

    if (sandboxEscalation) {
      try {
        assertSandboxEscalationProposal({
          proposal: sandboxEscalation,
          toolName: input.toolName,
          args: input.args,
          cwd: input.cwd ?? '',
        });
        sandboxEscalation = freezeSandboxEscalationProposal(sandboxEscalation);
      } catch (error) {
        return {
          kind: 'block',
          category: pre.category,
          reason: error instanceof SandboxEscalationError
            ? error.message
            : 'Sandbox escalation proposal validation failed.',
        };
      }
      if (input.mode === 'explore') {
        return {
          kind: 'block',
          category: pre.category,
          reason: 'Sandbox escalation is blocked in explore mode.',
        };
      }
    }

    if (pre.proceed && ((!additional && !sandboxEscalation) || input.mode === 'bypass')) {
      return { kind: 'allow', category: pre.category };
    }
    if (!additional && !sandboxEscalation && !pre.partialRequest) {
      // Defensive: pre.proceed=false && !blockReason && !partialRequest is
      // unreachable per the type contract, but TS doesn't know that. Treat
      // as block to fail safe.
      return {
        kind: 'block',
        category: pre.category,
        reason: 'PermissionEngine: invariant violated — no partialRequest in prompt branch',
      };
    }

    const requestId = this.deps.newId();
    const event: PermissionRequestEvent = additional
      ? {
          type: 'permission_request',
          kind: 'additional_permissions',
          id: this.deps.newId(),
          turnId: input.turnId,
          ts: this.deps.now(),
          requestId,
          toolUseId: input.toolUseId,
          toolName: input.toolName,
          category: pre.category,
          reason: 'additional_permissions',
          additionalPermissions: additional.profile,
          cwd: input.cwd ?? '',
          justification: additional.justification,
          intentHash: additional.intentHash,
          permissionsHash: additional.permissionsHash,
          risk: additional.risk,
          alsoApprovesToolExecution: pre.needsPrompt,
          availableDecisions: ['allow_once', 'deny'],
          ...(input.hint !== undefined ? { hint: input.hint } : {}),
        }
      : sandboxEscalation
        ? {
            type: 'permission_request',
            kind: 'sandbox_escalation',
            id: this.deps.newId(),
            turnId: input.turnId,
            ts: this.deps.now(),
            requestId,
            toolUseId: input.toolUseId,
            toolName: 'Bash',
            category: pre.category,
            reason: 'sandbox_escalation',
            command: sandboxEscalation.command,
            cwd: sandboxEscalation.cwd,
            justification: sandboxEscalation.justification,
            intentHash: sandboxEscalation.intentHash,
            commandHash: sandboxEscalation.commandHash,
            trigger: sandboxEscalation.trigger,
            risk: sandboxEscalation.risk,
            alsoApprovesToolExecution: pre.needsPrompt,
            availableDecisions: ['allow_once', 'deny'],
            ...(input.hint !== undefined ? { hint: input.hint } : {}),
          }
        : {
          type: 'permission_request',
          kind: 'tool_permission',
          id: this.deps.newId(),
          turnId: input.turnId,
          ts: this.deps.now(),
          requestId,
          toolUseId: input.toolUseId,
          toolName: pre.partialRequest!.toolName,
          category: pre.partialRequest!.category,
          reason: pre.partialRequest!.reason,
          args: pre.partialRequest!.args,
          ...(input.hint !== undefined ? { hint: input.hint } : {}),
        };

    let resolveFn: (r: PermissionResponse) => void = () => {};
    let rejectFn: (e: Error) => void = () => {};
    const parked = new Promise<PermissionResponse>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    state.parked.set(requestId, {
      requestId,
      toolUseId: input.toolUseId,
      category: pre.category,
      scopeKey: pre.scopeKey,
      sessionId: input.sessionId,
      toolName: input.toolName,
      turnId: input.turnId,
      ...(additional ? { additionalProposal: additional } : {}),
      ...(sandboxEscalation ? { sandboxEscalationProposal: sandboxEscalation } : {}),
      resolve: resolveFn,
      reject: rejectFn,
    });

    return { kind: 'prompt', category: pre.category, event, parked };
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
  ): { category: ToolCategory; toolUseId: string } | null {
    if (
      !response ||
      typeof response.requestId !== 'string' ||
      (response.decision !== 'allow' && response.decision !== 'deny') ||
      (response.rememberForTurn !== undefined && typeof response.rememberForTurn !== 'boolean') ||
      (response.reviewer !== undefined && response.reviewer !== 'user' && response.reviewer !== 'auto_review') ||
      (response.rationale !== undefined && typeof response.rationale !== 'string') ||
      (response.riskLevel !== undefined && !['low', 'medium', 'high', 'critical'].includes(response.riskLevel))
    ) {
      throw new Error('Invalid permission response');
    }
    const state = this.turns.get(turnId);
    if (!state) return null;
    const parked = state.parked.get(response.requestId);
    if (!parked) return null;

    if ((parked.additionalProposal || parked.sandboxEscalationProposal) && response.rememberForTurn !== undefined) {
      throw new Error('One-shot permission responses cannot use rememberForTurn');
    }

    state.parked.delete(response.requestId);

    if (response.decision === 'allow' && response.rememberForTurn) {
      state.remembered.add(parked.scopeKey);
      // The user allowed this scope for the whole turn, so other requests
      // already parked under the same scope (e.g. the rest of a parallel
      // browser_* batch) must not each re-prompt. Resolve them now — each
      // tool's own coroutine then emits its own permission_decision_ack, so the
      // UI queue drains without a second click. The current request was already
      // deleted above, so the snapshot never re-resolves it.
      for (const [otherId, other] of [...state.parked]) {
        if (other.scopeKey === parked.scopeKey) {
          state.parked.delete(otherId);
          other.resolve({ requestId: otherId, decision: 'allow', rememberForTurn: true });
        }
      }
    }

    if (response.decision === 'allow' && parked.additionalProposal) {
      const issuedAt = this.deps.now();
      state.grants.set(parked.toolUseId, {
        consumed: false,
        grant: freezeAdditionalPermissionGrant({
          grantId: this.deps.newId(),
          sessionId: parked.sessionId,
          turnId: parked.turnId,
          toolUseId: parked.toolUseId,
          toolName: parked.toolName,
          intentHash: parked.additionalProposal.intentHash,
          permissionsHash: parked.additionalProposal.permissionsHash,
          profile: parked.additionalProposal.profile,
          normalizedPaths: parked.additionalProposal.normalizedPaths,
          risk: parked.additionalProposal.risk,
          issuedAt,
          expiresAt: issuedAt + DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS,
        }),
      });
    }

    if (response.decision === 'allow' && parked.sandboxEscalationProposal) {
      const issuedAt = this.deps.now();
      const proposal = parked.sandboxEscalationProposal;
      state.escalationGrants.set(parked.toolUseId, {
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

    parked.resolve(response);
    return { category: parked.category, toolUseId: parked.toolUseId };
  }

  /**
   * Fail one parked request without ending the whole turn.
   * Used by runtime-level permission timeouts so late UI responses do not
   * resolve a tool call that has already failed closed.
   */
  expireRequest(turnId: string, requestId: string, reason: string): { category: ToolCategory; toolUseId: string } | null {
    const state = this.turns.get(turnId);
    if (!state) return null;
    const parked = state.parked.get(requestId);
    if (!parked) return null;
    state.parked.delete(requestId);
    parked.reject(parked.additionalProposal
      ? new AdditionalPermissionError({
          stage: 'approval',
          reason: 'additional_permission_timeout',
          message: reason,
          recoverable: true,
        })
      : parked.sandboxEscalationProposal
        ? new SandboxEscalationError({
            stage: 'approval',
            reason: 'sandbox_escalation_timeout',
            message: reason,
            recoverable: true,
          })
        : new Error(reason));
    return { category: parked.category, toolUseId: parked.toolUseId };
  }

  /** Test/debug accessor. */
  pendingCount(turnId: string): number {
    return this.turns.get(turnId)?.parked.size ?? 0;
  }

  consumeAdditionalPermissionGrant(input: {
    sessionId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    intentHash: string;
  }): AdditionalPermissionGrant | undefined {
    const state = this.turns.get(input.turnId);
    const pending = state?.grants.get(input.toolUseId);
    if (!pending) return undefined;
    if (pending.consumed) {
      throw new AdditionalPermissionError({ stage: 'consume', reason: 'grant_already_consumed' });
    }
    const grant = pending.grant;
    if (grant.expiresAt <= this.deps.now()) {
      state!.grants.delete(input.toolUseId);
      throw new AdditionalPermissionError({ stage: 'consume', reason: 'grant_expired' });
    }
    if (
      grant.sessionId !== input.sessionId
      || grant.turnId !== input.turnId
      || grant.toolUseId !== input.toolUseId
      || grant.toolName !== input.toolName
      || grant.intentHash !== input.intentHash
    ) {
      throw new AdditionalPermissionError({ stage: 'consume', reason: 'grant_intent_mismatch' });
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
    const pending = state?.escalationGrants.get(input.toolUseId);
    if (!pending) return undefined;
    if (pending.consumed) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_grant_consumed',
      });
    }
    const grant = pending.grant;
    if (grant.expiresAt <= this.deps.now()) {
      state!.escalationGrants.delete(input.toolUseId);
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_grant_expired',
      });
    }
    if (
      grant.sessionId !== input.sessionId
      || grant.turnId !== input.turnId
      || grant.toolUseId !== input.toolUseId
      || grant.toolName !== input.toolName
      || grant.intentHash !== input.intentHash
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

  private requireTurn(turnId: string): TurnState {
    let state = this.turns.get(turnId);
    if (!state) {
      // Auto-begin: callers may forget. This is a soft guarantee.
      state = {
        turnId,
        remembered: new Set(),
        parked: new Map(),
        grants: new Map(),
        escalationGrants: new Map(),
      };
      this.turns.set(turnId, state);
    }
    return state;
  }
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
