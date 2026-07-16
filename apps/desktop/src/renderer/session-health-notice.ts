/**
 * Derivation of the session health notice shown above the composer.
 *
 * #1038 — the notice answers exactly one question: "will the next send
 * fail for a recoverable connection/session reason, and where should the
 * user go?". The answer comes from `projectSessionSendOutcome` — the
 * same core projection the main-process send gate delegates to — fed
 * with renderer-side facts: the connection list, the default slug, a
 * `connections:hasSecret` probe, and `connectionLocked` on the session
 * summary. The notice and the send path cannot disagree, because they
 * decide from the same code over the same facts:
 *
 *   - `ready` / `rebind` → no notice (silent rebind stays silent, #1032).
 *   - `blocked` → destructive notice whose copy names the failing
 *     connection and points at the matching Settings section.
 *
 * `lastTestStatus` is an intentional pre-send reminder (product contract
 * decided in #1038). E4 locks that it must NOT gate send, so here it
 * must never claim send is blocked either: it renders only as a
 * `warning`, only when the projection says the session's own connection
 * will serve the next send (`ready`), and its copy states plainly that
 * the send is not intercepted. When the projection rebinds away from the
 * connection, the reminder is noise and stays silent.
 */

import {
  projectSessionSendOutcome,
  type LlmConnection,
  type SessionSendProjection,
  type SessionSendProjectionSession,
} from '@maka/core';

export interface SessionHealthNoticeInput {
  /**
   * The active session's send-relevant header facts. `undefined` when no
   * session is active → no notice. `backend` is `string` (not
   * `BackendKind`) so legacy on-disk values like `'claude'` surface
   * exactly as stored.
   */
  session: SessionSendProjectionSession | undefined;
  /** Every persisted connection — the projection's rebind walk reads all of them. */
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  /**
   * Secret presence per slug from the `connections:hasSecret` probe.
   * Unknown (probe in flight) is treated as present so a destructive
   * notice never flashes before the first probe lands; a genuine block
   * simply appears one tick later.
   */
  hasSecret(slug: string): boolean;
  /**
   * The session's own connection's most recent credential test result.
   * Advisory reminder only — never interpreted as a send block (E4).
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
  const { session } = input;
  if (!session) return undefined;

  const outcome = projectSessionSendOutcome({
    session,
    connections: input.connections,
    defaultSlug: input.defaultSlug,
    hasSecret: input.hasSecret,
  });

  if (outcome.kind === 'blocked') return blockedNotice(outcome, input);
  if (outcome.kind === 'rebind') return undefined;
  return credentialReminderNotice(input.lastTestStatus);
}

function blockedNotice(
  outcome: Extract<SessionSendProjection, { kind: 'blocked' }>,
  input: SessionHealthNoticeInput,
): SessionHealthNotice {
  const session = input.session!;
  const own = input.connections.find((connection) => connection.slug === session.llmConnectionSlug);
  const name = own?.name ?? session.llmConnectionSlug;
  switch (outcome.reason) {
    case 'fake_backend':
      return {
        tone: 'destructive',
        label: '会话已过期 · 请先配置真实模型',
        tooltip: '原会话使用旧的本地模拟连接，需要先到 设置 · 模型 添加并启用一个真实模型才能发送。',
        onClickTarget: 'models',
      };
    case 'missing_default_connection':
      return {
        tone: 'destructive',
        label: '未配置可用模型',
        tooltip: '当前会话没有可用的模型连接，发送会失败。请到 设置 · 模型 添加并启用一个模型。',
        onClickTarget: 'models',
      };
    case 'connection_missing':
      return {
        tone: 'destructive',
        label: '连接已删除',
        tooltip: '此会话依赖的模型连接已被删除，发送会失败。请到 设置 · 模型 检查连接配置。',
        onClickTarget: 'models',
      };
    case 'connection_disabled':
      return {
        tone: 'destructive',
        label: '连接已禁用',
        tooltip: `会话绑定的连接 "${name}" 已禁用，发送会失败。请到 设置 · 模型 启用它或选择其他连接。`,
        onClickTarget: 'models',
      };
    case 'missing_api_key':
      return {
        tone: 'destructive',
        label: '连接缺少密钥',
        tooltip: `连接 "${name}" 未填写 API key 或未完成登录，发送会失败。请到 设置 · 模型 补齐凭据。`,
        onClickTarget: 'models',
      };
    case 'missing_model':
      return {
        tone: 'destructive',
        label: '连接未选择模型',
        tooltip: `连接 "${name}" 没有默认模型，发送会失败。请到 设置 · 模型 选择一个模型。`,
        onClickTarget: 'models',
      };
    case 'empty_model_list':
      return {
        tone: 'destructive',
        label: '连接没有启用模型',
        tooltip: `连接 "${name}" 没有启用任何模型，发送会失败。请到 设置 · 模型 先添加模型。`,
        onClickTarget: 'models',
      };
    case 'model_not_enabled':
      return {
        tone: 'destructive',
        label: '会话模型未启用',
        tooltip: `模型 "${session.model}" 不在连接 "${name}" 的启用列表中，发送会失败。请到 设置 · 模型 重新选择。`,
        onClickTarget: 'models',
      };
    case 'model_not_chat_capable':
      return {
        tone: 'destructive',
        label: '会话模型不支持聊天',
        tooltip: `模型 "${session.model}" 不能用于聊天，发送会失败。请到 设置 · 模型 选择支持聊天的模型。`,
        onClickTarget: 'models',
      };
    case 'oauth_subscription_not_wired':
      return {
        tone: 'destructive',
        label: '订阅连接不能用于聊天',
        tooltip: `订阅连接 "${name}" 只用于账号状态查看，发送会失败。请先选择 API key 模型连接。`,
        onClickTarget: 'models',
      };
  }
}

/**
 * The intentional `lastTestStatus` reminder (#1038 contract): warning
 * tone only, copy states the send is NOT intercepted, Settings remains
 * the fix home. Only called when the projection is `ready`.
 */
function credentialReminderNotice(
  lastTestStatus: SessionHealthNoticeInput['lastTestStatus'],
): SessionHealthNotice | undefined {
  if (lastTestStatus === 'needs_reauth') {
    return {
      tone: 'warning',
      label: '上次连接测试鉴权失败',
      tooltip: '最近一次连接测试返回鉴权失败（401 / 403），密钥可能已过期或被吊销。这不会拦截发送，但若发送失败请到 设置 · 账号 重新登录。',
      onClickTarget: 'account',
    };
  }
  if (lastTestStatus === 'error') {
    return {
      tone: 'warning',
      label: '上次连接测试失败',
      tooltip: '最近一次连接测试因网络 / 超时 / 5xx 失败。这不会拦截发送，但若问题持续请到 设置 · 账号 检查 Base URL / 代理。',
      onClickTarget: 'account',
    };
  }
  return undefined;
}
