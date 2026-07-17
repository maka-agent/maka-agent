import {
  generalizedErrorMessageChinese,
  type ConnectionTestResult,
  type CreateConnectionInput,
  type LlmConnection,
  type ModelDiscoveryResult,
  type ProviderCategory,
  type ProviderType,
  type UpdateConnectionInput,
} from '@maka/core';

export interface ConnectionsBridge {
  list(): Promise<LlmConnection[]>;
  getDefault(): Promise<string | null>;
  setDefault(slug: string | null): Promise<void>;
  create(input: CreateConnectionInput): Promise<LlmConnection>;
  update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
  delete(slug: string): Promise<void>;
  test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult>;
  fetchModels(slug: string): Promise<ModelDiscoveryResult>;
  hasSecret(slug: string): Promise<boolean>;
  subscribeEvents?(handler: () => void): () => void;
}

export type CredentialPresenceStatus = boolean | 'loading' | 'error';

export function providerPanelActionErrorMessage(error: unknown): string {
  return generalizedErrorMessageChinese(error, '模型连接服务暂时不可用，请稍后重试。');
}

export interface ConnectionTestTroubleshootingCopy {
  /** Auth-class failure copy (errorClass 'auth' or HTTP 401/403). */
  auth: string;
  /** Final fallback copy when no failure class matched. */
  recheck: string;
}

// Shared connection-test failure classification. The Models connection
// sheet and the Account page used to each hand-copy this table; only the
// surface-specific troubleshooting copy differs, so callers inject it.
export function connectionTestFailureFallback(
  result: ConnectionTestResult,
  copy: ConnectionTestTroubleshootingCopy,
): string {
  if (result.statusCode === 429) return '当前账号或模型服务触发速率限制，请稍后重试。';
  if (result.errorClass === 'timeout') return '请求超时，请检查网络或代理后重试。';
  if (result.errorClass === 'auth' || result.statusCode === 401 || result.statusCode === 403) {
    return copy.auth;
  }
  if (result.errorClass === 'provider_unavailable' || (result.statusCode !== undefined && result.statusCode >= 500)) {
    return '模型服务暂时不可用，请稍后重试。';
  }
  if (result.errorClass === 'network') return '网络错误，请检查服务地址或代理设置后重试。';
  return copy.recheck;
}

export function connectionTestFailureMessage(
  result: ConnectionTestResult,
  copy: ConnectionTestTroubleshootingCopy,
): string {
  const fallback = connectionTestFailureFallback(result, copy);
  if (!result.errorMessage) return fallback;
  return generalizedErrorMessageChinese(new Error(result.errorMessage), fallback);
}

export function connectionLastTestMessageDisplay(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  const knownMessages: Readonly<Record<string, string>> = {
    '连接已验证': '连接已验证',
    '鉴权失败': '鉴权失败',
    '请求超时': '请求超时',
    '网络错误': '网络错误',
    '模型服务返回错误': '模型服务返回错误',
    '连接测试失败': '连接测试失败',
    'connection verified': '连接已验证',
    'authentication failed': '鉴权失败',
    'request timed out': '请求超时',
    'network error': '网络错误',
    'provider returned an error': '模型服务返回错误',
    'connection test failed': '连接测试失败',
    'claude oauth 未登录。': 'Claude OAuth 未登录。',
    'claude oauth 本地凭据读取失败。': 'Claude OAuth 本地凭据读取失败。',
    'claude oauth 需要重新登录。': 'Claude OAuth 需要重新登录。',
    'claude oauth 已登录。': 'Claude OAuth 已登录。',
    'claude oauth 已退出登录。': 'Claude OAuth 已退出登录。',
    'codex oauth 未登录。': 'Codex OAuth 未登录。',
    'codex oauth 本地凭据读取失败。': 'Codex OAuth 本地凭据读取失败。',
    'codex oauth 需要重新登录。': 'Codex OAuth 需要重新登录。',
    'codex oauth 已登录。': 'Codex OAuth 已登录。',
    'codex oauth 已退出登录。': 'Codex OAuth 已退出登录。',
    '当前账号无可用 codex 模型。': '当前账号无可用 Codex 模型。',
    'codex 模型列表获取失败。': 'Codex 模型列表获取失败。',
    'github copilot 需要重新导入 github cli 登录。': 'GitHub Copilot 需要重新导入 GitHub CLI 登录。',
    'github copilot 无法读取当前账号可用模型，请重新验证登录。': 'GitHub Copilot 无法读取当前账号可用模型，请重新验证登录。',
    'github copilot 登录已导入。': 'GitHub Copilot 登录已导入。',
    'github copilot 连接未能保存，请重新导入登录。': 'GitHub Copilot 连接未能保存，请重新导入登录。',
    'github copilot 已移除本地登录。': 'GitHub Copilot 已移除本地登录。',
  };
  const known = knownMessages[normalized];
  if (known) return known;
  const classified = generalizedErrorMessageChinese(new Error(trimmed), '');
  return classified || '连接测试状态暂时无法显示，请重新测试。';
}

export function isWiredOAuthProvider(type: ProviderType): boolean {
  return type === 'claude-subscription' || type === 'openai-codex';
}

export function categoryLabel(category: ProviderCategory): string {
  switch (category) {
    case 'oauth': return 'OAuth';
    case 'domestic': return '国内';
    case 'overseas': return '海外';
    case 'local': return '本地';
    case 'custom': return 'Custom';
  }
}

export function nextSlug(type: ProviderType, existing: string[]): string {
  // Lowercase before sweeping: provider types are not all lowercase
  // ('MiniMax', 'MiniMax-cn'), and replacing uppercase letters with '-'
  // produced slugs like '-ini-ax' that validateSlug rejects.
  const base = type.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!existing.includes(base)) return base;
  // Unbounded increment: `existing` is finite, so some suffix is always free.
  // (The previous bounded loop fell back to `${base}-${Date.now()}` after -99
  // without checking `existing`, which could return an already-taken slug the
  // save path then rejects.)
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}
