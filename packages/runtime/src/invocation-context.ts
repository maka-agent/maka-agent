/**
 * InvocationContext — Runtime v2 invocation/run spine.
 *
 * Source: docs/runtime-v2-architecture-evolution.md §Target Architecture,
 * §Proposed Module Shape, and Phase 2 (RuntimeRunner Shell).
 *
 * Phase 2 scope: types + injectable providers. RuntimeRunner consumes these
 * to build a testable invocation shell and can also be handed production ids
 * from an already-created AgentRun while migration wiring is in progress.
 *
 * Identity hierarchy carried on every context: sessionId ⊃ invocationId ⊃
 * runId ⊃ turnId. These mirror the canonical RuntimeEvent fields so events
 * minted inside a flow stay 1:1 with the invocation that produced them.
 */

import type { AttachmentRef } from '@maka/core/events';
import type { RuntimeEvent, RuntimeEventStatus } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';

// ============================================================================
// InvocationSource
// ============================================================================

/**
 * Where the invocation entered the runtime. Desktop, bot, and gateway should
 * eventually share the same runner; `test` covers in-process fake-service
 * invocations like the ones in this node's test suite.
 */
export const INVOCATION_SOURCES = ['desktop', 'bot', 'gateway', 'test'] as const;
export type InvocationSource = typeof INVOCATION_SOURCES[number];

export function isInvocationSource(value: unknown): value is InvocationSource {
  return typeof value === 'string' && (INVOCATION_SOURCES as readonly string[]).includes(value);
}

// ============================================================================
// InvocationLineage — retry / regenerate / branch pointers
// ============================================================================

/**
 * Optional lineage carried from the entrypoint. Mirrors the relevant
 * UserMessageInput fields so a future StoredMessage turn_state projection
 * can map 1:1 without re-deriving shape.
 */
export interface InvocationLineage {
  parentRunId?: string;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
}

// ============================================================================
// InvocationRequest — input to RuntimeRunner.run()
// ============================================================================

/**
 * Request to run one agent invocation. The runner owns preflight, context
 * creation, the initial user RuntimeEvent, and flow dispatch. Callers may
 * provide existing production spine ids (for example from AgentRun); when
 * omitted, the runner generates them through the injected providers.
 */
export interface InvocationRequest {
  sessionId: string;
  invocationId?: string;
  runId?: string;
  turnId: string;
  text: string;
  /** Optional attachments bound to this user turn. */
  attachments?: AttachmentRef[];
  /**
   * Prior conversation history resolved by the caller/gate. RuntimeRunner
   * passes this to AgentFlow as `context`, defaulting to [] so flows never
   * receive an undefined model-history input.
   */
  context?: StoredMessage[];
  /**
   * Optional prior RuntimeEvent ledger resolved by the caller. RuntimeRunner
   * passes this through without adding the current turn's RuntimeEvents.
   */
  runtimeContext?: RuntimeEvent[];
  /** Optional initial user RuntimeEvent already minted by an outer run owner. */
  initialRuntimeEvent?: RuntimeEvent;
  source: InvocationSource;
  /** Optional branch/agent lane; forwarded onto every emitted event. */
  branch?: string;
  /** Lineage for retry/regenerate/branch projections. */
  lineage?: InvocationLineage;
  /** Caller-owned abort signal; flows and tools SHOULD observe it. */
  abortSignal?: AbortSignal;
}

// ============================================================================
// InvocationContext — created by RuntimeRunner through injected providers
// ============================================================================

/**
 * The invocation/run spine handed to AgentFlow.run(ctx, request). Carries
 * the durable identity hierarchy plus the injectable id/time providers a
 * flow uses to mint canonical RuntimeEvents that line up with the spine.
 */
export interface InvocationContext {
  sessionId: string;
  /** Durable invocation spine id; groups every run/turn of one request. */
  invocationId: string;
  /** Specific run/attempt within the invocation. */
  runId: string;
  turnId: string;
  /** Optional branch/agent lane (forwarded from the request). */
  branch?: string;
  source: InvocationSource;
  /** Unix ms timestamp captured when the runner created the context. */
  startedAt: number;
  /** Caller-owned abort signal; flows and tools SHOULD observe it. */
  abortSignal?: AbortSignal;
  /** The original request, for flows that need source/lineage/text. */
  request: InvocationRequest;
  /** Injectable id provider (same instance the runner uses). */
  newId: () => string;
  /** Injectable clock (same instance the runner uses). */
  now: () => number;
}

// ============================================================================
// InvocationProviders — injectable id/time so tests can be deterministic
// ============================================================================

export interface InvocationProviders {
  newId: () => string;
  now: () => number;
}

/**
 * Best-effort default providers. Real entrypoints already inject stronger
 * id/time sources (see SessionManagerDeps.newId / now); tests SHOULD inject
 * their own deterministic providers rather than rely on this default.
 */
export function createDefaultInvocationProviders(): InvocationProviders {
  return {
    newId: () =>
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    now: () => Date.now(),
  };
}

// ============================================================================
// InvocationResult — structured outcome returned by RuntimeRunner.run()
// ============================================================================

/**
 * Result envelope collapses non-completed outcomes to 'failed'. The precise
 * terminal RuntimeEventStatus that produced a failure is retained inside
 * `failure.terminalStatus` so callers do not lose aborted/cancelled detail.
 */
export type InvocationResultStatus = 'completed' | 'failed';

export interface InvocationFailure {
  /**
   * Stable machine-readable class. Today one of: 'preflight', 'aborted',
   * the terminal RuntimeEventStatus ('failed' | 'aborted' | 'cancelled'),
   * or the thrown error's name.
   */
  class: string;
  message?: string;
  /** Precise terminal RuntimeEventStatus when the failure came from a terminal event. */
  terminalStatus?: RuntimeEventStatus;
}

export interface InvocationResult {
  invocationId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  status: InvocationResultStatus;
  /** Last non-partial model text from a successfully completed invocation. */
  finalOutput?: string;
  /** Every RuntimeEvent collected, in emission order (user event first). */
  events: RuntimeEvent[];
  /** Present when status === 'failed'. */
  failure?: InvocationFailure;
  startedAt: number;
  finishedAt: number;
}
