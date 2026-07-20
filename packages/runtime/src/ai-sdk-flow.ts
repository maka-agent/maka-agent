/**
 * AiSdkFlow — the default long-term AgentFlow implementation.
 *
 * Architecture: docs/architecture/runtime-core-architecture-draft.md
 *
 * Design intent (preserved by this node):
 *   - The AI SDK remains Maka's first-class long-term flow engine. This
 *     flow is the formal seam around the existing stepping engine, NOT a
 *     replacement for it.
 *   - The current model/tool loop lives inside `AiSdkBackend.send()`. This
 *     flow does NOT reimplement streaming. It wraps an `AgentBackend` (the
 *     production instance is `AiSdkBackend`) and normalizes its
 *     renderer-facing `SessionEvent` stream into canonical `RuntimeEvent`s.
 *   - This keeps current SessionManager behavior stable while giving future
 *     work a single target: `RuntimeRunner -> AiSdkFlow` instead of
 *     `SessionManager -> AgentRun -> AiSdkBackend`.
 *
 * What this adapter owns:
 *   - `run(ctx, input)`: drive the wrapped backend and emit `RuntimeEvent`s.
 *   - `mapSessionEventToRuntimeEvent`: a documented, testable placeholder
 *     mapping from the existing `SessionEvent` union onto `RuntimeEvent`.
 *   - coalesce duplicate terminal backend facts (e.g. `abort` followed by
 *     trailing `complete(user_stop)`) so the AgentFlow contract stays at
 *     exactly one terminal RuntimeEvent.
 *   - control surface (`stop` / `respondToPermission` / `dispose`): delegate
 *     to the wrapped backend so current control semantics are preserved.
 *
 * What this adapter deliberately does NOT do:
 *   - rewrite or fork `AiSdkBackend.send()`;
 *   - own model-history projection (Phase 7) or tool-event actions (Phase 5).
 */

import {
  failureClassFromCompleteStopReason,
  type AnyPermissionRequestEvent,
  type CompleteEvent,
  type SessionEvent,
} from '@maka/core/events';
import { projectInteractionPermissionRequest } from '@maka/core/interaction';
import type { PermissionDecision } from '@maka/core/backend-types';
import type { PermissionRequestPayload } from '@maka/core/permission';
import type { UserQuestionResponse } from '@maka/core/user-question';
import {
  isTerminalRuntimeEvent,
  type RuntimeEvent,
  type RuntimeEventStatus,
} from '@maka/core/runtime-event';

import type { AgentBackend, BackendSessionEvent } from '@maka/core/backend-types';
import { type AgentFlow, type AgentFlowControl, type FlowInput } from './agent-flow.js';
import type { InvocationContext } from './invocation-context.js';
import {
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
} from './interaction-authority.js';
import { isRuntimeLifecycleFatal } from './runtime-lifecycle-errors.js';

// ============================================================================
// SessionEvent → RuntimeEvent mapping (placeholder, Phase 4)
// ============================================================================

/** The `CompleteEvent.stopReason` literal union, re-declared for portability. */
export type CompleteStopReason = CompleteEvent['stopReason'];

/**
 * Map a `CompleteEvent.stopReason` onto a terminal `RuntimeEventStatus`.
 *
 * `end_turn` / `max_tokens` / `*_handoff` all represent the streaming phase
 * ending normally (control may be handed off, but the run is not a failure),
 * so they map to `completed`. `user_stop` maps to `aborted`; `error` to
 * `failed`. An explicit `step_limit` is also failed because the requested work
 * may be incomplete. Phase 5+ may introduce a richer `waiting`/`handoff` status.
 */
export function mapCompleteStopReason(reason: CompleteStopReason): RuntimeEventStatus {
  if (reason === 'user_stop') return 'aborted';
  return failureClassFromCompleteStopReason(reason) ? 'failed' : 'completed';
}

/**
 * Shared, mutable tool-name lookup accumulated as the stream flows. The AI
 * SDK backend emits `ToolStartEvent` (which carries `toolName`) before the
 * matching `ToolResultEvent` (which does not). Remembering the name keeps
 * `function_response` content populated without a second source of truth.
 */
export interface SessionEventMapMemory {
  toolNameByUseId: Map<string, string>;
  failureClass?: string;
}

/** Controls execution-sensitive private args and interaction payload ownership. */
export type InteractionProjectionMode = 'embedded' | 'host-owned';

export function createSessionEventMapMemory(): SessionEventMapMemory {
  return { toolNameByUseId: new Map() };
}

/**
 * Resolve the runtime identity shared by every event of an invocation.
 * Reuses the source `SessionEvent.id` as the canonical event id so the
 * adapter keeps 1:1 dedup linkage with the backend stream.
 */
function resolveBase(event: SessionEvent, ctx: InvocationContext) {
  const now = ctx.now ?? (() => Date.now());
  const base = {
    id: event.id,
    invocationId: ctx.invocationId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ts: typeof event.ts === 'number' ? event.ts : now(),
    partial: false,
  };
  if (ctx.branch !== undefined) (base as { branch?: string }).branch = ctx.branch;
  return base;
}

function mapPermissionRequest(event: AnyPermissionRequestEvent): PermissionRequestPayload {
  const { id: _eventId, turnId: _turnId, ts: _ts, type: _type, ...request } = event;
  const projected = projectInteractionPermissionRequest(request as PermissionRequestPayload);
  return {
    requestId: event.requestId,
    toolUseId: projected.toolUseId,
    ...projected.prompt,
  } as PermissionRequestPayload;
}

/**
 * Map one renderer-facing `SessionEvent` onto a canonical `RuntimeEvent`.
 *
 * This is the Phase 4 placeholder mapping documented in the architecture
 * doc. It is deterministic given `(event, ctx, memory)` and carries no I/O.
 * Role/author choices:
 *
 *   - model text/thinking          → role 'model',   author 'agent'
 *   - tool_start (function call)   → role 'model',   author 'agent'
 *   - tool progress/output deltas  → role 'tool',    author 'tool' (partial)
 *   - tool_result (function resp)  → role 'tool',    author 'tool'
 *   - permission_request           → role 'system',  author 'system'
 *   - permission_decision_ack      → embedded author 'user'; host-owned author 'system'
 *   - plan_submitted               → role 'system',  author 'agent'
 *   - token_usage                  → role 'system',  author 'system'
 *   - error                        → role 'system',  author 'system'
 *   - abort                        → role 'system',  author 'system' (terminal)
 *   - complete                     → role 'system',  author 'system' (terminal)
 *
 * `memory` is mutated for `tool_start` (records `toolName`) and read for
 * `tool_result`. Callers SHOULD pass one memory instance per invocation so
 * the `toolUseId → toolName` linkage is consistent across the stream. The
 * interaction projection defaults to embedded payloads for existing callers.
 */
export function mapSessionEventToRuntimeEvent(
  event: SessionEvent,
  ctx: InvocationContext,
  memory: SessionEventMapMemory = createSessionEventMapMemory(),
  interactionProjection: InteractionProjectionMode = 'embedded',
): RuntimeEvent {
  if (event.type === 'queue_update') {
    // Not backend-mappable by design: the kernel is queue_update's only
    // legal producer and pushes it directly into the turn stream. The flow
    // drops a backend-yielded one at the ingress (see run()), so reaching
    // this line means a caller bypassed that authority boundary.
    throw new Error('queue_update is not a backend event: the kernel is its only legal producer');
  }
  const narrowed: BackendSessionEvent = event;
  return mapBackendSessionEvent(narrowed, ctx, memory, interactionProjection);
}

function mapBackendSessionEvent(
  event: BackendSessionEvent,
  ctx: InvocationContext,
  memory: SessionEventMapMemory,
  interactionProjection: InteractionProjectionMode,
): RuntimeEvent {
  const base = resolveBase(event, ctx);

  switch (event.type) {
    // ── Model text ────────────────────────────────────────────────────────
    case 'text_delta':
      return {
        ...base,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: event.text },
        refs: { providerEventId: event.messageId },
      };
    case 'text_complete':
      return {
        ...base,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: event.text },
        refs: { providerEventId: event.messageId },
      };

    // ── Model thinking ────────────────────────────────────────────────────
    case 'thinking_delta':
      return {
        ...base,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: event.text },
        refs: { providerEventId: event.messageId },
      };
    case 'thinking_complete':
      return {
        ...base,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'thinking',
          text: event.text,
          ...(event.signature !== undefined ? { signature: event.signature } : {}),
        },
        refs: { providerEventId: event.messageId },
      };

    // ── Tool calls / results ──────────────────────────────────────────────
    case 'tool_start': {
      memory.toolNameByUseId.set(event.toolUseId, event.toolName);
      const ev: RuntimeEvent = {
        ...base,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: event.toolUseId,
          name: event.toolName,
          ...(interactionProjection === 'embedded' && Object.hasOwn(event, 'args')
            ? { args: structuredClone(event.args) }
            : {}),
          ...(event.review === undefined ? {} : { review: structuredClone(event.review) }),
        },
        refs: {
          toolCallId: event.toolUseId,
          ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
          ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
        },
      };
      if (event.activityKind !== undefined || event.displayName !== undefined) {
        const stateDelta: Record<string, unknown> = {};
        if (event.activityKind !== undefined) stateDelta.activityKind = event.activityKind;
        if (event.displayName !== undefined) stateDelta.displayName = event.displayName;
        ev.actions = { stateDelta };
      }
      return ev;
    }
    case 'tool_output_delta':
      // Transient tool stdout/stderr side-channel. Carried as a partial
      // tool-role heartbeat; the canonical tool result is the function_response
      // below. Phase 5 may promote this to a dedicated tool-progress action.
      return {
        ...base,
        partial: true,
        role: 'tool',
        author: 'tool',
        refs: { toolCallId: event.toolUseId },
      };
    case 'tool_progress':
      return {
        ...base,
        partial: true,
        role: 'tool',
        author: 'tool',
        refs: { toolCallId: event.toolUseId },
      };
    case 'tool_result': {
      const name = memory.toolNameByUseId.get(event.toolUseId) ?? '';
      const ev: RuntimeEvent = {
        ...base,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: event.toolUseId,
          name,
          result: event.content,
          ...(event.isError ? { isError: true } : {}),
        },
        refs: {
          toolCallId: event.toolUseId,
          ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
        },
      };
      if (event.durationMs !== undefined) {
        ev.actions = { stateDelta: { durationMs: event.durationMs } };
      }
      return ev;
    }

    // ── Permission / question interactions ──────────────
    case 'permission_request':
      if (interactionProjection === 'host-owned') {
        return {
          ...base,
          role: 'system',
          author: 'system',
          refs: { toolCallId: event.toolUseId, interactionId: event.requestId },
        };
      }
      return {
        ...base,
        role: 'system',
        author: 'system',
        actions: {
          permissionRequest: mapPermissionRequest(event),
        },
        refs: { toolCallId: event.toolUseId },
      };
    case 'permission_decision_ack':
      if (interactionProjection === 'host-owned') {
        return {
          ...base,
          role: 'system',
          author: 'system',
          refs: { toolCallId: event.toolUseId, interactionId: event.requestId },
        };
      }
      return {
        ...base,
        role: 'system',
        author: 'user',
        actions: {
          permissionDecision: {
            requestId: event.requestId,
            decision: event.decision,
            ...(event.rememberForTurn !== undefined
              ? { rememberForTurn: event.rememberForTurn }
              : {}),
            ...(event.reviewer !== undefined ? { reviewer: event.reviewer } : {}),
            ...(event.riskLevel !== undefined ? { riskLevel: event.riskLevel } : {}),
          },
        },
        refs: { toolCallId: event.toolUseId },
      };
    case 'user_question_request':
      if (interactionProjection === 'host-owned') {
        return {
          ...base,
          role: 'system',
          author: 'system',
          refs: { toolCallId: event.toolUseId, interactionId: event.requestId },
        };
      }
      return {
        ...base,
        role: 'system',
        author: 'system',
        actions: {
          userQuestionRequest: {
            requestId: event.requestId,
            toolUseId: event.toolUseId,
            questions: event.questions,
          },
        },
        refs: { toolCallId: event.toolUseId },
      };

    // ── Steering: a user message injected mid-turn at a step boundary ─────
    // Persisted as a first-class user event so the ledger, transcript, and
    // future-turn context all carry the interjection in place.
    case 'steering_message':
      return {
        ...base,
        role: 'user',
        author: 'user',
        // Raw text + steering marker: read models render the text as-is,
        // model replay wraps it in the canonical steering envelope.
        content: { kind: 'text', text: event.text, steering: true },
        refs: { providerEventId: event.messageId },
      };

    // (queue_update is deliberately NOT mappable: the kernel is its only
    // legal producer and pushes it directly into the turn stream. The flow
    // drops a backend-yielded one at the ingress — see run() — so it is
    // excluded from this function's input vocabulary.)

    // ── Plan handoff (placeholder; Phase 5/7 refines) ─────────────────────
    case 'plan_submitted':
      return {
        ...base,
        role: 'system',
        author: 'agent',
        actions: {
          stateDelta: {
            planId: event.planId,
            ...(event.proposalId ? { proposalId: event.proposalId } : {}),
            ...(event.revision !== undefined ? { revision: event.revision } : {}),
            title: event.title,
            ...(event.overview ? { overview: event.overview } : {}),
            ...(event.risks ? { risks: event.risks } : {}),
            ...(event.markdownPath ? { markdownPath: event.markdownPath } : {}),
            ...(event.steps ? { steps: event.steps } : {}),
          },
        },
      };

    // ── Token usage ───────────────────────────────────────────────────────
    case 'token_usage':
      return {
        ...base,
        role: 'system',
        author: 'system',
        actions: {
          tokenUsage: {
            input: event.input,
            output: event.output,
            ...(event.cacheHitInput !== undefined ? { cacheHitInput: event.cacheHitInput } : {}),
            ...(event.cacheMissInput !== undefined ? { cacheMissInput: event.cacheMissInput } : {}),
            ...(event.cacheMissInputSource !== undefined
              ? { cacheMissInputSource: event.cacheMissInputSource }
              : {}),
            ...(event.cacheWriteInput !== undefined
              ? { cacheWriteInput: event.cacheWriteInput }
              : {}),
            ...(event.reasoning !== undefined ? { reasoning: event.reasoning } : {}),
            ...(event.total !== undefined ? { total: event.total } : {}),
            ...(event.rawFinishReason !== undefined
              ? { rawFinishReason: event.rawFinishReason }
              : {}),
            ...(event.runtimeSteps !== undefined ? { runtimeSteps: event.runtimeSteps } : {}),
            ...(event.cacheRead !== undefined ? { cacheRead: event.cacheRead } : {}),
            ...(event.cacheCreation !== undefined ? { cacheCreation: event.cacheCreation } : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
            ...(event.contextRemaining !== undefined
              ? { contextRemaining: event.contextRemaining }
              : {}),
            ...(event.systemPromptHash !== undefined
              ? { systemPromptHash: event.systemPromptHash }
              : {}),
            ...(event.prefixHash !== undefined ? { prefixHash: event.prefixHash } : {}),
            ...(event.prefixChangeReason !== undefined
              ? { prefixChangeReason: event.prefixChangeReason }
              : {}),
            ...(event.requestShapeHash !== undefined
              ? { requestShapeHash: event.requestShapeHash }
              : {}),
            ...(event.requestShapeChangeReason !== undefined
              ? { requestShapeChangeReason: event.requestShapeChangeReason }
              : {}),
            ...(event.promptSegments !== undefined ? { promptSegments: event.promptSegments } : {}),
            ...(event.contextBudget !== undefined ? { contextBudget: event.contextBudget } : {}),
          },
        },
        ...(event.providerRequestTraceId !== undefined
          ? { refs: { providerRequestTraceId: event.providerRequestTraceId } }
          : {}),
      };

    // ── Error ─────────────────────────────────────────────────────────────
    case 'error':
      // No status here: the backend follows with a terminal `complete(error)`.
      // Keeping status off the error event avoids a double-terminal in the
      // error path; the trailing complete carries the terminal signal.
      memory.failureClass = event.reason ?? event.code ?? 'unknown';
      return {
        ...base,
        role: 'system',
        author: 'system',
        content: {
          kind: 'error',
          ...(event.code !== undefined ? { code: event.code } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          message: event.message,
          ...(event.details !== undefined ? { details: event.details } : {}),
        },
      };

    // ── Terminal: abort + complete ────────────────────────────────────────
    case 'abort':
      return {
        ...base,
        role: 'system',
        author: 'system',
        status: 'aborted',
        actions: { endInvocation: true, stateDelta: { abortSource: event.reason } },
      };
    case 'complete':
      return completeRuntimeEvent(base, event, memory);
    default: {
      // Exhaustiveness guard: if SessionEvent grows a new variant, the
      // mapping falls through to a diagnostic event instead of dropping it.
      const _exhaustive: never = event;
      void _exhaustive;
      return {
        ...base,
        role: 'system',
        author: 'system',
        actions: {
          stateDelta: { unmappedSessionEventType: (event as { type?: string }).type ?? 'unknown' },
        },
      };
    }
  }
}

function completeRuntimeEvent(
  base: ReturnType<typeof resolveBase>,
  event: CompleteEvent,
  memory: SessionEventMapMemory,
): RuntimeEvent {
  const stopReason = event.stopReason;
  const status =
    memory.failureClass && stopReason !== 'user_stop'
      ? 'failed'
      : mapCompleteStopReason(stopReason);
  const stateDelta: Record<string, unknown> = { stopReason };
  if (status === 'failed') {
    stateDelta.failureClass =
      memory.failureClass ?? failureClassFromCompleteStopReason(stopReason) ?? 'runtime_error';
  }
  // The context_budget_exhausted outcome carries which invariant made the turn
  // unrecoverable; the durable terminal state must not collapse it to a bare
  // failure class.
  if (event.contextBudgetExhaustedDetail !== undefined) {
    stateDelta.contextBudgetExhaustedDetail = event.contextBudgetExhaustedDetail;
  }
  if (status === 'aborted') stateDelta.abortSource = stopReason;
  return {
    ...base,
    role: 'system',
    author: 'system',
    status,
    actions: { endInvocation: true, stateDelta },
  };
}

// ============================================================================
// AiSdkFlow — AgentFlow over a wrapped AgentBackend
// ============================================================================

export interface AiSdkFlowInput {
  /** The wrapped stepping engine. Production: AiSdkBackend. Tests: any AgentBackend. */
  backend: AgentBackend;
  /** Host-owned requests persist only Interaction Store identity references. */
  interactionProjection?: InteractionProjectionMode;
  /**
   * Optional production projection hook. Called for every raw backend
   * SessionEvent after it has been mapped to a RuntimeEvent and before the
   * RuntimeEvent is yielded/coalesced.
   */
  onSessionEvent?: (sessionEvent: SessionEvent, runtimeEvent: RuntimeEvent) => Promise<void> | void;
  /** Called if the wrapped backend stream throws. */
  onError?: (error: unknown) => Promise<void> | void;
  /** Called after ordinary completion/error/abandonment, but never after a typed Interaction failure. */
  onFinally?: () => Promise<void> | void;
  /**
   * Keep consuming backend events after the first terminal RuntimeEvent.
   * Events consumed during that drain are silent: they are not yielded and
   * are not sent through onSessionEvent.
   */
  drainAfterTerminal?: boolean;
}

/**
 * Default long-term `AgentFlow` implementation.
 *
 * Wraps an existing `AgentBackend` (the production instance is
 * `AiSdkBackend`) and exposes the canonical `AgentFlow.run()` seam. The
 * adapter delegates all stepping to the backend's `send()` and only
 * translates `SessionEvent → RuntimeEvent`, so it cannot destabilize the
 * current `SessionManager` path: nothing changes until a caller opts into
 * `AiSdkFlow.run()`.
 *
 * Control surface delegates 1:1 to the wrapped backend, preserving the
 * existing `stop` / `respondToPermission` / `dispose` semantics.
 */
export class AiSdkFlow implements AgentFlow, AgentFlowControl {
  readonly kind: string;
  readonly sessionId: string;
  private readonly backend: AgentBackend;
  private readonly onSessionEvent: AiSdkFlowInput['onSessionEvent'];
  private readonly onError: AiSdkFlowInput['onError'];
  private readonly onFinally: AiSdkFlowInput['onFinally'];
  private readonly drainAfterTerminal: boolean;
  private readonly interactionProjection: InteractionProjectionMode;

  constructor(input: AiSdkFlowInput) {
    this.backend = input.backend;
    this.sessionId = input.backend.sessionId;
    this.kind = input.backend.kind;
    this.onSessionEvent = input.onSessionEvent;
    this.onError = input.onError;
    this.onFinally = input.onFinally;
    this.drainAfterTerminal = input.drainAfterTerminal ?? false;
    this.interactionProjection = input.interactionProjection ?? 'embedded';
  }

  /** The wrapped backend (exposed for runners that need the raw control surface). */
  get backendRef(): AgentBackend {
    return this.backend;
  }

  async *run(ctx: InvocationContext, input: FlowInput): AsyncIterable<RuntimeEvent> {
    if (ctx.sessionId !== this.sessionId) {
      throw new Error(
        `AiSdkFlow session mismatch: ctx.sessionId=${ctx.sessionId} but backend is bound to ${this.sessionId}`,
      );
    }

    // Bridge the FlowInput.abortSignal seam onto the backend's stop() control.
    // The legacy backend owns its own AbortController; this just routes an
    // external signal to the existing steering method.
    const abortSignal = input.abortSignal;
    let onAbort: (() => void) | null = null;
    if (abortSignal) {
      if (abortSignal.aborted) {
        await this.stop('user_stop').catch(() => {});
      } else {
        onAbort = () => {
          void this.stop('user_stop').catch(() => {});
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const memory = createSessionEventMapMemory();
    let terminalEmitted = false;
    let terminalAccepted = false;
    let errorEmitted = false;
    let interactionFailure:
      | RuntimeInteractionFailStopError
      | RuntimeInteractionInvariantError
      | undefined;
    try {
      for await (const sessionEvent of this.backend.send({
        invocationId: ctx.invocationId,
        runId: ctx.runId,
        turnId: ctx.turnId,
        ...(input.orchestration !== undefined ? { orchestration: input.orchestration } : {}),
        // The persisted head anchor: mid-turn capacity compaction keeps this
        // event verbatim and needs its exact ledger identity for coverage.
        ...(ctx.request.initialRuntimeEvent !== undefined
          ? { headAnchorRuntimeEvent: ctx.request.initialRuntimeEvent }
          : {}),
        text: input.text,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        ...(input.quotes !== undefined ? { quotes: input.quotes } : {}),
        context: input.context,
        ...(input.runtimeContext !== undefined ? { runtimeContext: input.runtimeContext } : {}),
        ...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
        ...(input.pullSteering !== undefined ? { pullSteering: input.pullSteering } : {}),
        ...(input.ackSteering !== undefined ? { ackSteering: input.ackSteering } : {}),
        ...(input.nackSteering !== undefined ? { nackSteering: input.nackSteering } : {}),
      })) {
        if (terminalEmitted) continue;
        // Ingress authority check: queue_update has exactly one legal
        // producer — the kernel, which pushes it directly into the turn
        // stream, never through this flow. A backend yielding one is forging
        // authoritative queue state: drop it here — not mapped, not
        // forwarded to observers, not persisted.
        if (sessionEvent.type === 'queue_update') continue;
        const runtimeEvent = mapSessionEventToRuntimeEvent(
          sessionEvent,
          ctx,
          memory,
          this.interactionProjection,
        );
        if (sessionEvent.type === 'error') errorEmitted = true;
        if (isTerminalRuntimeEvent(runtimeEvent)) {
          terminalEmitted = true;
          await this.onSessionEvent?.(sessionEvent, runtimeEvent);
          terminalAccepted = true;
          yield runtimeEvent;
          if (!this.drainAfterTerminal) break;
          continue;
        }
        await this.onSessionEvent?.(sessionEvent, runtimeEvent);
        yield runtimeEvent;
      }
      if (!terminalEmitted) {
        for (const sessionEvent of missingTerminalSessionEvents(ctx, {
          includeError: !errorEmitted,
        })) {
          const runtimeEvent = mapSessionEventToRuntimeEvent(
            sessionEvent,
            ctx,
            memory,
            this.interactionProjection,
          );
          await this.onSessionEvent?.(sessionEvent, runtimeEvent);
          if (isTerminalRuntimeEvent(runtimeEvent)) terminalEmitted = true;
          yield runtimeEvent;
        }
      }
    } catch (error) {
      if (isRuntimeLifecycleFatal(error)) interactionFailure = error;
      if (terminalAccepted && !interactionFailure) return;
      if (interactionFailure) {
        try {
          await this.onError?.(error);
        } catch {
          // A callback failure cannot replace the exact fail-stop/invariant identity.
        }
      } else {
        try {
          await this.onError?.(error);
        } catch (callbackError) {
          if (isRuntimeLifecycleFatal(callbackError)) interactionFailure = callbackError;
          throw callbackError;
        }
      }
      throw error;
    } finally {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      if (!interactionFailure) await this.onFinally?.();
    }
  }

  async stop(reason: 'user_stop' | 'redirect'): Promise<void> {
    await this.backend.stop(reason);
  }

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    await this.backend.respondToPermission(decision);
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    await this.backend.respondToUserQuestion?.(response);
  }

  async dispose(): Promise<void> {
    await this.backend.dispose();
  }
}

function missingTerminalSessionEvents(
  ctx: InvocationContext,
  options: { includeError: boolean },
): SessionEvent[] {
  const ts = ctx.now();
  const events: SessionEvent[] = [];
  if (options.includeError) {
    events.push({
      type: 'error',
      id: ctx.newId(),
      turnId: ctx.turnId,
      ts,
      recoverable: false,
      code: 'missing_terminal_event',
      reason: 'missing_terminal_event',
      message: 'flow exhausted without a terminal RuntimeEvent',
    });
  }
  events.push({
    type: 'complete',
    id: ctx.newId(),
    turnId: ctx.turnId,
    ts,
    stopReason: 'error',
  });
  return events;
}
