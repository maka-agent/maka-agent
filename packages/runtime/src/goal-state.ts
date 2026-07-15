/**
 * Goal execution state — session-scoped, in-memory.
 *
 * A goal is a long-running objective the agent works toward autonomously across
 * turns. After each turn, an external evaluator (CC-style) judges whether the
 * condition is met; if not, the system auto-continues.
 *
 * PERSISTENCE: this phase owns only in-process state. A restart clears every
 * Goal; persisted snapshots and restart recovery require a separate lifecycle
 * boundary and are deliberately deferred.
 *
 * Lifecycle (Codex-inspired):
 *   active → waiting → active
 *          → achieved / impossible / cleared / paused
 *          → stalled (block cap: N consecutive no-progress turns)
 *          → budget_limited (token budget exhausted)
 *          → max_iterations (total turn ceiling)
 */

export type GoalStatus =
  | 'active'
  | 'waiting'
  | 'achieved'
  | 'impossible'
  | 'cleared'
  | 'paused'
  | 'stalled'
  | 'budget_limited'
  | 'max_iterations';

/** Terminal statuses — a goal in one of these states will not continue. */
export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>([
  'achieved',
  'impossible',
  'cleared',
  'stalled',
  'budget_limited',
  'max_iterations',
]);

export interface GoalState {
  readonly id: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly condition: string;
  readonly status: GoalStatus;
  readonly setAt: number;
  readonly iterations: number;
  readonly maxIterations: number;
  /** Consecutive turns with no progress (drives the block cap → stalled). */
  readonly consecutiveNoProgress: number;
  /** Force-stop after this many consecutive no-progress turns (CC's 8). */
  readonly blockCap: number;
  /** Optional token budget; goal → budget_limited when exceeded. */
  readonly tokenBudget?: number;
  /** Token count observed when the goal was set (baseline for spend). */
  readonly tokensAtStart: number;
  /** Latest observed token count (used to compute spend). */
  readonly tokensNow: number;
  /**
   * True until the first real token observation. The baseline captured at set
   * time can be stale/0 (the model calls GoalSet before any continuation has
   * observed the session's token count), so the first settlement re-baselines
   * to measure only tokens the goal itself spends.
   */
  readonly tokensBaselinePending: boolean;
  readonly lastReason?: string;
  readonly achievedAt?: number;
  readonly pausedAt?: number;
}

/** Immutable identity of the Goal snapshot an asynchronous operation observed. */
export interface GoalCheckpoint {
  readonly goalId: string;
  readonly revision: number;
}

/**
 * Opaque in-process ownership token for externally queued Goal evidence.
 * Ordinary turn settlements retain the lease; explicit lifecycle control
 * replaces it so queued work cannot cross a pause/resume ABA boundary.
 */
export interface GoalControlLease {
  readonly goalId: string;
}

export function goalCheckpoint(goal: Pick<GoalState, 'id' | 'revision'>): GoalCheckpoint {
  return Object.freeze({ goalId: goal.id, revision: goal.revision });
}

export type GoalCreateResult =
  | { kind: 'created'; goal: GoalState }
  | { kind: 'unfinished'; goal: GoalState };

interface GoalTurnSettlementBase {
  readonly checkpoint: GoalCheckpoint;
  readonly turnId: string;
  readonly reason: string;
}

export type GoalTurnSettlementInput =
  | (GoalTurnSettlementBase & {
      readonly verdict: 'achieved';
    })
  | (GoalTurnSettlementBase & {
      readonly verdict: 'impossible';
    })
  | (GoalTurnSettlementBase & {
      readonly verdict: 'pause';
    })
  | (GoalTurnSettlementBase & (
      | {
          readonly verdict: 'continue';
          readonly waiting: true;
          readonly madeProgress?: never;
          readonly tokensNow?: number;
        }
      | {
          readonly verdict: 'continue';
          readonly waiting?: false;
          /** Undefined is neutral: neither advances nor resets the no-progress streak. */
          readonly madeProgress?: boolean;
          readonly tokensNow?: number;
        }
    ));

export type GoalTurnSettlementResult =
  | { kind: 'applied'; goal: GoalState }
  | { kind: 'duplicate'; goal: GoalState }
  | { kind: 'stale'; goal: GoalState }
  | { kind: 'inactive'; goal: GoalState }
  | { kind: 'not_found' };

export interface GoalManagerDeps {
  generateId: () => string;
  now: () => number;
  /**
   * Fired after every accepted goal state transition. Lets a host surface an
   * autonomous loop to the UI — a token-burning goal must never run without a
   * visible indicator and a clear affordance. This is a best-effort observer:
   * failures cannot roll back an already committed state transition.
   */
  onChange?: (goal: GoalState, previous?: GoalStatus) => void | Promise<void>;
}

export const DEFAULT_MAX_ITERATIONS = 50;
export const DEFAULT_BLOCK_CAP = 8;

interface GoalRecord {
  state: GoalState;
  controlLease: GoalControlLease;
}

interface GoalSessionRecord {
  goal?: GoalRecord;
  /** Turn identity belongs to the session lifetime, not an individual Goal. */
  readonly settledTurnIds: Set<string>;
}

export interface GoalPauseOptions {
  readonly checkpoint?: GoalCheckpoint;
  readonly reason?: string;
}

type GoalStatePatch = Partial<Omit<
  GoalState,
  'id' | 'revision' | 'sessionId' | 'condition' | 'setAt'
>>;

export class GoalManager {
  private sessions = new Map<string, GoalSessionRecord>();

  constructor(private readonly deps: GoalManagerDeps) {}

  private sessionFor(sessionId: string): GoalSessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: GoalSessionRecord = { settledTurnIds: new Set() };
    this.sessions.set(sessionId, created);
    return created;
  }

  private emit(goal: GoalState, previous?: GoalStatus): void {
    try {
      const notification = this.deps.onChange?.(goal, previous);
      void Promise.resolve(notification).catch(() => {});
    } catch {
      // State and control leases are already committed. A host notification
      // must not make the caller observe failure after that point.
    }
  }

  private commit(
    record: GoalRecord,
    patch: GoalStatePatch,
    options?: { renewControlLease?: boolean },
  ): GoalState {
    const previous = record.state.status;
    const committed = Object.freeze({
      ...record.state,
      ...patch,
      revision: record.state.revision + 1,
    });
    record.state = committed;
    if (options?.renewControlLease) {
      record.controlLease = createControlLease(committed.id);
    }
    this.emit(committed, previous);
    return committed;
  }

  create(sessionId: string, condition: string, opts?: {
    maxIterations?: number;
    blockCap?: number;
    tokenBudget?: number;
    tokensAtStart?: number;
  }): GoalCreateResult {
    const session = this.sessionFor(sessionId);
    const existing = session.goal?.state;
    if (existing && !TERMINAL_GOAL_STATUSES.has(existing.status)) {
      return { kind: 'unfinished', goal: existing };
    }

    const start = opts?.tokensAtStart ?? 0;
    const goal: GoalState = Object.freeze({
      id: this.deps.generateId(),
      revision: 0,
      sessionId,
      condition,
      status: 'active',
      setAt: this.deps.now(),
      iterations: 0,
      maxIterations: opts?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      consecutiveNoProgress: 0,
      blockCap: opts?.blockCap ?? DEFAULT_BLOCK_CAP,
      tokenBudget: opts?.tokenBudget,
      tokensAtStart: start,
      tokensNow: start,
      tokensBaselinePending: true,
    });
    const goalRecord: GoalRecord = {
      state: goal,
      controlLease: createControlLease(goal.id),
    };
    session.goal = goalRecord;
    this.emit(goal);
    return { kind: 'created', goal };
  }

  get(sessionId: string): GoalState | undefined {
    return this.sessions.get(sessionId)?.goal?.state;
  }

  getActive(sessionId: string): GoalState | undefined {
    const goal = this.sessions.get(sessionId)?.goal?.state;
    return goal?.status === 'active' ? goal : undefined;
  }

  getControlLease(sessionId: string): GoalControlLease | undefined {
    return this.sessions.get(sessionId)?.goal?.controlLease;
  }

  matchesControlLease(sessionId: string, lease: GoalControlLease): boolean {
    return this.sessions.get(sessionId)?.goal?.controlLease === lease;
  }

  matchesActive(sessionId: string, checkpoint: GoalCheckpoint): boolean {
    const goal = this.sessions.get(sessionId)?.goal?.state;
    return goal?.status === 'active'
      && goal.id === checkpoint.goalId
      && goal.revision === checkpoint.revision;
  }

  matches(sessionId: string, checkpoint: GoalCheckpoint): boolean {
    const goal = this.sessions.get(sessionId)?.goal?.state;
    return goal?.id === checkpoint.goalId && goal.revision === checkpoint.revision;
  }

  hasSettledTurn(sessionId: string, turnId: string): boolean {
    return this.sessions.get(sessionId)?.settledTurnIds.has(turnId) ?? false;
  }

  /** Consume invalidated queued evidence without changing the current Goal state. */
  markTurnSettled(sessionId: string, turnId: string): boolean {
    const session = this.sessionFor(sessionId);
    if (session.settledTurnIds.has(turnId)) return false;
    session.settledTurnIds.add(turnId);
    return true;
  }

  tokensSpent(sessionId: string): number {
    const goal = this.sessions.get(sessionId)?.goal?.state;
    if (!goal) return 0;
    return Math.max(0, goal.tokensNow - goal.tokensAtStart);
  }

  settleTurn(sessionId: string, input: GoalTurnSettlementInput): GoalTurnSettlementResult {
    const session = this.sessions.get(sessionId);
    const record = session?.goal;
    if (!session || !record) return { kind: 'not_found' };
    const current = record.state;
    if (session.settledTurnIds.has(input.turnId)) return { kind: 'duplicate', goal: current };
    if (current.id !== input.checkpoint.goalId) return { kind: 'stale', goal: current };
    if (current.revision !== input.checkpoint.revision) return { kind: 'stale', goal: current };
    if (
      current.status !== 'active'
      && !(input.verdict === 'pause' && current.status === 'waiting')
    ) {
      return { kind: 'inactive', goal: current };
    }

    let patch: GoalStatePatch;
    if (input.verdict === 'pause') {
      patch = {
        status: 'paused',
        pausedAt: this.deps.now(),
        lastReason: input.reason,
      };
    } else if (input.verdict === 'achieved') {
      patch = {
        status: 'achieved',
        lastReason: input.reason,
        achievedAt: this.deps.now(),
      };
    } else if (input.verdict === 'impossible') {
      patch = { status: 'impossible', lastReason: input.reason };
    } else {
      let tokensAtStart = current.tokensAtStart;
      let tokensNow = current.tokensNow;
      let tokensBaselinePending = current.tokensBaselinePending;
      let iterations = current.iterations;
      let consecutiveNoProgress = current.consecutiveNoProgress;
      let status: GoalStatus = current.status;
      let lastReason = input.reason;

      if (input.tokensNow !== undefined) {
        if (tokensBaselinePending) {
          tokensAtStart = input.tokensNow;
          tokensNow = input.tokensNow;
          tokensBaselinePending = false;
        } else {
          tokensNow = Math.max(tokensNow, input.tokensNow);
          if (
            current.tokenBudget !== undefined
            && tokensNow - tokensAtStart >= current.tokenBudget
          ) {
            status = 'budget_limited';
            lastReason = `Token budget exhausted (${current.tokenBudget} tokens)`;
          }
        }
      }

      if (status === 'active') {
        iterations++;
        if (iterations >= current.maxIterations) {
          status = 'max_iterations';
          lastReason = `Reached maximum iterations (${current.maxIterations})`;
        }
      }

      if (status === 'active' && input.madeProgress !== undefined) {
        if (input.madeProgress) {
          consecutiveNoProgress = 0;
        } else {
          consecutiveNoProgress++;
          if (consecutiveNoProgress >= current.blockCap) {
            status = 'stalled';
            lastReason = `No progress for ${current.blockCap} consecutive turns`;
          }
        }
      }

      if (status === 'active' && input.waiting === true) {
        status = 'waiting';
      }

      patch = {
        status,
        iterations,
        consecutiveNoProgress,
        tokensAtStart,
        tokensNow,
        tokensBaselinePending,
        lastReason,
      };
    }

    session.settledTurnIds.add(input.turnId);
    return {
      kind: 'applied',
      goal: this.commit(record, patch, {
        renewControlLease: input.verdict === 'pause',
      }),
    };
  }

  pause(sessionId: string, options?: GoalPauseOptions): GoalState | undefined {
    const record = this.sessions.get(sessionId)?.goal;
    if (!record || (record.state.status !== 'active' && record.state.status !== 'waiting')) {
      return undefined;
    }
    if (options?.checkpoint && !this.matches(sessionId, options.checkpoint)) return undefined;
    return this.commit(
      record,
      {
        status: 'paused',
        pausedAt: this.deps.now(),
        ...(options?.reason !== undefined ? { lastReason: options.reason } : {}),
      },
      { renewControlLease: true },
    );
  }

  resume(sessionId: string): GoalState | undefined {
    const record = this.sessions.get(sessionId)?.goal;
    if (!record || record.state.status !== 'paused') return undefined;
    return this.commit(
      record,
      { status: 'active', pausedAt: undefined },
      { renewControlLease: true },
    );
  }

  wakeWaiting(sessionId: string, checkpoint: GoalCheckpoint): GoalState | undefined {
    const record = this.sessions.get(sessionId)?.goal;
    if (
      !record
      || record.state.status !== 'waiting'
      || !this.matches(sessionId, checkpoint)
    ) {
      return undefined;
    }
    return this.commit(record, { status: 'active' });
  }

  clear(sessionId: string): GoalState | undefined {
    const record = this.sessions.get(sessionId)?.goal;
    if (!record || TERMINAL_GOAL_STATUSES.has(record.state.status)) return undefined;
    return this.commit(record, { status: 'cleared' }, { renewControlLease: true });
  }

  /** Drop Goal state while retaining the session's turn-id ledger (archive). */
  removeGoal(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    const record = session?.goal;
    if (!session || !record) return false;
    delete session.goal;
    this.emit(record.state, record.state.status);
    return true;
  }

  /** Release all in-memory ownership for a permanently deleted session. */
  removeSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)?.goal;
    const deleted = this.sessions.delete(sessionId);
    if (record && deleted) this.emit(record.state, record.state.status);
    return deleted;
  }

  dispose(): void {
    this.sessions.clear();
  }
}

function createControlLease(goalId: string): GoalControlLease {
  return Object.freeze({ goalId });
}
