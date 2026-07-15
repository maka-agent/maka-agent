import {
  failureClassFromCompleteStopReason,
  type SessionEvent,
} from '@maka/core';

export type GoalTurnOutcome =
  | { kind: 'completed'; turnId: string }
  | { kind: 'suspended'; turnId?: string; reason: string }
  | { kind: 'aborted'; turnId?: string }
  | { kind: 'errored'; turnId?: string; reason: string };

export interface SessionActivityLease {
  release: () => void;
}

interface SessionActivityState {
  count: number;
  whenIdle: Promise<void>;
  resolveIdle: () => void;
}

/** Tracks host work without imposing serialization on callers that use reserve(). */
export class SessionActivityRegistry {
  private readonly states = new Map<string, SessionActivityState>();

  /** Returns the current shared idle signal, or undefined when already idle. */
  whenIdle(sessionId: string): Promise<void> | undefined {
    return this.states.get(sessionId)?.whenIdle;
  }

  reserve(sessionId: string): SessionActivityLease {
    let state = this.states.get(sessionId);
    if (!state) {
      let resolveIdle!: () => void;
      const whenIdle = new Promise<void>((resolve) => { resolveIdle = resolve; });
      state = { count: 0, whenIdle, resolveIdle };
      this.states.set(sessionId, state);
    }
    state.count++;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const current = this.states.get(sessionId);
        if (current !== state) return;
        current.count--;
        if (current.count > 0) return;
        this.states.delete(sessionId);
        current.resolveIdle();
      },
    };
  }

  /** Atomically reserves an idle session; Goal admission uses this synchronous seam. */
  reserveIfIdle(sessionId: string): SessionActivityLease | undefined {
    if (this.states.has(sessionId)) return undefined;
    return this.reserve(sessionId);
  }

  /** Waits until the session is idle, then atomically owns the next activity slot. */
  async acquire(sessionId: string): Promise<SessionActivityLease> {
    for (;;) {
      const lease = this.reserveIfIdle(sessionId);
      if (lease) return lease;
      const whenIdle = this.whenIdle(sessionId);
      if (whenIdle) await whenIdle;
    }
  }
}

/** Reduces a fully drained SessionEvent stream to the host-facing Goal outcome. */
export class GoalTurnOutcomeTracker {
  private currentOutcome: GoalTurnOutcome | undefined;

  get outcome(): GoalTurnOutcome | undefined {
    return this.currentOutcome;
  }

  observe(event: SessionEvent): void {
    const failureClass = event.type === 'complete'
      ? failureClassFromCompleteStopReason(event.stopReason)
      : undefined;
    if (event.type === 'error' || failureClass !== undefined) {
      this.currentOutcome = {
        kind: 'errored',
        turnId: event.turnId,
        reason: event.type === 'error'
          ? event.message
          : `Turn ended with ${failureClass}`,
      };
      return;
    }
    if (this.currentOutcome?.kind === 'errored') return;
    if (event.type === 'abort' || (event.type === 'complete' && event.stopReason === 'user_stop')) {
      this.currentOutcome = { kind: 'aborted', turnId: event.turnId };
      return;
    }
    if (this.currentOutcome?.kind === 'aborted' || event.type !== 'complete') return;
    if (event.stopReason === 'permission_handoff') {
      this.currentOutcome = {
        kind: 'suspended',
        turnId: event.turnId,
        reason: 'Turn is waiting for user permission.',
      };
      return;
    }
    // A resumed stream may emit permission_handoff and later end normally.
    this.currentOutcome = { kind: 'completed', turnId: event.turnId };
  }

  fail(error: unknown, turnId?: string): GoalTurnOutcome {
    const reason = errorMessage(error);
    const observedTurnId = turnId ?? this.currentOutcome?.turnId;
    this.currentOutcome = {
      kind: 'errored',
      ...(observedTurnId ? { turnId: observedTurnId } : {}),
      reason,
    };
    return this.currentOutcome;
  }

  finish(fallbackTurnId?: string): GoalTurnOutcome {
    return this.currentOutcome ?? this.fail(
      new Error('Session turn ended without a completion event'),
      fallbackTurnId,
    );
  }
}

export interface DrainGoalTurnInput {
  events: AsyncIterable<SessionEvent>;
  /** Every event in this single-turn stream must carry this identity. */
  expectedTurnId: string;
  activity?: SessionActivityLease;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  onStreamError?: (error: unknown) => void | Promise<void>;
  /** Runs after complete drain/error projection, while the activity lease is held. */
  onDrained?: (outcome: GoalTurnOutcome) => void | Promise<void>;
  /** Runs after the activity lease is released. */
  onSettled?: (outcome: GoalTurnOutcome) => void;
}

export interface DrainGoalTurnResult {
  outcome: GoalTurnOutcome;
  streamError?: unknown;
}

export async function drainGoalTurn(input: DrainGoalTurnInput): Promise<DrainGoalTurnResult> {
  const tracker = new GoalTurnOutcomeTracker();
  let streamError: unknown;
  let streamFailed = false;
  const captureStreamError = (error: unknown): void => {
    if (streamFailed) return;
    streamFailed = true;
    streamError = error;
  };
  try {
    for await (const event of input.events) {
      if (event.turnId !== input.expectedTurnId) {
        captureStreamError(new Error(
          `Session turn identity mismatch: expected ${input.expectedTurnId}, received ${event.turnId}.`,
        ));
        continue;
      }
      tracker.observe(event);
      try {
        await input.onEvent?.(event);
      } catch (observerError) {
        // Projection is not the stream owner. Preserve the failure, but keep
        // consuming so activity is released only after the runtime turn drains.
        captureStreamError(observerError);
      }
    }
  } catch (error) {
    captureStreamError(error);
  }

  if (streamFailed) {
    tracker.fail(streamError, input.expectedTurnId);
    try {
      await input.onStreamError?.(streamError);
    } catch (observerError) {
      streamError = observerError;
      tracker.fail(observerError, input.expectedTurnId);
    }
  }

  let outcome = tracker.finish(input.expectedTurnId);
  try {
    await input.onDrained?.(outcome);
  } catch (observerError) {
    streamError = observerError;
    outcome = tracker.fail(observerError, input.expectedTurnId);
  } finally {
    input.activity?.release();
  }
  input.onSettled?.(outcome);
  return {
    outcome,
    ...(streamError !== undefined ? { streamError } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
