import { PROVIDER_DEFAULTS, type LlmConnection, type SessionHeader } from '@maka/core';

export const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';

export interface ReadyConnectionDeps {
  getConnection(slug: string): Promise<LlmConnection | null>;
  getApiKey(slug: string): Promise<string | null | undefined>;
}

export interface ReadyConnection {
  connection: LlmConnection;
  apiKey: string;
  model: string;
}

export async function requireReadyConnection(
  slug: string | null | undefined,
  deps: ReadyConnectionDeps,
  requestedModel?: string,
): Promise<ReadyConnection> {
  if (!slug || slug === 'fake') {
    throw chatConfigurationError('还没有配置默认模型。请到 设置 · 模型 添加 Anthropic / OpenAI / GLM 等 API key。');
  }

  const connection = await deps.getConnection(slug);
  if (!connection) {
    throw chatConfigurationError(`找不到模型连接 "${slug}"。请到 设置 · 模型 重新选择默认模型。`);
  }
  if (!connection.enabled) {
    throw chatConfigurationError(`模型连接 "${connection.name}" 已禁用。请到 设置 · 模型 启用或选择其他默认模型。`);
  }

  const apiKey = await deps.getApiKey(connection.slug);
  if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'none' && !apiKey) {
    throw chatConfigurationError(`模型连接 "${connection.name}" 缺少 API key。请到 设置 · 模型 补齐密钥后再聊天。`);
  }

  const model = requestedModel || connection.defaultModel;
  if (!model) {
    throw chatConfigurationError(`模型连接 "${connection.name}" 没有可用模型。请到 设置 · 模型 选择一个默认模型。`);
  }
  if (connection.models) {
    const allowedModels = new Set(connection.models.map((entry) => entry.id));
    if (allowedModels.size === 0) {
      throw chatConfigurationError(`模型连接 "${connection.name}" 没有启用任何模型。请到 设置 · 模型 先添加模型。`);
    }
    if (!allowedModels.has(model)) {
      throw chatConfigurationError(`模型 "${model}" 不在连接 "${connection.name}" 的启用模型列表中。请到 设置 · 模型 重新选择。`);
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
    );
  }
  await requireReadyConnection(header.llmConnectionSlug, deps, header.model);
}

export function chatConfigurationError(message: string): Error {
  const error = new Error(`${NO_REAL_CONNECTION_CODE}: ${message}`);
  (error as Error & { code: string }).code = NO_REAL_CONNECTION_CODE;
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
