import { randomUUID } from 'node:crypto';
import {
  GoalContinuationCoordinator,
  GoalManager,
  buildGoalTools,
  type GoalContinuationDeps,
  type GoalState,
  type GoalStatus,
  type GoalTaskGateTrace,
  type GoalTurnAdmission,
  type MakaTool,
} from '@maka/runtime';
import type { LlmConnection } from '@maka/core';

/**
 * Goal execution wiring for the main process. Owns the GoalManager, the goal
 * tools, and the turn-boundary continuation coordinator.
 *
 * The evaluator uses the session's default connection model with a small,
 * bounded output budget. A dedicated judge model would be cheaper, but reusing
 * the session model avoids a fragile provider-specific model mapping.
 *
 * Waiting is owned by the coordinator's in-memory backoff; it does not couple a
 * Goal to Automation and does not immediately spend another model turn.
 */
export interface MainGoalWiring {
  manager: GoalManager;
  tools: MakaTool[];
  coordinator: GoalContinuationCoordinator;
  /** Clear the current Goal generation without closing the session to future turns. */
  clearGoal: (sessionId: string) => GoalState | undefined;
  /** Persist archive, then discard Goal execution state. */
  archiveSession: (sessionId: string, persist: () => Promise<unknown>) => Promise<void>;
  /** Persist unarchive, then clear only the durable archive admission fence. */
  unarchiveSession: (sessionId: string, persist: () => Promise<unknown>) => Promise<void>;
  /** Persist deletion, then release every in-memory Goal owner for the session. */
  removeSession: (sessionId: string, persist: () => Promise<unknown>) => Promise<void>;
}

export interface CreateMainGoalWiringDeps {
  getDefaultConnectionSlug: () => Promise<string | null>;
  getConnection: (slug: string) => Promise<LlmConnection | null>;
  /**
   * The session's own connection + model, so the evaluator judges on the same
   * provider the session uses (not a global default that could route this
   * session's text to an unrelated provider). Null when the session is gone.
   */
  getSessionModel: (sessionId: string) => Promise<{ connectionSlug: string; model: string } | null>;
  resolveConnectionSecret: (slug: string) => Promise<string | null>;
  buildSubscriptionModelFetch: (connection: LlmConnection, sessionId: string, modelId: string) => typeof fetch | undefined;
  getAIModel: (input: { connection: LlmConnection; apiKey: string; modelId: string; fetch: typeof fetch | undefined }) => unknown;
  buildProviderOptions: (connection: LlmConnection, modelId: string) => unknown;
  getRecentMessages: (sessionId: string) => Promise<Array<{ type: string; text?: string }>>;
  /** Cumulative token count for a session (summed from token_usage messages). */
  getTokenCount: (sessionId: string) => Promise<number>;
  admitTurn: (sessionId: string, text: string) => GoalTurnAdmission;
  /** Pending/in-progress task keys used by the bounded Goal stop reminder. */
  listActionableTaskKeys?: (sessionId: string) => Promise<string[]>;
  /** Persist the task gate decision against the completed AgentRun. */
  recordTaskGateDecision?: (trace: GoalTaskGateTrace) => Promise<void>;
  /**
   * Fired on every goal state transition (set / continue / terminal / clear).
   * The host emits a session event so the renderer can badge an active goal and
   * offer a clear affordance — an autonomous token-burning loop must be visible.
   */
  onGoalChange?: (goal: GoalState, previous?: GoalStatus) => void;
}

export function createMainGoalWiring(deps: CreateMainGoalWiringDeps): MainGoalWiring {
  const manager = new GoalManager({
    generateId: () => randomUUID(),
    now: () => Date.now(),
    onChange: deps.onGoalChange,
  });

  // Synchronous best-effort token snapshot cache, refreshed each continuation.
  const tokenCache = new Map<string, number>();

  const continuationDeps: GoalContinuationDeps = {
    goalManager: manager,
    evaluator: {
      async evaluate(prompt: string, sessionId: string): Promise<string> {
        // Judge on the SESSION's own connection + model (fall back to the
        // default only if the session's connection is gone), so evaluation
        // routes to the same provider the session is actually driving.
        const sess = await deps.getSessionModel(sessionId);
        const slug = sess?.connectionSlug ?? await deps.getDefaultConnectionSlug();
        if (!slug) return '{"met": false, "impossible": false, "progress": false, "waiting": false, "reason": "no connection configured"}';
        const connection = await deps.getConnection(slug);
        if (!connection) return '{"met": false, "impossible": false, "progress": false, "waiting": false, "reason": "connection not found"}';
        const modelId = sess?.model ?? connection.defaultModel;
        const apiKey = await deps.resolveConnectionSecret(slug);
        const ai = await import('ai') as unknown as {
          generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
        };
        const modelFetch = deps.buildSubscriptionModelFetch(connection, 'goal-evaluator', modelId);
        const result = await ai.generateText({
          model: deps.getAIModel({ connection, apiKey: apiKey ?? '', modelId, fetch: modelFetch }),
          prompt,
          providerOptions: deps.buildProviderOptions(connection, modelId),
          // Ceiling, not a target — the verdict is tiny JSON. Kept well above the
          // JSON size so any model-side reasoning before the JSON doesn't consume
          // the whole budget and return empty text (finishReason=length). 250 was
          // too tight once the cap is honored by the AI SDK.
          maxOutputTokens: 1024,
        });
        return result.text;
      },
    },
    async getRecentContext(sessionId: string): Promise<string> {
      // Refresh the token snapshot while we have the session open.
      tokenCache.set(sessionId, await deps.getTokenCount(sessionId));
      const messages = await deps.getRecentMessages(sessionId);
      return messages
        .filter((m) => m.type === 'user' || m.type === 'assistant')
        .slice(-6)
        .map((m) => `[${m.type}]: ${(m.text ?? '').slice(0, 500)}`)
        .join('\n');
    },
    getTokenCount: (sessionId) => tokenCache.get(sessionId) ?? 0,
    admitTurn: deps.admitTurn,
    ...(deps.listActionableTaskKeys ? {
      taskGate: {
        listActionableTaskKeys: deps.listActionableTaskKeys,
        ...(deps.recordTaskGateDecision ? { recordDecision: deps.recordTaskGateDecision } : {}),
      },
    } : {}),
  };

  const coordinator = new GoalContinuationCoordinator(continuationDeps);
  const tools = buildGoalTools({
    goalManager: manager,
    goalContinuation: coordinator,
    getTokenCount: (sessionId) => tokenCache.get(sessionId) ?? 0,
  });

  async function closeSession(
    sessionId: string,
    kind: 'archive' | 'remove',
    persist: () => Promise<unknown>,
  ): Promise<void> {
    const operation = coordinator.beginSessionClose(sessionId, kind);
    try {
      await persist();
    } catch (error) {
      operation.rollback();
      throw error;
    }
    operation.commit();
    manager.remove(sessionId);
  }

  return {
    manager,
    tools,
    coordinator,
    clearGoal(sessionId) {
      const cleared = manager.clear(sessionId);
      if (cleared) coordinator.invalidateSession(sessionId);
      return cleared;
    },
    archiveSession(sessionId, persist) {
      return closeSession(sessionId, 'archive', persist);
    },
    async unarchiveSession(sessionId, persist) {
      await persist();
      coordinator.unarchiveSession(sessionId);
    },
    removeSession(sessionId, persist) {
      return closeSession(sessionId, 'remove', persist);
    },
  };
}
