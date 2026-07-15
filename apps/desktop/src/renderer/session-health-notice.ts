/**
 * Pure derivation of the session health notice shown above the composer.
 *
 * #1032: only hard-block / must-act conditions surface a notice. Soft
 * "will rebind to default on send" heads-ups stay silent — send-path silent
 * rebind + the authoritative send gate cover those cases without a banner.
 *
 * Priority order (most specific first):
 *
 *   1. Active session uses `backend='fake'` and no usable default exists.
 *   2. Active session references a missing connection and no usable default.
 *   3. Active connection is `needs_reauth` (warning) or `error` (destructive).
 *
 * Everything else → no notice.
 *
 * `defaultConnectionReady` is a renderer-side **display filter** only
 * (`defaultConnection exists && enabled`). It is NOT a send-readiness fact
 * and must not be treated as a send gate (PR-HEALTH-1 / I3 lock).
 */

export interface SessionHealthNoticeInput {
  /**
   * The session backend kind. `'fake'` is treated as stale because it
   * represents old local simulation sessions, not a real provider.
   *
   * `string` (not `BackendKind`) so legacy on-disk values like `'claude'`
   * (a removed backend) are surfaced exactly as the JSONL stored them.
   */
  backend: string | undefined;
  /**
   * True when the session's `llmConnectionSlug` resolves to a real
   * connection in the current store. False = either deleted or legacy.
   */
  hasActiveConnection: boolean;
  /**
   * Cheap renderer-side **hint** that "send-path silent rebind can succeed".
   * Computed as `(defaultConnection exists) && defaultConnection.enabled` —
   * it is NOT a send-readiness fact. When true, soft rebind cases stay
   * silent; when false, missing/fake sessions become hard notices.
   */
  defaultConnectionReady: boolean;
  /**
   * Result of the most recent credential test for the active connection.
   * `needs_reauth` (401/403) → warning; `error` (5xx/timeout/network) →
   * destructive. Only meaningful when `hasActiveConnection` is true.
   */
  lastTestStatus: 'verified' | 'needs_reauth' | 'error' | undefined;
}

export type SessionHealthNoticeTarget = 'models' | 'account';

export interface SessionHealthNotice {
  tone: 'info' | 'warning' | 'destructive';
  /** Short label shown inside the notice. */
  label: string;
  /** Longer explanation for tooltip / assistive text. */
  tooltip?: string;
  /** Which Settings section the click handler should navigate to. */
  onClickTarget: SessionHealthNoticeTarget;
}

export function deriveSessionHealthNotice(
  input: SessionHealthNoticeInput,
): SessionHealthNotice | undefined {
  if (input.backend === undefined) return undefined;

  // 1. Stale `fake` backend — only when send cannot silent-rebind.
  if (input.backend === 'fake') {
    if (input.defaultConnectionReady) return undefined;
    return {
      tone: 'destructive',
      label: '会话已过期 · 请先配置真实模型',
      tooltip: '原会话使用旧的本地模拟连接，需要先到 设置 · 模型 添加并启用一个真实模型才能发送。',
      onClickTarget: 'models',
    };
  }

  // 2. Connection missing — only when send cannot silent-rebind.
  if (!input.hasActiveConnection) {
    if (input.defaultConnectionReady) return undefined;
    return {
      tone: 'destructive',
      label: '连接已删除',
      tooltip: '此会话依赖的模型连接已被删除，当前没有默认连接。请到 设置 · 模型 添加一个可用的模型。',
      onClickTarget: 'models',
    };
  }

  // 3. Credential lifecycle states on a present connection.
  if (input.lastTestStatus === 'needs_reauth') {
    return {
      tone: 'warning',
      label: '需要重新登录',
      tooltip: '上次连接测试返回鉴权失败（401 / 403）。可能 API key 已过期或被吊销，请到 设置 · 账号 重新设置。',
      onClickTarget: 'account',
    };
  }
  if (input.lastTestStatus === 'error') {
    return {
      tone: 'destructive',
      label: '上次连接失败',
      tooltip: '上次连接测试因网络 / 超时 / 5xx 失败。请到 设置 · 账号 重新测试或检查 Base URL / 代理。',
      onClickTarget: 'account',
    };
  }
  return undefined;
}
