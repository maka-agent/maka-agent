import { randomUUID } from 'node:crypto';
import {
  GoalManager,
  buildGoalTools,
  type GoalContinuationDeps,
  type MakaTool,
} from '@maka/runtime';
import type { LlmConnection } from '@maka/core';

/**
 * Goal execution wiring for the main process. Owns the GoalManager, the goal
 * tools, and the turn-boundary continuation deps (evaluator + injection).
 *
 * The evaluator uses the session's default connection model with a tiny
 * (~250-token) budget — a full judge model is heavier than ideal, but the
 * request/response is small and this avoids a fragile cheap-model mapping.
 *
 * "Waiting on an external event" is handled inside the continuation controller
 * (neutral progress + normal re-check), so the wiring needs no automation
 * coupling — a goal is self-contained and bounded by its own caps.
 */
export interface MainGoalWiring {
  manager: GoalManager;
  tools: MakaTool[];
  continuationDeps: GoalContinuationDeps;
}

export interface CreateMainGoalWiringDeps {
  getDefaultConnectionSlug: () => Promise<string | null>;
  getConnection: (slug: string) => Promise<LlmConnection | null>;
  resolveConnectionSecret: (slug: string) => Promise<string | null>;
  buildSubscriptionModelFetch: (connection: LlmConnection, sessionId: string, modelId: string) => typeof fetch | undefined;
  getAIModel: (input: { connection: LlmConnection; apiKey: string; modelId: string; fetch: typeof fetch | undefined }) => unknown;
  buildProviderOptions: (connection: LlmConnection, modelId: string) => unknown;
  getRecentMessages: (sessionId: string) => Promise<Array<{ type: string; text?: string }>>;
  /** Cumulative token count for a session (summed from token_usage messages). */
  getTokenCount: (sessionId: string) => Promise<number>;
  injectTurn: (sessionId: string, text: string) => void;
  canContinue: (sessionId: string) => Promise<boolean>;
}

export function createMainGoalWiring(deps: CreateMainGoalWiringDeps): MainGoalWiring {
  const manager = new GoalManager({
    generateId: () => randomUUID(),
    now: () => Date.now(),
  });

  // Synchronous best-effort token snapshot cache, refreshed each continuation.
  const tokenCache = new Map<string, number>();

  const tools = buildGoalTools({
    goalManager: manager,
    getTokenCount: (sessionId) => tokenCache.get(sessionId) ?? 0,
  });

  const inFlight = new Set<string>();

  const continuationDeps: GoalContinuationDeps = {
    goalManager: manager,
    inFlight,
    evaluator: {
      async evaluate(prompt: string): Promise<string> {
        const slug = await deps.getDefaultConnectionSlug();
        if (!slug) return '{"met": false, "impossible": false, "progress": false, "reason": "no connection configured"}';
        const connection = await deps.getConnection(slug);
        if (!connection) return '{"met": false, "impossible": false, "progress": false, "reason": "connection not found"}';
        const apiKey = await deps.resolveConnectionSecret(slug);
        const ai = await import('ai') as unknown as {
          generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
        };
        const modelFetch = deps.buildSubscriptionModelFetch(connection, 'goal-evaluator', connection.defaultModel);
        const result = await ai.generateText({
          model: deps.getAIModel({ connection, apiKey: apiKey ?? '', modelId: connection.defaultModel, fetch: modelFetch }),
          prompt,
          providerOptions: deps.buildProviderOptions(connection, connection.defaultModel),
          maxTokens: 250,
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
    injectTurn: deps.injectTurn,
    canContinue: deps.canContinue,
  };

  return { manager, tools, continuationDeps };
}

