/**
 * RuntimeRunner — Runtime v2 invocation shell.
 *
 * Source: docs/runtime-v2-architecture-evolution.md §Target Architecture and
 * Phase 2 (RuntimeRunner Shell).
 *
 * RuntimeRunner is the invocation shell. It remains decoupled from
 * SessionManager / SessionStore so it can be exercised with fake services,
 * while still being able to wrap production AgentRun streams during the
 * Runtime v2 migration.
 *
 * Responsibilities (per the node spec):
 *   1. Run an injectable preflight gate.
 *   2. Create the InvocationContext through injected id/time providers.
 *   3. Emit (collect) the initial user RuntimeEvent.
 *   4. Dispatch to an injected AgentFlow and collect canonical RuntimeEvents.
 *   5. Return a structured result with the collected events and a terminal
 *      status.
 *
 * Out-of-scope (deliberately): direct SessionStore writes, projection
 * driving, operational AgentRunStore writes, and RuntimeEventStore ledger
 * writes. Those remain owned by the runtime orchestration around AgentRun while
 * SessionManager delegates invocation execution through this shell.
 */

import {
  isTerminalRuntimeEvent,
  type RuntimeEvent,
  type RuntimeEventStatus,
} from '@maka/core/runtime-event';
import type {
  InvocationContext,
  InvocationFailure,
  InvocationProviders,
  InvocationRequest,
  InvocationResult,
  InvocationResultStatus,
} from './invocation-context.js';
import { createDefaultInvocationProviders } from './invocation-context.js';
import type { FlowInput } from './agent-flow.js';

// ============================================================================
// RuntimeGate — narrow preflight seam
// ============================================================================

/**
 * Decision returned by a RuntimeGate preflight. `ok: false` blocks the
 * invocation before any context is created or event emitted.
 */
export interface RuntimeGateDecision {
  ok: boolean;
  /** Machine-readable reason when ok === false (surfaced as failure.message). */
  reason?: string;
}

/**
 * Narrow preflight interface for readiness/blocked/running/waiting policy.
 * Kept injectable so tests can pass a stub and Phase 6 can move desktop
 * main's readiness/rebind checks behind a real implementation.
 */
export interface RuntimeGate {
  preflight(request: InvocationRequest): Promise<RuntimeGateDecision>;
}

/**
 * Functional gate from a callback. Convenient for tests; also the shape a
 * future Phase 6 gate will compose from readiness rules.
 */
export function runtimeGateFromCallback(
  preflight: (
    request: InvocationRequest,
  ) => Promise<RuntimeGateDecision> | RuntimeGateDecision,
): RuntimeGate {
  return {
    preflight: async (request) => preflight(request),
  };
}

// ============================================================================
// AgentFlowLike — local flow seam
// ============================================================================

/**
 * Minimal flow contract RuntimeRunner dispatches to. The formal AgentFlow
 * interface (AiSdkFlow node) will be assignable to this; it is defined
 * locally so this skeleton does not block on — or duplicate — the flow
 * node's public surface.
 */
export interface AgentFlowLike {
  run(ctx: InvocationContext, input: FlowInput): AsyncIterable<RuntimeEvent>;
}

// ============================================================================
// RuntimeRunnerDeps
// ============================================================================

export interface RuntimeRunnerDeps {
  flow: AgentFlowLike;
  /** Optional preflight gate; omitted means "always allow". */
  gate?: RuntimeGate;
  /** Injectable id/time providers. Defaults to crypto.randomUUID / Date.now. */
  providers?: InvocationProviders;
  /**
   * Called after the initial user RuntimeEvent is built and before the flow is
   * dispatched. RuntimeRunner still does not own storage; orchestration layers
   * can use this to keep durable ledgers ahead of renderer-visible events.
   */
  onInitialRuntimeEvent?: (event: RuntimeEvent) => Promise<void> | void;
  /**
   * Whether to stop collecting at the first terminal RuntimeEvent. Defaults
   * to true for standalone runner callers; production bridges can set false
   * to keep draining cleanup/trailing events from wrapped streams.
   */
  stopOnTerminal?: boolean;
}

// ============================================================================
// RuntimeRunner
// ============================================================================

export class RuntimeRunner {
  private readonly flow: AgentFlowLike;
  private readonly gate: RuntimeGate | undefined;
  private readonly providers: InvocationProviders;
  private readonly onInitialRuntimeEvent: RuntimeRunnerDeps['onInitialRuntimeEvent'];
  private readonly stopOnTerminal: boolean;

  constructor(deps: RuntimeRunnerDeps) {
    this.flow = deps.flow;
    this.gate = deps.gate;
    this.providers = deps.providers ?? createDefaultInvocationProviders();
    this.onInitialRuntimeEvent = deps.onInitialRuntimeEvent;
    this.stopOnTerminal = deps.stopOnTerminal ?? true;
  }

  /**
   * Run one invocation end-to-end and return a structured result.
   *
   * Event order is guaranteed: the initial user RuntimeEvent is always
   * collected before any flow event. By default collection stops at the first
   * terminal RuntimeEvent; callers that wrap streams with cleanup/trailing
   * events can opt into full draining through RuntimeRunnerDeps.
   */
  async run(request: InvocationRequest): Promise<InvocationResult> {
    const startedAt = this.providers.now();
    const invocationId = request.invocationId ?? this.providers.newId();
    const runId = request.runId ?? this.providers.newId();

    // 1. Preflight (injectable gate). On failure we admit no invocation: no
    //    context, no user event, no flow dispatch.
    if (this.gate) {
      const decision = await this.gate.preflight(request);
      if (!decision.ok) {
        return this.buildResult({
          request,
          invocationId,
          runId,
          startedAt,
          finishedAt: this.providers.now(),
          status: 'failed',
          events: [],
          failure: {
            class: 'preflight',
            ...(decision.reason ? { message: decision.reason } : {}),
          },
        });
      }
    }

    // 2. Abort already signalled before dispatch. Fail fast without emitting
    //    a user event or calling the flow, mirroring the preflight path.
    if (request.abortSignal?.aborted) {
      return this.buildResult({
        request,
        invocationId,
        runId,
        startedAt,
        finishedAt: this.providers.now(),
        status: 'failed',
        events: [],
        failure: {
          class: 'aborted',
          message: 'abort signal already set before dispatch',
        },
      });
    }

    // 3. Create the invocation context through the injected providers.
    const ctx: InvocationContext = {
      sessionId: request.sessionId,
      invocationId,
      runId,
      turnId: request.turnId,
      ...(request.branch ? { branch: request.branch } : {}),
      source: request.source,
      startedAt,
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      request,
      newId: this.providers.newId,
      now: this.providers.now,
    };

    const events: RuntimeEvent[] = [];

    // 4. Emit the initial user RuntimeEvent before any flow event.
    const userEvent = buildUserEvent(ctx, request);
    await this.onInitialRuntimeEvent?.(userEvent);
    events.push(userEvent);
    const flowInput = buildFlowInput(request);

    // 5. Dispatch to the flow and collect canonical events. By default the
    //    first terminal event ends collection; when stopOnTerminal is false,
    //    keep draining while remembering any failure signal. A thrown error,
    //    non-completed terminal status, denied permission, non-terminal error,
    //    or incomplete model finish maps the result to 'failed'.
    let failure: InvocationFailure | undefined;
    let terminalSeen = false;
    try {
      for await (const ev of this.flow.run(ctx, flowInput)) {
        events.push(ev);
        failure ??= failureFromRuntimeEvent(ev);
        if (isTerminalRuntimeEvent(ev)) {
          terminalSeen = true;
          if (this.stopOnTerminal) {
            break;
          }
        }
      }
    } catch (error) {
      failure = {
        class: error instanceof Error && error.name ? error.name : 'error',
        ...(error instanceof Error && error.message ? { message: error.message } : {}),
      };
    }
    if (!failure && !terminalSeen) {
      failure = {
        class: 'missing_terminal_event',
        message: 'flow exhausted without a terminal RuntimeEvent',
      };
    }

    const status: InvocationResultStatus = failure ? 'failed' : 'completed';
    return this.buildResult({
      request,
      invocationId,
      runId,
      startedAt,
      finishedAt: this.providers.now(),
      status,
      events,
      ...(failure ? { failure } : {}),
    });
  }

  private buildResult(args: {
    request: InvocationRequest;
    invocationId: string;
    runId: string;
    startedAt: number;
    finishedAt: number;
    status: InvocationResultStatus;
    events: RuntimeEvent[];
    failure?: InvocationFailure;
  }): InvocationResult {
    return {
      invocationId: args.invocationId,
      runId: args.runId,
      sessionId: args.request.sessionId,
      turnId: args.request.turnId,
      status: args.status,
      events: args.events,
      ...(args.failure ? { failure: args.failure } : {}),
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function buildUserEvent(ctx: InvocationContext, request: InvocationRequest): RuntimeEvent {
  return {
    id: ctx.newId(),
    invocationId: ctx.invocationId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ts: ctx.startedAt,
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    partial: false,
    role: 'user',
    author: 'user',
    content: {
      kind: 'text',
      text: request.text,
      ...(request.attachments !== undefined && request.attachments.length > 0
        ? { attachments: request.attachments }
        : {}),
    },
  };
}

function buildFlowInput(request: InvocationRequest): FlowInput {
  return {
    text: request.text,
    context: request.context ?? [],
    ...(request.runtimeContext !== undefined ? { runtimeContext: request.runtimeContext } : {}),
    ...(request.attachments !== undefined ? { attachments: request.attachments } : {}),
    ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
  };
}

/**
 * Map a terminal RuntimeEvent to a failure when its status is anything other
 * than 'completed'. A terminal event without an explicit status (e.g. one
 * that only carries actions.endInvocation) is treated as completed.
 */
function failureFromRuntimeEvent(event: RuntimeEvent): InvocationFailure | undefined {
  if (isTerminalRuntimeEvent(event)) {
    const terminalFailure = failureFromTerminalEvent(event);
    if (terminalFailure) return terminalFailure;
  }

  const content = event.content;
  if (content?.kind === 'error') {
    return {
      class: content.reason ?? content.code ?? 'runtime_error',
      message: content.message,
    };
  }

  const permissionDecision = event.actions?.permissionDecision;
  if (permissionDecision?.decision === 'deny') {
    return {
      class: 'permission_denied',
      message: `permission request ${permissionDecision.requestId} was denied`,
    };
  }

  const rawFinishReason = event.actions?.tokenUsage?.rawFinishReason;
  const finishFailure = failureFromRawFinishReason(rawFinishReason);
  if (finishFailure) return finishFailure;

  return undefined;
}

function failureFromTerminalEvent(event: RuntimeEvent): InvocationFailure | undefined {
  const status: RuntimeEventStatus | undefined = event.status;
  if (status === undefined || status === 'completed') return undefined;
  const content = event.content;
  const message = content?.kind === 'error' ? content.message : undefined;
  return {
    class: status,
    ...(message ? { message } : {}),
    terminalStatus: status,
  };
}

function failureFromRawFinishReason(rawFinishReason: string | undefined): InvocationFailure | undefined {
  if (!rawFinishReason) return undefined;
  const normalized = rawFinishReason.toLowerCase().replace(/_/g, '-');
  if (normalized === 'tool-calls') {
    return {
      class: 'incomplete_tool_calls',
      message: 'model stopped at the tool-call step cap before completing the invocation',
    };
  }
  if (normalized === 'length' || normalized === 'max-tokens') {
    return {
      class: 'max_tokens',
      message: 'model stopped at the token limit before completing the invocation',
    };
  }
  return undefined;
}
