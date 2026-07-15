import type { SessionEvent } from '@maka/core';
import {
  GoalContinuationCoordinator,
  SessionActivityRegistry,
  drainGoalTurn,
  type DrainGoalTurnResult,
  type GoalContinuationDeps,
  type GoalActivation,
  type GoalActivationResult,
  type GoalMutationResult,
  type GoalExternalTurnStart,
  type GoalExternalTurnSettler,
  type GoalTurnAdmission,
  type GoalTurnBinder,
  type GoalTurnOutcome,
} from '@maka/runtime';

export interface CliGoalTurnHost {
  admitTurn: (sessionId: string, text: string, bindTurn: GoalTurnBinder) => GoalTurnAdmission;
}

/** Owns the CLI's single coordinator and the activity boundary shared with Automation. */
export class CliGoalContinuation {
  readonly activities = new SessionActivityRegistry();
  private readonly coordinator: GoalContinuationCoordinator;
  private host: CliGoalTurnHost | undefined;
  private disposed = false;

  constructor(deps: Omit<GoalContinuationDeps, 'admitTurn'>) {
    this.coordinator = new GoalContinuationCoordinator({
      ...deps,
      admitTurn: (sessionId, text, bindTurn) => {
        const whenIdle = this.activities.whenIdle(sessionId);
        if (whenIdle) return { kind: 'busy', whenIdle };
        return this.host?.admitTurn(sessionId, text, bindTurn) ?? {
          kind: 'unavailable',
          reason: 'TUI Goal host is not available.',
        };
      },
    });
  }

  bindHost(host: CliGoalTurnHost): () => void {
    if (this.disposed) throw new Error('CLI Goal continuation is disposed.');
    if (this.host) throw new Error('CLI Goal continuation already has a bound host.');
    this.host = host;
    return () => {
      if (this.host === host) this.host = undefined;
    };
  }

  beginExternalTurn(
    sessionId: string,
    turnId: string,
  ): GoalExternalTurnStart {
    return this.coordinator.beginExternalTurn(sessionId, turnId);
  }

  activateGoal<T>(
    sessionId: string,
    turnId: string,
    activate: () => GoalActivation<T>,
  ): GoalActivationResult<T> {
    return this.coordinator.activateGoal(sessionId, turnId, activate);
  }

  mutateGoal<T>(
    sessionId: string,
    turnId: string,
    mutate: () => GoalActivation<T>,
  ): GoalMutationResult<T> {
    return this.coordinator.mutateGoal(sessionId, turnId, mutate);
  }

  async runAutomationTurn(input: {
    sessionId: string;
    turnId: string;
    start: () => AsyncIterable<SessionEvent>;
  }): Promise<DrainGoalTurnResult> {
    const activity = await this.activities.acquire(input.sessionId);
    if (this.disposed) {
      activity.release();
      return {
        outcome: {
          kind: 'errored',
          turnId: input.turnId,
          reason: 'CLI Goal continuation is disposed.',
        },
      };
    }
    const registration = this.beginExternalTurn(input.sessionId, input.turnId);
    if (registration.kind !== 'registered') {
      activity.release();
      const reason = registration.kind === 'duplicate'
        ? `CLI turn ${input.turnId} is already registered.`
        : registration.reason;
      return {
        outcome: { kind: 'errored', turnId: input.turnId, reason },
      };
    }
    const settleExternalTurn: GoalExternalTurnSettler = registration.settle;
    let events: AsyncIterable<SessionEvent>;
    try {
      events = input.start();
    } catch (error) {
      activity.release();
      const reason = error instanceof Error ? error.message : String(error);
      const outcome: GoalTurnOutcome = {
        kind: 'errored',
        turnId: input.turnId,
        reason,
      };
      void settleExternalTurn(outcome);
      return { outcome, streamError: error };
    }
    return drainGoalTurn({
      events,
      expectedTurnId: input.turnId,
      activity,
      onSettled: (outcome) => { void settleExternalTurn(outcome); },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host = undefined;
    this.coordinator.dispose();
  }
}
