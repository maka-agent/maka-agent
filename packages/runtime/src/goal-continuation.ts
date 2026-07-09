/**
 * Goal continuation controller — the pure decision logic for what happens at a
 * turn boundary when a goal is active. Lives in @maka/runtime so desktop and
 * CLI share one implementation (Desktop/TUI parity rule).
 *
 * Called after a turn's event stream drains. Order of operations matters:
 * the external evaluator runs FIRST so a goal genuinely completed on its last
 * permitted turn is detected as achieved/impossible rather than misreported as
 * a cap failure. Caps (iterations / token budget / stall) are enforced only
 * after the evaluator has had its say.
 *
 * "Waiting on an external event" is treated as a NEUTRAL signal: the turn does
 * not count against the stall cap (the agent is legitimately blocked, not
 * stuck), and a normal continuation turn is injected so the agent re-checks.
 * A long wait is bounded by maxIterations and surfaces as a visible terminal
 * state — never a silent zombie. (A scheduled poll handoff to the automation
 * system is deliberately out of scope for v1; it couples two independent
 * lifecycles and is easy to get wrong.)
 */

import { evaluateGoal, type GoalEvaluation, type GoalEvaluatorDeps } from './goal-evaluator.js';
import type { GoalManager } from './goal-state.js';

export type GoalContinuationOutcome =
  | { kind: 'no_goal' }
  | { kind: 'cannot_continue' }
  | { kind: 'busy' }
  | { kind: 'achieved'; evaluation: GoalEvaluation }
  | { kind: 'impossible'; evaluation: GoalEvaluation }
  | { kind: 'stopped'; reason: string; status: string }
  | { kind: 'continued'; evaluation: GoalEvaluation };

export interface GoalContinuationDeps {
  goalManager: GoalManager;
  evaluator: GoalEvaluatorDeps;
  /** Summarized recent conversation (last ~5 messages) for the evaluator. */
  getRecentContext: (sessionId: string) => Promise<string>;
  /** Current cumulative token count for the session (for budget tracking). */
  getTokenCount?: (sessionId: string) => number;
  /** Inject a continuation turn into the session. */
  injectTurn: (sessionId: string, text: string) => void;
  /** Session is idle and can accept a new turn (exists, not archived, not running). */
  canContinue: (sessionId: string) => Promise<boolean>;
  /**
   * Per-session re-entrancy guard. Prevents two overlapping continuations for
   * the same session (the evaluator call spans multiple seconds, during which a
   * second turn could complete). Supplied by the wiring; omitted in unit tests.
   */
  inFlight?: Set<string>;
}

const CONTINUATION_PREAMBLE =
  '[Goal continuation] The goal is not yet met. Keep working toward it. '
  + 'Do not redefine success around a smaller task; match your verification to the full requirement.';

export async function handleGoalContinuation(
  deps: GoalContinuationDeps,
  sessionId: string,
): Promise<GoalContinuationOutcome> {
  const goal = deps.goalManager.getActive(sessionId);
  if (!goal) return { kind: 'no_goal' };

  // Re-entrancy guard: only one continuation in flight per session.
  if (deps.inFlight?.has(sessionId)) return { kind: 'busy' };
  deps.inFlight?.add(sessionId);
  try {
    if (!(await deps.canContinue(sessionId))) return { kind: 'cannot_continue' };

    // Evaluate FIRST — a genuine completion on the final permitted turn must be
    // detected before any cap short-circuits the loop.
    const context = await deps.getRecentContext(sessionId);
    const evaluation = await evaluateGoal(deps.evaluator, goal.condition, context, sessionId);

    if (evaluation.met) {
      deps.goalManager.markAchieved(sessionId, evaluation.reason);
      return { kind: 'achieved', evaluation };
    }
    if (evaluation.impossible) {
      deps.goalManager.markImpossible(sessionId, evaluation.reason);
      return { kind: 'impossible', evaluation };
    }

    // Enforce caps AFTER evaluation. Each may flip the goal terminal.
    if (deps.getTokenCount) {
      deps.goalManager.recordTokens(sessionId, deps.getTokenCount(sessionId));
    }
    deps.goalManager.incrementIteration(sessionId);
    // Progress signal drives the stall cap. Skip it (neutral) when the evaluator
    // failed (transient outage must not defeat stall detection) OR when the
    // agent is legitimately waiting on an external event (a wait is not a stall).
    if (!evaluation.evaluatorFailed && !evaluation.waiting) {
      deps.goalManager.recordProgress(sessionId, evaluation.progress);
    }

    const settled = deps.goalManager.get(sessionId);
    if (!settled || settled.status !== 'active') {
      return { kind: 'stopped', reason: settled?.lastReason ?? 'Goal settled', status: settled?.status ?? 'unknown' };
    }

    // Re-check idle immediately before injecting — the evaluator call may have
    // spanned seconds during which a user send started a new turn.
    if (!(await deps.canContinue(sessionId))) return { kind: 'cannot_continue' };

    settled.lastReason = evaluation.reason;
    const waitNote = evaluation.waiting ? ' (waiting on an external event — re-check, do not spin uselessly)' : '';
    deps.injectTurn(
      sessionId,
      `${CONTINUATION_PREAMBLE}\n\nEvaluation: ${evaluation.reason}${waitNote}\n`
      + `Goal: "${settled.condition}" (turn ${settled.iterations}/${settled.maxIterations}`
      + `${settled.consecutiveNoProgress > 0 ? `, ${settled.consecutiveNoProgress}/${settled.blockCap} no-progress` : ''})`,
    );
    return { kind: 'continued', evaluation };
  } finally {
    deps.inFlight?.delete(sessionId);
  }
}
