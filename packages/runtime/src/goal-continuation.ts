/**
 * Session-scoped Goal continuation coordinator.
 *
 * Agent turn outcomes are settled in FIFO order per session. A continuation is
 * retained as an intent until the host atomically admits it; waiting verdicts use
 * an in-memory backoff instead of immediately spending another turn.
 */

import { evaluateGoal, type GoalEvaluation, type GoalEvaluatorDeps } from './goal-evaluator.js';
import {
  goalCheckpoint,
  type GoalControlLease,
  type GoalCheckpoint,
  type GoalManager,
  type GoalState,
  type GoalStatus,
  type GoalTurnSettlementResult,
} from './goal-state.js';
import {
  GoalSessionCloseFence,
  type GoalSessionCloseKind,
  type GoalSessionCloseOperation,
} from './goal-session-close-fence.js';
import {
  GoalTaskGatePolicy,
  type GoalTaskGateDeps,
} from './goal-task-gate-policy.js';
import type { GoalTurnOutcome } from './goal-turn-lifecycle.js';

export type { GoalTurnOutcome } from './goal-turn-lifecycle.js';
export type { GoalSessionCloseOperation } from './goal-session-close-fence.js';
export type {
  GoalTaskGateDecision,
  GoalTaskGateDeps,
  GoalTaskGateTrace,
} from './goal-task-gate-policy.js';

export type GoalTurnAdmission =
  | { kind: 'started'; completion: Promise<GoalTurnOutcome> }
  | { kind: 'busy'; whenIdle: Promise<void> }
  | { kind: 'unavailable'; reason: string };

export type GoalTurnBinding =
  | { kind: 'bound' }
  | { kind: 'duplicate' }
  | { kind: 'unavailable'; reason: string };

/** Bind a host-reserved continuation turn before its event iterator starts. */
export type GoalTurnBinder = (turnId: string) => GoalTurnBinding;

export type GoalContinuationOutcome =
  | { kind: 'no_goal' }
  | { kind: 'duplicate' }
  | { kind: 'stale' }
  | { kind: 'achieved'; evaluation: GoalEvaluation }
  | { kind: 'impossible'; evaluation: GoalEvaluation }
  | { kind: 'stopped'; reason: string; status: GoalStatus }
  | { kind: 'waiting'; evaluation: GoalEvaluation }
  | { kind: 'continued'; evaluation: GoalEvaluation };

/** Exactly-once settlement capability captured when an external Agent turn starts. */
export type GoalExternalTurnSettler = (
  outcome: GoalTurnOutcome,
) => Promise<GoalContinuationOutcome>;

export interface GoalContinuationScheduler {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface GoalContinuationDeps {
  goalManager: GoalManager;
  evaluator: GoalEvaluatorDeps;
  /** Summarized recent conversation (last ~5 messages) for the evaluator. */
  getRecentContext: (sessionId: string) => Promise<string>;
  /** Current cumulative token count for the session (for budget tracking). */
  getTokenCount?: (sessionId: string) => number;
  /** Synchronously reserve and start, defer, or reject a Goal-owned turn. */
  admitTurn: (sessionId: string, text: string, bindTurn: GoalTurnBinder) => GoalTurnAdmission;
  taskGate?: GoalTaskGateDeps;
  scheduler?: GoalContinuationScheduler;
}

export const GOAL_WAIT_BACKOFF_BASE_MS = 5_000;
export const GOAL_WAIT_BACKOFF_MAX_MS = 5 * 60_000;

const CONTINUATION_PREAMBLE =
  '[Goal continuation] The goal is not yet met. Keep working toward it. '
  + 'Do not redefine success around a smaller task; match your verification to the full requirement.';

interface QueuedTurn {
  outcome: GoalTurnOutcome;
  controlLease: GoalControlLease;
  checkpoint?: GoalCheckpoint;
  registration: TurnRegistration;
  resolve: (outcome: GoalContinuationOutcome) => void;
}

interface ContinuationIntent {
  checkpoint: GoalCheckpoint;
  controlLease: GoalControlLease;
  triggeringTurnId: string;
  evaluation: GoalEvaluation;
}

interface WaitingTimer {
  handle: unknown;
  checkpoint: GoalCheckpoint;
}

interface TurnRegistration {
  readonly sessionId: string;
  turnId?: string;
  readonly lane: SessionLane;
  readonly observedControlLease?: GoalControlLease;
  readonly checkpoint?: GoalCheckpoint;
  state: 'preparing' | 'open' | 'activating' | 'mutating' | 'queued' | 'consumed';
  controlLease?: GoalControlLease;
}

interface SessionLane {
  sessionId: string;
  queue: QueuedTurn[];
  turns: Map<string, TurnRegistration>;
  processing?: QueuedTurn;
  draining: boolean;
  intent?: ContinuationIntent;
  busyWake?: Promise<void>;
  waitingTimer?: WaitingTimer;
  waitingGoalId?: string;
  consecutiveWaits: number;
}

export type GoalExternalTurnStart =
  | { kind: 'registered'; settle: GoalExternalTurnSettler }
  | { kind: 'duplicate' }
  | { kind: 'unavailable'; reason: string };

export interface GoalActivation<T> {
  readonly goal: GoalState;
  readonly result: T;
}

export type GoalActivationResult<T> =
  | { kind: 'activated'; result: T }
  | { kind: 'stale' };

export type GoalMutationResult<T> =
  | { kind: 'mutated'; result: T }
  | { kind: 'stale' };

export class GoalContinuationCoordinator {
  private readonly lanes = new Map<string, SessionLane>();
  private readonly sessionCloseFence: GoalSessionCloseFence;
  private readonly taskGatePolicy: GoalTaskGatePolicy;
  private readonly scheduler: GoalContinuationScheduler;
  private disposed = false;

  constructor(private readonly deps: GoalContinuationDeps) {
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.taskGatePolicy = new GoalTaskGatePolicy(deps.taskGate);
    this.sessionCloseFence = new GoalSessionCloseFence({
      onReopenedAfterRollback: (sessionId, kind) => {
        const goal = this.deps.goalManager.get(sessionId);
        if (!goal || (goal.status !== 'active' && goal.status !== 'waiting')) return;
        const operation = kind === 'archive' ? 'archive' : 'removal';
        this.deps.goalManager.pause(sessionId, {
          checkpoint: goalCheckpoint(goal),
          reason: `Goal continuation paused because session ${operation} did not complete.`,
        });
      },
    });
  }

  /**
   * Register an external Agent turn before its iterator starts. The returned
   * closure is the only legal settlement path, so terminal handling never has
   * to rediscover Goal ownership from mutable current state.
   */
  beginExternalTurn(
    sessionId: string,
    turnId: string,
  ): GoalExternalTurnStart {
    if (this.disposed) {
      return { kind: 'unavailable', reason: 'Goal continuation is disposed.' };
    }
    if (this.deps.goalManager.hasSettledTurn(sessionId, turnId)) {
      return { kind: 'duplicate' };
    }
    if (this.sessionCloseFence.isClosed(sessionId)) {
      return { kind: 'unavailable', reason: 'Goal continuation session is closed.' };
    }
    const lane = this.laneFor(sessionId);
    if (lane.turns.has(turnId)) return { kind: 'duplicate' };
    const goal = this.deps.goalManager.get(sessionId);
    const observedControlLease = this.deps.goalManager.getControlLease(sessionId);
    const controlLease = goal?.status === 'active' || goal?.status === 'waiting'
      ? observedControlLease
      : undefined;
    const registration: TurnRegistration = {
      sessionId,
      turnId,
      lane,
      state: 'open',
      ...(observedControlLease ? { observedControlLease } : {}),
      ...(controlLease ? { controlLease } : {}),
    };
    lane.turns.set(turnId, registration);

    let settlement: Promise<GoalContinuationOutcome> | undefined;
    return {
      kind: 'registered',
      settle: (outcome) => {
        settlement ??= this.settleRegisteredTurn(registration, outcome);
        return settlement;
      },
    };
  }

  /** Execute and bind one Goal activation only while this exact turn owns the right to do so. */
  activateGoal<T>(
    sessionId: string,
    turnId: string,
    activate: () => GoalActivation<T>,
  ): GoalActivationResult<T> {
    if (this.disposed) return { kind: 'stale' };
    const lane = this.lanes.get(sessionId);
    const registration = lane?.turns.get(turnId);
    if (
      !lane
      || !this.isCurrent(lane)
      || !registration
      || registration.state !== 'open'
      || registration.controlLease !== undefined
      || this.deps.goalManager.getControlLease(sessionId) !== registration.observedControlLease
    ) {
      return { kind: 'stale' };
    }
    registration.state = 'activating';
    try {
      const activation = activate();
      const controlLease = this.deps.goalManager.getControlLease(sessionId);
      if (
        !this.isCurrent(lane)
        || lane.turns.get(turnId) !== registration
        || registration.state !== 'activating'
        || activation.goal.status !== 'active'
        || this.deps.goalManager.get(sessionId) !== activation.goal
        || !controlLease
        || controlLease.goalId !== activation.goal.id
      ) {
        return { kind: 'stale' };
      }
      registration.controlLease = controlLease;
      registration.state = 'open';
      return { kind: 'activated', result: activation.result };
    } finally {
      if (registration.state === 'activating') registration.state = 'open';
    }
  }

  /** Mutate the exact Goal generation observed by this turn. */
  mutateGoal<T>(
    sessionId: string,
    turnId: string,
    mutate: () => GoalActivation<T>,
  ): GoalMutationResult<T> {
    if (this.disposed) return { kind: 'stale' };
    const lane = this.lanes.get(sessionId);
    const registration = lane?.turns.get(turnId);
    const controlLease = registration?.controlLease ?? registration?.observedControlLease;
    if (
      !lane
      || !this.isCurrent(lane)
      || !registration
      || registration.state !== 'open'
      || !controlLease
      || !this.deps.goalManager.matchesControlLease(sessionId, controlLease)
    ) {
      return { kind: 'stale' };
    }

    registration.state = 'mutating';
    try {
      const mutation = mutate();
      const nextControlLease = this.deps.goalManager.getControlLease(sessionId);
      if (
        !this.isCurrent(lane)
        || lane.turns.get(turnId) !== registration
        || registration.state !== 'mutating'
        || mutation.goal.id !== controlLease.goalId
        || this.deps.goalManager.get(sessionId) !== mutation.goal
        || !nextControlLease
        || nextControlLease === controlLease
        || nextControlLease.goalId !== mutation.goal.id
      ) {
        return { kind: 'stale' };
      }
      this.discardIntentOwnedBy(lane, controlLease);
      registration.state = 'open';
      return { kind: 'mutated', result: mutation.result };
    } finally {
      if (registration.state === 'mutating') registration.state = 'open';
    }
  }

  private settleRegisteredTurn(
    registration: TurnRegistration,
    outcome: GoalTurnOutcome,
  ): Promise<GoalContinuationOutcome> {
    const { sessionId, turnId } = registration;
    if (!turnId) return Promise.resolve({ kind: 'stale' });
    if (this.deps.goalManager.hasSettledTurn(sessionId, turnId)) {
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'duplicate' });
    }
    if (registration.state === 'consumed') {
      return Promise.resolve({ kind: 'stale' });
    }
    const lane = registration.lane;
    if (
      this.disposed
      || registration.state !== 'open'
      || !this.isCurrent(lane)
      || lane.turns.get(turnId) !== registration
    ) {
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'stale' });
    }

    registration.state = 'queued';
    const controlLease = registration.controlLease;
    const goal = this.deps.goalManager.get(sessionId);
    if (controlLease && !this.deps.goalManager.matchesControlLease(sessionId, controlLease)) {
      this.discardIntentOwnedBy(lane, controlLease);
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'stale' });
    }
    if (!goal || (goal.status !== 'active' && goal.status !== 'waiting')) {
      this.discardIntentOwnedBy(lane, controlLease);
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'no_goal' });
    }
    if (!controlLease) {
      this.discardIntentOwnedBy(lane, controlLease);
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'stale' });
    }
    const normalized: GoalTurnOutcome = outcome.turnId !== undefined && outcome.turnId !== turnId
      ? {
          kind: 'errored',
          turnId,
          reason: `Goal turn identity mismatch: expected ${turnId}, received ${outcome.turnId}.`,
        }
      : { ...outcome, turnId } as GoalTurnOutcome;
    return this.enqueueTurn(
      sessionId,
      normalized,
      controlLease,
      registration.checkpoint,
      registration,
    );
  }

  /** Revoke the current lane while allowing later turns in the same session. */
  invalidateSession(sessionId: string): void {
    const lane = this.lanes.get(sessionId);
    if (!lane) return;
    this.invalidateLane(lane);
    this.lanes.delete(sessionId);
  }

  /**
   * Fence admission synchronously before an archive/removal crosses an async
   * boundary. Each operation owns an independent holder, so one rollback can
   * never reopen a session still closed by another operation.
   */
  beginSessionClose(
    sessionId: string,
    kind: GoalSessionCloseKind,
  ): GoalSessionCloseOperation {
    const operation = this.sessionCloseFence.begin(sessionId, kind);
    this.invalidateSession(sessionId);
    return operation;
  }

  /** Clear only a committed archive fence; removal and pending holders remain. */
  unarchiveSession(sessionId: string): void {
    this.sessionCloseFence.unarchive(sessionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const lane of this.lanes.values()) this.invalidateLane(lane);
    this.lanes.clear();
    this.sessionCloseFence.dispose();
  }

  private enqueueTurn(
    sessionId: string,
    outcome: GoalTurnOutcome,
    controlLease: GoalControlLease,
    checkpoint: GoalCheckpoint | undefined,
    registration: TurnRegistration,
  ): Promise<GoalContinuationOutcome> {
    const turnId = outcome.turnId;
    if (this.disposed) {
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'stale' });
    }
    if (turnId && this.deps.goalManager.hasSettledTurn(sessionId, turnId)) {
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'duplicate' });
    }
    const current = this.deps.goalManager.get(sessionId);
    if (
      !this.deps.goalManager.matchesControlLease(sessionId, controlLease)
      || !current
      || (checkpoint !== undefined && !this.deps.goalManager.matchesActive(sessionId, checkpoint))
    ) {
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'stale' });
    }
    if (current.status !== 'active' && current.status !== 'waiting') {
      this.consumeTurnRegistration(registration);
      return Promise.resolve({ kind: 'no_goal' });
    }

    const lane = this.laneFor(sessionId);
    // New evidence always outranks an older, not-yet-admitted continuation.
    lane.intent = undefined;
    this.clearWaitingTimer(lane);
    return new Promise<GoalContinuationOutcome>((resolve) => {
      lane.queue.push({
        outcome,
        controlLease,
        ...(checkpoint ? { checkpoint } : {}),
        registration,
        resolve,
      });
      this.scheduleDrain(lane);
    });
  }

  private laneFor(sessionId: string): SessionLane {
    const existing = this.lanes.get(sessionId);
    if (existing) return existing;
    const lane: SessionLane = {
      sessionId,
      queue: [],
      turns: new Map(),
      draining: false,
      consecutiveWaits: 0,
    };
    this.lanes.set(sessionId, lane);
    return lane;
  }

  private isCurrent(lane: SessionLane): boolean {
    return !this.disposed && this.lanes.get(lane.sessionId) === lane;
  }

  private consumeTurnRegistration(registration: TurnRegistration): void {
    if (registration.state === 'consumed') return;
    const lane = registration.lane;
    const turnId = registration.turnId;
    if (turnId && lane.turns.get(turnId) === registration) {
      lane.turns.delete(turnId);
    }
    registration.state = 'consumed';
    if (turnId) this.deps.goalManager.markTurnSettled(registration.sessionId, turnId);
    this.dropIdleLane(lane);
  }

  private dropIdleLane(lane: SessionLane): void {
    if (
      !this.isCurrent(lane)
      || this.deps.goalManager.get(lane.sessionId)
      || lane.turns.size > 0
      || lane.queue.length > 0
      || lane.processing
      || lane.draining
      || lane.intent
      || lane.busyWake
      || lane.waitingTimer
    ) {
      return;
    }
    this.lanes.delete(lane.sessionId);
  }

  private discardIntentOwnedBy(
    lane: SessionLane,
    controlLease: GoalControlLease | undefined,
  ): void {
    if (!controlLease || lane.intent?.controlLease !== controlLease) return;
    lane.intent = undefined;
    lane.busyWake = undefined;
    this.clearWaitingTimer(lane);
    this.resetWaitingBackoff(lane);
  }

  private scheduleDrain(lane: SessionLane): void {
    if (!this.isCurrent(lane) || lane.draining) return;
    void this.drainLane(lane).catch((error) => {
      if (!this.isCurrent(lane)) return;
      this.pauseCurrentGoal(lane, `Goal continuation coordinator failed: ${errorMessage(error)}`);
    });
  }

  private async drainLane(lane: SessionLane): Promise<void> {
    if (!this.isCurrent(lane) || lane.draining) return;
    lane.draining = true;
    try {
      while (this.isCurrent(lane) && lane.queue.length > 0) {
        const item = lane.queue.shift();
        if (!item) break;
        lane.processing = item;
        let outcome: GoalContinuationOutcome;
        try {
          outcome = await this.processQueuedTurn(lane, item);
        } catch (error) {
          outcome = this.pauseCurrentGoal(
            lane,
            `Goal continuation coordinator failed: ${errorMessage(error)}`,
          );
        } finally {
          if (lane.processing === item) lane.processing = undefined;
        }
        item.resolve(outcome);
      }

      if (!this.isCurrent(lane) || lane.queue.length > 0) return;
      const goal = this.deps.goalManager.get(lane.sessionId);
      if (goal?.status === 'waiting' && lane.intent) {
        this.scheduleWaitingRetry(lane, goal);
      } else if (goal?.status === 'active' && lane.intent && !lane.busyWake) {
        await this.tryAdmitIntent(lane, lane.intent);
      }
    } finally {
      lane.draining = false;
      if (!this.isCurrent(lane)) return;
      const goal = this.deps.goalManager.get(lane.sessionId);
      if (
        lane.queue.length > 0
        || (
          lane.intent
          && goal?.status === 'active'
          && !lane.busyWake
          && !lane.waitingTimer
        )
      ) {
        this.scheduleDrain(lane);
      }
    }
  }

  private async processQueuedTurn(
    lane: SessionLane,
    item: QueuedTurn,
  ): Promise<GoalContinuationOutcome> {
    const turnId = item.outcome.turnId;
    try {
      if (turnId && this.deps.goalManager.hasSettledTurn(lane.sessionId, turnId)) {
        return { kind: 'duplicate' };
      }
      const goal = this.deps.goalManager.get(lane.sessionId);
      if (!this.deps.goalManager.matchesControlLease(lane.sessionId, item.controlLease)) {
        return { kind: 'stale' };
      }
      if (!goal || goal.id !== item.controlLease.goalId) return { kind: 'stale' };
      if (item.checkpoint && !this.deps.goalManager.matchesActive(lane.sessionId, item.checkpoint)) {
        return { kind: 'stale' };
      }
      if (item.outcome.kind !== 'completed') {
        if (goal.status !== 'active' && goal.status !== 'waiting') return { kind: 'no_goal' };
        return this.pauseAtCheckpoint(
          lane,
          item.checkpoint ?? goalCheckpoint(goal),
          turnFailureReason(item.outcome),
          turnId,
        );
      }
      return await this.processCompletion(
        lane,
        item.controlLease,
        item.outcome.turnId,
      );
    } finally {
      this.consumeTurnRegistration(item.registration);
    }
  }

  private async processCompletion(
    lane: SessionLane,
    controlLease: GoalControlLease,
    turnId: string,
  ): Promise<GoalContinuationOutcome> {
    let goal = this.deps.goalManager.get(lane.sessionId);
    if (
      !this.deps.goalManager.matchesControlLease(lane.sessionId, controlLease)
      || !goal
      || goal.id !== controlLease.goalId
    ) {
      return { kind: 'stale' };
    }
    if (this.deps.goalManager.hasSettledTurn(lane.sessionId, turnId)) {
      return { kind: 'duplicate' };
    }
    if (goal.status === 'waiting') {
      const woken = this.deps.goalManager.wakeWaiting(lane.sessionId, goalCheckpoint(goal));
      if (!woken) return { kind: 'stale' };
      goal = woken;
    }
    if (goal.status !== 'active') return { kind: 'no_goal' };

    const checkpoint = goalCheckpoint(goal);
    let context: string;
    try {
      context = await this.deps.getRecentContext(lane.sessionId);
    } catch (error) {
      return this.pauseAtCheckpoint(
        lane,
        checkpoint,
        `Unable to read Goal evaluation context: ${errorMessage(error)}`,
        turnId,
      );
    }
    if (!this.isCurrent(lane) || !this.deps.goalManager.matchesActive(lane.sessionId, checkpoint)) {
      return { kind: 'stale' };
    }

    const evaluation = await evaluateGoal(
      this.deps.evaluator,
      goal.condition,
      context,
      lane.sessionId,
    );
    if (!this.isCurrent(lane) || !this.deps.goalManager.matchesActive(lane.sessionId, checkpoint)) {
      return { kind: 'stale' };
    }

    let tokensNow: number | undefined;
    try {
      tokensNow = this.deps.getTokenCount?.(lane.sessionId);
    } catch (error) {
      return this.pauseAtCheckpoint(
        lane,
        checkpoint,
        `Unable to read Goal token usage: ${errorMessage(error)}`,
        turnId,
      );
    }

    const settlementBase = {
      checkpoint,
      turnId,
      reason: evaluation.reason,
    };
    let settlement: GoalTurnSettlementResult;
    if (evaluation.met || evaluation.impossible) {
      settlement = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: evaluation.met ? 'achieved' : 'impossible',
      });
    } else if (evaluation.waiting) {
      settlement = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: 'continue',
        waiting: true,
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    } else {
      settlement = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: 'continue',
        ...(!evaluation.evaluatorFailed ? { madeProgress: evaluation.progress } : {}),
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    }
    if (settlement.kind === 'duplicate') return { kind: 'duplicate' };
    if (settlement.kind !== 'applied') return { kind: 'stale' };

    const settled = settlement.goal;
    if (settled.status === 'achieved' || settled.status === 'impossible') {
      lane.intent = undefined;
      this.resetWaitingBackoff(lane);
      this.taskGatePolicy.record({
        sessionId: lane.sessionId,
        turnId,
        goalId: goal.id,
        decision: 'evaluator_terminal',
        taskKeys: [],
      });
      return settled.status === 'achieved'
        ? { kind: 'achieved', evaluation }
        : { kind: 'impossible', evaluation };
    }
    if (settled.status !== 'active' && settled.status !== 'waiting') {
      lane.intent = undefined;
      this.resetWaitingBackoff(lane);
      const taskKeys = await this.taskGatePolicy.listActionable(lane.sessionId);
      this.taskGatePolicy.record({
        sessionId: lane.sessionId,
        turnId,
        goalId: goal.id,
        decision: 'goal_stopped',
        taskKeys,
      });
      return {
        kind: 'stopped',
        reason: settled.lastReason ?? 'Goal settled',
        status: settled.status,
      };
    }

    lane.intent = {
      checkpoint: goalCheckpoint(settled),
      controlLease,
      triggeringTurnId: turnId,
      evaluation,
    };
    if (settled.status === 'waiting') {
      if (lane.waitingGoalId !== settled.id) {
        lane.waitingGoalId = settled.id;
        lane.consecutiveWaits = 0;
      }
      lane.consecutiveWaits++;
      return { kind: 'waiting', evaluation };
    }
    this.resetWaitingBackoff(lane);
    return { kind: 'continued', evaluation };
  }

  private async tryAdmitIntent(
    lane: SessionLane,
    intent: ContinuationIntent,
  ): Promise<void> {
    if (
      !this.isCurrent(lane)
      || lane.queue.length > 0
      || lane.intent !== intent
    ) {
      return;
    }
    if (!this.ownsIntent(lane, intent)) {
      lane.intent = undefined;
      return;
    }

    const taskPlan = await this.taskGatePolicy.planAdmission(
      lane.sessionId,
      intent.checkpoint.goalId,
    );
    if (
      !this.isCurrent(lane)
      || lane.queue.length > 0
      || lane.intent !== intent
    ) {
      return;
    }
    if (!this.ownsIntent(lane, intent)) {
      lane.intent = undefined;
      return;
    }

    const prompt = buildContinuationPrompt(
      this.deps.goalManager.get(lane.sessionId),
      intent.evaluation,
      taskPlan.reminder,
    );
    const registration: TurnRegistration = {
      sessionId: lane.sessionId,
      lane,
      observedControlLease: intent.controlLease,
      checkpoint: intent.checkpoint,
      state: 'preparing',
      controlLease: intent.controlLease,
    };

    let admission: GoalTurnAdmission;
    try {
      admission = this.deps.admitTurn(
        lane.sessionId,
        prompt,
        (turnId) => this.bindOwnedTurn(registration, turnId),
      );
    } catch (error) {
      admission = {
        kind: 'unavailable',
        reason: `Goal continuation could not start: ${errorMessage(error)}`,
      };
    }

    if (admission.kind === 'busy') {
      this.consumeTurnRegistration(registration);
      this.watchBusyLane(lane, admission.whenIdle);
      return;
    }
    if (admission.kind === 'unavailable') {
      this.consumeTurnRegistration(registration);
      this.pauseAtCheckpoint(lane, intent.checkpoint, admission.reason);
      return;
    }
    void Promise.resolve(admission.completion).then(
      (outcome) => this.handleStartedTurnOutcome(registration, outcome),
      (error) => this.handleStartedTurnOutcome(registration, {
        kind: 'errored',
        reason: errorMessage(error),
      }),
    );
    if (registration.state !== 'open') {
      this.consumeTurnRegistration(registration);
      this.pauseAtCheckpoint(
        lane,
        intent.checkpoint,
        'Goal continuation host started a turn without binding its identity.',
      );
      return;
    }

    lane.intent = undefined;
    this.taskGatePolicy.markStarted(intent.checkpoint.goalId, taskPlan);
    this.taskGatePolicy.record({
      sessionId: lane.sessionId,
      turnId: intent.triggeringTurnId,
      goalId: intent.checkpoint.goalId,
      decision: taskPlan.decision,
      taskKeys: taskPlan.taskKeys,
    });
  }

  private watchBusyLane(lane: SessionLane, whenIdle: Promise<void>): void {
    if (!this.isCurrent(lane) || lane.busyWake === whenIdle) return;
    lane.busyWake = whenIdle;
    const wake = () => {
      if (!this.isCurrent(lane) || lane.busyWake !== whenIdle) return;
      lane.busyWake = undefined;
      this.scheduleDrain(lane);
    };
    void Promise.resolve(whenIdle).then(wake, wake);
  }

  private handleStartedTurnOutcome(
    registration: TurnRegistration,
    outcome: GoalTurnOutcome,
  ): void {
    if (registration.state === 'consumed') return;
    void this.settleRegisteredTurn(registration, outcome);
  }

  private bindOwnedTurn(
    registration: TurnRegistration,
    turnId: string,
  ): GoalTurnBinding {
    const lane = registration.lane;
    if (
      !turnId
      || this.disposed
      || registration.state !== 'preparing'
      || !this.isCurrent(lane)
      || lane.intent?.checkpoint !== registration.checkpoint
      || !registration.controlLease
      || !this.deps.goalManager.matchesControlLease(registration.sessionId, registration.controlLease)
      || !registration.checkpoint
      || !this.deps.goalManager.matchesActive(registration.sessionId, registration.checkpoint)
    ) {
      this.consumeTurnRegistration(registration);
      return { kind: 'unavailable', reason: 'Goal continuation turn ownership is stale.' };
    }
    if (this.deps.goalManager.hasSettledTurn(registration.sessionId, turnId)) {
      this.consumeTurnRegistration(registration);
      return { kind: 'duplicate' };
    }
    if (lane.turns.has(turnId)) {
      this.consumeTurnRegistration(registration);
      return { kind: 'duplicate' };
    }
    registration.turnId = turnId;
    registration.state = 'open';
    lane.turns.set(turnId, registration);
    return { kind: 'bound' };
  }

  private ownsIntent(lane: SessionLane, intent: ContinuationIntent): boolean {
    return this.deps.goalManager.matchesControlLease(lane.sessionId, intent.controlLease)
      && this.deps.goalManager.matchesActive(lane.sessionId, intent.checkpoint);
  }

  private scheduleWaitingRetry(lane: SessionLane, goal: GoalState): void {
    if (!this.isCurrent(lane) || lane.waitingTimer || !lane.intent) return;
    if (!this.deps.goalManager.matches(lane.sessionId, lane.intent.checkpoint)) {
      lane.intent = undefined;
      this.resetWaitingBackoff(lane);
      return;
    }
    const checkpoint = goalCheckpoint(goal);
    const delayMs = waitBackoffMs(lane.consecutiveWaits);
    try {
      const handle = this.scheduler.setTimeout(() => {
        if (!this.isCurrent(lane)) return;
        const timer = lane.waitingTimer;
        if (!timer || timer.checkpoint !== checkpoint) return;
        lane.waitingTimer = undefined;
        if (lane.queue.length > 0) {
          this.scheduleDrain(lane);
          return;
        }
        const woken = this.deps.goalManager.wakeWaiting(lane.sessionId, checkpoint);
        if (!woken || !lane.intent) return;
        lane.intent = { ...lane.intent, checkpoint: goalCheckpoint(woken) };
        this.scheduleDrain(lane);
      }, delayMs);
      lane.waitingTimer = { handle, checkpoint };
    } catch (error) {
      this.pauseAtCheckpoint(
        lane,
        checkpoint,
        `Unable to schedule Goal waiting retry: ${errorMessage(error)}`,
      );
    }
  }

  private pauseCurrentGoal(lane: SessionLane, reason: string): GoalContinuationOutcome {
    const current = this.deps.goalManager.get(lane.sessionId);
    if (!current || (current.status !== 'active' && current.status !== 'waiting')) {
      return { kind: 'stale' };
    }
    return this.pauseAtCheckpoint(lane, goalCheckpoint(current), reason);
  }

  private pauseAtCheckpoint(
    lane: SessionLane,
    checkpoint: GoalCheckpoint,
    reason: string,
    turnId?: string,
  ): GoalContinuationOutcome {
    let paused: GoalState | undefined;
    if (turnId) {
      const settlement = this.deps.goalManager.settleTurn(lane.sessionId, {
        checkpoint,
        turnId,
        reason,
        verdict: 'pause',
      });
      if (settlement.kind === 'duplicate') return { kind: 'duplicate' };
      if (settlement.kind !== 'applied') return { kind: 'stale' };
      paused = settlement.goal;
    } else {
      paused = this.deps.goalManager.pause(lane.sessionId, { checkpoint, reason });
    }
    if (!paused) return { kind: 'stale' };
    lane.intent = undefined;
    lane.busyWake = undefined;
    this.clearWaitingTimer(lane);
    this.resetWaitingBackoff(lane);
    return { kind: 'stopped', reason, status: paused.status };
  }

  private clearWaitingTimer(lane: SessionLane): void {
    const timer = lane.waitingTimer;
    if (!timer) return;
    lane.waitingTimer = undefined;
    try {
      this.scheduler.clearTimeout(timer.handle);
    } catch {
      // The checkpoint makes a timer harmless even if a host cannot cancel it.
    }
  }

  private resetWaitingBackoff(lane: SessionLane): void {
    lane.waitingGoalId = undefined;
    lane.consecutiveWaits = 0;
  }

  private invalidateLane(lane: SessionLane): void {
    lane.intent = undefined;
    lane.busyWake = undefined;
    this.clearWaitingTimer(lane);
    for (const registration of [...lane.turns.values()]) {
      this.consumeTurnRegistration(registration);
    }
    if (lane.processing) this.consumeTurnRegistration(lane.processing.registration);
    lane.processing?.resolve({ kind: 'stale' });
    for (const item of lane.queue.splice(0)) {
      this.consumeTurnRegistration(item.registration);
      item.resolve({ kind: 'stale' });
    }
  }
}

function buildContinuationPrompt(
  goal: GoalState | undefined,
  evaluation: GoalEvaluation,
  taskReminder: string | undefined,
): string {
  const condition = goal?.condition ?? 'unknown';
  const iterations = goal?.iterations ?? 0;
  const maxIterations = goal?.maxIterations ?? 0;
  const noProgress = goal && goal.consecutiveNoProgress > 0
    ? `, ${goal.consecutiveNoProgress}/${goal.blockCap} no-progress`
    : '';
  return `${CONTINUATION_PREAMBLE}${taskReminder
    ? `\n\n${taskReminder}`
    : ''}`
    + `\n\nEvaluation: ${evaluation.reason}${evaluation.waiting ? ' (scheduled external-event re-check)' : ''}\n`
    + `Goal: "${condition}" (turn ${iterations}/${maxIterations}${noProgress})`;
}

function waitBackoffMs(consecutiveWaits: number): number {
  const exponent = Math.max(0, Math.min(16, consecutiveWaits - 1));
  return Math.min(GOAL_WAIT_BACKOFF_MAX_MS, GOAL_WAIT_BACKOFF_BASE_MS * (2 ** exponent));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function turnFailureReason(outcome: Exclude<GoalTurnOutcome, { kind: 'completed' }>): string {
  if (outcome.kind === 'aborted') return 'Goal-associated turn was aborted.';
  if (outcome.kind === 'suspended') return `Goal-associated turn suspended: ${outcome.reason}`;
  return `Goal-associated turn failed: ${outcome.reason}`;
}

const defaultScheduler: GoalContinuationScheduler = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref?: () => void }).unref?.();
    }
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
