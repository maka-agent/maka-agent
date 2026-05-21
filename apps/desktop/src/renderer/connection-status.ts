// Derived per-connection UI status, computed from the persistent
// LlmConnection fields plus the async `hasSecret` lookup. Backend (xuan)
// owns the persistent enum:
//
//   `lastTestStatus?: 'verified' | 'needs_reauth' | 'error'`
//
// UI mixes that with `enabled`, the auth requirement, secret presence,
// and `defaultModel` to choose a *display* status. Priority order is
// fixed per @kenji's contract so we never produce mixed labels like
// "disabled + verified":
//
//   1. !enabled                                → disabled
//   2. needs secret but missing, or no model   → not_configured
//   3. lastTestStatus = 'verified'             → verified
//   4. lastTestStatus = 'needs_reauth'         → needs_reauth
//   5. lastTestStatus = 'error'                → error
//   6. otherwise (secret + model, never tested)→ configured

import type {
  ConnectionAuth,
  ConnectionLastTestStatus,
  LlmConnection,
} from '@maka/core';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';

export type ConnectionUiStatus =
  | 'disabled'
  | 'not_configured'
  | 'configured'
  | 'verified'
  | 'needs_reauth'
  | 'error';

export interface ConnectionUiStatusInput {
  enabled: boolean;
  /** Whether a secret is present in the safeStorage credential store. */
  hasSecret: boolean;
  /** Non-empty `defaultModel` is required to call the connection. */
  defaultModel: string | undefined;
  /** Persistent test outcome (xuan's `5ca1f8a` schema). */
  lastTestStatus?: ConnectionLastTestStatus;
  /**
   * Determines whether `hasSecret` actually gates the connection. Providers
   * with `authKind: 'none'` (e.g. Ollama on localhost) never need a secret;
   * for them `hasSecret` is ignored in the not_configured check.
   */
  authKind: ConnectionAuth['kind'];
}

export function deriveConnectionUiStatus(input: ConnectionUiStatusInput): ConnectionUiStatus {
  if (!input.enabled) return 'disabled';
  const needsSecret = input.authKind !== 'none';
  if ((needsSecret && !input.hasSecret) || !input.defaultModel) {
    return 'not_configured';
  }
  switch (input.lastTestStatus) {
    case 'verified':
      return 'verified';
    case 'needs_reauth':
      return 'needs_reauth';
    case 'error':
      return 'error';
    default:
      return 'configured';
  }
}

export function connectionUiStatusFromRecord(
  connection: LlmConnection,
  hasSecret: boolean,
): ConnectionUiStatus {
  return deriveConnectionUiStatus({
    enabled: connection.enabled,
    hasSecret,
    defaultModel: connection.defaultModel,
    lastTestStatus: connection.lastTestStatus,
    authKind: PROVIDER_DEFAULTS[connection.providerType].authKind,
  });
}

interface StatusPresentation {
  label: string;
  detail: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
}

const STATUS_PRESENTATION: Record<ConnectionUiStatus, StatusPresentation> = {
  disabled: {
    label: '已禁用',
    detail: '不会用于聊天或代理调用，直到在设置里启用。',
    tone: 'neutral',
  },
  not_configured: {
    label: '未配置',
    detail: '缺少 API key 或默认模型。点开模型设置补全。',
    tone: 'warning',
  },
  configured: {
    label: '已配置 · 未验证',
    detail: '凭据已保存，但还未真正调用过该 provider。点测试以确认可达。',
    tone: 'info',
  },
  verified: {
    label: '已验证可用',
    detail: '最近一次测试成功。修改 key/baseUrl/默认模型会清掉此状态。',
    tone: 'success',
  },
  needs_reauth: {
    label: '需要重新登录',
    detail: '上次测试返回 401/403。请更新 API key 或 OAuth token。',
    tone: 'warning',
  },
  error: {
    label: '连接出错',
    detail: '上次测试失败：超时、网络或 provider 不可用。可重试或检查代理。',
    tone: 'destructive',
  },
};

export function presentConnectionUiStatus(status: ConnectionUiStatus): StatusPresentation {
  return STATUS_PRESENTATION[status];
}
