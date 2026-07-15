import type { SessionEvent } from '@maka/core';
import {
  drainGoalTurn,
  type GoalExternalTurnStart,
  type GoalExternalTurnSettler,
  type GoalTurnOutcome,
  type SessionActivityLease,
  type SessionActivityRegistry,
} from '@maka/runtime';
import type { MakaSessionDriver } from './session-driver.js';

export interface MakaPiTuiTurnLifecycle {
  activities: SessionActivityRegistry;
  beginExternalTurn: (sessionId: string, turnId: string) => GoalExternalTurnStart;
}

export type MakaPiTuiTurnRequest =
  | {
      kind: 'external';
      prompt: string;
      /** Model-facing text after explicit skill expansion, when different. */
      sendText?: string;
      /** Session observed before preparation; null is valid for the first turn. */
      sessionId: string | null;
    }
  | {
      kind: 'coordinator';
      prompt: string;
      sessionId: string;
      turnId: string;
      activity: SessionActivityLease;
    };

export interface RunMakaPiTuiTurnInput {
  driver: Pick<MakaSessionDriver, 'preparePrompt'>;
  lifecycle: MakaPiTuiTurnLifecycle;
  request: MakaPiTuiTurnRequest;
  shouldAbort: () => boolean;
  onStart?: () => void;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  onFailure?: (error: unknown) => void | Promise<void>;
}

/**
 * Owns one visible TUI turn from activity reservation through full stream drain.
 * External settlement always follows activity release; coordinator turns return
 * their outcome directly to the admission completion capability.
 */
export async function runMakaPiTuiTurn(
  input: RunMakaPiTuiTurnInput,
): Promise<GoalTurnOutcome> {
  const { request } = input;
  let activity = request.kind === 'coordinator' ? request.activity : undefined;
  let preparedTurnId = request.kind === 'coordinator' ? request.turnId : undefined;
  let settleExternalTurn: GoalExternalTurnSettler | undefined;
  let settlementNotified = false;

  const notifySettlement = (outcome: GoalTurnOutcome): void => {
    if (!settleExternalTurn || settlementNotified) return;
    settlementNotified = true;
    void settleExternalTurn(outcome);
  };

  const finishBeforeDrain = async (outcome: GoalTurnOutcome): Promise<GoalTurnOutcome> => {
    activity?.release();
    activity = undefined;
    notifySettlement(outcome);
    return outcome;
  };

  try {
    input.onStart?.();
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(preparedTurnId));
    }

    if (request.kind === 'external' && request.sessionId) {
      activity = await input.lifecycle.activities.acquire(request.sessionId);
      if (input.shouldAbort()) {
        return finishBeforeDrain(abortedOutcome(preparedTurnId));
      }
    }

    const turn = await input.driver.preparePrompt(
      request.prompt,
      {
        ...(request.kind === 'coordinator' ? { turnId: request.turnId } : {}),
        ...(request.kind === 'external' && request.sendText !== undefined
          ? { modelText: request.sendText }
          : {}),
      },
    );
    preparedTurnId = turn.turnId;

    if (request.kind === 'coordinator') {
      if (turn.sessionId !== request.sessionId) {
        throw new Error('TUI Goal turn started in a different session than its reserved activity.');
      }
      if (turn.turnId !== request.turnId) {
        throw new Error(`Prepared turn identity mismatch: expected ${request.turnId}, received ${turn.turnId}.`);
      }
    } else if (request.sessionId && turn.sessionId !== request.sessionId) {
      throw new Error('TUI turn started in a different session than its reserved activity.');
    }

    if (!activity) activity = await input.lifecycle.activities.acquire(turn.sessionId);
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(turn.turnId));
    }

    if (request.kind === 'external') {
      const registration = input.lifecycle.beginExternalTurn(turn.sessionId, turn.turnId);
      if (registration.kind !== 'registered') {
        throw new Error(registration.kind === 'duplicate'
          ? `TUI turn ${turn.turnId} is already registered.`
          : registration.reason);
      }
      settleExternalTurn = registration.settle;
    }

    let sawTerminalEvent = false;
    let failureProjected = false;
    const result = await drainGoalTurn({
      events: turn.events,
      expectedTurnId: turn.turnId,
      activity,
      onEvent: async (event) => {
        if (event.type === 'complete' || event.type === 'abort' || event.type === 'error') {
          sawTerminalEvent = true;
        }
        await input.onEvent?.(event);
      },
      onStreamError: async (error) => {
        failureProjected = true;
        await input.onFailure?.(error);
      },
      onDrained: async (outcome) => {
        if (outcome.kind === 'errored' && !sawTerminalEvent && !failureProjected) {
          await input.onFailure?.(new Error(outcome.reason));
        }
      },
      onSettled: notifySettlement,
    });
    activity = undefined;
    return result.outcome;
  } catch (error) {
    if (input.shouldAbort()) {
      return finishBeforeDrain(abortedOutcome(preparedTurnId));
    }
    let reportedError = error;
    try {
      await input.onFailure?.(error);
    } catch (projectionError) {
      reportedError = projectionError;
    }
    return finishBeforeDrain({
      kind: 'errored',
      ...(preparedTurnId ? { turnId: preparedTurnId } : {}),
      reason: errorMessage(reportedError),
    });
  }
}

function abortedOutcome(turnId: string | undefined): GoalTurnOutcome {
  return { kind: 'aborted', ...(turnId ? { turnId } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
