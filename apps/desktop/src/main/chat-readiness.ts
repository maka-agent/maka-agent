import {
  isConnectionReady,
  type ChatConfigurationReason,
  type LlmConnection,
  type SessionHeader,
} from '@maka/core';
import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_DEFAULTS,
} from '@maka/core/llm-connections';

export const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';

// `ChatConfigurationReason` moved to `@maka/core/connection-readiness`
// (PR110a) so the same taxonomy is shared between send-path,
// onboarding, and quick-chat. Re-exported here for back-compat — any
// future addition belongs in core, not here.
export type { ChatConfigurationReason };

export interface ReadyConnectionDeps {
  getConnection(slug: string): Promise<LlmConnection | null>;
  getApiKey(slug: string): Promise<string | null | undefined>;
}

export interface ReadyConnection {
  connection: LlmConnection;
  apiKey: string;
  model: string;
}

export interface SessionRebindDeps {
  readyConnectionDeps: ReadyConnectionDeps;
  getDefaultSlug(): Promise<string | null>;
  listConnectionSlugs(): Promise<string[]>;
  updateSession(
    sessionId: string,
    patch: Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model' | 'connectionLocked'>,
  ): Promise<unknown>;
}

export interface SessionRebindResult {
  rebound: boolean;
  connectionSlug?: string;
  modelId?: string;
}

export async function requireReadyConnection(
  slug: string | null | undefined,
  deps: ReadyConnectionDeps,
  requestedModel?: string,
): Promise<ReadyConnection> {
  // Slug missing / explicit 'fake' shortcut is checked before reaching
  // the core helper because we lack a connection object to evaluate.
  if (!slug || slug === 'fake') {
    throw chatConfigurationError(
      '等待配置默认模型。请到 设置 · 模型 添加 Anthropic / OpenAI / GLM 等 API key。',
      'missing_default_connection',
    );
  }

  const connection = await deps.getConnection(slug);
  if (!connection) {
    throw chatConfigurationError(
      `找不到模型连接 "${slug}"。请到 设置 · 模型 重新选择默认模型。`,
      'connection_missing',
    );
  }

  // PR110a: delegate the actual ready judgment to the pure core helper
  // so onboarding / quick chat / send-path share a single source of
  // truth. The desktop side only owns: (1) async secret lookup, (2)
  // Chinese error copy, (3) the throw-error API the rest of main.ts
  // expects.
  const normalizedConnection = normalizeCodexSubscriptionConnection(connection);
  const apiKey = await deps.getApiKey(normalizedConnection.slug);
  const normalizedRequestedModel = normalizeRequestedModel(connection, requestedModel);
  const verdict = isConnectionReady({
    connection: normalizedConnection,
    hasSecret: typeof apiKey === 'string' && apiKey.length > 0,
    requestedModel: normalizedRequestedModel,
  });

  if (verdict.ready === false) {
    throw chatConfigurationError(
      messageForReason(verdict.reason, normalizedConnection, normalizedRequestedModel),
      verdict.reason,
    );
  }

  return { connection: normalizedConnection, apiKey: apiKey ?? '', model: verdict.model };
}

function normalizeCodexSubscriptionConnection(connection: LlmConnection): LlmConnection {
  if (connection.providerType !== 'codex-subscription') return connection;
  const fallbackModels = PROVIDER_DEFAULTS['codex-subscription'].fallbackModels;
  const safeModels = (connection.models ?? []).filter(
    (entry) => entry.id && !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id),
  );
  const models = safeModels.length
    ? safeModels
    : fallbackModels.map((id) => ({ id }));
  const enabledModelIds = new Set(models.map((entry) => entry.id));
  const defaultModel =
    connection.defaultModel &&
    !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(connection.defaultModel) &&
    enabledModelIds.has(connection.defaultModel)
      ? connection.defaultModel
      : models[0]?.id ?? fallbackModels[0] ?? connection.defaultModel;
  if (models === connection.models && defaultModel === connection.defaultModel) return connection;
  return { ...connection, defaultModel, models };
}

function normalizeRequestedModel(
  connection: LlmConnection,
  requestedModel: string | undefined,
): string | undefined {
  if (
    connection.providerType === 'codex-subscription' &&
    requestedModel &&
    CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(requestedModel)
  ) {
    return undefined;
  }
  return requestedModel;
}

/**
 * Map a core readiness reason to the Chinese error copy that
 * `requireReadyConnection` has historically thrown. Centralized here
 * so the copy stays close to its existing semantics (PR110a refactor
 * is behavior-preserving — only the judgment moved to core).
 */
function messageForReason(
  reason: ChatConfigurationReason,
  connection: LlmConnection,
  requestedModel: string | undefined,
): string {
  switch (reason) {
    case 'connection_disabled':
      return `模型连接 "${connection.name}" 已禁用。请到 设置 · 模型 启用或选择其他默认模型。`;
    case 'missing_api_key':
      if (PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token') {
        return `模型连接 "${connection.name}" 等待完成 OAuth 登录。请到 设置 · 模型 重新登录后再聊天。`;
      }
      return `模型连接 "${connection.name}" 等待填写 API key。请到 设置 · 模型 补齐密钥后再聊天。`;
    case 'missing_model':
      return `模型连接 "${connection.name}" 没有可用模型。请到 设置 · 模型 选择一个默认模型。`;
    case 'empty_model_list':
      return `模型连接 "${connection.name}" 没有启用任何模型。请到 设置 · 模型 先添加模型。`;
    case 'model_not_enabled': {
      const model = requestedModel || connection.defaultModel;
      return `模型 "${model}" 不在连接 "${connection.name}" 的启用模型列表中。请到 设置 · 模型 重新选择。`;
    }
    case 'model_not_chat_capable': {
      const model = requestedModel || connection.defaultModel;
      return `模型 "${model}" 不能用于聊天。请到 设置 · 模型 选择支持聊天的模型。`;
    }
    case 'oauth_subscription_not_wired':
      return `订阅连接 "${connection.name}" 只用于账号状态查看，当前不能作为聊天模型。请先选择 API key 模型连接。`;
    case 'fake_backend':
      return '当前会话来自旧的本地模拟连接，不能直接发送。请到 设置 · 模型 添加真实模型后新建会话。';
    case 'missing_default_connection':
    case 'connection_missing':
      // These reasons are handled before we reach isConnectionReady,
      // but kept here for exhaustive switch.
      return '等待配置默认模型。请到 设置 · 模型 添加 Anthropic / OpenAI / GLM 等 API key。';
  }
}

export async function assertSessionCanSend(
  header: Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model'>,
  deps: ReadyConnectionDeps,
): Promise<void> {
  if (header.backend === 'fake') {
    throw chatConfigurationError(
      '当前会话来自旧的本地模拟连接，不能直接发送。请到 设置 · 模型 添加真实模型后新建会话。',
      'fake_backend',
    );
  }
  await requireReadyConnection(header.llmConnectionSlug, deps, header.model);
}

export async function ensureSessionCanSendOrRebind(
  sessionId: string,
  header: Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model' | 'connectionLocked'>,
  deps: SessionRebindDeps,
): Promise<SessionRebindResult> {
  try {
    await assertSessionCanSend(header, deps.readyConnectionDeps);
    return { rebound: false };
  } catch (error) {
    // Once a session has user messages, its connection/model is sticky.
    // Rebind remains only a recovery path for empty legacy placeholders.
    if (header.connectionLocked) {
      throw error;
    }
    if (!shouldRebindSessionToDefault(errorReason(error))) {
      throw error;
    }
    const defaultSlug = await deps.getDefaultSlug();
    const connectionSlugs = await deps.listConnectionSlugs().catch(() => []);
    let ready: ReadyConnection | undefined;
    for (const slug of new Set([defaultSlug, ...connectionSlugs])) {
      try {
        ready = await requireReadyConnection(slug, deps.readyConnectionDeps);
        break;
      } catch {
        // Try the next persisted connection; the original error wins if none are ready.
      }
    }
    if (!ready) throw error;
    await deps.updateSession(sessionId, {
      backend: 'ai-sdk',
      llmConnectionSlug: ready.connection.slug,
      model: ready.model,
      connectionLocked: true,
    });
    return {
      rebound: true,
      connectionSlug: ready.connection.slug,
      modelId: ready.model,
    };
  }
}

export function chatConfigurationError(message: string, reason: ChatConfigurationReason): Error {
  const error = new Error(`${NO_REAL_CONNECTION_CODE}:${reason}: ${message}`);
  (error as Error & { code: string; reason: ChatConfigurationReason }).code = NO_REAL_CONNECTION_CODE;
  (error as Error & { code: string; reason: ChatConfigurationReason }).reason = reason;
  return error;
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorReason(error: unknown): string | undefined {
  if (error instanceof Error && 'reason' in error) {
    return String((error as { reason?: unknown }).reason);
  }
  return undefined;
}

export function shouldRebindSessionToDefault(reason: string | undefined): boolean {
  return reason === 'fake_backend' ||
    reason === 'connection_missing' ||
    reason === 'missing_model' ||
    reason === 'empty_model_list' ||
    reason === 'model_not_enabled' ||
    reason === 'model_not_chat_capable';
}
