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
 *   const decision = await engine.evaluate({ sessionId, turnId, toolUseId, toolName, args, mode });
 *   if (decision.kind === 'allow') { ...proceed with tool... }
 *   else if (decision.kind === 'block') { ...synthesize tool_result(isError) with decision.reason... }
 *   else if (decision.kind === 'prompt') {
 *     emit(decision.event);                                  // PermissionRequestEvent
 *     const userResponse = await decision.parked;            // resolves on respondToPermission()
 *     // record decision messages + ack event via callbacks
 *   }
 */

import { projectToolActivityArgs } from '@maka/core';
import {
  classifyToolUse,
  matchToolPermissionRules,
  preToolUse,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
  type PreToolUseResult,
  type ToolCategory,
  type ToolExecutionFacts,
  type ToolPermissionRule,
} from '@maka/core/permission';
import type { PermissionDecisionAckEvent, PermissionRequestEvent } from '@maka/core/events';

// ============================================================================
// Per-turn state
// ============================================================================

interface TurnState {
  turnId: string;
  /** Tool-intent scopes granted with `rememberForTurn: true` in this turn. */
  remembered: Set<string>;
  /** Outstanding parked permission requests, keyed by requestId. */
  parked: Map<string, ParkedRequest>;
}

interface ParkedRequest {
  requestId: string;
  toolUseId: string;
  category: ToolCategory;
  scopeKey: string;
  rememberForTurnAllowed: boolean;
  resolve(response: PermissionResponse): void;
  reject(err: Error): void;
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
  /** Whether the tool participates in the base mode policy when no explicit rule matches. */
  permissionRequired?: boolean;
  /** Invocation-local rules. Explicit deny wins over allow, then base mode applies. */
  permissionRules?: readonly ToolPermissionRule[];
  /** Optional trusted platform sandbox availability for sandbox-aware policy. */
  sandbox?: {
    platformSandboxAvailable: boolean;
  };
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
      this.turns.set(turnId, { turnId, remembered: new Set(), parked: new Map() });
    }
  }

  /** End tracking, rejecting any still-parked requests as user_stop. */
  endTurn(turnId: string, reason: 'completed' | 'aborted' = 'completed'): void {
    const state = this.turns.get(turnId);
    if (!state) return;
    for (const parked of state.parked.values()) {
      parked.reject(
        new Error(`Turn ${turnId} ${reason} before permission request ${parked.requestId} was answered`),
      );
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
    const args = snapshotPermissionArgs(input.args);

    const category = classifyToolUse({
      toolName: input.toolName,
      args,
      ...(input.categoryHint !== undefined ? { categoryHint: input.categoryHint } : {}),
    });
    const ruleDecision = matchToolPermissionRules({
      toolName: input.toolName,
      args,
      category,
      rules: input.permissionRules ?? [],
    });
    if (ruleDecision === 'allow') return { kind: 'allow', category };
    if (ruleDecision === 'deny') {
      const requestId = this.deps.newId();
      return {
        kind: 'block',
        category,
        reason: `Tool ${input.toolName} was denied by an invocation permission rule`,
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

    const pre: PreToolUseResult = preToolUse({
      toolName: input.toolName,
      args,
      ...(input.categoryHint !== undefined ? { categoryHint: input.categoryHint } : {}),
      ...(input.executionFacts !== undefined ? { executionFacts: input.executionFacts } : {}),
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      mode: input.mode,
      turnRemembered: state.remembered,
    });

    if (pre.proceed) {
      return { kind: 'allow', category: pre.category };
    }
    if (pre.blockReason !== undefined) {
      return { kind: 'block', category: pre.category, reason: pre.blockReason };
    }
    if (!pre.partialRequest) {
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
    const event: PermissionRequestEvent = {
      type: 'permission_request',
      id: this.deps.newId(),
      turnId: input.turnId,
      ts: this.deps.now(),
      requestId,
      toolUseId: input.toolUseId,
      toolName: pre.partialRequest.toolName,
      category: pre.partialRequest.category,
      reason: pre.partialRequest.reason,
      args: projectToolActivityArgs(
        pre.partialRequest.toolName,
        pre.partialRequest.args,
      ),
      rememberForTurnAllowed: pre.partialRequest.rememberForTurnAllowed,
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
      rememberForTurnAllowed: pre.partialRequest.rememberForTurnAllowed !== false,
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
      (response.rememberForTurn !== undefined && typeof response.rememberForTurn !== 'boolean')
    ) {
      throw new Error('Invalid permission response');
    }
    const state = this.turns.get(turnId);
    if (!state) return null;
    const parked = state.parked.get(response.requestId);
    if (!parked) return null;

    state.parked.delete(response.requestId);

    if (
      response.decision === 'allow'
      && response.rememberForTurn
      && parked.rememberForTurnAllowed
    ) {
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

    parked.resolve(
      parked.rememberForTurnAllowed
        ? response
        : { ...response, rememberForTurn: false },
    );
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
    parked.reject(new Error(reason));
    return { category: parked.category, toolUseId: parked.toolUseId };
  }

  /** Test/debug accessor. */
  pendingCount(turnId: string): number {
    return this.turns.get(turnId)?.parked.size ?? 0;
  }

  private requireTurn(turnId: string): TurnState {
    let state = this.turns.get(turnId);
    if (!state) {
      // Auto-begin: callers may forget. This is a soft guarantee.
      state = { turnId, remembered: new Set(), parked: new Map() };
      this.turns.set(turnId, state);
    }
    return state;
  }
}

function snapshotPermissionArgs(value: unknown): unknown {
  return snapshotPermissionValue(value, new WeakSet<object>());
}

function snapshotPermissionValue(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Permission arguments must not contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) => snapshotPermissionValue(entry, seen)),
    );
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`Permission argument ${key} must be a plain data property`);
    }
    output[key] = snapshotPermissionValue(descriptor.value, seen);
  }
  return Object.freeze(output);
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
