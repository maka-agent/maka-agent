/**
 * AiSdkFlow — the default long-term AgentFlow implementation.
 *
 * Source: docs/runtime-v2-architecture-evolution.md §Target Architecture
 * and §Migration Plan › Phase 4 (AiSdkFlow Formalization).
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

import type { CompleteEvent, SessionEvent } from '@maka/core/events';
import type { PermissionDecision } from '@maka/core/backend-types';
import { isTerminalRuntimeEvent, type RuntimeEvent, type RuntimeEventStatus } from '@maka/core/runtime-event';

import type { AgentBackend } from './ai-sdk-backend.js';
import {
  type AgentFlow,
  type AgentFlowControl,
  type FlowInput,
  type InvocationContext,
} from './agent-flow.js';

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
 * `failed`. Phase 5+ may introduce a richer `waiting`/`handoff` status.
 */
export function mapCompleteStopReason(reason: CompleteStopReason): RuntimeEventStatus {
  switch (reason) {
    case 'user_stop':
      return 'aborted';
    case 'error':
      return 'failed';
    case 'end_turn':
    case 'max_tokens':
    case 'plan_handoff':
    case 'permission_handoff':
      return 'completed';
    default:
      return 'completed';
  }
}

/**
 * Shared, mutable tool-name lookup accumulated as the stream flows. The AI
 * SDK backend emits `ToolStartEvent` (which carries `toolName`) before the
 * matching `ToolResultEvent` (which does not). Remembering the name keeps
 * `function_response` content populated without a second source of truth.
 */
export interface SessionEventMapMemory {
  toolNameByUseId: Map<string, string>;
}

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
 *   - permission_decision_ack      → role 'system',  author 'user'
 *   - plan_submitted               → role 'system',  author 'agent'
 *   - token_usage                  → role 'system',  author 'system'
 *   - error                        → role 'system',  author 'system'
 *   - abort                        → role 'system',  author 'system' (terminal)
 *   - complete                     → role 'system',  author 'system' (terminal)
 *
 * `memory` is mutated for `tool_start` (records `toolName`) and read for
 * `tool_result`. Callers SHOULD pass one memory instance per invocation so
 * the `toolUseId → toolName` linkage is consistent across the stream.
 */
export function mapSessionEventToRuntimeEvent(
  event: SessionEvent,
  ctx: InvocationContext,
  memory: SessionEventMapMemory = createSessionEventMapMemory(),
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
          args: event.args,
        },
        refs: { toolCallId: event.toolUseId },
      };
      if (event.displayName !== undefined || event.intent !== undefined) {
        const stateDelta: Record<string, unknown> = {};
        if (event.displayName !== undefined) stateDelta.displayName = event.displayName;
        if (event.intent !== undefined) stateDelta.intent = event.intent;
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
        refs: { toolCallId: event.toolUseId },
      };
      if (event.durationMs !== undefined) {
        ev.actions = { stateDelta: { durationMs: event.durationMs } };
      }
      return ev;
    }

    // ── Permission (first-class runtime action, not just a UI echo) ───────
    case 'permission_request':
      return {
        ...base,
        role: 'system',
        author: 'system',
        actions: {
          permissionRequest: {
            requestId: event.requestId,
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            category: event.category,
            reason: event.reason,
            args: event.args,
            ...(event.hint !== undefined ? { hint: event.hint } : {}),
          },
        },
        refs: { toolCallId: event.toolUseId },
      };
    case 'permission_decision_ack':
      return {
        ...base,
        role: 'system',
        author: 'user',
        actions: {
          permissionDecision: {
            requestId: event.requestId,
            decision: event.decision,
            ...(event.rememberForTurn !== undefined ? { rememberForTurn: event.rememberForTurn } : {}),
          },
        },
        refs: { toolCallId: event.toolUseId },
      };

    // ── Plan handoff (placeholder; Phase 5/7 refines) ─────────────────────
    case 'plan_submitted':
      return {
        ...base,
        role: 'system',
        author: 'agent',
        actions: {
          stateDelta: {
            planId: event.planId,
            title: event.title,
            markdownPath: event.markdownPath,
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
            ...(event.cacheRead !== undefined ? { cacheRead: event.cacheRead } : {}),
            ...(event.cacheCreation !== undefined ? { cacheCreation: event.cacheCreation } : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
            ...(event.contextRemaining !== undefined
              ? { contextRemaining: event.contextRemaining }
              : {}),
          },
        },
      };

    // ── Error ─────────────────────────────────────────────────────────────
    case 'error':
      // No status here: the backend follows with a terminal `complete(error)`.
      // Keeping status off the error event avoids a double-terminal in the
      // error path; the trailing complete carries the terminal signal.
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
        actions: { endInvocation: true },
      };
    case 'complete':
      return {
        ...base,
        role: 'system',
        author: 'system',
        status: mapCompleteStopReason(event.stopReason),
        actions: { endInvocation: true },
      };

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

// ============================================================================
// AiSdkFlow — AgentFlow over a wrapped AgentBackend
// ============================================================================

export interface AiSdkFlowInput {
  /** The wrapped stepping engine. Production: AiSdkBackend. Tests: any AgentBackend. */
  backend: AgentBackend;
  /**
   * Optional production projection hook. Called for every raw backend
   * SessionEvent after it has been mapped to a RuntimeEvent and before the
   * RuntimeEvent is yielded/coalesced.
   */
  onSessionEvent?: (sessionEvent: SessionEvent, runtimeEvent: RuntimeEvent) => Promise<void> | void;
  /** Called if the wrapped backend stream throws. */
  onError?: (error: unknown) => Promise<void> | void;
  /** Called after backend streaming finishes, errors, or is abandoned. */
  onFinally?: () => Promise<void> | void;
  /**
   * Keep consuming backend events after the first terminal RuntimeEvent.
   * Duplicate terminal RuntimeEvents are still coalesced from flow output.
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

  constructor(input: AiSdkFlowInput) {
    this.backend = input.backend;
    this.sessionId = input.backend.sessionId;
    this.kind = input.backend.kind;
    this.onSessionEvent = input.onSessionEvent;
    this.onError = input.onError;
    this.onFinally = input.onFinally;
    this.drainAfterTerminal = input.drainAfterTerminal ?? false;
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
    try {
      for await (const sessionEvent of this.backend.send({
        turnId: ctx.turnId,
        text: input.text,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        context: input.context,
      })) {
        const runtimeEvent = mapSessionEventToRuntimeEvent(sessionEvent, ctx, memory);
        await this.onSessionEvent?.(sessionEvent, runtimeEvent);
        if (isTerminalRuntimeEvent(runtimeEvent)) {
          if (terminalEmitted) continue;
          terminalEmitted = true;
          yield runtimeEvent;
          if (!this.drainAfterTerminal) break;
          continue;
        }
        yield runtimeEvent;
      }
    } catch (error) {
      await this.onError?.(error);
      throw error;
    } finally {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      await this.onFinally?.();
    }
  }

  async stop(reason: 'user_stop' | 'redirect'): Promise<void> {
    await this.backend.stop(reason);
  }

  async respondToPermission(decision: PermissionDecision): Promise<void> {
    await this.backend.respondToPermission(decision);
  }

  async dispose(): Promise<void> {
    await this.backend.dispose();
  }
}
