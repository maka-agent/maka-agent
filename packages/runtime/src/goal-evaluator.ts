/**
 * Goal evaluator — CC-style external judge. Runs after each turn to decide
 * whether the goal is met, impossible, making progress, or waiting on an
 * external event. The judge runs on the SESSION's own model (see wiring): the
 * evaluation reads that session's recent messages, so routing it to the same
 * provider keeps the judgment consistent and avoids leaking session text to an
 * unrelated default connection.
 *
 * The working model never judges its own completion (unlike Codex): keeping the
 * judge external prevents the agent from rationalizing itself into a premature
 * "done", which is Codex's documented failure mode.
 */

export interface GoalEvaluation {
  /** Condition is satisfied — stop, success. */
  met: boolean;
  /** Fundamentally unachievable — stop, give up. */
  impossible: boolean;
  /** The last turn advanced toward the goal (resets the block cap). */
  progress: boolean;
  /** The agent is blocked waiting on an external event (CI, deploy, review). */
  waiting: boolean;
  /**
   * The evaluator failed (timeout/error) and produced no real judgment. The
   * caller should treat `progress` as UNKNOWN — neither advancing nor resetting
   * the stall counter — so a transient evaluator outage cannot silently defeat
   * stall detection. Fail-open on continuation still applies.
   */
  evaluatorFailed: boolean;
  /** One-sentence rationale, fed back to the agent as steering. */
  reason: string;
}

export interface GoalEvaluatorDeps {
  /**
   * Single-shot LLM call for goal evaluation, run on the session's own model
   * (the wiring resolves the session's connection from `sessionId`). The
   * evaluator must not run tools or read files — it judges from text only.
   */
  evaluate: (prompt: string, sessionId: string) => Promise<string>;
  /** Hard timeout for the evaluator call (ms). Defaults to 30_000 (CC's limit). */
  timeoutMs?: number;
  /** Injectable timer for tests. Defaults to global setTimeout/clearTimeout. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_EVALUATOR_TIMEOUT_MS = 30_000;

const EVALUATOR_SYSTEM = `You are a goal evaluation judge for an autonomous coding agent. Given a GOAL CONDITION and recent CONVERSATION CONTEXT, judge the agent's progress.

Respond ONLY with valid JSON in this exact shape:
{"met": boolean, "impossible": boolean, "progress": boolean, "waiting": boolean, "reason": "one sentence"}

Field rules:
- met: true ONLY if there is clear, concrete evidence the condition is fully satisfied. Match verification scope to the requirement scope — do not accept a narrower substitute.
- impossible: true ONLY for a truly unachievable goal (violates constraints/physics), not merely a hard one.
- progress: true if the last turn moved measurably closer to the goal (fixed a failure, advanced a step). false if the turn spun, repeated itself, or did nothing useful.
- waiting: true if the agent is correctly blocked on an external event it cannot speed up (CI run, deploy, remote queue, human review).
- reason: concise (under 120 chars), specific, actionable steering for the next turn.

Be conservative on "met" and "impossible". When uncertain, met=false impossible=false progress=false waiting=false.`;

export function buildGoalEvaluationPrompt(condition: string, context: string): string {
  return [
    EVALUATOR_SYSTEM,
    '',
    '--- GOAL CONDITION ---',
    condition,
    '',
    '--- RECENT CONVERSATION CONTEXT ---',
    context,
    '',
    '--- YOUR JUDGMENT (JSON only) ---',
  ].join('\n');
}

export function parseGoalEvaluation(raw: string): GoalEvaluation {
  // Unparseable output is "no real judgment" — treat it as a NEUTRAL evaluator
  // failure (like a timeout), NOT as real "no progress", so a garbled cheap-model
  // response cannot skew stall detection into a false 'stalled' termination.
  const fallback: GoalEvaluation = {
    met: false,
    impossible: false,
    progress: false,
    waiting: false,
    evaluatorFailed: true,
    reason: 'Evaluator produced unparseable output',
  };
  // Prefer the object that mentions "met"; fall back to the first object.
  const jsonMatch = raw.match(/\{[^{}]*"met"[^{}]*\}/s) ?? raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return fallback;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      met: Boolean(parsed.met),
      impossible: Boolean(parsed.impossible),
      progress: Boolean(parsed.progress),
      waiting: Boolean(parsed.waiting),
      evaluatorFailed: false,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.slice(0, 200)
          : 'No reason provided',
    };
  } catch {
    return { ...fallback, reason: 'Evaluator JSON parse failed' };
  }
}

/**
 * Race the evaluator against a hard timeout. On timeout or error, fail OPEN
 * for continuation (goal keeps working) but flag `evaluatorFailed` so the
 * caller does not treat the outage as either progress or a stall.
 */
export async function evaluateGoal(
  deps: GoalEvaluatorDeps,
  condition: string,
  context: string,
  sessionId: string,
): Promise<GoalEvaluation> {
  const prompt = buildGoalEvaluationPrompt(condition, context);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS;
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown;
  const timeout = new Promise<'__timeout__'>((resolve) => {
    timer = setT(() => resolve('__timeout__'), timeoutMs);
  });

  try {
    const result = await Promise.race([deps.evaluate(prompt, sessionId), timeout]);
    if (result === '__timeout__') {
      return {
        met: false,
        impossible: false,
        progress: false,
        waiting: false,
        evaluatorFailed: true,
        reason: 'Evaluator timed out (continuing)',
      };
    }
    return parseGoalEvaluation(result);
  } catch {
    return {
      met: false,
      impossible: false,
      progress: false,
      waiting: false,
      evaluatorFailed: true,
      reason: 'Evaluator call failed (continuing)',
    };
  } finally {
    clearT(timer);
  }
}

export { DEFAULT_EVALUATOR_TIMEOUT_MS };
