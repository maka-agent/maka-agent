import { randomUUID } from 'node:crypto';
import {
  buildGoalTools,
  GoalContinuationCoordinator,
  GoalManager,
  TERMINAL_GOAL_STATUSES,
  type GoalEvaluatorDeps,
  type GoalExternalTurnStart,
  type GoalState,
  type GoalTaskGateDeps,
  type GoalTurnAdmission,
  type GoalTurnIdentity,
  type MakaTool,
} from '@maka/runtime';
import {
  encodeGoalClearResult,
  encodeGoalQueryResult,
  type GoalProjection,
  type OperationOutcome,
} from '../protocol/index.js';
import type { GoalOperationHandlerMap, OperationResidency } from './operation-dispatcher.js';

export interface HostGoalRootPort {
  admitGoalTurn(
    sessionId: string,
    text: string,
    identity: GoalTurnIdentity,
  ): Promise<GoalTurnAdmission>;
}

export interface HostGoalEvaluationContext {
  readonly recentContext: string;
  readonly tokenCount: number;
}

export interface HostGoalCoordinatorOptions {
  readonly root: HostGoalRootPort;
  readonly evaluate: GoalEvaluatorDeps['evaluate'];
  readonly waitForEvaluatorPostCutEffects: () => Promise<void>;
  readonly readEvaluationContext: (sessionId: string) => Promise<HostGoalEvaluationContext>;
  readonly taskGate?: GoalTaskGateDeps;
  readonly acquireResidency: () => OperationResidency;
  readonly requestDrain: () => void;
  readonly newId?: () => string;
  readonly now?: () => number;
}

interface GoalResidency {
  readonly sessionId: string;
  readonly goalId: string;
  readonly token: OperationResidency;
  releaseTask?: Promise<void>;
}

export interface HostGoalSessionClose {
  readonly settled: Promise<void>;
  commit(): void;
  rollback(): void;
}

/** Host-local owner for the intentionally in-memory Goal lifecycle. */
export class HostGoalCoordinator {
  readonly handlers: GoalOperationHandlerMap = {
    'goal.query': (input) => this.#query(input.sessionId),
    'goal.clear': (input) => this.#clear(input.sessionId, input.goalId),
  };

  readonly manager: GoalManager;
  readonly coordinator: GoalContinuationCoordinator;
  readonly tools: readonly MakaTool[];

  readonly #acquireResidency: () => OperationResidency;
  readonly #requestDrain: () => void;
  readonly #tokenCounts = new Map<string, number>();
  readonly #residencies = new Map<string, GoalResidency>();
  readonly #normalReleaseTasks = new Set<Promise<void>>();
  readonly #closeErrors: unknown[] = [];
  #admissionClosed = false;
  #disposed = false;
  #failStop = false;
  #drainRequested = false;
  #closeTask: Promise<void> | undefined;
  #failStopReclaimer: (() => void) | undefined;

  constructor(options: HostGoalCoordinatorOptions) {
    const now = options.now ?? Date.now;
    this.#acquireResidency = options.acquireResidency;
    this.#requestDrain = options.requestDrain;
    this.manager = new GoalManager({
      generateId: options.newId ?? randomUUID,
      now,
      onChange: (goal) => this.#observeGoal(goal),
    });
    this.coordinator = new GoalContinuationCoordinator({
      goalManager: this.manager,
      evaluator: { evaluate: options.evaluate },
      getRecentContext: async (sessionId) => {
        const context = await options.readEvaluationContext(sessionId);
        if (!this.#disposed) this.#tokenCounts.set(sessionId, context.tokenCount);
        return context.recentContext;
      },
      getTokenCount: (sessionId) => this.#tokenCounts.get(sessionId) ?? 0,
      admitTurn: async (sessionId, text, identity) => {
        if (this.#admissionClosed) {
          return { kind: 'unavailable', reason: 'Runtime Host is draining.' };
        }
        await options.waitForEvaluatorPostCutEffects();
        if (this.#admissionClosed) {
          return { kind: 'unavailable', reason: 'Runtime Host is draining.' };
        }
        return options.root.admitGoalTurn(sessionId, text, identity);
      },
      taskGate: options.taskGate,
    });
    this.tools = Object.freeze(
      buildGoalTools({
        goalManager: this.manager,
        goalContinuation: this.coordinator,
        getTokenCount: (sessionId) => this.#tokenCounts.get(sessionId) ?? 0,
        now,
      }),
    );
  }

  beginExternalTurn(sessionId: string, turnId: string): GoalExternalTurnStart {
    if (this.#admissionClosed) {
      return { kind: 'unavailable', reason: 'Runtime Host is draining.' };
    }
    return this.coordinator.beginExternalTurn(sessionId, turnId);
  }

  beginSessionClose(sessionId: string, kind: 'archive' | 'remove'): HostGoalSessionClose {
    const fence = this.coordinator.beginSessionClose(sessionId, kind);
    const current = this.manager.get(sessionId);
    const goalId = current?.id;
    if (current && !TERMINAL_GOAL_STATUSES.has(current.status)) {
      this.manager.clear(sessionId);
    }
    const settled = goalId
      ? this.coordinator.whenGenerationIdle(sessionId, goalId)
      : Promise.resolve();
    let outcome: 'pending' | 'committed' | 'rolled_back' = 'pending';
    return {
      settled,
      commit: () => {
        if (outcome !== 'pending') return;
        outcome = 'committed';
        if (goalId && this.manager.get(sessionId)?.id === goalId) {
          this.manager.remove(sessionId);
        }
        fence.commit();
      },
      rollback: () => {
        if (outcome !== 'pending') return;
        outcome = 'rolled_back';
        fence.rollback();
      },
    };
  }

  unarchiveSession(sessionId: string): void {
    this.coordinator.unarchiveSession(sessionId);
  }

  beginDrain(): void {
    this.#admissionClosed = true;
    this.#disposeOwners();
    if (!this.#failStop) this.#scheduleAllNormalReleases();
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#closeOnce();
    return this.#closeTask;
  }

  async #closeOnce(): Promise<void> {
    this.beginDrain();
    await Promise.all(this.#normalReleaseTasks);
    if (this.#closeErrors.length === 1) throw this.#closeErrors[0];
    if (this.#closeErrors.length > 1) {
      throw new AggregateError(this.#closeErrors, 'Goal coordinator did not close cleanly');
    }
  }

  prepareFailStopReclaim(): () => void {
    if (this.#failStopReclaimer) return this.#failStopReclaimer;
    this.#failStop = true;
    this.#admissionClosed = true;
    this.#disposeOwners();

    const residencies = [...this.#residencies.values()];
    this.#residencies.clear();
    this.#normalReleaseTasks.clear();
    let reclaimed = false;
    this.#failStopReclaimer = () => {
      if (reclaimed) return;
      reclaimed = true;
      for (const residency of residencies) residency.token.release();
    };
    return this.#failStopReclaimer;
  }

  #query(sessionId: string): Promise<OperationOutcome<'goal.query'>> {
    if (this.#admissionClosed) return Promise.resolve(queryHostDraining());
    const goal = this.manager.get(sessionId);
    return Promise.resolve(
      success(
        'goal.query',
        encodeGoalQueryResult(goal ? { kind: 'item', goal: project(goal) } : { kind: 'none' }),
      ),
    );
  }

  #clear(sessionId: string, goalId: string): Promise<OperationOutcome<'goal.clear'>> {
    if (this.#admissionClosed) return Promise.resolve(hostDraining());
    const current = this.manager.get(sessionId);
    if (!current) return Promise.resolve(failure('not_found', 'Goal was not found'));
    if (current.id !== goalId) {
      return Promise.resolve(
        failure('operation_conflict', 'Goal identity does not match the current Goal generation'),
      );
    }
    if (TERMINAL_GOAL_STATUSES.has(current.status)) {
      return Promise.resolve(
        success('goal.clear', encodeGoalClearResult({ kind: 'unchanged', goal: project(current) })),
      );
    }

    const cleared = this.manager.clear(sessionId);
    if (!cleared) {
      return Promise.resolve(failure('internal_failure', 'Goal could not be cleared'));
    }
    this.coordinator.invalidateSession(sessionId);
    return Promise.resolve(
      success('goal.clear', encodeGoalClearResult({ kind: 'cleared', goal: project(cleared) })),
    );
  }

  #observeGoal(goal: GoalState): void {
    if (this.#admissionClosed || this.#disposed || this.#failStop) return;
    if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
      const residency = this.#residencies.get(generationKey(goal.sessionId, goal.id));
      if (residency) this.#scheduleNormalRelease(residency);
      return;
    }

    const key = generationKey(goal.sessionId, goal.id);
    if (this.#residencies.has(key)) return;
    try {
      this.#residencies.set(key, {
        sessionId: goal.sessionId,
        goalId: goal.id,
        token: this.#acquireResidency(),
      });
    } catch (error) {
      this.#recordNonClean(error);
    }
  }

  #scheduleNormalRelease(residency: GoalResidency): void {
    if (this.#failStop || residency.releaseTask) return;
    const task = Promise.resolve()
      .then(async () => {
        if (!this.#ownsNormalResidency(residency)) return;
        try {
          await this.coordinator.whenGenerationIdle(residency.sessionId, residency.goalId);
        } catch (error) {
          if (!this.#ownsNormalResidency(residency)) return;
          this.#recordNonClean(error);
        }
        if (this.#ownsNormalResidency(residency)) this.#releaseNormalResidency(residency);
      })
      .finally(() => {
        this.#normalReleaseTasks.delete(task);
      });
    residency.releaseTask = task;
    this.#normalReleaseTasks.add(task);
  }

  #ownsNormalResidency(residency: GoalResidency): boolean {
    return (
      !this.#failStop &&
      this.#residencies.get(generationKey(residency.sessionId, residency.goalId)) === residency
    );
  }

  #releaseNormalResidency(residency: GoalResidency): void {
    if (!this.#ownsNormalResidency(residency)) return;
    residency.token.release();
    this.#residencies.delete(generationKey(residency.sessionId, residency.goalId));
  }

  #disposeOwners(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.coordinator.dispose();
    } catch (error) {
      this.#recordNonClean(error);
    }
    try {
      this.manager.dispose();
    } catch (error) {
      this.#recordNonClean(error);
    }
    this.#tokenCounts.clear();
  }

  #scheduleAllNormalReleases(): void {
    for (const residency of [...this.#residencies.values()]) {
      this.#scheduleNormalRelease(residency);
    }
  }

  #recordNonClean(error: unknown): void {
    this.#closeErrors.push(error);
    this.#admissionClosed = true;
    if (this.#drainRequested || this.#failStop) return;
    this.#drainRequested = true;
    this.#requestDrain();
  }
}

function generationKey(sessionId: string, goalId: string): string {
  return JSON.stringify([sessionId, goalId]);
}

function project(goal: GoalState): GoalProjection {
  return {
    goalId: goal.id,
    revision: goal.revision,
    sessionId: goal.sessionId,
    condition: goal.condition,
    status: goal.status,
    setAt: goal.setAt,
    iterations: goal.iterations,
    maxIterations: goal.maxIterations,
    consecutiveNoProgress: goal.consecutiveNoProgress,
    blockCap: goal.blockCap,
    tokensAtStart: goal.tokensAtStart,
    tokensNow: goal.tokensNow,
    tokensBaselinePending: goal.tokensBaselinePending,
    ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
    ...(goal.lastReason === undefined ? {} : { lastReason: goal.lastReason }),
    ...(goal.achievedAt === undefined ? {} : { achievedAt: goal.achievedAt }),
    ...(goal.pausedAt === undefined ? {} : { pausedAt: goal.pausedAt }),
  };
}

function success<K extends 'goal.query' | 'goal.clear'>(
  _operation: K,
  result: Extract<OperationOutcome<K>, { ok: true }>['result'],
): OperationOutcome<K> {
  return { ok: true, result } as OperationOutcome<K>;
}

function failure(
  code: 'not_found' | 'operation_conflict' | 'internal_failure',
  message: string,
): Extract<OperationOutcome<'goal.clear'>, { ok: false }> {
  return { ok: false, error: { code, message } };
}

function hostDraining(): Extract<OperationOutcome<'goal.clear'>, { ok: false }> {
  return {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host is draining' },
  };
}

function queryHostDraining(): Extract<OperationOutcome<'goal.query'>, { ok: false }> {
  return {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host is draining' },
  };
}
