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
} from './goal-state.js';
import {
  GoalSessionCloseFence,
  type GoalSessionCloseKind,
  type GoalSessionCloseOperation,
} from './goal-session-close-fence.js';
import {
  GoalTaskGatePolicy,
  type GoalTaskGateDeps,
  type GoalTaskGateTrace,
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
  | {
      kind: 'prepared';
      turnId: string;
      /** Start the reserved turn after coordinator ownership is registered. */
      start: () => Promise<GoalTurnOutcome>;
      /** Idempotently release the reservation when it will not be started. */
      abandon: () => void | Promise<void>;
    }
  | { kind: 'busy'; whenIdle: Promise<void> }
  | { kind: 'unavailable'; reason: string };

export interface GoalTurnIdentity {
  readonly goalId: string;
}

/** Exactly-once settlement capability captured when an external Agent turn starts. */
export type GoalExternalTurnSettler = (outcome: GoalTurnOutcome) => Promise<void>;

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
  /** Prepare, defer, or reject a Goal-owned turn. */
  admitTurn: (
    sessionId: string,
    text: string,
    identity: GoalTurnIdentity,
  ) => GoalTurnAdmission | Promise<GoalTurnAdmission>;
  taskGate?: GoalTaskGateDeps;
  scheduler?: GoalContinuationScheduler;
}

export const GOAL_WAIT_BACKOFF_BASE_MS = 5_000;
export const GOAL_WAIT_BACKOFF_MAX_MS = 5 * 60_000;

const CONTINUATION_PREAMBLE =
  '[Goal continuation] The goal is not yet met. Keep working toward it. ' +
  'Do not redefine success around a smaller task; match your verification to the full requirement.';

interface QueuedTurn {
  turnId: string;
  outcome: GoalTurnOutcome;
  controlLease: GoalControlLease;
  workLease: GoalGenerationWorkLease;
  checkpoint?: GoalCheckpoint;
  resolve: () => void;
}

interface ContinuationIntent {
  checkpoint: GoalCheckpoint;
  controlLease: GoalControlLease;
  triggeringTurnId: string;
  evaluation: GoalEvaluation;
  workLease: GoalGenerationWorkLease;
}

interface WaitingTimer {
  handle: unknown;
  workLease: GoalGenerationWorkLease;
}

interface BusyWake {
  whenIdle: Promise<void>;
  workLease: GoalGenerationWorkLease;
}

interface TurnRegistration {
  readonly turnId: string;
  readonly lane: SessionLane;
  observedControlLease?: GoalControlLease;
  checkpoint?: GoalCheckpoint;
  controlLease?: GoalControlLease;
  workLease?: GoalGenerationWorkLease;
}

interface SessionLane {
  sessionId: string;
  queue: QueuedTurn[];
  turns: Map<string, TurnRegistration>;
  processing?: QueuedTurn;
  draining: boolean;
  intent?: ContinuationIntent;
  busyWake?: BusyWake;
  waitingTimer?: WaitingTimer;
  consecutiveWaits: number;
}

interface GoalGenerationWorkLease {
  readonly sessionId: string;
  readonly goalId: string;
  release(): void;
}

interface GoalGenerationWorkState {
  refs: number;
  failure?: { error: unknown };
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

class GoalGenerationWorkTracker {
  private readonly sessions = new Map<string, Map<string, GoalGenerationWorkState>>();

  retain(sessionId: string, goalId: string): GoalGenerationWorkLease {
    let generations = this.sessions.get(sessionId);
    if (!generations) {
      generations = new Map();
      this.sessions.set(sessionId, generations);
    }
    let state = generations.get(goalId);
    if (!state) {
      state = { refs: 0, waiters: [] };
      generations.set(goalId, state);
    }
    state.refs++;

    let released = false;
    return {
      sessionId,
      goalId,
      release: () => {
        if (released) return;
        released = true;
        state.refs--;
        if (state.refs === 0) this.settle(sessionId, goalId, state);
      },
    };
  }

  whenIdle(sessionId: string, goalId: string): Promise<void> {
    const state = this.sessions.get(sessionId)?.get(goalId);
    if (!state) return Promise.resolve();
    if (state.refs === 0) return Promise.reject(state.failure?.error);
    return new Promise<void>((resolve, reject) => {
      state.waiters.push({ resolve, reject });
    });
  }

  fail(lease: GoalGenerationWorkLease, error: unknown): void {
    const state = this.sessions.get(lease.sessionId)?.get(lease.goalId);
    if (state && state.failure === undefined) state.failure = { error };
  }

  private settle(sessionId: string, goalId: string, state: GoalGenerationWorkState): void {
    const waiters = state.waiters.splice(0);
    if (state.failure === undefined) {
      const generations = this.sessions.get(sessionId);
      generations?.delete(goalId);
      if (generations?.size === 0) this.sessions.delete(sessionId);
      for (const waiter of waiters) waiter.resolve();
      return;
    }
    for (const waiter of waiters) waiter.reject(state.failure.error);
  }
}

class GoalGenerationWorkFailure extends Error {
  constructor(
    readonly workLease: GoalGenerationWorkLease,
    readonly workError: unknown,
  ) {
    super(errorMessage(workError));
    this.name = 'GoalGenerationWorkFailure';
  }
}

export type GoalExternalTurnStart =
  | { kind: 'registered'; settle: GoalExternalTurnSettler }
  | { kind: 'unavailable'; reason: string };

export class GoalContinuationCoordinator {
  private readonly lanes = new Map<string, SessionLane>();
  private readonly generationWork = new GoalGenerationWorkTracker();
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

  /** Wait for coordinator work already retained by one Goal generation. */
  whenGenerationIdle(sessionId: string, goalId: string): Promise<void> {
    return this.generationWork.whenIdle(sessionId, goalId);
  }

  /**
   * Register an external Agent turn before its iterator starts. The returned
   * closure is the only legal settlement path, so terminal handling never has
   * to rediscover Goal ownership from mutable current state.
   */
  beginExternalTurn(sessionId: string, turnId: string): GoalExternalTurnStart {
    if (this.disposed) {
      return { kind: 'unavailable', reason: 'Goal continuation is disposed.' };
    }
    if (this.sessionCloseFence.isClosed(sessionId)) {
      return { kind: 'unavailable', reason: 'Goal continuation session is closed.' };
    }
    const lane = this.laneFor(sessionId);
    if (lane.turns.has(turnId)) {
      return { kind: 'unavailable', reason: `Goal turn ${turnId} is already registered.` };
    }
    const goal = this.deps.goalManager.get(sessionId);
    const observedControlLease = this.deps.goalManager.getControlLease(sessionId);
    const controlLease =
      goal?.status === 'active' || goal?.status === 'waiting' ? observedControlLease : undefined;
    const workLease = controlLease
      ? this.generationWork.retain(sessionId, controlLease.goalId)
      : undefined;
    const registration: TurnRegistration = {
      turnId,
      lane,
      ...(observedControlLease ? { observedControlLease } : {}),
      ...(controlLease ? { controlLease } : {}),
      ...(workLease ? { workLease } : {}),
    };
    lane.turns.set(turnId, registration);

    return {
      kind: 'registered',
      settle: (outcome) => this.settleRegisteredTurn(registration, outcome),
    };
  }

  /** Execute and bind one Goal activation only while this exact turn owns the right to do so. */
  activateGoal(
    sessionId: string,
    turnId: string,
    activate: () => GoalState,
  ): GoalState | undefined {
    const lane = this.lanes.get(sessionId);
    const registration = lane?.turns.get(turnId);
    if (
      !lane ||
      !this.isCurrent(lane) ||
      !registration ||
      registration.controlLease !== undefined ||
      this.deps.goalManager.getControlLease(sessionId) !== registration.observedControlLease
    ) {
      return undefined;
    }
    const goal = activate();
    this.bindRegistrationGeneration(registration, goal.id);
    registration.controlLease = this.deps.goalManager.getControlLease(sessionId);
    if (registration.checkpoint) registration.checkpoint = goalCheckpoint(goal);
    return goal;
  }

  /** Mutate the exact Goal generation observed by this turn. */
  mutateGoal(sessionId: string, turnId: string, mutate: () => GoalState): GoalState | undefined {
    const lane = this.lanes.get(sessionId);
    const registration = lane?.turns.get(turnId);
    const controlLease = registration?.controlLease ?? registration?.observedControlLease;
    if (
      !lane ||
      !this.isCurrent(lane) ||
      !registration ||
      !controlLease ||
      !this.deps.goalManager.matchesControlLease(sessionId, controlLease)
    ) {
      return undefined;
    }

    const goal = mutate();
    this.discardIntentOwnedBy(lane, controlLease);
    registration.observedControlLease = this.deps.goalManager.getControlLease(sessionId);
    registration.controlLease = undefined;
    return goal;
  }

  private settleRegisteredTurn(
    registration: TurnRegistration,
    outcome: GoalTurnOutcome,
  ): Promise<void> {
    const { lane, turnId } = registration;
    const sessionId = lane.sessionId;
    if (!this.isCurrent(lane) || lane.turns.get(turnId) !== registration) {
      this.consumeTurnRegistration(registration);
      return Promise.resolve();
    }
    const controlLease = registration.controlLease;
    const goal = this.deps.goalManager.get(sessionId);
    if (
      !controlLease ||
      !this.deps.goalManager.matchesControlLease(sessionId, controlLease) ||
      !goal ||
      (goal.status !== 'active' && goal.status !== 'waiting')
    ) {
      this.discardIntentOwnedBy(lane, controlLease);
      this.consumeTurnRegistration(registration);
      return Promise.resolve();
    }
    if (
      registration.checkpoint &&
      !this.deps.goalManager.matchesActive(sessionId, registration.checkpoint)
    ) {
      this.consumeTurnRegistration(registration);
      return Promise.resolve();
    }
    return this.enqueueTurn(outcome, controlLease, registration);
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
  beginSessionClose(sessionId: string, kind: GoalSessionCloseKind): GoalSessionCloseOperation {
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
    outcome: GoalTurnOutcome,
    controlLease: GoalControlLease,
    registration: TurnRegistration,
  ): Promise<void> {
    const lane = registration.lane;
    // New evidence always outranks an older, not-yet-admitted continuation.
    this.releaseIntent(lane);
    this.clearWaitingTimer(lane);
    const workLease =
      registration.workLease ?? this.generationWork.retain(lane.sessionId, controlLease.goalId);
    registration.workLease = undefined;
    return new Promise<void>((resolve) => {
      lane.queue.push({
        turnId: registration.turnId,
        outcome,
        controlLease,
        workLease,
        ...(registration.checkpoint ? { checkpoint: registration.checkpoint } : {}),
        resolve,
      });
      this.consumeTurnRegistration(registration);
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
    const lane = registration.lane;
    const turnId = registration.turnId;
    if (lane.turns.get(turnId) === registration) {
      lane.turns.delete(turnId);
    }
    registration.workLease?.release();
    registration.workLease = undefined;
    this.dropIdleLane(lane);
  }

  private bindRegistrationGeneration(registration: TurnRegistration, goalId: string): void {
    if (registration.workLease?.goalId === goalId) return;
    const next = this.generationWork.retain(registration.lane.sessionId, goalId);
    const previous = registration.workLease;
    registration.workLease = next;
    previous?.release();
  }

  private dropIdleLane(lane: SessionLane): void {
    if (
      !this.isCurrent(lane) ||
      lane.turns.size > 0 ||
      lane.queue.length > 0 ||
      lane.draining ||
      lane.intent ||
      lane.busyWake ||
      lane.waitingTimer
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
    this.releaseIntent(lane);
    this.clearBusyWake(lane);
    this.clearWaitingTimer(lane);
    this.resetWaitingBackoff(lane);
  }

  private scheduleDrain(lane: SessionLane): void {
    if (!this.isCurrent(lane) || lane.draining) return;
    void this.drainLane(lane).catch((error) => {
      if (error instanceof GoalGenerationWorkFailure) {
        this.generationWork.fail(error.workLease, error.workError);
        error.workLease.release();
        this.handleGenerationFailure(lane, error.workLease.goalId, error.workError);
      } else {
        this.handleCoordinatorFailure(lane, error);
      }
      this.finishLaneDrain(lane);
    });
  }

  private async drainLane(lane: SessionLane): Promise<void> {
    if (!this.isCurrent(lane) || lane.draining) return;
    lane.draining = true;
    let failed = false;
    try {
      while (this.isCurrent(lane) && lane.queue.length > 0) {
        const item = lane.queue.shift();
        if (!item) break;
        lane.processing = item;
        try {
          await this.processQueuedTurn(lane, item);
        } catch (error) {
          this.pauseCurrentGoal(
            lane,
            `Goal continuation coordinator failed: ${errorMessage(error)}`,
          );
        } finally {
          if (lane.processing === item) lane.processing = undefined;
          item.workLease.release();
          item.resolve();
        }
      }

      if (!this.isCurrent(lane) || lane.queue.length > 0) return;
      const goal = this.deps.goalManager.get(lane.sessionId);
      if (goal?.status === 'waiting' && lane.intent) {
        this.scheduleWaitingRetry(lane, goal);
      } else if (goal?.status === 'active' && lane.intent && !lane.busyWake) {
        await this.tryAdmitIntent(lane, lane.intent);
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      lane.draining = false;
      if (!failed) this.finishLaneDrain(lane);
    }
  }

  private finishLaneDrain(lane: SessionLane): void {
    if (!this.isCurrent(lane)) return;
    const goal = this.deps.goalManager.get(lane.sessionId);
    if (
      lane.queue.length > 0 ||
      (lane.intent && goal?.status === 'active' && !lane.busyWake && !lane.waitingTimer)
    ) {
      this.scheduleDrain(lane);
    } else {
      this.dropIdleLane(lane);
    }
  }

  private async processQueuedTurn(lane: SessionLane, item: QueuedTurn): Promise<void> {
    if (!this.deps.goalManager.matchesControlLease(lane.sessionId, item.controlLease)) {
      return;
    }
    const goal = this.deps.goalManager.get(lane.sessionId)!;
    if (item.checkpoint && !this.deps.goalManager.matchesActive(lane.sessionId, item.checkpoint)) {
      return;
    }
    if (item.outcome.kind !== 'completed') {
      if (goal.status !== 'active' && goal.status !== 'waiting') return;
      this.pauseAtCheckpoint(
        lane,
        item.checkpoint ?? goalCheckpoint(goal),
        turnFailureReason(item.outcome),
      );
      return;
    }
    await this.processCompletion(lane, item.controlLease, goal, item.turnId);
  }

  private async processCompletion(
    lane: SessionLane,
    controlLease: GoalControlLease,
    initialGoal: GoalState,
    turnId: string,
  ): Promise<void> {
    let goal = initialGoal;
    if (goal.status === 'waiting') {
      const woken = this.deps.goalManager.wakeWaiting(lane.sessionId, goalCheckpoint(goal));
      if (!woken) return;
      goal = woken;
    }
    if (goal.status !== 'active') return;

    const checkpoint = goalCheckpoint(goal);
    let context: string;
    try {
      context = await this.deps.getRecentContext(lane.sessionId);
    } catch (error) {
      this.pauseAtCheckpoint(
        lane,
        checkpoint,
        `Unable to read Goal evaluation context: ${errorMessage(error)}`,
      );
      return;
    }
    if (!this.isCurrent(lane) || !this.deps.goalManager.matchesActive(lane.sessionId, checkpoint)) {
      return;
    }

    const evaluation = await evaluateGoal(
      this.deps.evaluator,
      goal.condition,
      context,
      lane.sessionId,
    );
    if (!this.isCurrent(lane) || !this.deps.goalManager.matchesActive(lane.sessionId, checkpoint)) {
      return;
    }

    const tokensNow = this.deps.getTokenCount?.(lane.sessionId);

    const settlementBase = {
      checkpoint,
      reason: evaluation.reason,
    };
    let settled: GoalState | undefined;
    if (evaluation.met || evaluation.impossible) {
      settled = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: evaluation.met ? 'achieved' : 'impossible',
      });
    } else if (evaluation.waiting) {
      settled = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: 'continue',
        waiting: true,
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    } else {
      settled = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: 'continue',
        ...(!evaluation.evaluatorFailed ? { madeProgress: evaluation.progress } : {}),
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    }
    if (!settled) return;
    if (settled.status === 'achieved' || settled.status === 'impossible') {
      this.releaseIntent(lane);
      this.resetWaitingBackoff(lane);
      this.recordTaskGateDecision({
        sessionId: lane.sessionId,
        turnId,
        goalId: goal.id,
        decision: 'evaluator_terminal',
        taskKeys: [],
      });
      return;
    }
    if (settled.status !== 'active' && settled.status !== 'waiting') {
      this.releaseIntent(lane);
      this.resetWaitingBackoff(lane);
      const taskKeys = await this.taskGatePolicy.listActionable(lane.sessionId);
      this.recordTaskGateDecision({
        sessionId: lane.sessionId,
        turnId,
        goalId: goal.id,
        decision: 'goal_stopped',
        taskKeys,
      });
      return;
    }

    const nextIntent: ContinuationIntent = {
      checkpoint: goalCheckpoint(settled),
      controlLease,
      triggeringTurnId: turnId,
      evaluation,
      workLease: this.generationWork.retain(lane.sessionId, settled.id),
    };
    this.releaseIntent(lane);
    lane.intent = nextIntent;
    if (settled.status === 'waiting') {
      lane.consecutiveWaits++;
      return;
    }
    this.resetWaitingBackoff(lane);
  }

  private async tryAdmitIntent(lane: SessionLane, intent: ContinuationIntent): Promise<void> {
    if (!this.isCurrent(lane) || lane.queue.length > 0 || lane.intent !== intent) {
      return;
    }
    if (!this.ownedGoal(lane, intent)) {
      this.releaseIntent(lane, intent);
      return;
    }

    const admissionWork = this.generationWork.retain(lane.sessionId, intent.checkpoint.goalId);
    let failureHandedOff = false;
    try {
      const taskPlan = await this.taskGatePolicy.planAdmission(
        lane.sessionId,
        intent.checkpoint.goalId,
      );
      if (!this.isCurrent(lane) || lane.queue.length > 0 || lane.intent !== intent) {
        return;
      }
      const goal = this.ownedGoal(lane, intent);
      if (!goal) {
        this.releaseIntent(lane, intent);
        return;
      }

      const prompt = buildContinuationPrompt(goal, intent.evaluation, taskPlan.reminder);
      const admission = await this.deps.admitTurn(lane.sessionId, prompt, {
        goalId: intent.checkpoint.goalId,
      });
      if (!this.isCurrent(lane) || lane.queue.length > 0 || lane.intent !== intent) {
        await this.abandonPreparedAdmission(admission);
        return;
      }
      if (!this.ownedGoal(lane, intent)) {
        await this.abandonPreparedAdmission(admission);
        this.releaseIntent(lane, intent);
        return;
      }

      if (admission.kind === 'busy') {
        this.watchBusyLane(lane, intent, admission.whenIdle);
        return;
      }
      if (admission.kind === 'unavailable') {
        this.pauseAtCheckpoint(lane, intent.checkpoint, admission.reason);
        return;
      }

      const registration: TurnRegistration = {
        turnId: admission.turnId,
        lane,
        observedControlLease: intent.controlLease,
        checkpoint: intent.checkpoint,
        controlLease: intent.controlLease,
        workLease: this.generationWork.retain(lane.sessionId, intent.checkpoint.goalId),
      };
      lane.turns.set(admission.turnId, registration);

      let completion: Promise<GoalTurnOutcome>;
      try {
        completion = admission.start();
      } catch (error) {
        void this.settleRegisteredTurn(registration, {
          kind: 'errored',
          turnId: admission.turnId,
          reason: errorMessage(error),
        });
        return;
      }
      void completion.then(
        (outcome) => {
          void this.settleRegisteredTurn(registration, outcome);
        },
        (error) => {
          void this.settleRegisteredTurn(registration, {
            kind: 'errored',
            turnId: admission.turnId,
            reason: errorMessage(error),
          });
        },
      );

      this.releaseIntent(lane, intent);
      this.taskGatePolicy.markStarted(intent.checkpoint.goalId, taskPlan);
      this.recordTaskGateDecision({
        sessionId: lane.sessionId,
        turnId: intent.triggeringTurnId,
        goalId: intent.checkpoint.goalId,
        decision: taskPlan.decision,
        taskKeys: taskPlan.taskKeys,
      });
    } catch (error) {
      failureHandedOff = true;
      throw new GoalGenerationWorkFailure(admissionWork, error);
    } finally {
      if (!failureHandedOff) admissionWork.release();
    }
  }

  private watchBusyLane(
    lane: SessionLane,
    intent: ContinuationIntent,
    whenIdle: Promise<void>,
  ): void {
    if (!this.isCurrent(lane) || lane.busyWake?.whenIdle === whenIdle) return;
    this.clearBusyWake(lane);
    const busyWake: BusyWake = {
      whenIdle,
      workLease: this.generationWork.retain(lane.sessionId, intent.checkpoint.goalId),
    };
    lane.busyWake = busyWake;
    const wake = () => {
      if (!this.isCurrent(lane) || lane.busyWake !== busyWake) return;
      lane.busyWake = undefined;
      busyWake.workLease.release();
      this.scheduleDrain(lane);
    };
    void whenIdle.then(wake, wake);
  }

  private recordTaskGateDecision(trace: GoalTaskGateTrace): void {
    const workLease = this.generationWork.retain(trace.sessionId, trace.goalId);
    const settle = () => workLease.release();
    void this.taskGatePolicy.record(trace).then(settle, settle);
  }

  private ownedGoal(lane: SessionLane, intent: ContinuationIntent): GoalState | undefined {
    if (
      !this.deps.goalManager.matchesControlLease(lane.sessionId, intent.controlLease) ||
      !this.deps.goalManager.matchesActive(lane.sessionId, intent.checkpoint)
    ) {
      return undefined;
    }
    return this.deps.goalManager.get(lane.sessionId);
  }

  private scheduleWaitingRetry(lane: SessionLane, goal: GoalState): void {
    if (!this.isCurrent(lane) || lane.waitingTimer || !lane.intent) return;
    if (!this.deps.goalManager.matches(lane.sessionId, lane.intent.checkpoint)) {
      this.releaseIntent(lane);
      this.resetWaitingBackoff(lane);
      return;
    }
    const checkpoint = goalCheckpoint(goal);
    const delayMs = waitBackoffMs(lane.consecutiveWaits);
    const workLease = this.generationWork.retain(lane.sessionId, checkpoint.goalId);
    let timer: WaitingTimer;
    let handle: unknown;
    try {
      handle = this.scheduler.setTimeout(() => {
        if (lane.waitingTimer !== timer) return;
        lane.waitingTimer = undefined;
        timer.workLease.release();
        if (!this.isCurrent(lane)) return;
        if (lane.queue.length > 0) {
          this.scheduleDrain(lane);
          return;
        }
        const woken = this.deps.goalManager.wakeWaiting(lane.sessionId, checkpoint);
        if (!woken || !lane.intent) return;
        lane.intent = { ...lane.intent, checkpoint: goalCheckpoint(woken) };
        this.scheduleDrain(lane);
      }, delayMs);
    } catch (error) {
      workLease.release();
      throw error;
    }
    timer = { handle, workLease };
    lane.waitingTimer = timer;
  }

  private pauseCurrentGoal(lane: SessionLane, reason: string): void {
    const current = this.deps.goalManager.get(lane.sessionId);
    if (!current || (current.status !== 'active' && current.status !== 'waiting')) {
      return;
    }
    this.pauseAtCheckpoint(lane, goalCheckpoint(current), reason);
  }

  private handleCoordinatorFailure(lane: SessionLane, error: unknown): void {
    if (!this.isCurrent(lane)) return;
    this.pauseCurrentGoal(lane, `Goal continuation coordinator failed: ${errorMessage(error)}`);
  }

  private handleGenerationFailure(lane: SessionLane, goalId: string, error: unknown): void {
    if (this.deps.goalManager.get(lane.sessionId)?.id !== goalId) return;
    this.handleCoordinatorFailure(lane, error);
  }

  private async abandonPreparedAdmission(admission: GoalTurnAdmission): Promise<void> {
    if (admission.kind !== 'prepared') return;
    await admission.abandon();
  }

  private pauseAtCheckpoint(lane: SessionLane, checkpoint: GoalCheckpoint, reason: string): void {
    const paused = this.deps.goalManager.pause(lane.sessionId, { checkpoint, reason });
    if (!paused) return;
    this.releaseIntent(lane);
    this.clearBusyWake(lane);
    this.clearWaitingTimer(lane);
    this.resetWaitingBackoff(lane);
  }

  private releaseIntent(lane: SessionLane, expected?: ContinuationIntent): void {
    const intent = lane.intent;
    if (!intent || (expected && intent !== expected)) return;
    lane.intent = undefined;
    intent.workLease.release();
  }

  private clearBusyWake(lane: SessionLane): void {
    const busyWake = lane.busyWake;
    if (!busyWake) return;
    lane.busyWake = undefined;
    busyWake.workLease.release();
  }

  private clearWaitingTimer(lane: SessionLane): void {
    const timer = lane.waitingTimer;
    if (!timer) return;
    lane.waitingTimer = undefined;
    this.scheduler.clearTimeout(timer.handle);
    timer.workLease.release();
  }

  private resetWaitingBackoff(lane: SessionLane): void {
    lane.consecutiveWaits = 0;
  }

  private invalidateLane(lane: SessionLane): void {
    this.releaseIntent(lane);
    this.clearBusyWake(lane);
    this.clearWaitingTimer(lane);
    for (const registration of [...lane.turns.values()]) {
      this.consumeTurnRegistration(registration);
    }
    lane.processing?.resolve();
    for (const item of lane.queue.splice(0)) {
      item.workLease.release();
      item.resolve();
    }
  }
}

function buildContinuationPrompt(
  goal: GoalState,
  evaluation: GoalEvaluation,
  taskReminder: string | undefined,
): string {
  const noProgress =
    goal.consecutiveNoProgress > 0
      ? `, ${goal.consecutiveNoProgress}/${goal.blockCap} no-progress`
      : '';
  return (
    `${CONTINUATION_PREAMBLE}${taskReminder ? `\n\n${taskReminder}` : ''}` +
    `\n\nEvaluation: ${evaluation.reason}${evaluation.waiting ? ' (scheduled external-event re-check)' : ''}\n` +
    `Goal: "${goal.condition}" (turn ${goal.iterations}/${goal.maxIterations}${noProgress})`
  );
}

function waitBackoffMs(consecutiveWaits: number): number {
  return Math.min(
    GOAL_WAIT_BACKOFF_MAX_MS,
    GOAL_WAIT_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveWaits - 1),
  );
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
