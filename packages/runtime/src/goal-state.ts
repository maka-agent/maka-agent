/**
 * Goal execution state — session-scoped, in-memory.
 *
 * A goal is a durable objective the agent works toward autonomously across
 * turns. After each turn, an external evaluator (CC-style) judges whether the
 * condition is met; if not, the system auto-continues.
 *
 * PERSISTENCE: goals live only in memory and are intentionally NOT persisted —
 * a restart clears every goal (the autonomous loop stops rather than silently
 * resuming an objective the user may no longer want). This is a deliberate v1
 * default: a goal is bounded to the running session's lifetime. Durable,
 * cross-restart objectives are the Automation primitive's job, not this one.
 *
 * Lifecycle (Codex-inspired):
 *   active → achieved / impossible / cleared / paused
 *          → stalled (block cap: N consecutive no-progress turns)
 *          → budget_limited (token budget exhausted)
 *          → max_iterations (total turn ceiling)
 */

export type GoalStatus =
  | 'active'
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
  id: string;
  sessionId: string;
  condition: string;
  status: GoalStatus;
  setAt: number;
  iterations: number;
  maxIterations: number;
  /** Consecutive turns with no progress (drives the block cap → stalled). */
  consecutiveNoProgress: number;
  /** Force-stop after this many consecutive no-progress turns (CC's 8). */
  blockCap: number;
  /** Optional token budget; goal → budget_limited when exceeded. */
  tokenBudget?: number;
  /** Token count observed when the goal was set (baseline for spend). */
  tokensAtStart: number;
  /** Latest observed token count (used to compute spend). */
  tokensNow: number;
  /**
   * True until the first real token observation. The baseline captured at set
   * time can be stale/0 (the model calls GoalSet before any continuation has
   * observed the session's token count), so the first recordTokens re-baselines
   * to measure only tokens the goal itself spends.
   */
  tokensBaselinePending: boolean;
  lastReason?: string;
  achievedAt?: number;
  pausedAt?: number;
}

export interface GoalManagerDeps {
  generateId: () => string;
  now: () => number;
  /**
   * Fired after every goal state transition (set / continue / pause / resume /
   * terminal / clear / remove). Lets a host surface an autonomous loop to the
   * UI — a token-burning goal must never run without a visible indicator and a
   * clear affordance. `previous` is the status before the change (undefined on
   * first set) so a host can detect entering/leaving the active state.
   */
  onChange?: (goal: GoalState, previous?: GoalStatus) => void;
}

export const DEFAULT_MAX_ITERATIONS = 50;
export const DEFAULT_BLOCK_CAP = 8;

export class GoalManager {
  private goals = new Map<string, GoalState>();

  constructor(private readonly deps: GoalManagerDeps) {}

  private emit(goal: GoalState, previous?: GoalStatus): void {
    this.deps.onChange?.(goal, previous);
  }

  set(sessionId: string, condition: string, opts?: {
    maxIterations?: number;
    blockCap?: number;
    tokenBudget?: number;
    tokensAtStart?: number;
  }): GoalState {
    // Replacing an existing goal: settle the old one before overwriting.
    const existing = this.goals.get(sessionId);
    if (existing && !TERMINAL_GOAL_STATUSES.has(existing.status)) {
      existing.status = 'cleared';
    }
    const start = opts?.tokensAtStart ?? 0;
    const goal: GoalState = {
      id: this.deps.generateId(),
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
    };
    this.goals.set(sessionId, goal);
    this.emit(goal);
    return goal;
  }

  get(sessionId: string): GoalState | undefined {
    return this.goals.get(sessionId);
  }

  getActive(sessionId: string): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    return goal?.status === 'active' ? goal : undefined;
  }

  tokensSpent(sessionId: string): number {
    const goal = this.goals.get(sessionId);
    if (!goal) return 0;
    return Math.max(0, goal.tokensNow - goal.tokensAtStart);
  }

  incrementIteration(sessionId: string): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal || goal.status !== 'active') return undefined;
    const previous = goal.status;
    goal.iterations++;
    if (goal.iterations >= goal.maxIterations) {
      goal.status = 'max_iterations';
      goal.lastReason = `Reached maximum iterations (${goal.maxIterations})`;
    }
    this.emit(goal, previous);
    return goal;
  }

  recordProgress(sessionId: string, madeProgress: boolean): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal || goal.status !== 'active') return undefined;
    const previous = goal.status;
    if (madeProgress) {
      goal.consecutiveNoProgress = 0;
    } else {
      goal.consecutiveNoProgress++;
      if (goal.consecutiveNoProgress >= goal.blockCap) {
        goal.status = 'stalled';
        goal.lastReason = `No progress for ${goal.blockCap} consecutive turns`;
      }
    }
    this.emit(goal, previous);
    return goal;
  }

  recordTokens(sessionId: string, tokensNow: number): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal) return undefined;
    const previous = goal.status;
    // The first real observation establishes the baseline (see field doc).
    if (goal.tokensBaselinePending) {
      goal.tokensAtStart = tokensNow;
      goal.tokensNow = tokensNow;
      goal.tokensBaselinePending = false;
      this.emit(goal, previous);
      return goal;
    }
    // Token counts are monotonic; never let a stale/smaller read regress spend.
    goal.tokensNow = Math.max(goal.tokensNow, tokensNow);
    if (
      goal.status === 'active' &&
      goal.tokenBudget !== undefined &&
      goal.tokensNow - goal.tokensAtStart >= goal.tokenBudget
    ) {
      goal.status = 'budget_limited';
      goal.lastReason = `Token budget exhausted (${goal.tokenBudget} tokens)`;
    }
    this.emit(goal, previous);
    return goal;
  }

  markAchieved(sessionId: string, reason: string): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal || goal.status !== 'active') return undefined;
    const previous = goal.status;
    goal.status = 'achieved';
    goal.lastReason = reason;
    goal.achievedAt = this.deps.now();
    this.emit(goal, previous);
    return goal;
  }

  markImpossible(sessionId: string, reason: string): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal || goal.status !== 'active') return undefined;
    const previous = goal.status;
    goal.status = 'impossible';
    goal.lastReason = reason;
    this.emit(goal, previous);
    return goal;
  }

  pause(sessionId: string): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal || goal.status !== 'active') return undefined;
    const previous = goal.status;
    goal.status = 'paused';
    goal.pausedAt = this.deps.now();
    this.emit(goal, previous);
    return goal;
  }

  resume(sessionId: string): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal || goal.status !== 'paused') return undefined;
    const previous = goal.status;
    goal.status = 'active';
    goal.pausedAt = undefined;
    this.emit(goal, previous);
    return goal;
  }

  clear(sessionId: string): GoalState | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal) return undefined;
    const previous = goal.status;
    if (!TERMINAL_GOAL_STATUSES.has(goal.status)) {
      goal.status = 'cleared';
    }
    this.emit(goal, previous);
    return goal;
  }

  remove(sessionId: string): boolean {
    const goal = this.goals.get(sessionId);
    const deleted = this.goals.delete(sessionId);
    if (goal && deleted) this.emit(goal, goal.status);
    return deleted;
  }

  dispose(): void {
    this.goals.clear();
  }
}
