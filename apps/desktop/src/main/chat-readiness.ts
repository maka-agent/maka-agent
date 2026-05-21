import { PROVIDER_DEFAULTS, type LlmConnection, type SessionHeader } from '@maka/core';

export const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';

export type ChatConfigurationReason =
  | 'missing_default_connection'
  | 'connection_missing'
  | 'connection_disabled'
  | 'missing_api_key'
  | 'missing_model'
  | 'empty_model_list'
  | 'model_not_enabled'
  | 'fake_backend';

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
  if (!slug || slug === 'fake') {
    throw chatConfigurationError(
      '还没有配置默认模型。请到 设置 · 模型 添加 Anthropic / OpenAI / GLM 等 API key。',
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
  if (!connection.enabled) {
    throw chatConfigurationError(
      `模型连接 "${connection.name}" 已禁用。请到 设置 · 模型 启用或选择其他默认模型。`,
      'connection_disabled',
    );
  }

  const apiKey = await deps.getApiKey(connection.slug);
  if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'none' && !apiKey) {
    throw chatConfigurationError(
      `模型连接 "${connection.name}" 缺少 API key。请到 设置 · 模型 补齐密钥后再聊天。`,
      'missing_api_key',
    );
  }

  const model = requestedModel || connection.defaultModel;
  if (!model) {
    throw chatConfigurationError(
      `模型连接 "${connection.name}" 没有可用模型。请到 设置 · 模型 选择一个默认模型。`,
      'missing_model',
    );
  }
  if (connection.models) {
    const allowedModels = new Set(connection.models.map((entry) => entry.id));
    if (allowedModels.size === 0) {
      throw chatConfigurationError(
        `模型连接 "${connection.name}" 没有启用任何模型。请到 设置 · 模型 先添加模型。`,
        'empty_model_list',
      );
    }
    if (!allowedModels.has(model)) {
      throw chatConfigurationError(
        `模型 "${model}" 不在连接 "${connection.name}" 的启用模型列表中。请到 设置 · 模型 重新选择。`,
        'model_not_enabled',
      );
    }
  }

  return { connection, apiKey: apiKey ?? '', model };
}

export async function assertSessionCanSend(
  header: Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model'>,
  deps: ReadyConnectionDeps,
): Promise<void> {
  if (header.backend === 'fake') {
    throw chatConfigurationError(
      '当前会话使用的是 FakeBackend，只能做开发演示。请到 设置 · 模型 添加真实模型后新建会话。',
      'fake_backend',
    );
  }
  await requireReadyConnection(header.llmConnectionSlug, deps, header.model);
}

export async function ensureSessionCanSendOrRebind(
  sessionId: string,
  header: Pick<SessionHeader, 'backend' | 'llmConnectionSlug' | 'model'>,
  deps: SessionRebindDeps,
): Promise<SessionRebindResult> {
  try {
    await assertSessionCanSend(header, deps.readyConnectionDeps);
    return { rebound: false };
  } catch (error) {
    if (!shouldRebindSessionToDefault(errorReason(error))) {
      throw error;
    }
    const defaultSlug = await deps.getDefaultSlug();
    let ready: ReadyConnection;
    try {
      ready = await requireReadyConnection(defaultSlug, deps.readyConnectionDeps);
    } catch {
      throw error;
    }
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
    reason === 'model_not_enabled';
}
