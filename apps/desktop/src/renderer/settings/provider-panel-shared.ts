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
