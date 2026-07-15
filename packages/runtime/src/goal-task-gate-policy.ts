export type GoalTaskGateDecision =
  | 'evaluator_terminal'
  | 'goal_stopped'
  | 'no_actionable_tasks'
  | 'reminder_injected'
  | 'reminder_limit_reached';

export interface GoalTaskGateTrace {
  sessionId: string;
  turnId: string;
  goalId: string;
  decision: GoalTaskGateDecision;
  taskKeys: string[];
}

export interface GoalTaskGateDeps {
  /** List only pending/in_progress tasks. Blocked and terminal tasks are excluded. */
  listActionableTaskKeys: (sessionId: string, signal: AbortSignal) => Promise<string[]>;
  /** Advisory storage reads fail open after this bound. */
  listActionableTimeoutMs?: number;
  /** One reminder per goal id, even when a session replaces its active goal. */
  remindedGoalIds?: Set<string>;
  recordDecision?: (trace: GoalTaskGateTrace) => void | Promise<void>;
}

export interface GoalTaskGateAdmissionPlan {
  readonly taskKeys: string[];
  readonly decision: Exclude<GoalTaskGateDecision, 'evaluator_terminal' | 'goal_stopped'>;
  readonly reminder?: string;
}

const TASK_GATE_REMINDER =
  '[Task reminder] Actionable session tasks remain. Reconcile them before stopping: finish them with real evidence, '
  + 'or update their status truthfully. A task is advisory and never overrides files, tests, artifacts, or verifier evidence.';
const DEFAULT_LIST_ACTIONABLE_TIMEOUT_MS = 1_000;

const reminderState = new WeakMap<GoalTaskGateDeps, Set<string>>();

/** Owns the advisory task reminder budget and best-effort decision tracing. */
export class GoalTaskGatePolicy {
  private readonly remindedGoalIds: Set<string>;

  constructor(private readonly deps: GoalTaskGateDeps | undefined) {
    this.remindedGoalIds = deps
      ? deps.remindedGoalIds ?? reminderStateFor(deps)
      : new Set<string>();
  }

  async listActionable(sessionId: string): Promise<string[]> {
    if (!this.deps) return [];
    const controller = new AbortController();
    const timeoutMs = normalizeTimeout(this.deps.listActionableTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, timeoutMs);
        timer.unref?.();
      });
      const taskKeys = await Promise.race([
        this.deps.listActionableTaskKeys(sessionId, controller.signal),
        timedOut,
      ]);
      return taskKeys ? [...new Set(taskKeys)] : [];
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async planAdmission(sessionId: string, goalId: string): Promise<GoalTaskGateAdmissionPlan> {
    const taskKeys = await this.listActionable(sessionId);
    if (taskKeys.length === 0) {
      return { taskKeys, decision: 'no_actionable_tasks' };
    }
    if (this.remindedGoalIds.has(goalId)) {
      return { taskKeys, decision: 'reminder_limit_reached' };
    }
    return {
      taskKeys,
      decision: 'reminder_injected',
      reminder: `${TASK_GATE_REMINDER}\nActionable task keys: ${taskKeys.join(', ')}`,
    };
  }

  markStarted(goalId: string, plan: GoalTaskGateAdmissionPlan): void {
    if (plan.decision === 'reminder_injected') this.remindedGoalIds.add(goalId);
  }

  record(trace: GoalTaskGateTrace): void {
    if (!this.deps?.recordDecision) return;
    try {
      void Promise.resolve(this.deps.recordDecision(trace)).catch(() => {});
    } catch {
      // Diagnostic tracing must never perturb Goal continuation.
    }
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_LIST_ACTIONABLE_TIMEOUT_MS;
}

function reminderStateFor(deps: GoalTaskGateDeps): Set<string> {
  const existing = reminderState.get(deps);
  if (existing) return existing;
  const created = new Set<string>();
  reminderState.set(deps, created);
  return created;
}
