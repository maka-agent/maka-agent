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
  /** Whether a saved credential is available for this connection. */
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
    label: '待补齐',
    detail: '等待填写模型密钥或选择默认模型。点开模型设置补全。',
    tone: 'warning',
  },
  configured: {
    label: '已配置 · 等待验证',
    detail: '凭据已保存；点测试连接确认服务可达。',
    tone: 'info',
  },
  verified: {
    // Credential-validation label only. The provider-auth contract draws a
    // hard line between `validated` and `operational` — agent
    // send / stream / interrupt readiness is a separate runtime
    // probe, not implied by credential test passing.
    label: '凭据已验证',
    detail: '最近一次测试成功。修改模型密钥、服务地址或默认模型会清掉此状态；发送链路需独立验证。',
    tone: 'success',
  },
  needs_reauth: {
    label: '需要重新登录',
    detail: '上次测试返回 401/403。请更新模型密钥或重新登录订阅账号。',
    tone: 'warning',
  },
  error: {
    label: '连接出错',
    detail: '上次测试失败：超时、网络或服务商返回错误。可重试或检查代理。',
    tone: 'destructive',
  },
};

export function presentConnectionUiStatus(status: ConnectionUiStatus): StatusPresentation {
  return STATUS_PRESENTATION[status];
}
