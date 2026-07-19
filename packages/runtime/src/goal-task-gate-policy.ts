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
  listActionableTaskKeys: (sessionId: string) => Promise<string[]>;
  recordDecision?: (trace: GoalTaskGateTrace) => Promise<void>;
}

interface GoalTaskGateAdmissionPlan {
  readonly taskKeys: string[];
  readonly decision: Exclude<GoalTaskGateDecision, 'evaluator_terminal' | 'goal_stopped'>;
  readonly reminder?: string;
}

const TASK_GATE_REMINDER =
  '[Task reminder] Actionable session tasks remain. Reconcile them before stopping: finish them with real evidence, ' +
  'or update their status truthfully. A task is advisory and never overrides files, tests, artifacts, or verifier evidence.';

/** Owns the advisory task reminder budget and best-effort decision tracing. */
export class GoalTaskGatePolicy {
  private readonly remindedGoalIds = new Set<string>();

  constructor(private readonly deps: GoalTaskGateDeps | undefined) {}

  async listActionable(sessionId: string): Promise<string[]> {
    if (!this.deps) return [];
    try {
      return await this.deps.listActionableTaskKeys(sessionId);
    } catch {
      return [];
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
    void this.deps.recordDecision(trace).catch(() => {});
  }
}
