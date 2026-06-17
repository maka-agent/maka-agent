import { randomUUID } from 'node:crypto';
import type { LlmConnection, ProviderType } from '@maka/core';
import {
  AiSdkBackend,
  type BackendRegistry,
  buildBuiltinTools,
  FakeBackend,
  getAIModel,
  PermissionEngine,
} from '@maka/runtime';

/**
 * Backend registration for the lab. The lab core stays backend-agnostic
 * (runExperiment takes `registerBackends`); these are the two concrete
 * wirings the CLI uses. Keeping them here keeps @ai-sdk / credential
 * concerns out of the engine.
 */

/** Register the deterministic stub backend ('fake') — no model, no tools. */
export function registerFakeBackend(registry: BackendRegistry): void {
  registry.register('fake', (ctx) =>
    new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
}

/**
 * Provider details for a real ('ai-sdk') run, keyed by the slug a Config
 * references. The API key is read from a named env var and never written
 * to the spec — the lab carries no secrets at rest.
 */
export interface LabConnection {
  slug: string;
  providerType: ProviderType;
  defaultModel: string;
  baseUrl?: string;
  /** Name of the env var holding the API key, e.g. ANTHROPIC_API_KEY. */
  apiKeyEnv: string;
}

/**
 * Register the real model backend ('ai-sdk'). Resolves a Config's
 * llmConnectionSlug against `connections`, reads the key from the named
 * env var, and wires a minimal AiSdkBackend: model + builtin tools +
 * an execute-mode permission engine (the runner auto-approves the
 * prompts execute still raises). Telemetry / artifact / synthesis-cache
 * hooks are omitted on purpose — a benchmark scores via the Task's
 * verification command, not usage logs.
 */
export function registerAiSdkBackend(registry: BackendRegistry, connections: LabConnection[]): void {
  const bySlug = new Map(connections.map((c) => [c.slug, c]));
  const permissionEngine = new PermissionEngine({ newId: randomUUID, now: Date.now });
  const tools = buildBuiltinTools();

  registry.register('ai-sdk', (ctx) => {
    const slug = ctx.header.llmConnectionSlug;
    const labConn = bySlug.get(slug);
    if (!labConn) throw new Error(`@maka/lab: no connection registered for slug="${slug}"`);
    const apiKey = process.env[labConn.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`@maka/lab: env var ${labConn.apiKeyEnv} is empty (needed for slug="${slug}")`);
    }
    const modelId = ctx.header.model || labConn.defaultModel;

    return new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...ctx.header, model: modelId },
      appendMessage: (message) => ctx.store.appendMessage(ctx.sessionId, message),
      connection: toLlmConnection(labConn),
      apiKey,
      modelId,
      permissionEngine,
      modelFactory: getAIModel,
      tools,
    });
  });
}

function toLlmConnection(c: LabConnection): LlmConnection {
  return {
    slug: c.slug,
    name: c.slug,
    providerType: c.providerType,
    defaultModel: c.defaultModel,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
  };
}
